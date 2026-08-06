# expo-builder redesign — design

**Date:** 2026-08-06
**Status:** Approved for planning

## Problem

`expo-builder` builds Expo/React Native apps in ephemeral Tart VMs on a remote Mac. Six problems block it:

1. iOS builds fail on Expo SDK 57.
2. The name `eas-builder` persists throughout the code, docs, remote paths, and the Tart image name.
3. It installs as a git submodule, which makes adoption awkward.
4. Configuration requires seven fields plus a manually copied SSH key.
5. The CLI has no argument parser, no `--help`, and silently ignores unknown flags.
6. Disk on the build Mac fills up.

## Diagnosis

All findings below were confirmed by read-only inspection of the build Mac (`mingu@defymac`, macOS 26.6, Apple Silicon, Tart 2.31.0) on 2026-08-06.

### SDK 57 (confirmed)

The Tart image is built from `ghcr.io/cirruslabs/macos-sequoia-xcode:26.2`, so the VM has **Xcode 26.2**. Expo SDK 56 already raised the iOS floor to **Xcode 26.4**, and SDK 57 (React Native 0.86, Node ≥ 22.13) keeps it there. iOS builds therefore fail at the Xcode/pod stage.

Newest published tags: `macos-sequoia-xcode:26.6` and `macos-tahoe-xcode:26.5`. The host Mac runs Xcode 26.6, so `macos-sequoia-xcode:26.6` is both the newest available and host-matching.

### Disk (confirmed — and not what it appeared to be)

There were **no leaked build VMs** and **no orphan `tart` processes**. The VM teardown path works. Disk was at 89% (50 GiB free of 460 GiB) because of five unrelated accumulations:

| What | `du` size | Cause |
|---|---|---|
| `~/.tart/cache/OCIs` | 80 GB | `setup-tart.ts:256` pulls the OCI image, `:267` clones it, cache never pruned |
| `~/eas/buddy-cache/v5` | 28 GB | Orphaned build cache (cocoapods 15G, gradle 11G, bun 2.3G) from a removed feature |
| `~/eas/buddy/admin/runpod` | 20 GB | `collectSyncFiles` walks the entire monorepo; rsync has no `--delete` |
| `~/eas/buddy/{node_modules,mobile/build}` | 2.2 GB | `bun install` and `--output` write into the **mounted** dir |
| `~/eas/buddy/.git` | 526 MB | Per-build `git init && git add -A && commit` (`eas.ts:695`), never gc'd (5708 loose objects, `size-pack: 0`) |

**Remediated on 2026-08-06** ahead of implementation: `tart prune --entries caches --space-budget 0` and `rm -rf ~/eas`, after moving `output.aab` and `output.ipa` to `~/.expo-builder/artifacts/legacy/`. Reclaimed **57 GiB** (89% → 76%, 107 GiB free). The gap between 57 GiB and the ~132 GB `du` total is APFS block sharing: `tart clone` uses copy-on-write, so `du` counts blocks shared between the OCI cache and the local VM image twice.

### Latent VM-lifecycle bugs (real, but not the cause of the disk issue)

In `buildMacHostScript` (`eas.ts:493-556`):

- `trap cleanup EXIT` is registered at line 550, **after** `tart clone` (511) and `tart set` (518). With `set -e`, a failure in between leaks the clone with no cleanup.
- The trap does not list `HUP`. Bash does not run `EXIT` traps on an untrapped `SIGHUP`, so an SSH disconnect (wifi drop, sleep, terminal close) leaks the VM and orphans the backgrounded `tart run`.
- `tart delete` immediately follows `tart stop` and can lose the race for the VM lock; the failure is swallowed by `|| true`, so the leak is silent.
- The `^build-` stale sweep is the only recovery path, runs only at the start of the next build, and would stop a concurrently running build's VM.

These must be fixed even though they did not cause the observed disk usage.

## Decisions

| Question | Decision |
|---|---|
| Distribution | npm package, usable via `bunx`/`npx`, as a devDependency, or globally |
| Runtime | Bun **and** Node, via `bun build --target=node` |
| Config | Auto-detection + `expo-builder.json`, secrets from env |
| SSH key | Default to `~/.ssh`, overridable |
| Storage | All four: scoped sync + `--delete`, OCI auto-prune, bounded build cache, `clean`/`doctor` |
| Sequencing | One pass |

