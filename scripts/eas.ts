#!/usr/bin/env bun
/**
 * Unified EAS CLI — interactive prompts for build, submit, update, and run.
 *
 * A standalone build tool for Expo/React Native projects that supports:
 *   - EAS Cloud builds
 *   - Remote Mac builds via Tart VMs (ephemeral, clean macOS VMs)
 *   - Store submission
 *   - OTA updates
 *   - Local build + device install
 *
 * Usage:
 *   bun eas                                    # interactive mode
 *   bun eas build                              # cloud build (defaults: development, all)
 *   bun eas build preview android              # cloud build preview, Android only
 *   bun eas build preview ios --remote         # build in Tart VM on remote Mac
 *   bun eas submit preview                     # submit latest preview build to stores
 *   bun eas deploy production                  # cloud build + auto-submit production
 *   bun eas deploy production all --remote     # build in Tart VM + submit to stores
 *   bun eas update                             # OTA update (interactive)
 *   bun eas update preview "fix something"     # OTA update to preview channel
 *   bun eas run android                        # local build + install on device (macOS/Linux only)
 */

import { execFileSync, spawnSync, spawn } from "child_process";
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import * as p from "@clack/prompts";
import { resolve } from "path";
import ignore from "ignore";

// Tool's own directory (for .ssh-key/, plugins/, setup-tart.ts)
const TOOL_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
// Project being built (for .env, source files, logs) — when called from another
// project (e.g. `bun eas-builder/scripts/eas.ts`), cwd is the project root.
const PROJECT_ROOT = process.cwd();
const IS_WINDOWS = process.platform === "win32";

// Java version — shared between buildVmScript() PATH/JAVA_HOME and setup-tart.ts
const JAVA_VERSION = "17";

// Project config — loaded from .env
function loadProjectConfig(): { name: string; mobileDir: string } {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return { name: "app", mobileDir: PROJECT_ROOT };
  const env = readFileSync(envPath, "utf-8");
  const get = (key: string): string => {
    const match = env.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1]?.trim() ?? "";
  };
  const name = get("PROJECT_NAME") || "app";
  const mobileDirRel = get("PROJECT_MOBILE_DIR") || ".";
  return { name, mobileDir: resolve(PROJECT_ROOT, mobileDirRel) };
}

const PROJECT = loadProjectConfig();
const MOBILE_DIR = PROJECT.mobileDir;

type Command = "build" | "submit" | "deploy" | "update" | "run" | "back";
type Profile = "development" | "preview" | "production";
type Platform = "android" | "ios" | "all";
type BuildLocation = "eas" | "remote";

const COMMANDS = ["build", "submit", "deploy", "update", "run"] as const;
const PROFILES = ["development", "preview", "production"] as const;
const PLATFORMS = ["android", "ios", "all"] as const;

// =============================================================================
// Shell helpers
// =============================================================================

class CommandError extends Error {
  constructor(
    message: string,
    public readonly cmd?: string,
    public readonly exitCode?: number
  ) {
    super(message);
    this.name = "CommandError";
  }
}

function run(cmd: string, args: string[], opts?: { cwd?: string; allowFailure?: boolean }) {
  console.log(`\n$ ${cmd} ${args.join(" ")}\n`);
  try {
    execFileSync(cmd, args, { stdio: "inherit", cwd: opts?.cwd ?? MOBILE_DIR });
  } catch (err: any) {
    if (opts?.allowFailure) return;
    const exitCode = err.status ?? err.code ?? 1;
    throw new CommandError(
      `Command failed: ${cmd} ${args.join(" ")}`,
      cmd,
      exitCode
    );
  }
}

function eas(args: string[]) {
  run("bunx", ["eas", ...args]);
}

/**
 * Wrap a command in a login shell so Homebrew-installed tools (tart, etc.)
 * are on PATH. Non-interactive SSH doesn't source .zshrc/.zprofile.
 */
function loginWrap(cmd: string): string {
  return `$SHELL -lc '${cmd.replace(/'/g, "'\\''")}'`;
}

// =============================================================================
// Cross-platform path + SSH helpers
// =============================================================================

/**
 * Convert a local path to rsync-compatible format.
 * Windows: D:\foo\bar → /cygdrive/d/foo/bar (cwRsync needs cygwin paths)
 * macOS/Linux: returns path as-is
 */
function toRsyncPath(localPath: string): string {
  if (!IS_WINDOWS) return localPath;
  return localPath
    .replace(/\\/g, "/")
    .replace(/^([A-Z]):/i, (_, drive: string) => `/cygdrive/${drive.toLowerCase()}`);
}

/**
 * Locate cwRsync's bundled cygwin ssh.exe (Windows only).
 * Win32-OpenSSH is incompatible with rsync's binary protocol — we must use
 * the cygwin ssh that ships alongside cwRsync.
 */
