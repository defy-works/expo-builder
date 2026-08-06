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

Newest published Tart tags: `macos-sequoia-xcode:26.6` and `macos-tahoe-xcode:26.5`. EAS Cloud builds SDK 57 with Xcode 26.6, so `macos-sequoia-xcode:26.6` is the correct target — see §7, which establishes that matching EAS's Xcode beats picking the newest.

### Disk (confirmed — and not what it appeared to be)

There were **no leaked build VMs** and **no orphan `tart` processes**. The VM teardown path works. Disk was at 89% (50 GiB free of 460 GiB) because of five unrelated accumulations:

| What | `du` size | Cause |
|---|---|---|
| `~/.tart/cache/OCIs` | 80 GB *nominal* | Pulled OCI image. **Mostly illusory** — see below; only ~5 GB was real |
| `~/eas/buddy-cache/v5` | 28 GB | Orphaned build cache (cocoapods 15G, gradle 11G, bun 2.3G) from a removed feature |
| `~/eas/buddy/admin/runpod` | 20 GB | `collectSyncFiles` walks the entire monorepo; rsync has no `--delete` |
| `~/eas/buddy/{node_modules,mobile/build}` | 2.2 GB | `bun install` and `--output` write into the **mounted** dir |
| `~/eas/buddy/.git` | 526 MB | Per-build `git init && git add -A && commit` (`eas.ts:695`), never gc'd (5708 loose objects, `size-pack: 0`) |

**Remediated on 2026-08-06** ahead of implementation: `tart prune --entries caches --space-budget 0` and `rm -rf ~/eas`, after moving `output.aab` and `output.ipa` to `~/.expo-builder/artifacts/legacy/`. Reclaimed **57 GiB** (89% → 76%, 107 GiB free).

The gap between 57 GiB freed and the ~132 GB `du` total is APFS block sharing. `tart clone` uses `clonefile(2)`, which shares disk extents rather than copying bytes, so `du` counts blocks shared between the OCI cache and the local VM image against both. Since `~/eas` alone was ~52 GB of genuinely unique files, pruning the OCI cache recovered only about **5 GB**. This is why §6 retains the cache rather than pruning it: the entry above overstates its cost by more than an order of magnitude.

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
| Storage | Scoped sync + `--delete`, bounded build cache, `clean`/`doctor` |
| Images | One provisioned image, slimmed at provisioning time; OCI cache **retained**, not pruned |
| Low disk | Preflight check with automatic safe clean, refuse rather than fail mid-build |
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
    "xcode": "auto",
    "name": "expo-builder"
  },
  "cache": { "enabled": true, "budgetGB": 15 }
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

The build Mac is disk-constrained: 460 GB total with ~107 GB free after the 2026-08-06 cleanup, of which one provisioned image already claims 80 GB. Storage design is therefore a first-class constraint, not an afterthought.

#### The OCI cache is retained, not pruned

**This reverses an earlier decision in this document's first revision.** `tart clone` uses macOS `clonefile(2)`, so a cloned VM shares disk extents with its source and no bytes are copied up front; the two diverge lazily under copy-on-write. The pulled OCI image and the local VM built from it therefore share nearly all their blocks, and `du` counts those shared blocks against both.

The 2026-08-06 cleanup measured this: 57 GiB was freed in total, but `~/eas` alone accounted for ~52 GB of genuinely unique files. Pruning the nominally "80 GB" OCI cache recovered only **roughly 5 GB**.

So the pristine pulled image is retained. It costs ~5 GB and it makes re-provisioning free — a re-clone rather than a 61.9 GB re-download. Tart additionally auto-prunes its own cache under space pressure (up to 100 GB, tunable via `--prune-limit`), so the cache self-manages in an emergency.

`clean --deep` still offers explicit OCI cache pruning for when space is genuinely needed, but `clean` no longer does it by default and `vm rebuild` no longer triggers it.

#### clean

`expo-builder clean` reports what it would remove, then confirms (`--yes` skips, `--dry-run` reports only):

- Stale `expo-builder-build-*` and legacy `build-*` VMs
- Legacy `~/eas/*` sync directories
- Artifacts beyond the 3 most recent per project
- Cache directories over budget
- With `--deep` only: the OCI cache, accompanied by a warning that the next `vm rebuild` will re-download ~62 GB

#### Preflight

