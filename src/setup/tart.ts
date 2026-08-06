import * as p from "@clack/prompts";
import { spawn } from "child_process";
import { BuildError } from "../errors";
import { ssh, sshTargetString, loginWrap, type SshTarget } from "../remote/ssh";
import { planImageEviction, type ImageEntry } from "../remote/storage";

export interface ProvisionOptions {
  target: SshTarget;
  imageName: string;
  /** OCI reference, e.g. ghcr.io/cirruslabs/macos-sequoia-xcode:26.6 */
  source: string;
  keepImages: number;
  yes: boolean;
}

export interface ToolVersions {
  xcode: string;
  node: string;
  jdk: string;
}

/**
 * Ephemeral VMs recycle IPs on the same subnet, so the Mac accumulates a host
 * key per VM and eventually hits a collision. StrictHostKeyChecking=no does
 * NOT bypass a *changed* key — only an unknown one — so known_hosts must be
 * discarded entirely for VM-directed SSH.
 */
export const VM_SSH_OPTS =
  "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR";

/**
 * expo-builder only ever produces device and store archives, never runs a
 * simulator, so simulator runtimes and non-iOS platforms are dead weight.
 * iPhoneOS.platform is required for device builds and is never touched.
 */
export function slimCommands(): string[] {
  return [
    "# Remove simulator runtimes — we build device/store archives only",
    "xcrun simctl delete all 2>/dev/null || true",
    "xcrun simctl runtime delete all 2>/dev/null || true",
    "sudo rm -rf /Library/Developer/CoreSimulator/Profiles/Runtimes/* 2>/dev/null || true",
    "rm -rf ~/Library/Developer/CoreSimulator/Devices/* 2>/dev/null || true",
    "rm -rf ~/Library/Developer/CoreSimulator/Caches/* 2>/dev/null || true",
    "",
    "# Remove non-iOS platform support",
    "sudo rm -rf /Applications/Xcode.app/Contents/Developer/Platforms/AppleTVOS.platform 2>/dev/null || true",
    "sudo rm -rf /Applications/Xcode.app/Contents/Developer/Platforms/AppleTVSimulator.platform 2>/dev/null || true",
    "sudo rm -rf /Applications/Xcode.app/Contents/Developer/Platforms/WatchOS.platform 2>/dev/null || true",
    "sudo rm -rf /Applications/Xcode.app/Contents/Developer/Platforms/WatchSimulator.platform 2>/dev/null || true",
    "sudo rm -rf /Applications/Xcode.app/Contents/Developer/Platforms/XROS.platform 2>/dev/null || true",
    "sudo rm -rf /Applications/Xcode.app/Contents/Developer/Platforms/XRSimulator.platform 2>/dev/null || true",
    "",
    "# Drop caches that regenerate on demand",
    "rm -rf ~/Library/Developer/Xcode/DerivedData/* 2>/dev/null || true",
    "rm -rf ~/Library/Developer/Xcode/iOS\\ DeviceSupport/* 2>/dev/null || true",
    "brew cleanup --prune=all 2>/dev/null || true",
  ];
}

export interface ProvisionStepConfig {
  javaVersion: string;
  androidPlatform: string;
  androidBuildTools: string;
  androidNdk: string;
}

export interface ProvisionStep {
  label: string;
  command: string;
  sudo?: boolean;
}

export function provisionSteps(cfg: ProvisionStepConfig): ProvisionStep[] {
  return [
    {
      label: "Accepting the Xcode license",
      command: "xcodebuild -license accept && xcodebuild -runFirstLaunch",
      sudo: true,
    },
    { label: "Installing bun", command: "curl -fsSL https://bun.sh/install | bash" },
    { label: "Installing Node.js", command: "brew install node" },
    {
      label: `Installing Java ${cfg.javaVersion}`,
      command: `brew install openjdk@${cfg.javaVersion}`,
    },
    {
      label: "Linking Java",
      command: `ln -sfn /opt/homebrew/opt/openjdk@${cfg.javaVersion}/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk-${cfg.javaVersion}.jdk`,
      sudo: true,
    },
    {
      label: "Installing the Android SDK",
      command: [
        "brew install --cask android-commandlinetools",
        'export ANDROID_HOME="$HOME/Library/Android/sdk"',
        'mkdir -p "$ANDROID_HOME"',
        'SDKMANAGER="/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager"',
        `yes | $SDKMANAGER --sdk_root="$ANDROID_HOME" "platforms;${cfg.androidPlatform}" "build-tools;${cfg.androidBuildTools}" "platform-tools" "ndk;${cfg.androidNdk}"`,
      ].join(" && "),
    },
    // ccache is required by the iOS build cache path: the plugin points CC/CXX
    // at wrapper scripts around it, and DerivedData cannot be cached because
    // EAS copies the project to a fresh temp dir each build.
    { label: "Installing CocoaPods, Fastlane and ccache", command: "brew install cocoapods fastlane ccache" },
    { label: "Installing eas-cli and dotenv-cli", command: "$HOME/.bun/bin/bun install -g eas-cli dotenv-cli" },
  ];
}

