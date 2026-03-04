# expo-builder

Standalone build system for Expo/React Native projects. Builds iOS and Android apps in ephemeral Tart VMs on a remote Mac via SSH from any OS (Windows, macOS, or Linux).

## What This Is

A reusable CLI tool that wraps EAS CLI with:
- **Interactive prompts** — `bun eas` for guided build/submit/deploy/update flows
- **Remote Mac builds via Tart VMs** — ephemeral macOS VMs on Apple Silicon, no dependency drift
- **EAS Cloud builds** — standard cloud builds as fallback
- **Store submission** — submit builds to App Store / Play Store
- **OTA updates** — push JS bundle updates via EAS Update
- **Local build + install** — build and install on connected device

## TOOL_ROOT vs PROJECT_ROOT

The scripts distinguish between two root directories:

- **TOOL_ROOT** (`import.meta.url` → `scripts/..`) — where expo-builder itself lives. Used for tool-owned assets: `.ssh-key/id`, `scripts/setup-tart.ts`, `plugins/`, and `.env`.
- **PROJECT_ROOT** (from `.env` `PROJECT_ROOT`, resolved relative to TOOL_ROOT) — the project being built. Used for source files, `logs/`, `.gitignore`, rsync root.

**All config lives in `TOOL_ROOT/.env`** — project name, mobile dir, remote builder credentials, Expo token. This is true for both standalone and submodule usage.

**Standalone mode:** `PROJECT_ROOT=.` in `.env` → TOOL_ROOT == PROJECT_ROOT. Default behavior.

**Submodule mode:** `PROJECT_ROOT=..` in `.env` → PROJECT_ROOT is the parent project. The tool reads its own `.env` but builds the parent project's source tree.

## Architecture

```
Your machine (scripts/eas.ts)
  │
  ├─ rsync ──────────► Mac host ~/eas/<project>/
  │
  └─ ssh ────────────► Mac host
                         │
                         ├─ tart clone eas-builder build-<ts>
                         ├─ tart run --dir=<name>:<path> build-<ts>
                         ├─ ssh admin@<vm-ip> ──► Tart VM
                         │     ├─ eas env:pull (credentials from EAS)
                         │     ├─ eas build:version:get + increment
                         │     ├─ bun install && eas build --local
                         │     └─ (deploy: eas submit --path <artifact>)
                         ├─ tart stop build-<ts>
                         └─ tart delete build-<ts>
```

Each build gets a fresh clone of a pre-configured VM image. No state carries over between builds.

## Files

```
expo-builder/
├── CLAUDE.md                    # This file
├── LICENSE                      # MIT license
├── README.md                    # User-facing documentation
├── .env.example                 # Configuration template
├── .gitignore
├── package.json                 # Dependencies (@clack/prompts, ignore)
├── tsconfig.json                # TypeScript config (IDE support)
├── scripts/
│   ├── eas.ts                   # Main CLI — build, submit, deploy, update, run
│   └── setup-tart.ts            # One-time Tart VM setup on remote Mac
├── plugins/
│   └── withBuildOptimizations.js # Expo config plugin for iOS build optimizations
└── .ssh-key/
    ├── README.md                # SSH key setup instructions
    └── id                       # SSH private key (gitignored)
```

## Setup

### Prerequisites
- **Any OS** (Windows, macOS, or Linux) with Bun, SSH, and rsync
  - Windows: `choco install rsync` (cwRsync)
  - macOS: `brew install rsync` (or use built-in)
  - Linux: `sudo apt install rsync`
- **Remote Mac** (Apple Silicon) with SSH access and Homebrew
- **Expo account** with `EXPO_TOKEN`

### 1. Configure

Copy `.env.example` to `.env` and fill in:

```env
PROJECT_NAME=my-app              # Used for VM mount name, temp files, intro label
PROJECT_MOBILE_DIR=.             # Relative path to Expo project (default: project root)
REMOTE_BUILDER_USER=user         # SSH username for Mac
REMOTE_BUILDER_HOST=192.168.1.x  # SSH host for Mac
REMOTE_BUILDER_PATH=~/eas/my-app # Remote directory on Mac
EXPO_TOKEN=expo_xxx              # From expo.dev → Account Settings → Access Tokens
```

### 2. SSH Key

