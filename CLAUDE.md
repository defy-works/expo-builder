# expo-builder

Build system for Expo/React Native projects. Builds iOS and Android apps in ephemeral Tart VMs on a remote Mac via SSH from any OS (Windows, macOS, or Linux).

Installed as a git submodule (`eas-builder/`) inside the host project. Can also be copied manually (see README "Manual Installation").

## What This Is

A reusable CLI tool that wraps EAS CLI with:
- **Interactive prompts** — `bun eas` for guided build/submit/deploy/update flows
- **Remote Mac builds via Tart VMs** — ephemeral macOS VMs on Apple Silicon, no dependency drift
- **EAS Cloud builds** — standard cloud builds as fallback
- **Store submission** — submit builds to App Store / Play Store
- **OTA updates** — push JS bundle updates via EAS Update
- **Local build + install** — build and install on connected device

## TOOL_ROOT vs PROJECT_ROOT

- **TOOL_ROOT** (`import.meta.url` → `scripts/..`) — where expo-builder itself lives. Used for: `.ssh-key/id`, `scripts/setup-tart.ts`, `plugins/`, and `.env`.
- **PROJECT_ROOT** (`.env` → `PROJECT_ROOT`, resolved relative to TOOL_ROOT) — the project being built. Used for: source files, `logs/`, `.gitignore`, rsync root.

All config lives in `TOOL_ROOT/.env`. `PROJECT_ROOT` is a relative path in that `.env` — typically `..` (submodule pointing to parent) or `.` (manual install where tool IS the project).

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
eas-builder/                         # submodule in host project
├── CLAUDE.md                        # This file
├── README.md                        # User-facing documentation
├── .env.example                     # Configuration template
├── .env                             # Config (gitignored)
├── .gitignore
├── package.json                     # Dependencies (@clack/prompts, ignore)
├── tsconfig.json                    # TypeScript config (IDE support)
├── LICENSE                          # MIT license
├── scripts/
│   ├── eas.ts                       # Main CLI — build, submit, deploy, update, run
│   └── setup-tart.ts                # One-time Tart VM setup on remote Mac
├── plugins/
│   └── withBuildOptimizations.js     # iOS config plugin (auto-injected at build time)
└── .ssh-key/
    ├── README.md                    # SSH key setup instructions
    └── id                           # SSH private key (gitignored)
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

Copy `.env.example` to `.env` and fill in. Key fields:

| Field | Description | Example |
|-------|-------------|---------|
| `PROJECT_NAME` | VM mount name, temp file prefix, CLI label | `my-app` |
| `PROJECT_ROOT` | Path to host project, relative to this dir | `..` |
| `PROJECT_MOBILE_DIR` | Expo project path, relative to PROJECT_ROOT | `mobile` or `.` |
| `REMOTE_BUILDER_USER` | SSH username for Mac | `john` |
| `REMOTE_BUILDER_HOST` | SSH host for Mac | `192.168.1.50` |
| `REMOTE_BUILDER_PATH` | Working directory on Mac | `~/eas/my-app` |
| `EXPO_TOKEN` | EAS CLI auth token | `expo_xxx` |

### 2. SSH Key

Place your SSH private key at `.ssh-key/id`. Permissions are set automatically before each build.

### 3. Install Dependencies

```bash
cd eas-builder && bun install
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

## iOS Build Optimizations Plugin

Fully automatic — no changes needed in the project's `app.config.ts`.

When optimizations are enabled (the default, disable with `--no-optimize`):
1. The plugin file (`plugins/withBuildOptimizations.js`) is copied to the project's `plugins/` dir on the Mac
2. `app.config.ts` is wrapped with a thin module that imports the original config and appends the plugin

The plugin:
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
- For `--remote` builds: version is fetched via `eas build:version:get`, incremented, and set via `scripts/set-version.ts` after a successful build
- `set-version.ts` calls the Expo GraphQL API (`api.expo.dev/graphql`) directly using the `createAppVersion` mutation — this is what `eas build:version:set` does under the hood, but without requiring an interactive TTY
- The script is copied to the Mac host before the VM starts and accessed via VirtioFS mount

### VM Resource Allocation
The Mac host script dynamically allocates CPU and memory to the VM:
- CPU: total cores - 2 (minimum: all cores if ≤ 4)
- Memory: total MB - 4096 (minimum: all memory if ≤ 8GB)

### Persistent Build Cache
When the build profile in `eas.json` has a `cache.key` (e.g., `"v6"`), dependency caches persist across builds at `REMOTE_BUILDER_PATH-cache/<key>/` on the Mac host (a sibling directory to the project, e.g., `~/eas/buddy-cache/v6/`). The cache is mounted as a separate VirtioFS volume (`build-cache`) and symlinked to `~/build-cache` inside the VM. This keeps cache files outside the project's git working tree, avoiding EAS filename casing checks on macOS.

What's cached:
- **Bun** — `~/.bun/install/cache` (package downloads)
- **Gradle** — `~/.gradle/caches` (downloaded deps, build cache) + `~/.gradle/wrapper` (Gradle distributions)
- **CocoaPods** — `~/Library/Caches/CocoaPods`

- **ccache** — `~/.ccache` (compiled C/C++/ObjC object files for iOS builds)

All caches use symlinks to VirtioFS — zero setup time, writes persist immediately. Our `bun install` uses `--backend=copyfile` to bypass macOS `clonefile()` which fails across VirtioFS boundaries.

DerivedData is NOT cached — EAS copies the project to a random temp dir each build, changing the DerivedData subdir hash. ccache is used instead: it caches compiled C/C++/ObjC objects by content hash (path-independent), so cache hits work across different temp dirs. Requires `brew install ccache` in the VM image (added to `setup-tart.ts`). The `withBuildOptimizations` plugin sets `CC`/`CXX` to ccache wrapper scripts on all Xcode targets (app + pods via Podfile post_install injection).

Cache invalidation: bump `cache.key` in `eas.json` (e.g., `"v6"` → `"v7"`). Old keys are cleaned up automatically on the next build.

Skip with `--no-cache` flag. If no `cache.key` exists in `eas.json`, builds run without caching (no change from previous behavior).

### Build Optimizations (opt-in via `--no-optimize` to disable)
- **Android**: Dynamic JVM memory (`RAM - 2GB`), `MaxMetaspaceSize=512m`, `workers.max=2`, disable `lintVital` tasks via init.gradle
- **iOS**: Disable Xcode index store, skip dSYM for non-production (via config plugin, auto-injected)

### Logs
All build output is saved to `logs/<platform>-<profile>-<timestamp>.log` for debugging. The console shows filtered, deduplicated output with `│` bar formatting.

## Coding Conventions

- **Runtime**: Bun (use `bun` / `bunx`, never `npm` / `npx`)
- **Language**: TypeScript
- **CLI UI**: `@clack/prompts` for spinners, selects, confirms
- **File sync**: `ignore` library for .gitignore/.easignore parsing
- **SSH**: system `ssh` for commands; rsync uses cwRsync's cygwin SSH on Windows, system `ssh` on macOS/Linux