Before each remote build, `expo-builder` projects the space the build needs (transient CoW clone plus build writes, budgeted at 25 GB) against actual free space. If short, it runs the safe subset of `clean` automatically — stale VMs, over-budget cache, old artifacts — and only then proceeds. If still short, it refuses with a breakdown of what is consuming space rather than dying mid-build on a full disk. `doctor` reports the same breakdown on demand and warns below 40 GB free.

#### Build cache

The cache is **shared across all projects**, not per-project: `~/.expo-builder/cache/{bun,cocoapods,gradle}`, mounted into the VM as a second `--dir`, with `BUN_INSTALL_CACHE_DIR`, `CP_HOME_DIR`, and `GRADLE_USER_HOME` pointed at it.

The first revision of this document used a per-project `cache/<slug>/` layout. That was wrong for a constrained disk: these caches are content-addressed, so two Expo projects sharing most of their dependency graph would store two nearly identical copies. Sharing deduplicates them and keeps the cache from scaling with project count. This follows EAS's own model, which serves all builds from shared npm/Maven/CocoaPods caches rather than per-project storage (§10).

After each build an LRU sweep enforces `cache.budgetGB`, **default 15** rather than the 30 in the first revision, given the disk constraint. Preflight trims the cache first when space is short. `--no-cache` and `cache.enabled: false` disable it.

Because `GRADLE_USER_HOME` moves to the mounted cache, the Android optimization files (`gradle.properties`, `init.gradle`) are written into that gradle home rather than `~/.gradle`.

A future step, if disk pressure persists, is EAS's actual approach: run a caching proxy on the Mac host (a local npm registry proxy, a Gradle read-only dependency cache) so the VM pulls over the network and nothing mutable is mounted at all. That is deferred — it is a larger build with its own operational surface, and shared content-addressed directories capture most of the benefit.

#### Target footprint

| Item | Budget |
|---|---|
| Pristine OCI image + provisioned image (extent-shared) | ~55–60 GB after slimming |
| Build cache | ≤ 15 GB |
| Artifacts (3 per project) | < 1 GB |
| Transient build clone + build writes | ≤ 25 GB, reclaimed on teardown |
| **Peak** | **~100 GB** |

This fits within the ~107 GB currently free, but only because of image slimming (§7). Without it the current 80 GB image pushes peak past the available space, which is why slimming is a requirement rather than an optimisation.

### 7. SDK compatibility and image selection

**Newest is not safest.** Expo's own [`expo-sdk-xcode-compatibility`](https://github.com/expo/fyi/blob/main/expo-sdk-xcode-compatibility.md) states: "Expo SDKs support up to a specific Xcode version. If you use a newer, unsupported version, your build may fail." So the image must be chosen to match the project's SDK, not pinned to the latest release.

Expo publishes a **floor** per SDK in its support matrix, and an effective **known-good** version as the default EAS Cloud image for that SDK. The second is the better target: it is Expo stating which Xcode it actually builds that SDK with, and matching it maximises fidelity between local VM builds and cloud builds, which is this tool's purpose.

| SDK | Xcode floor | EAS Cloud default (known-good) |
|---|---|---|
| 57 | 26.4 | 26.6 (`macos-tahoe-26.5-xcode-26.6`) |
| 56 | 26.4 | 26.4 (`macos-tahoe-26.4-xcode-26.4`) |
| 55 | 26.2 | 26.2 (`macos-sequoia-15.6-xcode-26.2`) |
| 54 | 16.1 | 26.0 (`macos-sequoia-15.6-xcode-26.0`) |
| 53 | — | 16.4 (`macos-sequoia-15.5-xcode-16.4`) |
| 49–51 | — | 15.4 (`macos-sonoma-14.5-xcode-15.4`) |

Note that SDK 54's floor is 16.1 while EAS builds it on 26.0: a floor alone is not enough information to pick an image.

#### Resolution algorithm

`vm.xcode` defaults to `"auto"`. Resolution:

1. Read the project's Expo SDK major version from `mobileDir/package.json`.
2. Look up `{ floor, knownGood }` for that SDK.
3. List available Tart image tags from **both** `ghcr.io/cirruslabs/macos-tahoe-xcode` and `macos-sequoia-xcode`. The ghcr tag list is readable anonymously (fetch a pull-scoped token, then `GET /v2/<repo>/tags/list`), so this needs no credentials. Discard `-beta`, `-rc`, and non-version tags including `latest`.
4. Choose the newest tag satisfying `floor <= tag <= knownGood`. Tie-break toward the macOS base EAS uses for that SDK.
5. If nothing satisfies the range, pick the newest `>= floor` and **warn** that it exceeds what EAS builds this SDK with.
6. If the SDK is absent from the table, use the newest stable tag and warn that compatibility is unverified.