Place your SSH private key at `.ssh-key/id` and set permissions (`chmod 600` on macOS/Linux, `icacls` on Windows). See `.ssh-key/README.md`.

### 3. Setup Tart VM

```bash
bun run setup
```

This SSHes into the Mac and installs Tart, pulls a macOS+Xcode VM image, and installs build dependencies (bun, node, Java 17, Android SDK, CocoaPods, Fastlane, eas-cli).

### 4. Install Dependencies

```bash
bun install
```

## Usage

```bash
# Interactive mode
bun eas

# Non-interactive
bun eas build preview ios --remote        # Build in Tart VM
bun eas build preview android             # Build on EAS Cloud
bun eas deploy production all --remote    # Build in VM + submit to stores
bun eas submit preview                    # Submit latest build to stores
bun eas update preview "fix bug"          # OTA update
bun eas run android                       # Local build + install

# Flags
--remote        # Use Tart VM on remote Mac instead of EAS Cloud
--no-optimize   # Skip build optimizations (Gradle tuning, iOS dSYM skip)
```

## Integration with Your Expo Project

This tool is designed to live **alongside** your Expo project, or as a separate repo that syncs files to the Mac.

### If your project root IS the Expo project:
```env
PROJECT_MOBILE_DIR=.
```

### If your Expo project is in a subdirectory (e.g., `mobile/`):
```env
PROJECT_MOBILE_DIR=mobile
```

### iOS Build Optimizations Plugin

The iOS config plugin (`plugins/withBuildOptimizations.js`) is automatically copied from expo-builder to the project's `plugins/` directory on the Mac during remote builds when optimizations are enabled. No manual copy needed.

Your `app.config.ts` must conditionally include it:

```ts
plugins: [
  // ... your other plugins
  ...(process.env.OPTIMIZE_BUILD ? ["./plugins/withBuildOptimizations"] : []),
],
```

The plugin is activated automatically when `--no-optimize` is NOT passed. It:
- Disables Xcode index store (saves memory, IDE-only feature)
- Skips dSYM generation for non-production builds

Android optimizations (Gradle memory limits, lint disabling) are applied via `~/.gradle/` files inside the VM — no plugin needed.

## Key Concepts

### Tart VMs
- [Tart](https://tart.run/) runs macOS VMs on Apple Silicon via Apple's Virtualization.framework
- Each build clones a frozen `eas-builder` image → fresh environment every time
- VMs are ephemeral: cloned, used, deleted after each build
- Stale VMs from interrupted builds are cleaned up automatically

### Phase Markers Protocol
The shell scripts emit structured markers (`::phase::`, `::boot-wait::`, `::vm-ip::`, `::version::`, `::error::`, `::stale::`, `::vm-resources::`) that the Node.js side parses to drive `@clack/prompts` spinners.

### Version Management
- `appVersionSource` should be `"remote"` in `eas.json` — EAS manages build numbers server-side
- For `--remote` builds: version is fetched via `eas build:version:get`, incremented, and set via `eas build:version:set` after a successful build
- `eas build:version:set` only accepts piped input: `echo "$NEXT" | eas build:version:set`

### VM Resource Allocation
The Mac host script dynamically allocates CPU and memory to the VM:
- CPU: total cores - 2 (minimum: all cores if ≤ 4)
- Memory: total MB - 4096 (minimum: all memory if ≤ 8GB)

### Build Optimizations (opt-in via `--no-optimize` to disable)
- **Android**: Dynamic JVM memory (`RAM - 2GB`), `MaxMetaspaceSize=512m`, `workers.max=2`, disable `lintVital` tasks via init.gradle
- **iOS**: Disable Xcode index store, skip dSYM for non-production (via config plugin)

### Logs
All build output is saved to `logs/<platform>-<profile>-<timestamp>.log` for debugging. The console shows filtered, deduplicated output with `│` bar formatting.

## Coding Conventions

- **Runtime**: Bun (use `bun` / `bunx`, never `npm` / `npx`)
- **Language**: TypeScript
- **CLI UI**: `@clack/prompts` for spinners, selects, confirms
- **File sync**: `ignore` library for .gitignore/.easignore parsing
- **SSH**: system `ssh` for commands; rsync uses cwRsync's cygwin SSH on Windows, system `ssh` on macOS/Linux
