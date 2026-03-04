# expo-builder

Build Expo/React Native apps in ephemeral [Tart](https://tart.run/) VMs on a remote Mac — from any OS (Windows, macOS, or Linux), via SSH.

Every build gets a **fresh macOS VM clone** with Xcode and all dependencies pre-installed. No dependency drift, no stale caches, no Homebrew conflicts. When the build finishes, the VM is deleted.

Also supports EAS Cloud builds, store submission, OTA updates, and local device installs — all through one CLI.

## Why?

EAS Cloud builds cost credits and queue time. Running `eas build --local` on a bare-metal Mac works but accumulates state — Homebrew updates break Xcode's `exportArchive`, PATH conflicts between tools, and every dependency is a potential failure point.

Tart VMs solve this: each build starts from a frozen image. The VM boots in ~20s, runs the build, and gets deleted. If something breaks, clone a new image and rebuild — no debugging stale state.

## How It Works

```
Your machine                       Mac (Apple Silicon)
────────────                       ──────────────────
bun eas build --remote
  │
  ├─ rsync ──────────────────────► ~/eas/my-app/
  │  (project files)
  │
  └─ ssh ────────────────────────► bash script on Mac host
                                     │
                                     ├─ Clean up stale VMs
                                     ├─ tart clone eas-builder → build-<ts>
                                     ├─ Allocate CPU/RAM to VM
                                     ├─ tart run (boot VM, mount project)
                                     │
                                     └─ ssh admin@<vm-ip> ──► inside Tart VM
                                          │
                                          ├─ eas env:pull (credentials)
                                          ├─ bun install
                                          ├─ eas build --local
                                          ├─ eas build:version:set (increment)
                                          └─ eas submit (if deploying)
                                     │
                                     ├─ tart stop → tart delete
                                     └─ (VM gone, no state left)
```

## Prerequisites

### On Your Machine (Windows, macOS, or Linux)
- [Bun](https://bun.sh/) — runtime
- SSH client:
  - **Windows**: ships with Windows 10+ (Settings → Apps → Optional Features → OpenSSH Client)
  - **macOS / Linux**: pre-installed
- rsync:
  - **Windows**: `choco install rsync` (installs cwRsync)
  - **macOS**: `brew install rsync` (or use the built-in rsync)
  - **Linux**: `sudo apt install rsync` (or your distro's package manager)

### On the Remote Mac
- Apple Silicon (M1/M2/M3/M4) — required for Tart's Virtualization.framework
- [Homebrew](https://brew.sh/) — the setup script installs everything else
- SSH access — your Windows machine must be able to `ssh user@mac`

### Expo
- An [Expo](https://expo.dev/) account
- An access token — create at expo.dev → Account Settings → Access Tokens
- Your project should use EAS Build (i.e., have an `eas.json`)

## Quick Start

### 1. Install dependencies

```bash
cd expo-builder
bun install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Your project name (used for VM mount, temp files, CLI label)
PROJECT_NAME=my-app

# Path to the project root, relative to this directory
# Use "." if this IS the project, or ".." if used as a submodule
PROJECT_ROOT=.

# Path to the Expo project, relative to PROJECT_ROOT
# Use "." if the project root IS the Expo project, or "mobile" for a subdirectory
PROJECT_MOBILE_DIR=.

# SSH credentials for the Mac
REMOTE_BUILDER_USER=john
REMOTE_BUILDER_HOST=192.168.1.50
REMOTE_BUILDER_PATH=~/eas/my-app

# Expo access token
EXPO_TOKEN=expo_xxxxxxxxxxxxx
```

### 3. Set up SSH key for rsync

rsync needs a key file (it can't use the SSH agent on all platforms).

```bash
# Copy your private key
cp ~/.ssh/id_ed25519 .ssh-key/id
```

Lock down permissions:

```bash
# Windows (cwRsync rejects keys that are too open)
icacls .ssh-key\id /inheritance:r /grant:r "%USERNAME%:R"

# macOS / Linux
chmod 600 .ssh-key/id
```

The key must match an entry in `~/.ssh/authorized_keys` on the Mac.

### 4. Set up the Tart VM

```bash
bun run setup
```

This connects to your Mac via SSH and:
1. Installs [Tart](https://tart.run/) via Homebrew
2. Pulls a macOS + Xcode VM image (~25GB download)
3. Clones it as `eas-builder` (~70GB disk)
4. Boots the VM, sets up passwordless SSH (Mac → VM)
5. Installs build tools inside the VM:
   - Xcode license + first launch
   - Bun, Node.js, Java 17
   - Android SDK (cmdline-tools, platform 36, build-tools, NDK)
   - CocoaPods, Fastlane
   - eas-cli, dotenv-cli
6. Stops the VM — image is ready

This takes 30–60 minutes (mostly downloading). You only need to do it once.

### 5. Build

```bash
# Interactive — walks you through every option
bun eas

# Or go direct
bun eas build preview ios --remote
```

## Usage

### Interactive Mode

```bash
bun eas
```

Presents a menu: Build, Submit, Build + Submit, OTA Update, Run. Each option walks you through profile, platform, and build location selection.

### Non-Interactive (CI-friendly)

```bash
# Build
bun eas build preview ios --remote         # iOS in Tart VM
bun eas build preview android --remote     # Android in Tart VM
bun eas build preview all --remote         # Both (sequential)
bun eas build preview ios                  # iOS on EAS Cloud

# Build + Submit to stores
bun eas deploy production ios --remote
bun eas deploy production all --remote

# Submit latest existing build
bun eas submit preview

# OTA update (JS-only, no native rebuild)
bun eas update preview "bug fixes"

# Local build + install on device (macOS/Linux only)
bun eas run android
bun eas run ios
```

### Flags

| Flag | Description |
|------|-------------|
| `--remote` | Build in Tart VM on your Mac instead of EAS Cloud |
| `--no-optimize` | Skip build optimizations (useful for debugging build issues) |

## Build Optimizations

Enabled by default for remote builds. Disable with `--no-optimize`.

### Android
Applied via `~/.gradle/` files inside the VM (no project changes needed):
- **JVM memory**: dynamically set to `(VM RAM - 2GB)` with `MaxMetaspaceSize=512m`
- **Workers**: limited to 2 (prevents OOM on constrained VMs)
- **Architecture**: `arm64-v8a` only (no x86 emulator builds)
- **Lint**: `lintVital` tasks disabled via `init.gradle` (they OOM on large RN projects)

### iOS
Applied via an Expo config plugin (`plugins/withBuildOptimizations.js`):
- **Index store disabled**: `COMPILER_INDEX_STORE_ENABLE=NO` (IDE-only feature)
- **dSYM skipped**: `DEBUG_INFORMATION_FORMAT=dwarf` for non-production (faster, less memory)

Fully automatic — no changes needed in your `app.config.ts`. During remote builds, the plugin is copied to the project's `plugins/` directory and injected into the config via a build-time wrapper.

## Version Management

Set `appVersionSource` to `"remote"` in your `eas.json` so EAS manages `versionCode` (Android) and `buildNumber` (iOS) server-side.

For remote builds, the script:
1. Runs the build with `eas build --local`
2. Fetches the current version with `eas build:version:get`
3. Increments it and sets it with `eas build:version:set`

This is necessary because `--local` doesn't auto-increment like cloud builds do.

## VM Lifecycle

Each remote build follows this lifecycle:

1. **Clone** — `tart clone eas-builder build-<timestamp>` (~30s)
2. **Configure** — allocate CPU (cores - 2) and memory (RAM - 4GB) to the VM
3. **Boot** — `tart run` with project directory mounted (~20s)
4. **Build** — SSH into VM, pull credentials, install deps, run EAS build
5. **Cleanup** — `tart stop` + `tart delete` (VM is gone)

If a build is interrupted (Ctrl+C), the cleanup runs automatically. If the process is killed, stale VMs are cleaned up at the start of the next build.

## Logs

All build output (unfiltered) is saved to:

```
logs/<platform>-<profile>-<timestamp>.log
```

The terminal shows filtered, deduplicated output with progress spinners. Check the log file for full details when debugging.

## Project Structure

```
expo-builder/
├── scripts/
│   ├── eas.ts                   # Main CLI entry point
│   └── setup-tart.ts            # One-time VM setup
├── plugins/
│   └── withBuildOptimizations.js # iOS Xcode config plugin (optional)
├── .ssh-key/
│   ├── id                       # Your SSH private key (gitignored)
│   └── README.md
├── .env                         # Your config (gitignored)
├── .env.example                 # Config template
├── .gitignore
├── package.json
├── tsconfig.json                # TypeScript config (IDE support)
├── LICENSE                      # MIT license
├── CLAUDE.md                    # AI assistant context
└── README.md                    # This file
```

## Integrating Into an Existing Project

### Option A: Git submodule (recommended)

Add expo-builder as a submodule — no file duplication, updates via `git pull`:

```bash
cd your-project
git submodule add https://github.com/defy-works/expo-builder.git eas-builder
```

Add to your `package.json`:
```json
{
  "scripts": {
    "eas": "bun run eas-builder/scripts/eas.ts"
  }
}
```

Create `eas-builder/.env` (all config lives in the submodule directory):
```env
PROJECT_NAME=my-app
PROJECT_ROOT=..              # points to the parent project
PROJECT_MOBILE_DIR=mobile    # relative to PROJECT_ROOT
REMOTE_BUILDER_USER=...
REMOTE_BUILDER_HOST=...
REMOTE_BUILDER_PATH=~/eas/my-app
EXPO_TOKEN=...
```

The script reads `.env`, `.ssh-key/`, and `plugins/` from its own directory (TOOL_ROOT). Source files, logs, and `.gitignore` come from PROJECT_ROOT (the parent project).

### Option B: Copy files

Copy the scripts into your project directly:

1. Copy `scripts/eas.ts`, `scripts/setup-tart.ts`, `plugins/withBuildOptimizations.js`
2. Copy `.ssh-key/README.md` and create `.ssh-key/` directory
3. Add to your `package.json`:
   ```json
   {
     "scripts": {
       "eas": "bun run scripts/eas.ts",
       "setup": "bun run scripts/setup-tart.ts"
     },
     "devDependencies": {
       "@clack/prompts": "^1.0.1",
       "ignore": "^7.0.5"
     }
   }
   ```
4. Add to your `.gitignore`:
   ```
   .ssh-key/*
   !.ssh-key/README.md
   logs/
   ```
5. Add the env vars from `.env.example` to your `.env`
6. Set `PROJECT_MOBILE_DIR` to match your project structure

## Troubleshooting

### "Could not find cwRsync's bundled ssh.exe" (Windows only)
Install rsync: `choco install rsync`. The script needs cwRsync's cygwin SSH (Win32-OpenSSH is incompatible with rsync's binary protocol).

### "SSH key not found at .ssh-key/id"
Copy your private key: `cp ~/.ssh/id_ed25519 .ssh-key/id` and set permissions:
- **Windows**: `icacls .ssh-key\id /inheritance:r /grant:r "%USERNAME%:R"`
- **macOS / Linux**: `chmod 600 .ssh-key/id`

### "Permission denied (publickey)" on rsync (macOS/Linux)
Check that `.ssh-key/id` has `600` permissions: `ls -la .ssh-key/id` should show `-rw-------`. Fix with `chmod 600 .ssh-key/id`.

### "VM failed to boot within 90 seconds"
The Mac may not have enough resources. Check that no other VMs are running: `ssh user@mac "tart list"`.

### "Tart VM not set up"
Run `bun run setup` first. This creates the `eas-builder` base image on the Mac.

### Gradle OOM during Android build
This is why optimizations are on by default. If you're still hitting OOM, your Mac may not have enough RAM. The script allocates `(total RAM - 4GB)` to the VM. 8GB minimum recommended, 16GB+ preferred.

### Build works on EAS Cloud but fails remotely
Check `logs/` for the full output. Common causes:
- Missing environment variables — make sure `eas env:pull` has the right secrets
- Different Xcode version — set `TART_XCODE_VERSION` in `.env` to match your EAS cloud image
- Missing native dependencies — rebuild the VM image with `bun run setup`

## License

MIT