export function parseVersions(probe: string): ToolVersions {
  const get = (key: string): string => {
    const match = probe.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1]?.trim().replace(/^v/, "") ?? "";
  };
  return { xcode: get("XCODE"), node: get("NODE"), jdk: get("JDK") };
}

export const VERSION_PROBE = [
  `echo "XCODE=$(xcodebuild -version | head -1 | awk '{print $2}')"`,
  `echo "NODE=$(node --version 2>/dev/null)"`,
  `echo "JDK=$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9.]+)".*/\\1/')"`,
].join("; ");

async function sshStream(target: SshTarget, cmd: string): Promise<{ code: number; tail: string[]; out: string }> {
  return new Promise((done) => {
    const child = spawn("ssh", [sshTargetString(target), loginWrap(cmd)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const tail: string[] = [];
    let out = "";
    const collect = (chunk: Buffer) => {
      out += chunk.toString();
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        tail.push(trimmed);
        if (tail.length > 30) tail.shift();
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("close", (code) => done({ code: code ?? 1, tail, out }));
  });
}

export async function provisionImage(opts: ProvisionOptions): Promise<number> {
  const { target, imageName, source, keepImages, yes } = opts;

  p.intro(`Provisioning ${imageName} from ${source}`);

  const existing = ssh(target, "tart list --quiet 2>/dev/null || true", { allowFailure: true });
  if (existing.split("\n").some((l) => l.trim() === imageName)) {
    if (!yes) {
      const ok = await p.confirm({
        message: `Image "${imageName}" exists. Replace it? The pulled base is cached, so this needs no re-download.`,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Cancelled");
        return 0;
      }
    }
    // Stop first: tart refuses to delete a running VM, and a failed delete
    // here would surface later as a confusing "already exists" clone error.
    ssh(target, `tart stop -t 30 ${imageName} 2>/dev/null || true`, { allowFailure: true });
    ssh(target, `tart delete ${imageName}`, { allowFailure: true });
    if (ssh(target, "tart list --quiet 2>/dev/null || true", { allowFailure: true })
      .split("\n").some((l) => l.trim() === imageName)) {
      throw new BuildError(
        `Could not remove the existing image "${imageName}".`,
        `Stop and delete it manually on the Mac:\n  tart stop ${imageName}; tart delete ${imageName}`,
      );
    }
  }

  const pull = p.spinner();
  pull.start(`Pulling ${source} (~62 GB on first run, cached afterwards)...`);
  const pulled = await sshStream(target, `tart pull ${source}`);
  if (pulled.code !== 0) {
    pull.stop("Pull failed");
    throw new BuildError(`Failed to pull ${source}`, pulled.tail.slice(-5).join("\n"));
  }
  pull.stop("Base image ready");

  const clone = p.spinner();
  clone.start("Cloning base image (APFS copy-on-write, near-instant)...");
  const cloned = await sshStream(target, `tart clone ${source} ${imageName}`);
  if (cloned.code !== 0) {
    clone.stop("Clone failed");
    throw new BuildError(`Failed to clone ${source}`, cloned.tail.slice(-5).join("\n"));
  }
  clone.stop("Image cloned");

  const boot = p.spinner();
  boot.start("Booting the image...");
  ssh(target, `nohup tart run --no-graphics ${imageName} > /dev/null 2>&1 &`, { allowFailure: true });

  let vmIp = "";
  for (let i = 1; i <= 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    vmIp = ssh(target, `tart ip ${imageName}`, { allowFailure: true });
    if (vmIp) break;
    boot.message(`Booting the image... (${i * 3}s)`);
  }
  if (!vmIp) {
    boot.stop("Image failed to boot");
    ssh(target, `tart stop ${imageName}`, { allowFailure: true });
    throw new BuildError("The VM did not boot within 90 seconds.");
  }
  boot.stop(`Booted (${vmIp})`);

  const key = p.spinner();
  key.start("Configuring SSH key auth (Mac → VM)...");
  ssh(target, 'test -f ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519');
  if (!ssh(target, "command -v sshpass", { allowFailure: true })) {
    await sshStream(target, "brew install hudochenkov/sshpass/sshpass");
  }
  ssh(target, `sshpass -p admin ssh-copy-id ${VM_SSH_OPTS} admin@${vmIp}`, { allowFailure: true });
  const verified = ssh(
    target,
    `ssh -o BatchMode=yes -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 ${VM_SSH_OPTS} -o ConnectTimeout=10 admin@${vmIp} echo ok`,
    { allowFailure: true },
  );
  if (verified !== "ok") {
    key.stop("SSH key auth failed");
    throw new BuildError(
      "Could not establish passwordless SSH from the Mac into the VM.",
      `Try manually from the Mac: ssh admin@${vmIp}  (password: admin)`,
    );
  }
  key.stop("SSH key auth configured");

  const vmSsh = `ssh ${VM_SSH_OPTS} -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 admin@${vmIp}`;
  const vmPath = 'export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';
  const inVm = (cmd: string, sudo = false) => {
    const body = sudo ? `echo admin | sudo -S ${cmd}` : cmd;
    return `${vmSsh} '${vmPath} && ${body.replace(/'/g, "'\\''")}'`;
  };

  const steps = provisionSteps({
    javaVersion: "17",
    androidPlatform: "android-36",
    androidBuildTools: "36.0.0",
    androidNdk: "27.1.12297006",
  });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const s = p.spinner();
    s.start(`${step.label}... [${i + 1}/${steps.length}]`);
    const result = await sshStream(target, inVm(step.command, step.sudo));
    if (result.code !== 0) {
      s.stop(`Failed: ${step.label}`);
      // Fatal by design: the old script warned and continued, which silently
      // produced broken images that only failed much later, mid-build.
      throw new BuildError(
        `Provisioning failed at: ${step.label}`,
        result.tail.slice(-10).join("\n"),
      );
    }
    s.stop(`${step.label} [${i + 1}/${steps.length}]`);
  }

  const slim = p.spinner();
  slim.start("Slimming the image...");
  const sizeCmd = `du -sk "\${TART_HOME:-$HOME/.tart}/vms/${imageName}" | cut -f1`;
  const beforeKb = parseInt(ssh(target, sizeCmd, { allowFailure: true }), 10) || 0;
  await sshStream(target, inVm(slimCommands().join("\n"), false));
  const afterKb = parseInt(ssh(target, sizeCmd, { allowFailure: true }), 10) || 0;
  const savedGb = Math.max(0, (beforeKb - afterKb) / 1024 / 1024);
  slim.stop(`Image slimmed (${savedGb.toFixed(1)} GB reclaimed)`);

  const probe = p.spinner();
  probe.start("Recording installed versions...");
  const probeResult = await sshStream(target, inVm(VERSION_PROBE));
  const versions = parseVersions(probeResult.out);
  const record = JSON.stringify({
    repo: source.slice(0, source.lastIndexOf(":")),
    tag: source.slice(source.lastIndexOf(":") + 1),
    ...versions,
    slimmedGb: Number(savedGb.toFixed(1)),
    provisionedAt: new Date().toISOString(),
  });
  ssh(target, `mkdir -p $HOME/.expo-builder && cat > $HOME/.expo-builder/image.json << 'JSONEOF'\n${record}\nJSONEOF`);
  probe.stop(`Xcode ${versions.xcode}, Node ${versions.node}, JDK ${versions.jdk}`);

  ssh(target, `tart stop ${imageName}`, { allowFailure: true });

  const listRaw = ssh(target, "tart list --format json 2>/dev/null || echo '[]'", { allowFailure: true });
  try {
    const entries = (JSON.parse(listRaw) as { Name: string; Source: string }[])
      .filter((v) => v.Source === "local" && v.Name.startsWith("expo-builder-xcode-"))
      .map<ImageEntry>((v, idx) => ({ name: v.Name, accessed: idx }));
    for (const name of planImageEviction(entries, keepImages)) {
      ssh(target, `tart delete ${name}`, { allowFailure: true });
      p.log.info(`Evicted old image: ${name}`);
    }
  } catch { /* eviction is best-effort */ }

  p.outro("Image ready. Run: expo-builder build preview ios --remote");
  return 0;
}