## Design

### 1. Package and layout

Published to npm as `expo-builder`. `bin` points at `dist/cli.js`, built by `bun build --target=node --format=esm`. `@clack/prompts` and `ignore` are bundled into the output, so the package has **zero runtime dependencies** and `npx expo-builder` starts without an install step. `files: ["dist", "plugins", "schema.json", "README.md", "LICENSE"]`, `engines.node >= 20`.

The 1,392-line `scripts/eas.ts` and 382-line `scripts/setup-tart.ts` split into modules, each with one responsibility:

```
src/
  cli.ts            entry: parse → dispatch → format errors
  args.ts           parser, help text, version
  config.ts         discovery, merging, validation
  compat.ts         Expo SDK → minimum Xcode/Node/JDK table
  errors.ts         CommandError and user-facing formatting
  commands/
    build.ts submit.ts deploy.ts update.ts run.ts
    init.ts doctor.ts clean.ts vm.ts logs.ts interactive.ts
  remote/
    ssh.ts          exec helpers, key discovery, login-shell wrapping
    sync.ts         sync-set computation, rsync invocation
    host-script.ts  Mac host bash generator (VM lifecycle)
    vm-script.ts    in-VM bash generator
    markers.ts      ::phase:: protocol parsing
  ui/
    phases.ts       spinner/phase state machine
    output.ts       filtering, dedup, │-bar rendering, log file
  setup/
    tart.ts         image provisioning
plugins/withBuildOptimizations.js
```

The boundary that matters most: `host-script.ts` and `vm-script.ts` are **pure functions from config to bash strings**, with no I/O. That makes the riskiest code in the project directly testable (see §9).

### 2. Configuration

Auto-detected, never asked for:

- **Mobile dir** — cwd if it contains `app.json`/`app.config.{js,ts}` plus `eas.json`; otherwise search one level below the git root and use the sole match. Multiple matches prompt interactively, or error listing candidates in non-interactive mode.
- **Project name** — Expo config `slug`, falling back to `package.json` `name`, then the directory name.
- **Project root** — `git rev-parse --show-toplevel`, falling back to the mobile dir.
- **Remote path** — `~/.expo-builder/projects/<slug>` on the Mac. No longer user-specified.

`expo-builder.json` at the project root is checked in and holds **no secrets**. Minimum viable file:

```json
{ "mac": "mingu@defymac" }
```

Full form:

```json
{
  "$schema": "https://unpkg.com/expo-builder/schema.json",
  "mac": { "host": "defymac", "user": "mingu", "sshKey": "~/.ssh/id_ed25519" },
  "mobileDir": "mobile",
  "syncPaths": ["shared"],
  "vm": {
    "image": "ghcr.io/cirruslabs/macos-sequoia-xcode",
    "xcode": "26.6",
    "name": "expo-builder"
  },
  "cache": { "enabled": true, "budgetGB": 30 }
}
```

`~/.expo-builder/config.json` provides user-level defaults merged **underneath** project config, so `mac` can be set once across projects. Precedence, highest first: CLI flags → `expo-builder.json` → `~/.expo-builder/config.json` → auto-detection → built-in defaults.

`EXPO_TOKEN` resolves from `process.env` → `<projectRoot>/.env` → `<mobileDir>/.env` → `~/.expo-builder/env`. It is never read from `expo-builder.json`, and `init` writes a `.gitignore` entry if it creates an env file.

The SSH key is probed in order: `--ssh-key` → `mac.sshKey` → `ssh -G <host>` `identityfile` entries → `~/.ssh/id_ed25519` → `~/.ssh/id_rsa`. The `.ssh-key/id` directory and its copy step are removed.

The selected key is **never modified in place**. Today `ensureSshKeyPermissions` (`eas.ts:163-195`) rewrites the key file to normalize CRLF and tightens its ACL, which was acceptable when the key was a dedicated copy inside the tool directory but is not acceptable against a user's real `~/.ssh/id_ed25519`. Instead: if the key needs normalization for cwRsync's cygwin SSH (which rejects CRLF keys), write a normalized copy to `~/.expo-builder/ssh/<hash>` with locked-down permissions and use that for rsync only. The user's key is read, never written.

