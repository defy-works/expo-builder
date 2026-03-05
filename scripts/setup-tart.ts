#!/usr/bin/env bun
/**
 * One-time setup for Tart VM-based builds on a remote Mac.
 *
 * Run from any OS (Windows, macOS, or Linux):
 *   bun run scripts/setup-tart.ts
 *
 * What it does (all via SSH to the Mac host):
 *   1. Installs Tart (brew install cirruslabs/cli/tart)
 *   2. Pulls a macOS + Xcode VM image → clones as "eas-builder"
 *   3. Boots the VM, waits for SSH
 *   4. Sets up SSH key auth from Mac → VM (passwordless)
 *   5. Installs build deps inside VM (Xcode license, bun, node, Java 17, cocoapods, fastlane, eas-cli)
 *   6. Stops the VM — ready for builds
 */

import { execFileSync, spawn, spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import * as p from "@clack/prompts";

// Tool's own directory — reads .env from where setup-tart.ts lives
const TOOL_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SetupConfig {
  user: string;
  host: string;
  xcodeVersion: string;
  expoToken: string;
  tartBaseImage: string;
  javaVersion: string;
  androidPlatform: string;
  androidBuildTools: string;
  androidNdk: string;
}

function loadConfig(): SetupConfig {
  const envPath = resolve(TOOL_ROOT, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`.env not found at ${TOOL_ROOT}`);
  }
  const env = readFileSync(envPath, "utf-8");
  const get = (key: string): string => {
    const match = env.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1]?.trim() ?? "";
  };

  const user = get("REMOTE_BUILDER_USER");
  const host = get("REMOTE_BUILDER_HOST");
  if (!user || !host) {
    throw new Error("Missing REMOTE_BUILDER_USER or REMOTE_BUILDER_HOST in .env");
  }

  const xcodeVersion = get("TART_XCODE_VERSION") || "26.2";
  const tartBaseImage = get("TART_BASE_IMAGE") || "ghcr.io/cirruslabs/macos-sequoia-xcode";

  return {
    user,
    host,
    xcodeVersion,
    expoToken: get("EXPO_TOKEN") || "",
    tartBaseImage,
    javaVersion: get("JAVA_VERSION") || "17",
    androidPlatform: get("ANDROID_PLATFORM") || "android-36",
    androidBuildTools: get("ANDROID_BUILD_TOOLS") || "36.0.0",
    androidNdk: get("ANDROID_NDK") || "27.1.12297006",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a command in a login shell so Homebrew, bun, tart etc. are on PATH.
 * Non-interactive SSH doesn't source .zshrc/.zprofile — this forces it.
 */
function loginWrap(cmd: string): string {
  return `$SHELL -lc '${cmd.replace(/'/g, "'\\''")}'`;
}

/** Run a command silently on the Mac host, return stdout. */
function ssh(target: string, cmd: string, opts?: { allowFailure?: boolean }): string {
  try {
    return execFileSync("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      target,
      loginWrap(cmd),
    ], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    if (opts?.allowFailure) return "";
    const stderr = err.stderr?.toString().trim() ?? "";
    throw new Error(`SSH command failed: ${cmd}\n${stderr}`);
  }
}

/** Show a line with │ bar */
function showLine(text: string) {
  process.stdout.write(`\x1b[2K\r│  ${text}\n`);
}

/**
 * Run an SSH command asynchronously (spinner-friendly).
 * Optionally shows output lines matching `show` pattern with │ bars.
 */
async function sshAsync(
  target: string,
  cmd: string,
  opts?: { show?: RegExp },
): Promise<{ code: number; lastOutput: string[] }> {
  return new Promise((done) => {
    const child = spawn("ssh", [target, loginWrap(cmd)], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lastOutput: string[] = [];
    let buf = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        lastOutput.push(line);
        if (lastOutput.length > 30) lastOutput.shift();
        if (opts?.show?.test(line)) showLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        lastOutput.push(line);
        if (lastOutput.length > 30) lastOutput.shift();
      }
    });

    child.on("close", (code) => done({ code: code ?? 1, lastOutput }));
  });
}

/**
 * Run an interactive command that needs a TTY (e.g. sudo password prompt).
 * Only used for CLT update which may prompt for macOS password.
 */