Searching both repositories is required, not optional: SDK 57 targets Xcode 26.6, and on Tart that exists only as `macos-sequoia-xcode:26.6` — `macos-tahoe-xcode` currently stops at 26.5.

`vm.xcode` also accepts an explicit version (pin exactly) or `"latest"` (newest stable tag, accompanied by a warning on every build, since Expo documents this as a failure mode).

#### Staying current

The SDK table ships bundled so the tool works offline, and is refreshable rather than static:

- `expo-builder doctor` compares the provisioned image against the resolution above and prints the exact remedy, for example `expo-builder vm rebuild` when the image is Xcode 26.2 but the project is on SDK 57.
- `doctor --refresh` re-fetches the SDK table and the ghcr tag lists, caching to `~/.expo-builder/compat.json` with a TTL.
- `build --remote` performs the same check against the cache (never blocking on the network) and warns when a better-matching image is available or when the project's SDK has changed since provisioning. It does not rebuild the image implicitly — that is a ~25 GB download and stays an explicit `vm rebuild`.

Because the bundled table will go stale between releases, `doctor` treats a fetched table as authoritative over the bundled one, and reports when it is falling back to bundled data.

#### Image strategy: one image, slimmed

Exactly **one provisioned image** exists at a time, named `expo-builder`. `vm rebuild` replaces it in place; images are never accumulated per SDK. At 80 GB each on a 460 GB disk, a second image is not affordable.

Because the pristine pulled image is retained (§6), rebuilding is a `clonefile` re-clone plus provisioning, with **no re-download**, so replacing the image is cheap in bytes even though it costs provisioning time.

Provisioning **slims the image before freezing it**. This tool only ever produces device and store archives — it never runs a simulator — so the iOS/tvOS/watchOS simulator runtimes shipped in the cirruslabs image are dead weight, as is non-iOS platform support. Provisioning removes them and records the measured before/after size in `~/.expo-builder/image.json`.

The expected saving is 20–35 GB, but that figure is **unverified** — it must be measured on the first provisioning run and this document updated with the real number. The §6 footprint table assumes slimming lands the image near 50 GB; if measurement shows otherwise, the cache budget and retention counts need revisiting.

#### Rejected: base image plus self-installed Xcode

Pulling `macos-sequoia-base` (23.7 GB) and installing Xcode with the `xcodes` CLI instead of pulling `macos-sequoia-xcode` (61.9 GB) was considered, on the theory that switching Xcode versions would then cost a ~14 GB Xcode download rather than a full image pull.

Rejected because:

- Apple gates Xcode downloads behind developer-portal authentication, so this makes an **Apple ID and 2FA mandatory** for image provisioning, plus a keychain session that expires. That is a direct regression against this project's primary goal of being easy to run.
- The steady-state saving is only ~5 GB, since the retained OCI image and the provisioned clone share extents anyway.
- The benefit is concentrated entirely in *switching* Xcode versions, which the one-image-at-a-time policy makes rare.
- It adds failure modes outside our control: Apple download flakiness, session expiry, rate limiting, and a 20–30 minute unxip.

Worth revisiting only if the single-image policy proves too restrictive in practice.

#### Provisioning

Provisioning records the resolved image tag and the actual installed Xcode, Node, and JDK versions to `~/.expo-builder/image.json`, so `doctor` compares against reality rather than against the tag alone.

`setup/tart.ts` currently warns and continues when a provisioning step fails (`setup-tart.ts:358-365`), which silently produces a broken image. Step failures become **fatal by default**, with `--continue-on-error` to opt out. Provisioning also asserts the installed Node version meets the SDK floor (22.13 for SDK 57) before declaring success.

### 8. Rename and migration

Every occurrence of `eas-builder` becomes `expo-builder`: package name, documentation, module paths, remote paths, and the Tart image name.

Renaming the Tart image is free because of APFS copy-on-write: `tart clone eas-builder expo-builder && tart delete eas-builder`. `build` and `doctor` detect a legacy `eas-builder` image and offer the migration. `clean` offers to remove legacy `~/eas/<name>` directories.