### 3. CLI

```
expo-builder <command> [positionals] [flags]

Commands
  build [profile] [platform]     Build on EAS Cloud or in a Tart VM
  submit [profile] [platform]    Submit an existing build to the stores
  deploy [profile] [platform]    Build then submit
  update [profile] -m <message>  OTA update
  run <platform>                 Local build + install on a connected device
  init                           Scaffold expo-builder.json, verify SSH
  doctor                         Check local deps, Mac, image, SDK compatibility
  clean                          Report and reclaim disk on the Mac
  vm <list|rebuild|delete|shell> Manage the Tart image
  logs [--last]                  Show build logs

Global flags
  -h, --help      -V, --version   --json        --verbose
  -y, --yes       --project <p>   --profile <p> --platform <p>
  --remote        --cloud         --no-optimize --no-cache
  --ssh-key <p>   --dry-run
```

Behavioural changes from today:

- **Unknown flags are an error** listing valid flags. Today `parseArgs` pushes anything unrecognized into `rest`, so a typo like `--remot` silently produces a cloud build.
- `--help` works per command; `--json` emits machine-readable results for CI.
- Bare positionals (`preview ios`) still work for compatibility; `--profile`/`--platform` are canonical.
- No arguments still opens the interactive `@clack` menu.
- Exit codes: `0` success, `1` usage or configuration error, `2` build or remote failure.

### 4. Sync

The sync set becomes:

1. `mobileDir`
2. Workspace packages the mobile package depends on via `workspace:` protocol, resolved transitively from the root `package.json` workspaces
3. Root manifests when `mobileDir` is nested: `package.json`, the lockfile, `pnpm-workspace.yaml`/`turbo.json`, shared `tsconfig` bases
4. Anything in `syncPaths`

`.gitignore` and `.easignore` are still honored via the `ignore` library. rsync gains **`--delete`**, scoped to the synced set. This is what prevents the `admin/runpod` class of accumulation.

`git init && git add -A && commit` is deleted. The VM script sets **`EAS_NO_VCS=1`**, which makes EAS use its own packaging algorithm, still honoring `.gitignore`/`.easignore`, with no git dependency at all.

**The mounted directory stops being a build directory.** Today `bun install` and `--output build/output.aab` write into the Mac's synced folder. Instead:

1. Mount the synced source at `/Volumes/My Shared Files/<slug>` using Tart's read-only mount suffix (`--dir=<slug>:<path>:ro`).
2. Inside the VM, copy source to the VM's own disk (`rsync -a` to `~/work`).
3. Build in `~/work`, writing the artifact to `~/out/`.
4. For `deploy`, `eas submit --path ~/out/<artifact>` runs in the VM before teardown.
5. Copy the artifact out to `~/.expo-builder/artifacts/<slug>/<timestamp>/` on the Mac. It is additionally downloaded to the local machine only when `--download <path>` is passed.

The Mac's synced directory then only ever contains source. This is also faster, since VirtioFS mount I/O is slower than the VM's local disk.

### 5. VM lifecycle

`host-script.ts` generates:

```sh
set -euo pipefail
VM="expo-builder-build-$$-<timestamp>"
VM_CREATED=0

destroy_vm() {
  tart stop -t 30 "$1" 2>/dev/null || true
  # poll until State != running, max 60s
  # tart delete with up to 5 retries, 2s apart
  # emit ::error:: if the VM still exists
}

cleanup() {
  rc=$?
  [ "$VM_CREATED" = 1 ] && destroy_vm "$VM"
  rm -f "$STATE"
  exit $rc
}
trap cleanup EXIT INT TERM HUP
```

Changes against today:

- The trap is registered **before** `tart clone`, guarded by `VM_CREATED` so it is a no-op if the clone never happened.
- `HUP` is trapped explicitly, so an SSH disconnect still tears the VM down.
- Teardown stops, **polls `tart list --format json` until the VM is not running**, then deletes with retries, and **reports failure via `::error::`** instead of swallowing it with `|| true`.
- The stale sweep parses `tart list --format json` and only removes VMs that match `expo-builder-build-*` **and** are not running **and** whose embedded PID is not alive. It can no longer kill a concurrent build.
- The local Node side traps `SIGTERM` and `SIGHUP` in addition to `SIGINT`.

