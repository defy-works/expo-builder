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
- SSH access — your machine must be able to `ssh user@mac`

### Expo
- An [Expo](https://expo.dev/) account
- An access token — create at expo.dev → Account Settings → Access Tokens
- Your project should use EAS Build (i.e., have an `eas.json`)

## Setup

### 1. Add to your project

```bash
git submodule add https://github.com/defy-works/expo-builder.git eas-builder
```

Add a script to your `package.json`:
```json
{
  "scripts": {
    "eas": "bun run eas-builder/scripts/eas.ts"
  }
}
```

### 2. Configure

```bash
cp eas-builder/.env.example eas-builder/.env
```

Edit `eas-builder/.env`:

```env
PROJECT_NAME=my-app

# Path to your project root, relative to this directory
PROJECT_ROOT=..

# Path to the Expo project, relative to PROJECT_ROOT
# Use "." if the project root IS the Expo project
PROJECT_MOBILE_DIR=mobile

# SSH credentials for the Mac
REMOTE_BUILDER_USER=john
REMOTE_BUILDER_HOST=192.168.1.50
REMOTE_BUILDER_PATH=~/eas/my-app

# Expo access token
EXPO_TOKEN=expo_xxxxxxxxxxxxx
```

### 3. SSH key

rsync needs a key file (it can't use the SSH agent on all platforms). Copy your private key — permissions are set automatically before each build.

```bash
cp ~/.ssh/id_ed25519 eas-builder/.ssh-key/id
```

The key must match an entry in `~/.ssh/authorized_keys` on the Mac.

### 4. Build

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
eas-builder/                       # submodule in your project
├── scripts/
│   ├── eas.ts                     # Main CLI entry point
│   └── setup-tart.ts              # One-time VM setup
├── plugins/
│   └── withBuildOptimizations.js   # iOS Xcode config plugin (auto-injected)
├── .ssh-key/
│   ├── id                         # Your SSH private key (gitignored)
│   └── README.md
├── .env                           # Your config (gitignored)
├── .env.example                   # Config template
├── package.json                   # Dependencies (@clack/prompts, ignore)
├── CLAUDE.md                      # AI assistant context
└── README.md                      # This file
```

## Manual Installation

If you prefer not to use a submodule, you can copy the files directly into your project:

1. Copy `scripts/eas.ts`, `scripts/setup-tart.ts`
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
6. Set `PROJECT_ROOT=.` and `PROJECT_MOBILE_DIR` to match your project structure

## Troubleshooting

### "Could not find cwRsync's bundled ssh.exe" (Windows only)
Install rsync: `choco install rsync`. The script needs cwRsync's cygwin SSH (Win32-OpenSSH is incompatible with rsync's binary protocol).

### "SSH key not found at .ssh-key/id"
Copy your private key: `cp ~/.ssh/id_ed25519 eas-builder/.ssh-key/id`. Permissions are set automatically.

### "Permission denied (publickey)" on rsync
The key at `eas-builder/.ssh-key/id` must match an entry in `~/.ssh/authorized_keys` on the Mac. Verify with `ssh -i eas-builder/.ssh-key/id user@mac echo ok`.

### "VM failed to boot within 90 seconds"
The Mac may not have enough resources. Check that no other VMs are running: `ssh user@mac "tart list"`.

### "Tart VM not set up"
Run `bun eas build --remote` — it will prompt to run setup automatically. Or run `bun run eas-builder/scripts/setup-tart.ts` directly.

### Gradle OOM during Android build
This is why optimizations are on by default. If you're still hitting OOM, your Mac may not have enough RAM. The script allocates `(total RAM - 4GB)` to the VM. 8GB minimum recommended, 16GB+ preferred.

### Build works on EAS Cloud but fails remotely
Check `logs/` for the full output. Common causes:
- Missing environment variables — make sure `eas env:pull` has the right secrets
- Different Xcode version — set `TART_XCODE_VERSION` in `.env` to match your EAS cloud image
- Missing native dependencies — rebuild the VM image with `bun run eas-builder/scripts/setup-tart.ts`

## License

MIT