The submodule installation path is dropped from the docs in favour of the npm package. The README gains a migration section for existing submodule users.

### 9. Testing

The project currently has no tests. Add, using `bun test`:

- **Unit** — argument parsing (including unknown-flag rejection and positional compatibility), config discovery and precedence, sync-set computation (workspace resolution, `.gitignore`/`.easignore` application), `::phase::` marker parsing.
- **Image resolution** — the §7 algorithm against a fixed fixture of ghcr tags, covering: exact known-good match (SDK 57 → 26.6), floor-only SDKs (SDK 54 must resolve to 26.0, **not** the newest tag), pre-release tags excluded, cross-repo selection when only one repo carries the needed Xcode, the no-tag-in-range warning path, and the unknown-SDK fallback. Network access is mocked; these must never hit ghcr in tests.
- **Golden-file** — snapshots of the bash emitted by `host-script.ts` and `vm-script.ts` across the matrix of platform × profile × optimize × cache × submit. These scripts are the riskiest code and are pure string generation, so snapshots catch lifecycle regressions cheaply. Trap registration order and `HUP` presence get explicit assertions rather than relying on snapshot review.

No integration test runs against a real Mac in CI. `build --remote --dry-run` prints the scripts that would be executed, which serves both manual verification and debugging.

## 10. Prior art: how EAS Build does it

Checked deliberately, since EAS solves the same problem at scale and offers roughly fifteen Xcode images concurrently.

**Images are monolithic, one per (OS, Xcode) pair.** EAS image names encode the whole environment — `macos-sonoma-14.6-xcode-16.1`, `ubuntu-24.04-jdk-17-ndk-r27b-sdk-55` — and each carries "one specific version of Node.js, Yarn, CocoaPods, Xcode, Ruby, Fastlane". There is no base image with Xcode swapped in afterwards. This is direct support for §7's rejection of the base-plus-`xcodes` approach.

**Scale is handled by fleet, not by layering.** iOS builds run on Mac mini hosts in Expo's own macOS cloud, with every build getting a fresh VM. Carrying many images is affordable because a build is scheduled onto a host that has the right one — a lever unavailable with a single Mac. Hence §7's one-image-at-a-time policy: the constraint is real and structural, not a shortcoming of this design.

**Ephemeral VM per build.** Matches what this tool already does.

**Caching is served, not stored per project.** EAS runs an npm cache server, a Maven cache server, and serves most CocoaPods artifacts from a cache server. Build VMs pull through the network; nothing persistent accumulates per project on the builder. `ccache` is keyed on a hash of the lockfile.

This last point changed the design: §6's cache moved from per-project to shared, and a host-side caching proxy is recorded as the eventual direction rather than mounted directories.

**Not publicly documented,** and therefore not relied upon here: which hypervisor Expo uses, whether hosts hold all images or pull on demand, and their per-host eviction policy. Statements above are drawn from Expo's published documentation; the fleet-scheduling inference is ours.

## Out of scope

- Concurrent builds of the same project against one Mac. The stale sweep is made concurrency-safe so parallel builds do not destroy each other, but parallel-build orchestration is not a feature.
- Non-macOS remote builders.
- Replacing EAS CLI itself. `expo-builder` continues to wrap `eas`.
- Windows or Linux as the remote builder host.

## Sources

Compatibility data in §7 was gathered on 2026-08-06 from:

- [Expo SDK Xcode Compatibility](https://github.com/expo/fyi/blob/main/expo-sdk-xcode-compatibility.md) — the "support up to a specific Xcode version" upper-bound warning
- [Expo SDK reference — support for Android and iOS versions](https://docs.expo.dev/versions/latest/) — per-SDK Xcode floors
- [EAS Build infrastructure — iOS server images](https://docs.expo.dev/build-reference/infrastructure/) — default image per SDK
- [Expo SDK 57 changelog](https://expo.dev/changelog/sdk-57) — React Native 0.86, Node 22.13 minimum
- [EAS Build caching](https://docs.expo.dev/build-reference/caching/) — the cache-server model in §10
- [Tart FAQ](https://tart.run/faq/) — `clonefile(2)` copy-on-write, automatic cache pruning
- `ghcr.io/cirruslabs/macos-{tahoe,sequoia}-xcode` and `-base` tag lists and manifest sizes, queried anonymously