Legacy `build-*` VMs from the old naming are still swept, for migration.

### 6. Storage

`expo-builder clean` reports what it would remove, then confirms (`--yes` skips, `--dry-run` reports only):

- `tart prune --entries caches --space-budget 0` — the OCI cache
- Stale `expo-builder-build-*` and legacy `build-*` VMs
- Legacy `~/eas/*` sync directories
- Artifacts beyond the 5 most recent per project
- Cache directories over budget

It runs automatically after `vm rebuild`. `doctor` reports Mac free space and warns below 40 GB, which is roughly the headroom one image rebuild needs.

The bounded build cache is restored: `~/.expo-builder/cache/<slug>/{bun,cocoapods,gradle}` is mounted into the VM as a second `--dir`, with `BUN_INSTALL_CACHE_DIR`, `CP_HOME_DIR`, and `GRADLE_USER_HOME` pointed at it. After each build, an LRU sweep enforces `cache.budgetGB` (default 30). `--no-cache` and `cache.enabled: false` disable it.

Because `GRADLE_USER_HOME` moves to the mounted cache, the Android optimization files (`gradle.properties`, `init.gradle`) are written into that gradle home rather than `~/.gradle`.

### 7. SDK compatibility

`compat.ts` holds a small data-driven table mapping Expo SDK major version to minimum Xcode, Node, and JDK. It is seeded only with entries verified against Expo's published requirements — at time of writing, SDK 57 (Xcode 26.4, Node 22.13, JDK 17) and SDK 56 (Xcode 26.4). Entries for older SDKs are added as they are verified rather than guessed. SDK versions absent from the table warn rather than block, so a new Expo release does not break the tool.

Provisioning records the image tag and the actual installed Xcode/Node/JDK versions to `~/.expo-builder/image.json`. `doctor` reads the project's `expo` dependency version, diffs it against that record, and prints the exact remedy — for example `expo-builder vm rebuild --xcode 26.6`.

The default image becomes `ghcr.io/cirruslabs/macos-sequoia-xcode:26.6`.

`setup/tart.ts` currently warns and continues when a provisioning step fails (`setup-tart.ts:358-365`), which silently produces a broken image. Step failures become **fatal by default**, with `--continue-on-error` to opt out. Provisioning also asserts the installed Node version meets the floor before declaring success.

### 8. Rename and migration

Every occurrence of `eas-builder` becomes `expo-builder`: package name, documentation, module paths, remote paths, and the Tart image name.

Renaming the Tart image is free because of APFS copy-on-write: `tart clone eas-builder expo-builder && tart delete eas-builder`. `build` and `doctor` detect a legacy `eas-builder` image and offer the migration. `clean` offers to remove legacy `~/eas/<name>` directories.

The submodule installation path is dropped from the docs in favour of the npm package. The README gains a migration section for existing submodule users.

### 9. Testing

The project currently has no tests. Add, using `bun test`:

- **Unit** — argument parsing (including unknown-flag rejection and positional compatibility), config discovery and precedence, sync-set computation (workspace resolution, `.gitignore`/`.easignore` application), `::phase::` marker parsing, `compat.ts` lookups including the unknown-SDK fallback.
- **Golden-file** — snapshots of the bash emitted by `host-script.ts` and `vm-script.ts` across the matrix of platform × profile × optimize × cache × submit. These scripts are the riskiest code and are pure string generation, so snapshots catch lifecycle regressions cheaply. Trap registration order and `HUP` presence get explicit assertions rather than relying on snapshot review.

No integration test runs against a real Mac in CI. `build --remote --dry-run` prints the scripts that would be executed, which serves both manual verification and debugging.

## Out of scope

- Concurrent builds of the same project against one Mac. The stale sweep is made concurrency-safe so parallel builds do not destroy each other, but parallel-build orchestration is not a feature.
- Non-macOS remote builders.
- Replacing EAS CLI itself. `expo-builder` continues to wrap `eas`.
- Windows or Linux as the remote builder host.