function sshInteractive(target: string, cmd: string): number {
  const result = spawnSync("ssh", ["-tt", target, cmd], { stdio: "inherit" });
  return result.status ?? 1;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function main() {
  // When called from eas.ts as a subprocess, skip intro/outro framing
  const embedded = process.argv.includes("--embedded");
  if (!embedded) p.intro("Tart VM Setup");

  const config = loadConfig();
  const target = `${config.user}@${config.host}`;
  const image = `${config.tartBaseImage}:${config.xcodeVersion}`;

  // ── 1. Test SSH ──────────────────────────────────────────────────────────

  const s1 = p.spinner();
  s1.start(`Connecting to ${target}...`);
  try {
    ssh(target, "echo ok");
    s1.stop(`SSH OK (${target})`);
  } catch {
    s1.stop(`Cannot SSH to ${target}`);
    p.log.error(`Make sure you can run: ssh ${target}`);
    process.exit(1);
  }

  // ── 2. Check CLT + install Tart ─────────────────────────────────────────

  const s2 = p.spinner();
  s2.start("Checking Homebrew...");
  const brewDiag = ssh(target, "brew doctor 2>&1 | head -30", { allowFailure: true });
  if (brewDiag.includes("Command Line Tools") && (brewDiag.includes("outdated") || brewDiag.includes("too old"))) {
    s2.stop("Command Line Tools outdated");
    p.log.warn("Updating via softwareupdate (sudo password may be required on the Mac)...");
    const updateCmd = [
      "sudo rm -rf /Library/Developer/CommandLineTools",
      "sudo touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress",
      'LABEL=$(softwareupdate -l 2>&1 | grep -E "Label:.*Command Line" | sed "s/^.*Label: //" | head -1)',
      'echo "Installing: $LABEL"',
      'sudo softwareupdate -i "$LABEL" --verbose',
      "sudo rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress",
    ].join(" && ");
    const cltCode = sshInteractive(target, updateCmd);
    if (cltCode !== 0) {
      p.log.error("CLT update failed. SSH into the Mac and run: sudo xcode-select --install");
      process.exit(1);
    }
    p.log.success("Command Line Tools updated");
  } else {
    s2.stop("Homebrew OK");
  }

  const s2b = p.spinner();
  s2b.start("Checking Tart...");
  const hasTart = ssh(target, "command -v tart", { allowFailure: true });
  if (hasTart) {
    s2b.stop("Tart already installed");
  } else {
    s2b.message("Installing Tart...");
    const result = await sshAsync(target, "brew install cirruslabs/cli/tart", { show: /==>|Downloading|Installing/ });
    if (result.code !== 0) {
      s2b.stop("Failed to install Tart");
      for (const l of result.lastOutput.slice(-5)) showLine(l);
      p.log.error("SSH into the Mac and run: brew install cirruslabs/cli/tart");
      process.exit(1);
    }
    s2b.stop("Tart installed");
  }

  // ── 3. Pull/clone base image ────────────────────────────────────────────

  const s3 = p.spinner();
  s3.start("Checking eas-builder image...");
  const images = ssh(target, "tart list --quiet", { allowFailure: true });
  if (images.includes("eas-builder")) {
    s3.stop("eas-builder image already exists");
    const recreate = await p.confirm({
      message: "Recreate it? (pulls fresh Xcode image, ~25GB download)",
    });
    if (p.isCancel(recreate)) process.exit(0);
    if (recreate) {
      const sd = p.spinner();
      sd.start("Deleting existing eas-builder image...");
      ssh(target, "tart delete eas-builder", { allowFailure: true });
      sd.stop("Old image deleted");
    } else {
      p.outro("Setup complete (using existing image)");
      return;
    }
  } else {
    s3.stop("eas-builder image not found — will create");
  }

  const s3b = p.spinner();
  s3b.start(`Pulling Xcode image (~25GB): ${image}`);
  const pullResult = await sshAsync(target, `tart pull ${image}`, { show: /pulling|downloading|%/i });
  if (pullResult.code !== 0) {
    s3b.stop("Failed to pull image");
    for (const l of pullResult.lastOutput.slice(-5)) showLine(l);
    p.log.error(`Check the image name and network: ${image}`);
    process.exit(1);
  }
  s3b.stop("Image pulled");

  const s3c = p.spinner();
  s3c.start("Cloning image as eas-builder (~70GB disk copy)...");
  const cloneResult = await sshAsync(target, `tart clone ${image} eas-builder`);
  if (cloneResult.code !== 0) {
    s3c.stop("Failed to clone image");
    for (const l of cloneResult.lastOutput.slice(-5)) showLine(l);
    process.exit(1);
  }
  s3c.stop("eas-builder image created");

  // ── 4. Boot VM and get IP ───────────────────────────────────────────────

  const s4 = p.spinner();
  s4.start("Booting eas-builder VM...");
  ssh(target, "nohup tart run --no-graphics eas-builder > /dev/null 2>&1 &", { allowFailure: true });

  let vmIp = "";
  for (let i = 1; i <= 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    vmIp = ssh(target, "tart ip eas-builder", { allowFailure: true });
    if (vmIp) break;
    s4.message(`Booting VM... (${i * 3}s)`);
  }
  if (!vmIp) {
    s4.stop("VM failed to boot within 90 seconds");
    ssh(target, "tart stop eas-builder", { allowFailure: true });
    process.exit(1);
  }
  s4.stop(`VM booted (${vmIp})`);

  // ── 5. SSH key auth (Mac → VM) ─────────────────────────────────────────

  const s5 = p.spinner();
  s5.start("Setting up SSH key auth (Mac → VM)...");

  // Ensure Mac has an SSH key
  ssh(target, 'test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');

  // Install sshpass if needed (for copying key with default "admin" password)
  const hasSshpass = ssh(target, "command -v sshpass", { allowFailure: true });
  if (!hasSshpass) {
    s5.message("Installing sshpass...");
    await sshAsync(target, "brew install hudochenkov/sshpass/sshpass");
  }

  s5.message("Copying SSH key to VM...");
  ssh(target, `sshpass -p admin ssh-copy-id -o StrictHostKeyChecking=no admin@${vmIp}`, { allowFailure: true });

  // Verify
  const vmSshTest = ssh(target, `ssh -o BatchMode=yes -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no -o ConnectTimeout=10 admin@${vmIp} echo ok`, { allowFailure: true });
  if (vmSshTest !== "ok") {
    s5.stop("SSH key auth — could not verify (may need manual setup)");
    p.log.warn("Try: ssh admin@<vm-ip> from the Mac");
  } else {
    s5.stop("SSH key auth configured");
  }

  // ── 6. Install build deps inside VM ─────────────────────────────────────

  const vmSshOpts = `-o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519`;
  const vmPath = `export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"`;

  const vmRunAsync = (cmd: string, opts?: { show?: RegExp }) =>
    sshAsync(target, `ssh ${vmSshOpts} admin@${vmIp} '${vmPath} && ${cmd.replace(/'/g, "'\\''")}'`, opts);

  const vmSudoAsync = (cmd: string, opts?: { show?: RegExp }) =>
    sshAsync(target, `ssh ${vmSshOpts} admin@${vmIp} '${vmPath} && echo admin | sudo -S ${cmd.replace(/'/g, "'\\''")}'`, opts);

  const steps = [
    { label: "Accepting Xcode license", fn: () => vmSudoAsync("xcodebuild -license accept").then(() => vmSudoAsync("xcodebuild -runFirstLaunch")) },
    { label: "Installing bun", fn: () => vmRunAsync("curl -fsSL https://bun.sh/install | bash") },
    { label: "Installing Node.js", fn: () => vmRunAsync("brew install node", { show: /==>|Installing/ }) },
    { label: `Installing Java ${config.javaVersion} (for Android/Gradle)`, fn: () => vmRunAsync(`brew install openjdk@${config.javaVersion}`, { show: /==>|Installing/ }).then(() =>
      vmSudoAsync(`ln -sfn /opt/homebrew/opt/openjdk@${config.javaVersion}/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-${config.javaVersion}.jdk`)) },
    { label: "Installing Android SDK", fn: () =>
      vmRunAsync("brew install --cask android-commandlinetools", { show: /==>|Installing|Downloading/ }).then(() =>
      vmRunAsync([
        'export ANDROID_HOME="$HOME/Library/Android/sdk"',
        'mkdir -p "$ANDROID_HOME"',
        'SDKMANAGER="/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager"',
        `yes | $SDKMANAGER --sdk_root="$ANDROID_HOME" "platforms;${config.androidPlatform}" "build-tools;${config.androidBuildTools}" "platform-tools" "ndk;${config.androidNdk}"`,
      ].join(" && "), { show: /Installing|done|Warning/i }))
    },
    { label: "Installing CocoaPods + Fastlane", fn: () => vmRunAsync("brew install cocoapods fastlane", { show: /==>|Installing/ }) },
    { label: "Installing ccache (C/C++/ObjC compilation cache)", fn: () => vmRunAsync("brew install ccache", { show: /==>|Installing/ }) },
    { label: "Installing eas-cli + dotenv-cli", fn: () => vmRunAsync("$HOME/.bun/bin/bun install -g eas-cli dotenv-cli") },
    { label: "Cleaning up Homebrew cache", fn: () => vmRunAsync("brew cleanup --prune=all") },
  ];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const s = p.spinner();
    s.start(`${step.label}... [${i + 1}/${steps.length}]`);
    const result = await step.fn();
    if (result.code !== 0) {
      s.stop(`Failed: ${step.label}`);
      for (const l of result.lastOutput.slice(-5)) showLine(l);
      // Don't exit — try to continue with remaining steps
      p.log.warn("Continuing with remaining steps...");
    } else {
      s.stop(`${step.label} [${i + 1}/${steps.length}]`);
    }
  }

  // ── 7. Stop VM ──────────────────────────────────────────────────────────

  const s7 = p.spinner();
  s7.start("Stopping VM...");
  ssh(target, "tart stop eas-builder", { allowFailure: true });
  s7.stop("VM stopped — image is ready for builds");

  if (!embedded) p.outro("Setup complete. Run: bun eas build preview ios --remote");
}

main().catch((err) => {
  p.log.error(err.message);
  process.exit(1);
});
