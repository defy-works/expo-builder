# expo-builder

An npm-published CLI that builds Expo/React Native projects in ephemeral Tart VMs on a remote Mac, over SSH, from any OS. Also wraps EAS Cloud builds, store submission, OTA updates, and local device installs.

## What this is

A **package**, not a submodule. Consumers install it (`bun add -d expo-builder`, `bunx expo-builder`, or globally) and configure it with an `expo-builder.json` in *their* project. This tool's own directory holds no user config.

## Architecture

```
Your machine (src/cli.ts)
  │
  ├─ rsync (--delete, scoped) ──► Mac ~/.expo-builder/projects/<slug>/
  │
  └─ ssh ───────────────────────► bash on the Mac host
                                    ├─ stale VM sweep (skips running / live-PID VMs)
                                    ├─ tart clone <image> expo-builder-build-$$-<ts>
                                    ├─ tart run --dir=<slug>:<path>:ro --dir=cache:<path>
                                    ├─ ssh admin@<vm-ip> ──► inside the VM
                                    │     ├─ rsync mount → ~/work  (build off the mount)
                                    │     ├─ eas env:pull / bun install
                                    │     ├─ eas build --local --output ~/out/app.<ext>
                                    │     └─ eas submit (deploy only)
                                    ├─ scp artifact → ~/.expo-builder/artifacts/<slug>/
                                    └─ trap cleanup EXIT INT TERM HUP → stop, wait, delete
```

## Module layout

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Entry: parse → dispatch → format errors → exit code |
| `src/args.ts` | Parser, help text. **Rejects unknown flags** |
| `src/errors.ts` | `UsageError` (exit 1) / `BuildError` (exit 2) |
| `src/config.ts` | Discovery, merging, validation, `remotePaths()` |
| `src/compat.ts` | SDK requirement table, version compare, image resolution, ghcr tags |
| `src/compat-cache.ts` | 24h TTL cache so builds never block on the network |
| `src/remote/markers.ts` | `::marker::` protocol parsing |
| `src/remote/sync.ts` | Sync-set computation, workspace deps, rsync args |
| `src/remote/storage.ts` | `diskutil` parsing, volume validation, image retention |
| `src/remote/vm-script.ts` | Bash that runs **inside** the VM (pure function) |
| `src/remote/host-script.ts` | Bash that runs on the **Mac host** (pure function) |
| `src/remote/ssh.ts` | SSH helpers, key discovery, cygwin path conversion |
| `src/ui/` | Output filtering and phase spinners |
| `src/commands/` | One file per command |
| `src/setup/tart.ts` | Image provisioning, slimming, `image.json` |

`host-script.ts` and `vm-script.ts` are **pure string generation with no I/O**, which is what makes the riskiest code testable. They have golden-file snapshots plus explicit assertions.

## Config resolution

Precedence, highest first: CLI flags → `expo-builder.json` (project root) → `~/.expo-builder/config.json` → auto-detection → defaults.

Auto-detected: mobile dir (cwd if it has `eas.json` + `app.json`/`app.config.*`, else one level below the git root), slug (Expo `slug` → package name → dir name), project root (git toplevel), remote paths.

`EXPO_TOKEN` resolves from env → project `.env` → mobile `.env` → `~/.expo-builder/env`. **Never** from `expo-builder.json`.

## Image selection

`vm.xcode: "auto"` targets the Xcode **EAS Cloud uses for the project's SDK**, bounded below by Expo's published floor. Deliberately *not* newest-wins: Expo documents that an Xcode newer than an SDK supports may fail. SDK 54 is the motivating case — floor 16.1, EAS default 26.0.

Both `macos-tahoe-xcode` and `macos-sequoia-xcode` must be searched; SDK 57 wants Xcode 26.6, which exists only on sequoia.

`compat.ts` is seeded only with **verified** entries. Add new SDKs from Expo's docs, never by guessing. Unknown SDKs warn rather than block.

## Storage model

- **The OCI cache is retained, not pruned.** `tart clone` uses `clonefile(2)`, so the cache and local image share extents; pruning frees little but costs a ~62 GB re-download. `clean --deep` is the explicit escape hatch.
- **Slimming and retention interact.** Deleting files in the clone does not free blocks the cache still references, so slimming only reclaims space once the cache is dropped. Do not "fix" one without considering the other.
- Cache is **shared across projects**, not per-slug — these caches are content-addressed, so per-project copies would duplicate.
- Preflight refuses or auto-cleans rather than dying mid-build.

## Invariants — do not undo

1. **`trap cleanup EXIT INT TERM HUP` is registered before `tart clone`**, guarded by `VM_CREATED`. Bash skips EXIT traps on untrapped SIGHUP, so omitting HUP leaks VMs on SSH disconnect.
2. **Teardown reports failure.** `tart delete` retries and emits `::error::`; never swallow it with `|| true`.
3. **The stale sweep checks `Running` and PID liveness**, so it cannot destroy a concurrent build.
4. **Remote paths carry a literal `$HOME`, not `~`.** They are used inside double quotes in bash, where `~` does not expand.
5. **`planImageEviction` lives in `remote/storage.ts`**, re-exported from `commands/vm.ts`, to avoid a cycle with `setup/tart.ts`.
6. **The user's SSH key is never modified.** Normalization writes a copy to `~/.expo-builder/ssh/`.
7. **`EAS_NO_VCS=1`** replaces the old per-build `git init`; EAS packages the project itself and honours `.gitignore`/`.easignore`.
8. **Builds happen on the VM's own disk**, never in the mounted directory, which is mounted `:ro`.

## Conventions

- **Runtime**: Bun for development (`bun test`, `bun build`); the published bundle targets Node 20+.
- **Language**: TypeScript, strict, `noUncheckedIndexedAccess`.
- **CLI UI**: `@clack/prompts`, bundled into `dist/` so the package has zero runtime deps.
- **Tests**: `bun test`. Pure logic is unit-tested; bash generation is snapshot-tested.

## Reference

- Design spec: `docs/superpowers/specs/2026-08-06-expo-builder-redesign-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-06-expo-builder-redesign.md`
