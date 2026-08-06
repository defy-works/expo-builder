# expo-builder

Build Expo/React Native apps in ephemeral [Tart](https://tart.run/) VMs on a remote Mac — from any OS (Windows, macOS, or Linux), over SSH.

Every build gets a **fresh macOS VM clone** with Xcode and all dependencies pre-installed. No dependency drift, no stale caches, no Homebrew conflicts. When the build finishes, the VM is deleted.

Also supports EAS Cloud builds, store submission, OTA updates, and local device installs — through one CLI.

## Install

**From git** (no npm publish required — recommended for private use):

```bash
bun add -d github:defy-works/expo-builder
```

The `prepare` script builds `dist/` on install, so this needs Bun on the installing machine.

**From a local checkout** (for developing expo-builder itself):

```bash
cd /path/to/expo-builder && bun link
cd /path/to/your-project  && bun link expo-builder
```

**From npm**:

```bash
bun add -d @defy-works/expo-builder     # or: bun add -g @defy-works/expo-builder
bunx expo-builder --help    # npx also works
```

The published package is bundled for Node and has **zero runtime dependencies**, so `bunx`/`npx` starts without an install step.

## Quick start

```bash
bunx expo-builder init      # writes expo-builder.json, verifies SSH to your Mac
bunx expo-builder doctor    # checks the Mac, the VM image, and SDK compatibility
bunx expo-builder vm rebuild # provisions the VM image (first run only)

bunx expo-builder build preview ios --remote
```

## Configuration

`expo-builder.json` at your project root. The minimum is one line:

```json
{ "mac": "user@your-mac" }
```

Everything else is auto-detected: the Expo project directory, the app slug, the project root, and the remote paths on the Mac.

Full form:

```json
{
  "$schema": "https://unpkg.com/@defy-works/expo-builder/schema.json",
  "mac": {
    "host": "your-mac",
    "user": "you",
    "sshKey": "~/.ssh/id_ed25519",
    "tartHome": "/Volumes/BuildSSD/.tart"
  },
  "mobileDir": "mobile",
  "syncPaths": ["shared"],
  "vm": { "xcode": "auto", "name": "expo-builder", "keepImages": "auto" },
  "cache": { "enabled": true, "budgetGB": 15 }
}
```

| Field | Default | Meaning |
|---|---|---|
| `mac` | required | `"user@host"` or an object |
| `mac.sshKey` | auto | Probes `~/.ssh/id_ed25519`, `id_rsa`, `id_ecdsa` |
| `mac.tartHome` | `~/.tart` | Relocate VM storage. **Must be APFS** — see [Storage](#storage-on-the-mac) |
| `mobileDir` | auto | Detected from `eas.json` + `app.json`/`app.config.*` |
| `syncPaths` | `[]` | Extra directories to sync beyond the mobile dir and its workspace deps |
| `vm.xcode` | `"auto"` | `"auto"`, `"latest"`, or an exact version |
| `vm.keepImages` | `"auto"` | Derived from free disk; 1 below 150 GB free, up to 3 above |
| `cache.budgetGB` | `15` | Shared dependency cache ceiling on the Mac |

**`EXPO_TOKEN` never goes in this file.** It is read from the environment, then `.env` at the project root or mobile dir, then `~/.expo-builder/env`.

## Commands

| Command | Description |
|---|---|
| `build [profile] [platform]` | Build on EAS Cloud, or in a Tart VM with `--remote` |
| `submit [profile] [platform]` | Submit an existing build to the stores |
| `deploy [profile] [platform]` | Build then submit |
| `update [profile] -m <msg>` | OTA update, no native rebuild |
| `run <android\|ios>` | Local build + install on a connected device |
| `init` | Scaffold config, verify SSH |
| `doctor` | Check the Mac, image, SDK compatibility, and disk |
| `clean` | Report and reclaim disk on the Mac |
| `vm <list\|rebuild\|delete\|migrate>` | Manage the Tart image |
| `logs [--last]` | Show build logs |

Profiles are `development`, `preview`, `production`. Platforms are `android`, `ios`, `all`.

Key flags: `--remote`, `--cloud`, `--no-optimize`, `--no-cache`, `--dry-run`, `--json`, `--yes`, `--xcode <v>`, `--project <path>`, `--ssh-key <path>`.

## How image selection works

`vm.xcode` defaults to `"auto"`, which targets **the Xcode that EAS Cloud uses for your Expo SDK** — not the newest available.

That distinction matters. Expo documents that [SDKs support Xcode only *up to* a specific version](https://github.com/expo/fyi/blob/main/expo-sdk-xcode-compatibility.md), and a newer one may fail. SDK 54, for example, has a floor of Xcode 16.1 but EAS builds it on 26.0 — so "newest wins" would be wrong.

Resolution reads your SDK from `package.json`, lists available tags from both `macos-tahoe-xcode` and `macos-sequoia-xcode` on ghcr (anonymously, no credentials), discards pre-releases, and picks the newest tag within `[floor, EAS default]`.

`doctor` tells you when a rebuild is warranted. Tag data is cached in `~/.expo-builder/compat.json` with a 24-hour TTL, so builds never block on the network; `doctor --refresh` forces a refresh.

## Storage on the Mac

A provisioned image plus its share of the retained base costs roughly **92 GB per Xcode version**. Budget about 25 GB more for a build in flight and up to 15 GB for the shared cache.

- **The Tart OCI cache is retained, not pruned.** `tart clone` uses APFS `clonefile(2)`, so the pulled base and the local image share disk extents — pruning the cache typically frees only a few GB while costing a ~62 GB re-download on the next rebuild. `clean --deep` prunes it explicitly when you genuinely need the space.
- **Image slimming.** Provisioning removes simulator runtimes and non-iOS platforms, since this tool only ever produces device and store archives.
- **Preflight.** Before each remote build, free space is checked; the safe parts of `clean` run automatically if short, and the build is refused with a breakdown rather than dying halfway through.
- **The synced directory only ever holds source.** Builds run on the VM's own disk, and artifacts land in `~/.expo-builder/artifacts/<slug>/`.

### External volumes

Set `mac.tartHome` to move storage off the internal disk. Two hard requirements:

1. **APFS.** `clonefile(2)` is APFS-only. On exFAT or HFS+ every `tart clone` becomes a full ~80 GB byte copy. This is rejected outright.
2. **Ownership enabled.** External volumes ignore ownership by default, which makes Tart fail with permission errors. Fix with `sudo diskutil enableOwnership /Volumes/<name>`.

An **SSD** is strongly recommended — VM builds are random-I/O heavy and a spinning disk will be markedly slower. A 1 TB NVMe over USB 3.2 Gen 2 comfortably holds three images.

```bash
expo-builder vm migrate --to /Volumes/BuildSSD/.tart
```

## Build optimizations

On by default. `--no-optimize` disables all of them; `--no-ccache` disables only ccache.

**Android** — `~/.gradle` config inside the VM: dynamic JVM heap (`RAM − 2 GB`), `MaxMetaspaceSize=512m`, `workers.max=2`, `arm64-v8a` only, and `lintVital` disabled (it OOMs on large RN projects).

**iOS** — an Expo config plugin injected into your `plugins` array at build time: `COMPILER_INDEX_STORE_ENABLE=NO`, `DEBUG_INFORMATION_FORMAT=dwarf` for non-production, and `CC`/`CXX` pointed at ccache wrappers. No change to your `app.config.ts` is needed, and the injection is discarded with the VM.

**ccache** caches compiled C/C++/ObjC objects by content hash. That matters because EAS copies the project to a fresh temp directory on every build, which changes the DerivedData path — so DerivedData cannot usefully be cached, but ccache can.

## Caching

The shared cache lives at `~/.expo-builder/cache` on the Mac and is mounted into the VM, with `~/.bun/install/cache`, `~/.gradle/caches`, `~/Library/Caches/CocoaPods` and `~/.ccache` symlinked into it.

`bun install` runs with `--backend=copyfile` whenever the cache is mounted: bun defaults to `clonefile` on macOS, which fails across a VirtioFS boundary.

## Version management

Set `appVersionSource` to `"remote"` in `eas.json`. For remote builds the tool reads the current version with `eas build:version:get`, increments it, and sets it after a successful build — `--local` does not auto-increment the way cloud builds do.

Setting it goes through the Expo GraphQL `createAppVersion` mutation rather than `eas build:version:set`, which is interactive-only on EAS CLI v18+ (no `--version`, no `--non-interactive`). Scripting the CLI command leaves a nasty failure: the build compiles, the version silently never gets set, and the next build reuses the same number.

## Migrating from the submodule

```bash
git rm -r eas-builder
bun add -d expo-builder
bunx expo-builder init
bunx expo-builder vm rebuild
```

`init` replaces `.env`, and the `.ssh-key/id` copy is no longer needed — your existing `~/.ssh` key is used. The legacy Tart image is detected by `doctor`; renaming it is free thanks to APFS cloning:

```bash
tart clone eas-builder expo-builder && tart delete eas-builder
```

`clean` offers to remove the old `~/eas/<name>` sync directories.

## Requirements

- **Your machine**: SSH and rsync. Windows needs cwRsync (`choco install rsync`) — Win32-OpenSSH is incompatible with rsync's binary protocol. Bun or Node 20+.
- **The Mac**: Apple Silicon, Homebrew, SSH access. Everything else is installed by `vm rebuild`.
- **Expo**: an account, an access token, and `eas.json` in your project.

## Troubleshooting

**"Could not find cwRsync's bundled ssh.exe"** — `choco install rsync`.

**"Permission denied (publickey)"** — the key must match an entry in `~/.ssh/authorized_keys` on the Mac. Check with `ssh user@mac echo ok`.

**"VM failed to boot within 90 seconds"** — check that no other VM is running: `expo-builder vm list`.

**Gradle OOM** — optimizations are on by default; if it still OOMs the Mac likely lacks RAM. 16 GB+ recommended.

**Build works on EAS Cloud but fails remotely** — run `expo-builder doctor`; an Xcode mismatch against your SDK is the usual cause. Check `logs/` for full output.

## License

MIT