function findCwrsyncSsh(): string {
  try {
    const rsyncPath = execFileSync("where.exe", ["rsync.exe"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n")[0].trim();
    // rsync.exe is a shim — resolve to the real cwRsync tools/bin/ directory
    // Chocolatey layout: lib/rsync/tools/bin/rsync.exe
    const chocoLib = resolve(rsyncPath, "..", "..", "lib", "rsync", "tools", "bin", "ssh.exe");
    if (existsSync(chocoLib)) return chocoLib;
    // Fallback: ssh.exe next to rsync.exe
    const sibling = resolve(rsyncPath, "..", "ssh.exe");
    if (existsSync(sibling)) return sibling;
  } catch {}
  throw new CommandError(
    "Could not find cwRsync's bundled ssh.exe.\n" +
    "Make sure rsync is installed via: choco install rsync"
  );
}

const SSH_KEY_DIR = resolve(TOOL_ROOT, ".ssh-key");
const SSH_KEY_FILE = resolve(SSH_KEY_DIR, "id");

/**
 * Validate SSH key exists and set correct permissions.
 * Windows: icacls to restrict to current user
 * macOS/Linux: chmod 600
 */
function ensureSshKeyPermissions(): void {
  if (!existsSync(SSH_KEY_FILE)) {
    throw new CommandError(
      `SSH key not found at .ssh-key/id\n` +
      "Place your SSH private key there for remote Mac builds.\n" +
      "See .ssh-key/README.md for instructions."
    );
  }

  // Normalize line endings — OpenSSH rejects CRLF keys with "error in libcrypto"
  const raw = readFileSync(SSH_KEY_FILE, "utf-8");
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const content = normalized.endsWith("\n") ? normalized : normalized + "\n";
  if (raw !== content) {
    if (IS_WINDOWS) {
      const user = process.env.USERNAME ?? process.env.USER ?? "CURRENT_USER";
      try { execFileSync("icacls", [SSH_KEY_FILE, "/grant", `${user}:F`], { stdio: "pipe" }); } catch {}
    }
    writeFileSync(SSH_KEY_FILE, content);
  }

  // Lock down permissions
  if (IS_WINDOWS) {
    const user = process.env.USERNAME ?? process.env.USER ?? "CURRENT_USER";
    try {
      execFileSync("icacls", [SSH_KEY_FILE, "/inheritance:r", "/grant:r", `${user}:R`], { stdio: "pipe" });
    } catch {}
  } else {
    try {
      execFileSync("chmod", ["600", SSH_KEY_FILE], { stdio: "pipe" });
    } catch {}
  }
}

/**
 * Build the rsync `-e` SSH command string.
 * Windows: uses cwRsync's bundled cygwin ssh with cygwin key path
 * macOS/Linux: uses system ssh with native key path
 */
function buildRsyncSshCmd(): string {
  if (IS_WINDOWS) {
    const cwSshPath = findCwrsyncSsh();
    const cygSsh = toRsyncPath(cwSshPath);
    const cygKeyPath = toRsyncPath(SSH_KEY_FILE);
    return `${cygSsh} -i ${cygKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
  }
  return `ssh -i ${SSH_KEY_FILE} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
}

// =============================================================================
// Remote builder config (loaded from root .env)
// =============================================================================

interface RemoteConfig {
  user: string;
  host: string;
  path: string;
  expoToken: string;
}

function loadRemoteConfig(): RemoteConfig {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) {
    throw new CommandError(
      ".env not found at project root. Cannot load remote builder config."
    );
  }
  const env = readFileSync(envPath, "utf-8");
  const get = (key: string): string => {
    const match = env.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1]?.trim() ?? "";
  };

  const user = get("REMOTE_BUILDER_USER");
  const host = get("REMOTE_BUILDER_HOST");
  const remotePath = get("REMOTE_BUILDER_PATH");
  const expoToken = get("EXPO_TOKEN");

  if (!user || !host || !remotePath) {
    throw new CommandError(
      "Missing REMOTE_BUILDER_USER, REMOTE_BUILDER_HOST, or REMOTE_BUILDER_PATH in .env"
    );
  }
  if (!expoToken) {
    throw new CommandError(
      "Missing EXPO_TOKEN in .env\n" +
      "Create one at: expo.dev → Account Settings → Access Tokens"
    );
  }

  return { user, host, path: remotePath, expoToken };
}

// =============================================================================
// Dependency checks (local only — VM deps are baked into the Tart image)
// =============================================================================

type Dep = { name: string; installHint: string };

function cmdExists(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function sshExists(): boolean {
  try {
    // OpenSSH uses -V (not --version)
    execFileSync("ssh", ["-V"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function checkLocalDeps(): Dep[] {
  const missing: Dep[] = [];
  if (!sshExists()) {
    const hint = IS_WINDOWS
      ? "Windows 10+ ships OpenSSH — enable in Settings > Apps > Optional Features"
      : "ssh should be pre-installed on macOS/Linux";
    missing.push({ name: "ssh", installHint: hint });
  }
  if (!cmdExists("rsync")) {
    const hint = IS_WINDOWS
      ? "choco install rsync"
      : process.platform === "darwin"
        ? "brew install rsync"
        : "sudo apt install rsync (or your distro's package manager)";
    missing.push({ name: "rsync", installHint: hint });
  }
  return missing;
}

async function ensureDeps(deps: Dep[], interactive: boolean): Promise<void> {
  if (deps.length === 0) return;

  const list = deps.map(d => `  • ${d.name}  →  ${d.installHint}`).join("\n");

  if (!interactive) {
    throw new CommandError(
      `Missing local dependencies:\n${list}\n\n` +
      "Install them manually."
    );
  }

  console.log(`\nMissing local dependencies:`);
  for (const d of deps) console.log(`  • ${d.name}`);

  const ok = await p.confirm({ message: `Install missing dependencies?` });
  if (p.isCancel(ok) || !ok) {
    throw new CommandError(`Install manually:\n${list}`);
  }

  for (const d of deps) {
    console.log(`\nInstalling ${d.name}...`);
    console.log(`  → ${d.installHint}`);
    if (IS_WINDOWS && d.installHint.startsWith("choco install")) {
      run("choco", ["install", d.name, "-y"]);
    } else if (process.platform === "darwin" && d.installHint.startsWith("brew install")) {
      run("brew", ["install", d.name]);
    } else {
      throw new CommandError(
        `Cannot auto-install ${d.name}. Install manually:\n  ${d.installHint}`
      );
    }
  }
}

/**
 * Walk the project tree and collect files for remote sync, respecting
 * .gitignore and .easignore using the `ignore` library.
 * Returns relative paths (forward-slash separated) suitable for rsync --files-from.
 */
function collectSyncFiles(): string[] {
  // Root-level ignore (applies to all paths)
  const rootIg = ignore().add([".git", ".temp", ".ssh-key"]);
  const rootGitignore = resolve(PROJECT_ROOT, ".gitignore");
  if (existsSync(rootGitignore)) rootIg.add(readFileSync(rootGitignore, "utf-8"));

  // Mobile-level ignore (applies only under mobile dir, if it's a subdirectory)
  const mobileRel = resolve(MOBILE_DIR).replace(resolve(PROJECT_ROOT), "").replace(/\\/g, "/").replace(/^\//, "");
  const mobileIg = ignore();
  if (mobileRel) {
    const mobileGitignore = resolve(MOBILE_DIR, ".gitignore");
    if (existsSync(mobileGitignore)) mobileIg.add(readFileSync(mobileGitignore, "utf-8"));
    const easIgnore = resolve(MOBILE_DIR, ".easignore");
    if (existsSync(easIgnore)) mobileIg.add(readFileSync(easIgnore, "utf-8"));
  }

  const files: string[] = [];

  function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const testPath = entry.isDirectory() ? `${entryRel}/` : entryRel;

      // Check root-level ignore
      if (rootIg.ignores(testPath)) continue;

      // Check mobile-level ignore for paths under mobile dir
      if (mobileRel && entryRel.startsWith(`${mobileRel}/`)) {
        const subRel = entry.isDirectory()
          ? entryRel.slice(mobileRel.length + 1) + "/"
          : entryRel.slice(mobileRel.length + 1);
        if (mobileIg.ignores(subRel)) continue;
      }

      if (entry.isDirectory()) {
        walk(resolve(dir, entry.name), entryRel);
      } else {
        files.push(entryRel);
      }
    }
  }

  walk(PROJECT_ROOT, "");
  return files;
}

// =============================================================================
// Tart VM build scripts
// =============================================================================

/**
 * Build the shell script that runs INSIDE the Tart VM.
 * Handles: env pull, dependency install, EAS local build, version increment.
 */
function buildVmScript(
  expoToken: string,
  profile: Profile,
  plat: "android" | "ios",
  submit: boolean,
  optimize: boolean,
): string {
  const projectName = PROJECT.name;
  const mobileRel = resolve(MOBILE_DIR).replace(resolve(PROJECT_ROOT), "").replace(/\\/g, "/").replace(/^\//, "");
  const cdPath = mobileRel ? `~/project/${mobileRel}` : "~/project";

  const ext = plat === "ios" ? "ipa" : "aab";
  const output = `build/output.${ext}`;
  const versionField = plat === "ios" ? "buildNumber" : "versionCode";

  // Phase markers (::phase::name) are parsed by the Node.js side to drive spinners.
  // All stdout/stderr is captured — only markers and key patterns are shown to the user.

  // Build optimizations — only when optimize flag is set
  const optimizeSetup: string[] = [];
  if (optimize) {
    // Activate the iOS config plugin (conditional in app.config.ts)
    optimizeSetup.push('export OPTIMIZE_BUILD=1');

    if (plat === "android") {
      optimizeSetup.push(
        "",
        "# Gradle tuning — dynamic memory, disable lint, limit workers",
        "mkdir -p ~/.gradle",
        'TOTAL_MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))',
        'JVM_MAX_GB=$(( TOTAL_MEM_GB > 4 ? TOTAL_MEM_GB - 2 : 2 ))',
        `cat > ~/.gradle/gradle.properties << GEOF`,
        "org.gradle.caching=true",
        "org.gradle.workers.max=2",
        "reactNativeArchitectures=arm64-v8a",
        'org.gradle.jvmargs=-Xmx${JVM_MAX_GB}g -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError',
        "GEOF",
        // Disable lintVital tasks — they OOM analyzing every RN dependency
        `cat > ~/.gradle/init.gradle << 'GEOF'`,
        "allprojects {",
        "    afterEvaluate {",
        "        tasks.matching { it.name.contains('lintVital') }.configureEach {",
        "            enabled = false",
        "        }",
        "    }",
        "}",
        "GEOF",
      );
    }
  }

  const lines: string[] = [
    "set -e",
    `export PATH="$HOME/.bun/bin:/opt/homebrew/opt/openjdk@${JAVA_VERSION}/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"`,
    `export JAVA_HOME="/opt/homebrew/opt/openjdk@${JAVA_VERSION}"`,
    'export ANDROID_HOME="$HOME/Library/Android/sdk"',
    `ln -sfn '/Volumes/My Shared Files/${projectName}' ~/project`,
    `cd ${cdPath}`,
    `export EXPO_TOKEN="${expoToken}"`,
    ...optimizeSetup,
    "",
    'echo "::phase::env-pull"',
    `eas env:pull --environment ${profile} --non-interactive`,
    "",
    'echo "::phase::install"',
    "bun install --frozen-lockfile",
    "",
    'echo "::phase::build"',
    "mkdir -p build",
    "[ ! -f .env.local ] && touch .env.local",
    `dotenv -e .env.local -- eas build --local --platform ${plat} --profile ${profile} --output ${output} --non-interactive 2>&1`,
    "",
    'echo "::phase::version"',
    `VERSION_JSON=$(eas build:version:get -p ${plat} --profile ${profile} --json --non-interactive 2>/dev/null || echo '{}')`,
    `CUR=$(echo "$VERSION_JSON" | bun -e "const d=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.${versionField}??0))")`,
    "NEXT=$((CUR + 1))",
    'echo "::version::$CUR → $NEXT"',
    `echo "$NEXT" | eas build:version:set -p ${plat} --profile ${profile} || echo "::error::Version increment failed"`,
  ];

  if (submit) {
    lines.push(
      "",
      'echo "::phase::submit"',
      `eas submit --platform ${plat} --profile ${profile} --path ${output} --non-interactive`,
    );
  }

  return lines.join("\n");
}

/**
 * Build the shell script that runs on the Mac HOST.
 * Orchestrates the full Tart VM lifecycle: clone → boot → build → cleanup.
 */
function buildMacHostScript(remotePath: string, vmScript: string, vmStateFile: string): string {
  const projectName = PROJECT.name;
  // Escape any literal VMEOF in the VM script to prevent heredoc breakage
  const safeVmScript = vmScript.replace(/^VMEOF$/gm, "VM_EOF_ESCAPED");

  return `set -e
eval "$($SHELL -lc 'echo export PATH="$PATH"')"
VM="build-$(date +%s)"
echo "$VM" > ${vmStateFile}

# Clean up any stale build VMs from previous interrupted runs
for STALE in $(tart list --quiet 2>/dev/null | grep '^build-'); do
  echo "::stale::$STALE"
  tart stop "$STALE" 2>/dev/null || true
  tart delete "$STALE" 2>/dev/null || true
done

echo "::phase::clone-vm"
tart clone eas-builder $VM

# Allocate most of the Mac's resources to the VM (keep 2 cores + 4GB for host)
TOTAL_CPU=$(sysctl -n hw.ncpu)
TOTAL_MEM_MB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
VM_CPU=$((TOTAL_CPU > 4 ? TOTAL_CPU - 2 : TOTAL_CPU))
VM_MEM_MB=$((TOTAL_MEM_MB > 8192 ? TOTAL_MEM_MB - 4096 : TOTAL_MEM_MB))
tart set $VM --cpu $VM_CPU --memory $VM_MEM_MB
echo "::vm-resources::$VM_CPU CPUs, $((VM_MEM_MB / 1024))GB RAM"

echo "::phase::boot-vm"
tart run --dir=${projectName}:${remotePath} --no-graphics $VM &
VM_PID=$!

VM_IP=""
for i in $(seq 1 30); do
  VM_IP=$(tart ip $VM 2>/dev/null) && [ -n "$VM_IP" ] && break
  echo "::boot-wait::$((i * 3))"
  sleep 3
done

if [ -z "$VM_IP" ]; then
  echo "::error::VM failed to boot within 90 seconds"
  kill $VM_PID 2>/dev/null || true
  tart delete $VM 2>/dev/null || true
  rm -f ${vmStateFile}
  exit 1
fi
echo "::vm-ip::$VM_IP"

cleanup() {
  local rc=$?
  echo ""
  [ $rc -ne 0 ] && echo "::error::Build failed (exit code $rc)"
  echo "::phase::cleanup"
  tart stop $VM 2>/dev/null || true
  tart delete $VM 2>/dev/null || true
  rm -f ${vmStateFile}
}
trap cleanup EXIT

ssh -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 -o ConnectTimeout=30 admin@$VM_IP bash -s <<'VMEOF'
${safeVmScript}
VMEOF
`;
}

// =============================================================================
// Remote build (Tart VM on Mac)
// =============================================================================

async function runRemoteBuild(profile: Profile, platform: Platform, interactive = false, submit = false, optimize = true) {
  const remote = loadRemoteConfig();
  const sshTarget = `${remote.user}@${remote.host}`;

  // --local requires one platform at a time
  const platforms: ("android" | "ios")[] =
    platform === "all" ? ["ios", "android"] : [platform as "android" | "ios"];

  const action = submit ? "Build + Submit" : "Build";
  const platLabel = platform === "all" ? "ios + android" : platform;
  p.log.step(`Remote ${action}: ${profile} / ${platLabel}`);

  // ── Step 1: Preflight ──────────────────────────────────────────────────

  const s1 = p.spinner();
  s1.start(`Connecting to ${sshTarget}...`);
  try {
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", sshTarget, "echo ok"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    s1.stop(`SSH OK (${sshTarget})`);
  } catch (err: any) {
    s1.stop("SSH connection failed");
    const stderr = err.stderr?.toString() ?? "";
    throw new CommandError(
      `SSH to ${sshTarget} failed.\n${stderr}\n` +
      "Make sure you can run: ssh " + sshTarget
    );
  }

  // Check Tart is installed and eas-builder image exists
  const s1b = p.spinner();
  s1b.start("Checking Tart VM image...");
  let needsSetup = false;
  try {
    execFileSync("ssh", [sshTarget, loginWrap("command -v tart")], { stdio: "pipe" });
    const images = execFileSync("ssh", [sshTarget, loginWrap("tart list --quiet")], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    if (!images.includes("eas-builder")) needsSetup = true;
  } catch {
    needsSetup = true;
  }

  if (needsSetup) {
    s1b.stop("Tart VM not set up");
    if (interactive) {
      const ok = await p.confirm({ message: "Run setup now?" });
      if (p.isCancel(ok) || !ok) {
        throw new CommandError("Tart VM setup required. Run manually: bun run scripts/setup-tart.ts");
      }
    }
    p.log.info("Running Tart VM setup...");
    const setupScript = resolve(TOOL_ROOT, "scripts", "setup-tart.ts");
    const setupResult = spawnSync("bun", ["run", setupScript, "--embedded"], {
      stdio: "inherit",
      cwd: PROJECT_ROOT,
    });
    if (setupResult.status !== 0) {
      throw new CommandError("Tart VM setup failed.", "bun", setupResult.status ?? 1);
    }
  } else {
    s1b.stop("Tart VM image ready");
  }

  // Check local deps (ssh, rsync)
  await ensureDeps(checkLocalDeps(), interactive);

  // Ensure remote directory exists
  execFileSync("ssh", [sshTarget, `mkdir -p ${remote.path}`], { stdio: "pipe" });

  // ── Step 2: Sync project to Mac host ───────────────────────────────────

  const s2 = p.spinner();
  s2.start("Collecting files for sync...");
  const syncFiles = collectSyncFiles();
  s2.stop(`${syncFiles.length} files to sync`);

  // Validate SSH key permissions and build rsync SSH command
  ensureSshKeyPermissions();
  const sshCmd = buildRsyncSshCmd();
  const rsyncSrc = toRsyncPath(PROJECT_ROOT) + "/";

  // Find Homebrew rsync on Mac (cwRsync requires GNU rsync as receiver)
  let remoteRsyncPath: string | undefined;
  try {
    const out = execFileSync("ssh", [sshTarget, "[ -x /opt/homebrew/bin/rsync ] && echo /opt/homebrew/bin/rsync"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (out) remoteRsyncPath = out;
  } catch {}

  const s2b = p.spinner();
  s2b.start("Syncing project to Mac...");
  const dest = `${sshTarget}:${remote.path}/`;

  const rsyncArgs = [
    "-rltz",
    "-e", sshCmd,
    ...(remoteRsyncPath ? ["--rsync-path", remoteRsyncPath] : []),
    "--files-from=-",
    rsyncSrc,
    dest,
  ];
  const rsyncResult = spawnSync("rsync", rsyncArgs, {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    input: syncFiles.join("\n") + "\n",
  });
  if (rsyncResult.status !== 0) {
    s2b.stop("rsync failed");
    const stderr = rsyncResult.stderr?.toString().trim() ?? "";
    if (stderr) p.log.error(stderr);
    throw new CommandError(
      `rsync failed with exit code ${rsyncResult.status}`,
      "rsync",
      rsyncResult.status ?? 1,
    );
  }

  // EAS requires a git repo — init one since .git was excluded from sync.
  execFileSync("ssh", [sshTarget, `cd ${remote.path} && git init && git add -A && (git diff --cached --quiet || git commit -m "deploy" --no-gpg-sign)`], { stdio: "pipe" });
  s2b.stop("Project synced to Mac");

  // ── Step 3: Build in Tart VM ───────────────────────────────────────────

  for (let i = 0; i < platforms.length; i++) {
    const plat = platforms[i];
    const n = platforms.length > 1 ? ` [${i + 1}/${platforms.length}]` : "";
    p.log.step(`${action}: ${plat} (${profile})${n}`);

    const vmScript = buildVmScript(remote.expoToken, profile, plat, submit, optimize);
    const ts = Date.now();
    const scriptPath = `/tmp/${PROJECT.name}-build-${ts}-${i}.sh`;
    const vmStateFile = `/tmp/${PROJECT.name}-vm-${ts}-${i}`;
    const macScript = buildMacHostScript(remote.path, vmScript, vmStateFile);

    // Write script to a temp file on the Mac, then execute it.
    // No PTY (-tt) — PTY puts the local terminal into raw mode which breaks
    // spinner rendering. Instead, Ctrl+C cleanup is handled by a separate SSH
    // that reads the VM name from a state file and stops/deletes it.
    spawnSync("ssh", [sshTarget, `cat > ${scriptPath} && chmod +x ${scriptPath}`], {
      stdio: ["pipe", "pipe", "pipe"],
      input: macScript,
    });

    // Phase labels for spinners — driven by ::phase:: markers in the scripts
    const phaseStart: Record<string, string> = {
      "clone-vm": "Cloning VM...",
      "boot-vm":  "Booting VM...",
      "env-pull": "Pulling credentials from EAS...",
      "install":  "Installing dependencies...",
      "build":    `Building ${plat} (${profile})...`,
      "version":  "Updating version...",
      "submit":   "Submitting to store...",
      "cleanup":  "Cleaning up VM...",
    };
    const phaseDone: Record<string, string> = {
      "clone-vm": "VM cloned",
      "boot-vm":  "VM booted",
      "env-pull": "Credentials ready",
      "install":  "Dependencies installed",
      "build":    `${plat} build complete`,
      "version":  "Version updated",
      "submit":   "Submitted to store",
      "cleanup":  "VM cleaned up",
    };

    // ── Local log file ──────────────────────────────────────────────────
    const logDir = resolve(PROJECT_ROOT, "logs");
    mkdirSync(logDir, { recursive: true });
    const logFile = resolve(logDir, `${plat}-${profile}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
    const log = (text: string) => appendFileSync(logFile, text + "\n");

    const exitCode = await new Promise<number>((done, fail) => {
      const child = spawn("ssh", [sshTarget, `bash ${scriptPath}; rm -f ${scriptPath}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let spinner: ReturnType<typeof p.spinner> | null = null;
      let currentPhase = "";
      let currentEasPhase = "";
      let hadOutput = false;
      let buildFailed = false;
      let prevLine = "";
      let dupCount = 0;
      const lastOutput: string[] = [];

      // Noise patterns to filter from display (still logged to file)
      const noisePattern = /^(\s+at\s)|^npm (warn|notice)\b/;

      // Patterns worth showing to the user during each phase.
      const showPatterns: Record<string, RegExp> = {
        "env-pull": /pulled|downloaded|secret/i,
        "install":  /installed|resolved|packages/i,
        "build":    /^\[([A-Z][A-Z_]+)\]/,
        "version":  /version|warning/i,
        "submit":   /submitted|upload|error/i,
      };

      function stopSpinner(ok: boolean) {
        if (!spinner || !currentPhase) return;
        flushDups();
        flushOutput();
        spinner.stop(ok
          ? phaseDone[currentPhase] ?? `${currentPhase} done`
          : `Failed during: ${phaseStart[currentPhase] ?? currentPhase}`);
        spinner = null;
      }

      function startPhase(name: string) {
        stopSpinner(true);
        currentPhase = name;
        currentEasPhase = "";
        spinner = p.spinner();
        spinner.start(phaseStart[name] ?? name);
      }

      /** Show a line with the │ bar, truncated to terminal width */
      function showLine(text: string) {
        const cols = process.stdout.columns || 80;
        const prefix = "│  ";
        const max = cols - prefix.length - 1;
        const display = text.length > max ? text.slice(0, max - 3) + "..." : text;
        process.stdout.write(`\x1b[2K\r${prefix}${display}\n`);
        hadOutput = true;
      }

      /** Print a │ separator after output lines, before spinner resumes */
      function flushOutput() {
        if (hadOutput) {
          process.stdout.write(`\x1b[2K\r│\n`);
          hadOutput = false;
        }
      }

      /** Flush duplicate line count */
      function flushDups() {
        if (dupCount > 0) {
          showLine(`  ...repeated ${dupCount} times`);
          dupCount = 0;
        }
      }

      /** Process a single line: log to file, filter noise, dedup, show */
      function processLine(line: string, isStderr = false) {
        log(line);

        // Structured markers — never filtered
        const pm = line.match(/^::phase::(.+)$/);
        if (pm) { startPhase(pm[1]); return; }

        const res = line.match(/^::vm-resources::(.+)$/);
        if (res) { showLine(`VM: ${res[1]}`); return; }

        const bw = line.match(/^::boot-wait::(\d+)$/);
        if (bw && spinner) { flushOutput(); spinner.message(`Booting VM... (${bw[1]}s)`); return; }

        const ip = line.match(/^::vm-ip::(.+)$/);
        if (ip && spinner) { flushOutput(); spinner.message(`VM booted (${ip[1]})`); return; }

        const ver = line.match(/^::version::(.+)$/);
        if (ver && spinner) { flushOutput(); spinner.message(`Version: ${ver[1]}`); return; }

        const stale = line.match(/^::stale::(.+)$/);
        if (stale) { showLine(`Cleaning up stale VM: ${stale[1]}`); return; }

        const err = line.match(/^::error::(.+)$/);
        if (err) {
          stopSpinner(false);
          buildFailed = true;
          p.log.error(err[1]);
          return;
        }

        // Accumulate for error context
        lastOutput.push(line);
        if (lastOutput.length > 50) lastOutput.shift();

        // Stderr always shown
        if (isStderr) { flushDups(); showLine(line); return; }

        // Filter noise
        if (noisePattern.test(line)) return;

        // Dedup consecutive identical lines
        if (line === prevLine) { dupCount++; return; }
        flushDups();
        prevLine = line;

        // Show relevant output with │ bar
        const pattern = showPatterns[currentPhase];
        if (pattern?.test(line)) {
          if (currentPhase === "build") {
            const easPhase = line.match(/^\[([A-Z][A-Z_]+)\]/);
            if (easPhase && spinner) {
              const label = easPhase[1].toLowerCase().replace(/_/g, " ");
              if (label !== currentEasPhase) {
                flushOutput();
                currentEasPhase = label;
                spinner.message(`Building ${plat}: ${label}`);
              }
            }
          }
          showLine(line);
        }
      }

      let buf = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.replace(/\r/g, "").trim();
          if (line) processLine(line);
        }
      });

      let stderrBuf = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const parts = stderrBuf.split("\n");
        stderrBuf = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.replace(/\r/g, "").trim();
          if (line) processLine(line, true);
        }
      });

      // Ctrl+C: clean up VM first, THEN kill SSH.
      // We must finish cleanup before the process exits, so we block on the
      // cleanup SSH and only kill the build SSH afterwards.
      let interrupted = false;
      const onSigInt = () => {
        if (interrupted) return; // ignore repeated Ctrl+C
        interrupted = true;
        stopSpinner(false);
        p.log.warn("Interrupted — cleaning up VM on Mac...");
        try {
          execFileSync("ssh", ["-o", "ConnectTimeout=10", sshTarget, loginWrap(
            `VM=$(cat ${vmStateFile} 2>/dev/null); ` +
            `[ -n "$VM" ] && tart stop "$VM" 2>/dev/null; ` +
            `[ -n "$VM" ] && tart delete "$VM" 2>/dev/null; ` +
            `rm -f ${vmStateFile} ${scriptPath}`
          )], { stdio: "pipe", timeout: 30000 });
          p.log.info("VM cleaned up");
        } catch {
          p.log.warn("Could not clean up VM — will be cleaned up on next build");
        }
        child.kill("SIGTERM");
      };
      process.on("SIGINT", onSigInt);

      child.on("close", (code) => {
        process.off("SIGINT", onSigInt);
        if (buildFailed) {
          // Error was already reported via ::error:: marker.
          // Cleanup phase ran successfully — stop its spinner as OK.
          stopSpinner(true);
          if (lastOutput.length > 0) {
            p.log.message("Last output:");
            for (const l of lastOutput.slice(-15)) process.stdout.write(`│  ${l}\n`);
            process.stdout.write(`│\n`);
          }
          p.log.info(`Full log: ${logFile}`);
        } else if (code !== 0) {
          // Unexpected failure — no ::error:: marker was emitted
          stopSpinner(false);
          if (lastOutput.length > 0) {
            p.log.message("Last output:");
            for (const l of lastOutput.slice(-15)) process.stdout.write(`│  ${l}\n`);
            process.stdout.write(`│\n`);
          }
          p.log.info(`Full log: ${logFile}`);
        } else {
          stopSpinner(true);
          p.log.info(`Log: ${logFile}`);
        }
        done(code ?? 1);
      });
      child.on("error", (err) => {
        process.off("SIGINT", onSigInt);
        fail(err);
      });
    });
    if (exitCode !== 0) {
      throw new CommandError(
        `Remote build failed (${plat}, ${profile})`,
        "ssh",
        exitCode,
      );
    }
    p.log.success(`${plat} ${action.toLowerCase()} complete`);
  }
}

async function runRemoteDeploy(profile: Profile, platform: Platform, interactive = false, optimize = true) {
  if (profile === "development") {
    throw new CommandError(
      "Cannot deploy development builds — they use internal distribution (APK) which stores reject.\n" +
      "Use 'preview' or 'production' profile instead."
    );
  }

  // Build + submit inside the Tart VM (submit=true)
  await runRemoteBuild(profile, platform, interactive, /* submit */ true, optimize);
}

// =============================================================================
// Commands
// =============================================================================

function runBuild(profile: Profile, platform: Platform) {
  eas(["build", "--platform", platform, "--profile", profile, "--non-interactive"]);
}

function runSubmit(profile: Profile, platform: Platform) {
  if (profile === "development") {
    throw new CommandError(
      "Cannot submit development builds — they use internal distribution (APK) which stores reject.\n" +
      "Use 'preview' or 'production' profile instead."
    );
  }
  eas(["submit", "--platform", platform, "--profile", profile, "--non-interactive", "--latest"]);
}

function runDeploy(profile: Profile, platform: Platform) {
  if (profile === "development") {
    throw new CommandError(
      "Cannot deploy development builds — they use internal distribution (APK) which stores reject.\n" +
      "Use 'preview' or 'production' profile instead, or use 'build' for dev builds."
    );
  }
  // --auto-submit ties the exact build to its submission (no --latest guessing)
  eas(["build", "--platform", platform, "--profile", profile, "--non-interactive", "--auto-submit"]);
}

function runUpdate(profile: Profile, message: string) {
  eas(["update", "--channel", profile, "--environment", profile, "--message", message, "--non-interactive"]);
}

function runLocal(platform: "android" | "ios") {
  const ext = platform === "android" ? "apk" : "ipa";
  const output = `build/${PROJECT.name}-dev.${ext}`;

  eas([
    "build",
    "--platform", platform,
    "--profile", "development",
    "--local",
    "--output", output,
  ]);

  if (platform === "android") {
    run("adb", ["install", output]);
  } else {
    // Auto-detect first wired iOS device and install
    let result: string;
    try {
      result = execFileSync("xcrun", [
        "devicectl", "list", "devices", "-j", "/dev/stdout",
      ], { encoding: "utf-8", stdio: ["pipe", "pipe", "inherit"] });
    } catch (err: any) {
      throw new CommandError(
        `Failed to list iOS devices: ${err.message}\n` +
        "Make sure Xcode is installed and xcrun is available."
      );
    }

    let devices: any[];
    try {
      devices = JSON.parse(result)?.result?.devices ?? [];
    } catch {
      throw new CommandError("Failed to parse device list from xcrun");
    }

    const wired = devices.find((d: any) => d?.connectionProperties?.transportType === "wired");
    if (!wired) {
      throw new CommandError(
        "No wired iOS device found. Connect a device via USB and try again."
      );
    }
    console.log(`\nInstalling on ${wired.deviceProperties?.name ?? wired.identifier}...`);
    run("xcrun", ["devicectl", "device", "install", "app", "--device", wired.identifier, output]);
  }
}

// =============================================================================
// Arg parsing
// =============================================================================

function parseArgs(): { command: Command; profile?: Profile; platform?: Platform; rest: string[] } | null {
  const args = process.argv.slice(2);
  if (args.length === 0) return null;

  const command = args[0] as Command;
  if (!COMMANDS.includes(command as any)) {
    throw new CommandError(
      `Unknown command: ${command}\nValid commands: ${COMMANDS.join(", ")}`
    );
  }

  let profile: Profile | undefined;
  let platform: Platform | undefined;
  const rest: string[] = [];

  for (const arg of args.slice(1)) {
    if (PROFILES.includes(arg as any)) profile = arg as Profile;
    else if (PLATFORMS.includes(arg as any)) platform = arg as Platform;
    else if (arg.startsWith("--")) rest.push(arg);
    else rest.push(arg);
  }

  return { command, profile, platform, rest };
}

// =============================================================================
// Interactive mode
// =============================================================================

async function selectBuildLocation(): Promise<BuildLocation | null> {
  const location = await p.select<BuildLocation>({
    message: "Where do you want to build?",
    options: [
      { value: "eas", label: "EAS Cloud", hint: "build on Expo's servers" },
      { value: "remote", label: "Remote Mac", hint: "build in Tart VM via SSH" },
    ],
  });
  if (p.isCancel(location)) return null;
  return location;
}

async function promptBuildFlow(): Promise<boolean> {
  p.log.step("Build");

  const location = await selectBuildLocation();
  if (location === null) return false;

  const profile = await p.select<Profile>({
    message: "Which build profile do you want to use?",
    options: [
      { value: "development", label: "Development", hint: "dev client for internal testing" },
      { value: "preview", label: "Preview", hint: "release build for beta testers" },
      { value: "production", label: "Production", hint: "store release" },
    ],
  });
  if (p.isCancel(profile)) return false;

  const platform = await p.select<Platform>({
    message: "Which platform do you want to build for?",
    options: [
      { value: "all", label: "Both", hint: "Android + iOS" },
      { value: "android", label: "Android" },
      { value: "ios", label: "iOS" },
    ],
  });
  if (p.isCancel(platform)) return false;

  const confirmed = await p.confirm({
    message: `Build ${profile} for ${platform === "all" ? "both platforms" : platform} on ${location === "eas" ? "EAS cloud" : "remote Mac"}?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return false;

  if (location === "eas") {
    runBuild(profile, platform);
  } else {
    const optimize = await p.confirm({
      message: "Optimize build? (limits memory, disables lint, skips dSYM)",
      initialValue: true,
    });
    if (p.isCancel(optimize)) return false;
    await runRemoteBuild(profile, platform, true, false, optimize);
  }
  return true;
}

async function promptSubmitFlow(): Promise<boolean> {
  p.log.step("Submit");

  const profile = await p.select<Profile>({
    message: "Which build profile do you want to submit?",
    options: [
      { value: "preview", label: "Preview", hint: "beta testers" },
      { value: "production", label: "Production", hint: "store release" },
    ],
  });
  if (p.isCancel(profile)) return false;

  const platform = await p.select<Platform>({
    message: "Which platform do you want to build for?",
    options: [
      { value: "all", label: "Both", hint: "Android + iOS" },
      { value: "android", label: "Android" },
      { value: "ios", label: "iOS" },
    ],
  });
  if (p.isCancel(platform)) return false;

  const confirmed = await p.confirm({
    message: `Submit latest ${profile} build for ${platform === "all" ? "both platforms" : platform} to stores?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return false;

  runSubmit(profile, platform);
  return true;
}

async function promptDeployFlow(): Promise<boolean> {
  p.log.step("Build + Submit");

  const location = await selectBuildLocation();
  if (location === null) return false;

  const profile = await p.select<Profile>({
    message: "Which build profile do you want to use?",
    options: [
      { value: "preview", label: "Preview", hint: "beta testers" },
      { value: "production", label: "Production", hint: "store release" },
    ],
  });
  if (p.isCancel(profile)) return false;

  const platform = await p.select<Platform>({
    message: "Which platform do you want to build and submit for?",
    options: [
      { value: "all", label: "Both", hint: "Android + iOS" },
      { value: "android", label: "Android" },
      { value: "ios", label: "iOS" },
    ],
  });
  if (p.isCancel(platform)) return false;

  const confirmed = await p.confirm({
    message: `Build + Submit ${profile} for ${platform === "all" ? "both platforms" : platform} on ${location === "eas" ? "EAS cloud" : "remote Mac"}?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return false;

  if (location === "eas") {
    runDeploy(profile, platform);
  } else {
    const optimize = await p.confirm({
      message: "Optimize build? (limits memory, disables lint, skips dSYM)",
      initialValue: true,
    });
    if (p.isCancel(optimize)) return false;
    await runRemoteDeploy(profile, platform, true, optimize);
  }
  return true;
}

async function promptUpdateFlow(): Promise<boolean> {
  p.log.step("OTA Update");

  const profile = await p.select<Profile>({
    message: "Which channel do you want to push the update to?",
    options: [
      { value: "production", label: "Production", hint: "live users" },
      { value: "preview", label: "Preview", hint: "beta testers" },
      { value: "development", label: "Development", hint: "dev builds" },
    ],
  });
  if (p.isCancel(profile)) return false;

  const message = await p.text({
    message: "What is the update message?",
    placeholder: "Short description of what changed",
    validate: (v) => !v || v.length === 0 ? "Message is required" : undefined,
  });
  if (p.isCancel(message)) return false;

  const confirmed = await p.confirm({ message: `Push OTA update to ${profile} channel?` });
  if (p.isCancel(confirmed) || !confirmed) return false;

  runUpdate(profile, message);
  return true;
}

async function promptRunFlow(): Promise<boolean> {
  p.log.step("Run");

  const platform = await p.select<"android" | "ios">({
    message: "Which platform do you want to run on?",
    options: [
      { value: "android", label: "Android", hint: "adb install" },
      { value: "ios", label: "iOS", hint: "xcrun devicectl (Mac only)" },
    ],
  });
  if (p.isCancel(platform)) return false;

  const confirmed = await p.confirm({
    message: `Local build + install on ${platform} device?`,
  });
  if (p.isCancel(confirmed) || !confirmed) return false;

  runLocal(platform);
  return true;
}

async function interactive() {
  p.intro(`${PROJECT.name} EAS`);

  while (true) {
    const command = await p.select<Command>({
      message: "What do you want to do?",
      options: [
        { value: "build", label: "Build", hint: "build on EAS cloud or remote Mac" },
        { value: "submit", label: "Submit", hint: "submit latest build to stores" },
        { value: "deploy", label: "Build + Submit", hint: "build then submit to stores" },
        { value: "update", label: "OTA Update", hint: "push JS bundle update (no native rebuild)" },
        { value: "run", label: "Run", hint: "local build + install on physical device (macOS/Linux)" },
        { value: "back", label: "Back", hint: "exit" },
      ],
    });

    if (p.isCancel(command) || command === "back") {
      p.cancel("Goodbye!");
      process.exit(0);
    }

    let completed = false;

    switch (command) {
      case "build":
        completed = await promptBuildFlow();
        break;
      case "submit":
        completed = await promptSubmitFlow();
        break;
      case "deploy":
        completed = await promptDeployFlow();
        break;
      case "update":
        completed = await promptUpdateFlow();
        break;
      case "run":
        completed = await promptRunFlow();
        break;
    }

    if (completed) {
      p.outro("Done!");
      process.exit(0);
    }
    // If not completed (user cancelled), loop back to main menu
    console.log("\n");
  }
}

// =============================================================================
// Error handling wrapper
// =============================================================================

function handleError(err: unknown): never {
  if (err instanceof CommandError) {
    console.error(`\n❌ ${err.message}`);
    if (err.exitCode) {
      process.exit(err.exitCode);
    }
  } else if (err instanceof Error) {
    console.error(`\n❌ Error: ${err.message}`);
  } else {
    console.error(`\n❌ An unknown error occurred`);
  }
  process.exit(1);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  try {
    await mainInner();
  } catch (err) {
    handleError(err);
  }
}

async function mainInner() {
  const parsed = parseArgs();

  if (!parsed) {
    await interactive();
    return;
  }

  const { command } = parsed;
  const remote = parsed.rest.includes("--remote");
  const optimize = !parsed.rest.includes("--no-optimize");

  if (command === "run") {
    const platform = parsed.platform as "android" | "ios" | undefined;
    if (!platform || platform === ("all" as any)) {
      throw new CommandError("Run requires a single platform: android or ios");
    }
    runLocal(platform);
  } else if (command === "build") {
    if (remote) {
      await runRemoteBuild(parsed.profile ?? "development", parsed.platform ?? "all", false, false, optimize);
    } else {
      runBuild(parsed.profile ?? "development", parsed.platform ?? "all");
    }
  } else if (command === "submit") {
    runSubmit(parsed.profile ?? "preview", parsed.platform ?? "all");
  } else if (command === "deploy") {
    if (remote) {
      await runRemoteDeploy(parsed.profile ?? "preview", parsed.platform ?? "all", false, optimize);
    } else {
      runDeploy(parsed.profile ?? "preview", parsed.platform ?? "all");
    }
  } else if (command === "update") {
    const message = parsed.rest.filter(r => !r.startsWith("--")).join(" ") || "Update";
    runUpdate(parsed.profile ?? "production", message);
  }
}

main();
