# expo-builder Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild expo-builder as a published npm package with SDK-aware Tart image selection, a real CLI, bounded Mac storage, and hardened VM teardown — fixing Expo SDK 57 iOS builds along the way.

**Architecture:** A Bun/TypeScript CLI bundled for Node, split into pure-logic modules (arg parsing, config discovery, image resolution, sync-set computation, bash generation) that are unit-tested without I/O, plus thin I/O layers (ssh, rsync, spinners) and command handlers. The riskiest code — the bash that drives the Tart VM lifecycle on the remote Mac — is pure string generation and is covered by golden-file tests.

**Tech Stack:** Bun (runtime + test runner + bundler), TypeScript, `@clack/prompts` (bundled), `ignore` (bundled), Tart on a remote Apple Silicon Mac, EAS CLI inside the VM.

**Spec:** `docs/superpowers/specs/2026-08-06-expo-builder-redesign-design.md`

---

## Background the engineer needs

You have not seen this codebase. Read these before starting:

- `docs/superpowers/specs/2026-08-06-expo-builder-redesign-design.md` — the full design and the reasoning behind every decision below. Especially §6 (storage), §7 (image resolution), and §10 (why we do things the way EAS does).
- `scripts/eas.ts` — the 1,392-line file being replaced. Useful as reference for the rsync invocation, the marker protocol, and the `@clack` output filtering, all of which are being preserved in spirit.
- `scripts/setup-tart.ts` — the 382-line VM provisioning script being replaced.

Domain terms:

- **Tart** — runs macOS VMs on Apple Silicon. `tart clone` uses APFS `clonefile(2)`, so clones share disk blocks and cost near-zero until written.
- **TOOL_ROOT / PROJECT_ROOT** — the old config model. Being deleted. Config now lives in the *project*, not the tool.
- **Marker protocol** — the remote bash emits `::phase::name`, `::vm-ip::`, `::error::` etc. on stdout; the Node side parses these to drive spinners.
- **Profile** — `development` | `preview` | `production`. **Platform** — `android` | `ios` | `all`.

Conventions: Bun only (`bun`, `bunx` — never `npm`/`npx`). TypeScript. Two-space indent, double quotes, semicolons — match the existing files.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/cli.ts` | Entry point: parse, dispatch, format errors, set exit code |
| `src/args.ts` | Argument parser, help text, version |
| `src/errors.ts` | `UsageError` / `BuildError` and user-facing formatting |
| `src/config.ts` | Config discovery, merging, validation |
| `src/compat.ts` | Expo SDK requirement table, version compare, image resolution |
| `src/remote/markers.ts` | `::marker::` protocol parsing |
| `src/remote/sync.ts` | Sync-set computation and rsync invocation |
| `src/remote/storage.ts` | `diskutil` parsing, volume validation, `keepImages` derivation |
| `src/remote/vm-script.ts` | Generates the bash that runs *inside* the VM |
| `src/remote/host-script.ts` | Generates the bash that runs on the *Mac host* (VM lifecycle) |
| `src/remote/ssh.ts` | SSH exec helpers, key discovery, login-shell wrapping |
| `src/ui/output.ts` | Output filtering, dedup, `│`-bar rendering, log files |
| `src/ui/phases.ts` | Spinner/phase state machine |
| `src/commands/*.ts` | One file per command |
| `src/setup/tart.ts` | Image provisioning, slimming, `image.json` |
| `schema.json` | JSON schema for `expo-builder.json` |
| `test/*.test.ts` | Unit and golden-file tests |

**Modified:** `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `CLAUDE.md`, `.env.example` (deleted).

**Deleted:** `scripts/eas.ts`, `scripts/setup-tart.ts`, `.env.example`, `.ssh-key/`.

---

## Task 1: Package scaffolding

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `.gitignore`
- Create: `test/smoke.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";
import pkg from "../package.json";

test("package is named expo-builder and exposes a bin", () => {
  expect(pkg.name).toBe("expo-builder");
  expect(pkg.bin["expo-builder"]).toBe("./dist/cli.js");
});

test("package declares no runtime dependencies", () => {
  expect(pkg.dependencies ?? {}).toEqual({});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/smoke.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` because `pkg.bin` is undefined.

- [ ] **Step 3: Rewrite package.json**

Replace `package.json` entirely:

```json
{
  "name": "expo-builder",
  "version": "0.2.0",
  "description": "Build Expo/React Native apps in ephemeral Tart VMs on a remote Mac — from any OS",
  "license": "MIT",
  "type": "module",
  "bin": {
    "expo-builder": "./dist/cli.js"
  },
  "files": [
    "dist",
    "plugins",
    "schema.json",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "bun build src/cli.ts --target=node --format=esm --outfile dist/cli.js --banner \"#!/usr/bin/env node\"",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "bun run build"
  },
  "devDependencies": {
    "@clack/prompts": "^1.0.1",
    "@types/bun": "^1.3.9",
    "@types/node": "^25.2.3",
    "ignore": "^7.0.5",
    "typescript": "~5.9.0"
  }
}
```

Note: `@clack/prompts` and `ignore` stay in `devDependencies` deliberately — `bun build` inlines them into `dist/cli.js`, so the published package has zero runtime dependencies.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/smoke.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Update tsconfig.json**

Replace `tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 6: Add dist/ to .gitignore**

Append to `.gitignore`:

```
# Build output
dist/
```

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore test/smoke.test.ts
git commit -m "build: scaffold expo-builder as a publishable package"
```

---

## Task 2: Error types

**Files:**
- Create: `src/errors.ts`
- Create: `test/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/errors.test.ts`:

```ts
import { expect, test } from "bun:test";
import { UsageError, BuildError, exitCodeFor, formatError } from "../src/errors";

test("usage errors exit 1", () => {
  expect(exitCodeFor(new UsageError("bad flag"))).toBe(1);
});

test("build errors exit 2", () => {
  expect(exitCodeFor(new BuildError("ios build failed"))).toBe(2);
});

test("unknown errors exit 1", () => {
  expect(exitCodeFor(new Error("boom"))).toBe(1);
});

test("formatError includes the hint when present", () => {
  const err = new UsageError("Unknown flag: --remot", "Did you mean --remote?");
  expect(formatError(err)).toContain("Unknown flag: --remot");
  expect(formatError(err)).toContain("Did you mean --remote?");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/errors.test.ts`
Expected: FAIL — cannot resolve module `../src/errors`.

- [ ] **Step 3: Write the implementation**

Create `src/errors.ts`:

```ts
/** A problem with how the command was invoked or configured. Exit code 1. */
export class UsageError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** A build, remote, or VM failure. Exit code 2. */
export class BuildError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "BuildError";
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof BuildError) return 2;
  return 1;
}

export function formatError(err: unknown): string {
  if (err instanceof UsageError || err instanceof BuildError) {
    return err.hint ? `${err.message}\n\n${err.hint}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return "An unknown error occurred";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/errors.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat: add typed errors with distinct exit codes"
```

---

## Task 3: Argument parser

The old parser (`scripts/eas.ts:1066-1089`) pushed anything unrecognised into a `rest` array, so `--remot` was silently ignored and produced a cloud build. This task fixes that.

**Files:**
- Create: `src/args.ts`
- Create: `test/args.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/args.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseArgs } from "../src/args";
import { UsageError } from "../src/errors";

test("parses command with positional profile and platform", () => {
  const r = parseArgs(["build", "preview", "ios"]);
  expect(r.command).toBe("build");
  expect(r.profile).toBe("preview");
  expect(r.platform).toBe("ios");
});

test("positional order does not matter", () => {
  const r = parseArgs(["build", "ios", "preview"]);
  expect(r.profile).toBe("preview");
  expect(r.platform).toBe("ios");
});

test("named flags override positionals", () => {
  const r = parseArgs(["build", "preview", "--profile", "production"]);
  expect(r.profile).toBe("production");
});

test("boolean flags are recognised", () => {
  const r = parseArgs(["build", "--remote", "--no-optimize"]);
  expect(r.flags.remote).toBe(true);
  expect(r.flags.optimize).toBe(false);
});

test("optimize defaults to true", () => {
  expect(parseArgs(["build"]).flags.optimize).toBe(true);
});

test("unknown flags are rejected", () => {
  expect(() => parseArgs(["build", "--remot"])).toThrow(UsageError);
});

test("unknown flag error suggests the closest valid flag", () => {
  try {
    parseArgs(["build", "--remot"]);
    throw new Error("should have thrown");
  } catch (err) {
    expect((err as UsageError).hint).toContain("--remote");
  }
});

test("unknown commands are rejected", () => {
  expect(() => parseArgs(["bulid"])).toThrow(UsageError);
});

test("no arguments means interactive", () => {
  expect(parseArgs([]).command).toBe("interactive");
});

test("--help sets the help flag", () => {
  expect(parseArgs(["build", "--help"]).flags.help).toBe(true);
});

test("update collects a message via -m", () => {
  const r = parseArgs(["update", "preview", "-m", "fixed the bug"]);
  expect(r.flags.message).toBe("fixed the bug");
});

test("value flags reject a missing value", () => {
  expect(() => parseArgs(["build", "--project"])).toThrow(UsageError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/args.test.ts`
Expected: FAIL — cannot resolve module `../src/args`.

- [ ] **Step 3: Write the implementation**

Create `src/args.ts`:

```ts
import { UsageError } from "./errors";

export const COMMANDS = [
  "build", "submit", "deploy", "update", "run",
  "init", "doctor", "clean", "vm", "logs", "interactive",
] as const;
export const PROFILES = ["development", "preview", "production"] as const;
export const PLATFORMS = ["android", "ios", "all"] as const;

export type Command = (typeof COMMANDS)[number];
export type Profile = (typeof PROFILES)[number];
export type Platform = (typeof PLATFORMS)[number];

export interface Flags {
  help: boolean;
  version: boolean;
  json: boolean;
  verbose: boolean;
  yes: boolean;
  remote: boolean;
  cloud: boolean;
  optimize: boolean;
  cache: boolean;
  dryRun: boolean;
  deep: boolean;
  project?: string;
  sshKey?: string;
  message?: string;
  xcode?: string;
  download?: string;
  to?: string;
}

export interface ParsedArgs {
  command: Command;
  profile?: Profile;
  platform?: Platform;
  flags: Flags;
  positionals: string[];
}

const BOOLEAN_FLAGS: Record<string, keyof Flags> = {
  "--help": "help", "-h": "help",
  "--version": "version", "-V": "version",
  "--json": "json",
  "--verbose": "verbose",
  "--yes": "yes", "-y": "yes",
  "--remote": "remote",
  "--cloud": "cloud",
  "--dry-run": "dryRun",
  "--deep": "deep",
};

/** Flags that invert a default-true value. */
const NEGATED_FLAGS: Record<string, keyof Flags> = {
  "--no-optimize": "optimize",
  "--no-cache": "cache",
};

const VALUE_FLAGS: Record<string, keyof Flags> = {
  "--project": "project",
  "--ssh-key": "sshKey",
  "--message": "message", "-m": "message",
  "--profile": "profile" as keyof Flags,
  "--platform": "platform" as keyof Flags,
  "--xcode": "xcode",
  "--download": "download",
  "--to": "to",
};

const ALL_FLAG_NAMES = [
  ...Object.keys(BOOLEAN_FLAGS),
  ...Object.keys(NEGATED_FLAGS),
  ...Object.keys(VALUE_FLAGS),
];

/** Levenshtein distance, used only to suggest a flag on a typo. */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[a.length]![b.length]!;
}

function suggest(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dist = distance(input, c);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return bestDist <= 3 ? best : undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {
    help: false, version: false, json: false, verbose: false, yes: false,
    remote: false, cloud: false, optimize: true, cache: true,
    dryRun: false, deep: false,
  };

  if (argv.length === 0) {
    return { command: "interactive", flags, positionals: [] };
  }

  const first = argv[0]!;
  let command: Command;
  let rest: string[];

  if (first.startsWith("-")) {
    command = "interactive";
    rest = argv;
  } else if ((COMMANDS as readonly string[]).includes(first)) {
    command = first as Command;
    rest = argv.slice(1);
  } else {
    const hint = suggest(first, [...COMMANDS]);
    throw new UsageError(
      `Unknown command: ${first}`,
      hint ? `Did you mean "${hint}"?\n\nValid commands: ${COMMANDS.join(", ")}`
           : `Valid commands: ${COMMANDS.join(", ")}`
    );
  }

  let profile: Profile | undefined;
  let platform: Platform | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;

    if (!arg.startsWith("-")) {
      if ((PROFILES as readonly string[]).includes(arg)) profile = arg as Profile;
      else if ((PLATFORMS as readonly string[]).includes(arg)) platform = arg as Platform;
      else positionals.push(arg);
      continue;
    }

    if (arg in BOOLEAN_FLAGS) {
      (flags as Record<string, unknown>)[BOOLEAN_FLAGS[arg]!] = true;
      continue;
    }

    if (arg in NEGATED_FLAGS) {
      (flags as Record<string, unknown>)[NEGATED_FLAGS[arg]!] = false;
      continue;
    }

    if (arg in VALUE_FLAGS) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`Flag ${arg} requires a value`);
      }
      i++;
      const key = VALUE_FLAGS[arg]!;
      if (key === ("profile" as keyof Flags)) {
        if (!(PROFILES as readonly string[]).includes(value)) {
          throw new UsageError(
            `Invalid profile: ${value}`,
            `Valid profiles: ${PROFILES.join(", ")}`
          );
        }
        profile = value as Profile;
      } else if (key === ("platform" as keyof Flags)) {
        if (!(PLATFORMS as readonly string[]).includes(value)) {
          throw new UsageError(
            `Invalid platform: ${value}`,
            `Valid platforms: ${PLATFORMS.join(", ")}`
          );
        }
        platform = value as Platform;
      } else {
        (flags as Record<string, unknown>)[key] = value;
      }
      continue;
    }

    const hint = suggest(arg, ALL_FLAG_NAMES);
    throw new UsageError(
      `Unknown flag: ${arg}`,
      hint ? `Did you mean "${hint}"?` : `Run "expo-builder ${command} --help" for valid flags.`
    );
  }

  return { command, profile, platform, flags, positionals };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/args.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/args.ts test/args.test.ts
git commit -m "feat: add argument parser that rejects unknown flags"
```

---

## Task 4: Version comparison and the SDK requirement table

**Files:**
- Create: `src/compat.ts`
- Create: `test/compat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/compat.test.ts`:

```ts
import { expect, test } from "bun:test";
import { compareVersions, requirementsFor, parseSdkMajor } from "../src/compat";

test("compareVersions orders numerically, not lexically", () => {
  expect(compareVersions("26.10", "26.9")).toBeGreaterThan(0);
  expect(compareVersions("26.2", "26.10")).toBeLessThan(0);
  expect(compareVersions("26.4", "26.4")).toBe(0);
});

test("compareVersions handles differing segment counts", () => {
  expect(compareVersions("26.4.1", "26.4")).toBeGreaterThan(0);
  expect(compareVersions("26", "26.0")).toBe(0);
});

test("SDK 57 requires Xcode 26.4 with 26.6 known-good", () => {
  const r = requirementsFor(57)!;
  expect(r.minXcode).toBe("26.4");
  expect(r.knownGoodXcode).toBe("26.6");
  expect(r.minNode).toBe("22.13.0");
});

test("SDK 54 floor is far below its known-good", () => {
  const r = requirementsFor(54)!;
  expect(r.minXcode).toBe("16.1");
  expect(r.knownGoodXcode).toBe("26.0");
});

test("unknown SDKs return undefined", () => {
  expect(requirementsFor(99)).toBeUndefined();
});

test("parseSdkMajor extracts the major from a dependency range", () => {
  expect(parseSdkMajor("^57.0.0")).toBe(57);
  expect(parseSdkMajor("~56.0.3")).toBe(56);
  expect(parseSdkMajor("54.0.0")).toBe(54);
  expect(parseSdkMajor("not-a-version")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/compat.test.ts`
Expected: FAIL — cannot resolve module `../src/compat`.

- [ ] **Step 3: Write the implementation**

Create `src/compat.ts`:

```ts
export interface SdkRequirement {
  /** Minimum Xcode Expo publishes for this SDK. */
  minXcode: string;
  /** The Xcode EAS Cloud actually builds this SDK with — the target we aim for. */
  knownGoodXcode: string;
  minNode: string;
  minJdk: string;
}

/**
 * Seeded only with entries verified against Expo's published requirements
 * on 2026-08-06. Older SDKs are added as verified, never guessed.
 *
 * Sources:
 *   https://docs.expo.dev/versions/latest/            (floors)
 *   https://docs.expo.dev/build-reference/infrastructure/ (EAS default image)
 */
export const SDK_REQUIREMENTS: Record<number, SdkRequirement> = {
  57: { minXcode: "26.4", knownGoodXcode: "26.6", minNode: "22.13.0", minJdk: "17" },
  56: { minXcode: "26.4", knownGoodXcode: "26.4", minNode: "20.19.4", minJdk: "17" },
  55: { minXcode: "26.2", knownGoodXcode: "26.2", minNode: "20.19.4", minJdk: "17" },
  54: { minXcode: "16.1", knownGoodXcode: "26.0", minNode: "20.19.4", minJdk: "17" },
  53: { minXcode: "16.1", knownGoodXcode: "16.4", minNode: "18.18.0", minJdk: "17" },
};

export function requirementsFor(sdkMajor: number): SdkRequirement | undefined {
  return SDK_REQUIREMENTS[sdkMajor];
}

/** Numeric, segment-wise version comparison. Returns <0, 0, or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Extract the major version from a package.json dependency range. */
export function parseSdkMajor(range: string): number | undefined {
  const match = range.match(/(\d+)\./);
  if (!match) return undefined;
  const major = parseInt(match[1]!, 10);
  return Number.isNaN(major) ? undefined : major;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/compat.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compat.ts test/compat.test.ts
git commit -m "feat: add Expo SDK requirement table and version comparison"
```

---

## Task 5: Tart image resolution

This is the SDK 57 fix. The old default was `macos-sequoia-xcode:26.2`, which is Xcode 26.2 — below SDK 56's floor of 26.4, so iOS builds failed.

**Critical behaviour:** SDK 54 must resolve to Xcode **26.0**, not the newest available tag. Expo documents that a newer-than-supported Xcode may fail, so "newest wins" is a bug.

**Files:**
- Modify: `src/compat.ts`
- Modify: `test/compat.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/compat.test.ts`:

```ts
import { resolveImage, type RepoTags } from "../src/compat";

const TAGS: RepoTags[] = [
  { repo: "ghcr.io/cirruslabs/macos-tahoe-xcode",
    tags: ["26.0.1", "26.1", "26.2", "26.3", "26.4", "26.4.1", "26.5", "26.5-beta", "latest"] },
  { repo: "ghcr.io/cirruslabs/macos-sequoia-xcode",
    tags: ["26.0", "26.1", "26.2", "26.3", "26.4", "26.4.1", "26.6", "26.4-rc", "latest"] },
];

test("SDK 57 resolves to the known-good 26.6, only available on sequoia", () => {
  const r = resolveImage(57, TAGS);
  expect(r.tag).toBe("26.6");
  expect(r.repo).toBe("ghcr.io/cirruslabs/macos-sequoia-xcode");
  expect(r.warnings).toEqual([]);
});

test("SDK 54 resolves to 26.0, NOT the newest tag", () => {
  const r = resolveImage(54, TAGS);
  expect(r.tag).toBe("26.0");
});

test("SDK 56 resolves to its known-good 26.4", () => {
  expect(resolveImage(56, TAGS).tag).toBe("26.4");
});

test("pre-release tags are never selected", () => {
  const r = resolveImage(57, [
    { repo: "ghcr.io/cirruslabs/macos-sequoia-xcode", tags: ["26.4", "26.7-beta", "26.8-rc"] },
  ]);
  expect(r.tag).toBe("26.4");
});

test("the literal tag 'latest' is never selected", () => {
  const r = resolveImage(56, [
    { repo: "ghcr.io/cirruslabs/macos-sequoia-xcode", tags: ["26.4", "latest"] },
  ]);
  expect(r.tag).toBe("26.4");
});

test("warns when nothing is within range and falls back above the floor", () => {
  const r = resolveImage(57, [
    { repo: "ghcr.io/cirruslabs/macos-sequoia-xcode", tags: ["26.9"] },
  ]);
  expect(r.tag).toBe("26.9");
  expect(r.warnings.join(" ")).toContain("exceeds");
});

test("errors when nothing meets the floor", () => {
  const r = resolveImage(57, [
    { repo: "ghcr.io/cirruslabs/macos-sequoia-xcode", tags: ["26.0", "26.2"] },
  ]);
  expect(r.tag).toBeUndefined();
  expect(r.warnings.join(" ")).toContain("No image");
});

test("unknown SDK picks the newest stable and warns", () => {
  const r = resolveImage(99, TAGS);
  expect(r.tag).toBe("26.6");
  expect(r.warnings.join(" ")).toContain("Unknown Expo SDK");
});

test("an explicit override is honoured and skips resolution", () => {
  const r = resolveImage(54, TAGS, "26.6");
  expect(r.tag).toBe("26.6");
});

test("an explicit override that does not exist is an error", () => {
  const r = resolveImage(54, TAGS, "99.9");
  expect(r.tag).toBeUndefined();
  expect(r.warnings.join(" ")).toContain("not available");
});

test("'latest' override picks the newest stable tag and warns", () => {
  const r = resolveImage(54, TAGS, "latest");
  expect(r.tag).toBe("26.6");
  expect(r.warnings.join(" ")).toContain("may fail");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/compat.test.ts`
Expected: FAIL — `resolveImage` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/compat.ts`:

```ts
export interface RepoTags {
  repo: string;
  tags: string[];
}

export interface ImageChoice {
  repo?: string;
  tag?: string;
  warnings: string[];
}

/** Tahoe is EAS's base for SDK 56+; sequoia below that. Used only to break ties. */
function preferredRepoFor(sdkMajor: number | undefined): string {
  return sdkMajor !== undefined && sdkMajor >= 56 ? "tahoe" : "sequoia";
}

const STABLE_TAG = /^\d+(\.\d+)*$/;

interface Candidate { repo: string; tag: string }

function stableCandidates(repos: RepoTags[]): Candidate[] {
  const out: Candidate[] = [];
  for (const { repo, tags } of repos) {
    for (const tag of tags) {
      if (STABLE_TAG.test(tag)) out.push({ repo, tag });
    }
  }
  return out;
}

/** Newest first; ties broken toward the preferred macOS base. */
function sortCandidates(candidates: Candidate[], prefer: string): Candidate[] {
  return [...candidates].sort((a, b) => {
    const byVersion = compareVersions(b.tag, a.tag);
    if (byVersion !== 0) return byVersion;
    const aPref = a.repo.includes(prefer) ? 0 : 1;
    const bPref = b.repo.includes(prefer) ? 0 : 1;
    return aPref - bPref;
  });
}

/**
 * Choose the Tart image for a project's Expo SDK.
 *
 * Targets the Xcode that EAS Cloud builds this SDK with, bounded below by
 * Expo's published floor. Deliberately NOT "newest wins" — Expo documents
 * that a newer-than-supported Xcode may fail.
 */
export function resolveImage(
  sdkMajor: number | undefined,
  repos: RepoTags[],
  override?: string,
): ImageChoice {
  const warnings: string[] = [];
  const candidates = stableCandidates(repos);
  const prefer = preferredRepoFor(sdkMajor);
  const sorted = sortCandidates(candidates, prefer);

  if (override && override !== "auto") {
    if (override === "latest") {
      const newest = sorted[0];
      warnings.push(
        'vm.xcode is "latest". Expo documents that an Xcode newer than an SDK supports may fail. ' +
        'Prefer "auto".'
      );
      if (!newest) {
        warnings.push("No stable image tags available.");
        return { warnings };
      }
      return { repo: newest.repo, tag: newest.tag, warnings };
    }
    const exact = sorted.find((c) => compareVersions(c.tag, override) === 0);
    if (!exact) {
      warnings.push(`Xcode ${override} is not available as a Tart image.`);
      return { warnings };
    }
    return { repo: exact.repo, tag: exact.tag, warnings };
  }

  const req = sdkMajor === undefined ? undefined : requirementsFor(sdkMajor);

  if (!req) {
    const newest = sorted[0];
    warnings.push(
      `Unknown Expo SDK${sdkMajor === undefined ? "" : ` ${sdkMajor}`}. ` +
      `Using the newest stable image; compatibility is unverified.`
    );
    if (!newest) {
      warnings.push("No stable image tags available.");
      return { warnings };
    }
    return { repo: newest.repo, tag: newest.tag, warnings };
  }

  const inRange = sorted.filter(
    (c) =>
      compareVersions(c.tag, req.minXcode) >= 0 &&
      compareVersions(c.tag, req.knownGoodXcode) <= 0
  );
  if (inRange[0]) return { repo: inRange[0].repo, tag: inRange[0].tag, warnings };

  const aboveFloor = sorted.filter((c) => compareVersions(c.tag, req.minXcode) >= 0);
  const fallback = aboveFloor[aboveFloor.length - 1];
  if (fallback) {
    warnings.push(
      `Xcode ${fallback.tag} exceeds ${req.knownGoodXcode}, which EAS Cloud uses for SDK ${sdkMajor}. ` +
      `Builds may fail.`
    );
    return { repo: fallback.repo, tag: fallback.tag, warnings };
  }

  warnings.push(
    `No image meets Expo SDK ${sdkMajor}'s minimum of Xcode ${req.minXcode}.`
  );
  return { warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/compat.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compat.ts test/compat.test.ts
git commit -m "feat: resolve Tart image from Expo SDK rather than pinning latest"
```

---

## Task 6: Fetching ghcr tags

**Files:**
- Modify: `src/compat.ts`
- Modify: `test/compat.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/compat.test.ts`:

```ts
import { IMAGE_REPOS, fetchRepoTags } from "../src/compat";

test("both image repos are queried", () => {
  expect(IMAGE_REPOS).toContain("cirruslabs/macos-tahoe-xcode");
  expect(IMAGE_REPOS).toContain("cirruslabs/macos-sequoia-xcode");
});

test("fetchRepoTags parses the registry response", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes("token")) {
      return new Response(JSON.stringify({ token: "abc" }));
    }
    return new Response(JSON.stringify({ name: "x", tags: ["26.4", "26.6"] }));
  }) as unknown as typeof fetch;

  const result = await fetchRepoTags("cirruslabs/macos-sequoia-xcode", fakeFetch);
  expect(result.tags).toEqual(["26.4", "26.6"]);
  expect(calls[0]).toContain("ghcr.io/token");
});

test("fetchRepoTags returns empty tags when the registry fails", async () => {
  const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const result = await fetchRepoTags("cirruslabs/macos-sequoia-xcode", failing);
  expect(result.tags).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/compat.test.ts`
Expected: FAIL — `IMAGE_REPOS` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/compat.ts`:

```ts
export const IMAGE_REPOS = [
  "cirruslabs/macos-tahoe-xcode",
  "cirruslabs/macos-sequoia-xcode",
] as const;

/**
 * List tags for a ghcr repo. Anonymous pull-scoped tokens work, so no
 * credentials are needed. Never throws — a registry failure degrades to
 * an empty tag list so callers can fall back to cached data.
 */
export async function fetchRepoTags(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoTags> {
  const full = `ghcr.io/${repo}`;
  try {
    const tokenRes = await fetchImpl(
      `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${repo}:pull`)}&service=ghcr.io`
    );
    if (!tokenRes.ok) return { repo: full, tags: [] };
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) return { repo: full, tags: [] };

    const tagsRes = await fetchImpl(`https://ghcr.io/v2/${repo}/tags/list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!tagsRes.ok) return { repo: full, tags: [] };
    const body = (await tagsRes.json()) as { tags?: string[] };
    return { repo: full, tags: body.tags ?? [] };
  } catch {
    return { repo: full, tags: [] };
  }
}

export async function fetchAllRepoTags(fetchImpl: typeof fetch = fetch): Promise<RepoTags[]> {
  return Promise.all(IMAGE_REPOS.map((r) => fetchRepoTags(r, fetchImpl)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/compat.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compat.ts test/compat.test.ts
git commit -m "feat: list Tart image tags from ghcr anonymously"
```

---

## Task 6b: Compat cache

Spec §7 requires that `build --remote` never blocks on the network for compatibility checks, and that `doctor --refresh` refreshes the data. This is the cache that makes both true.

**Files:**
- Create: `src/compat-cache.ts`
- Create: `test/compat-cache.test.ts`
- Modify: `src/args.ts`

- [ ] **Step 1: Write the failing test**

Create `test/compat-cache.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCompatTags, isStale, CACHE_TTL_MS } from "../src/compat-cache";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "expo-builder-compat-"));
}

const TAGS = [{ repo: "ghcr.io/cirruslabs/macos-sequoia-xcode", tags: ["26.6"] }];

test("a cache newer than the TTL is not stale", () => {
  expect(isStale(Date.now() - 1000)).toBe(false);
});

test("a cache older than the TTL is stale", () => {
  expect(isStale(Date.now() - CACHE_TTL_MS - 1000)).toBe(true);
});

test("a fresh cache is used without any network call", async () => {
  const dir = scratch();
  const path = join(dir, "compat.json");
  writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), tags: TAGS }));

  let called = false;
  const result = await loadCompatTags({
    cachePath: path,
    fetchImpl: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch,
  });

  expect(called).toBe(false);
  expect(result.tags).toEqual(TAGS);
  expect(result.fromCache).toBe(true);
});

test("forceRefresh fetches even when the cache is fresh", async () => {
  const dir = scratch();
  const path = join(dir, "compat.json");
  writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), tags: TAGS }));

  const fakeFetch = (async (url: string) => {
    if (String(url).includes("token")) return new Response(JSON.stringify({ token: "t" }));
    return new Response(JSON.stringify({ tags: ["26.9"] }));
  }) as unknown as typeof fetch;

  const result = await loadCompatTags({ cachePath: path, fetchImpl: fakeFetch, forceRefresh: true });
  expect(result.fromCache).toBe(false);
  expect(result.tags.some((r) => r.tags.includes("26.9"))).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf-8")).tags[0].tags).toContain("26.9");
});

test("a stale cache is still returned when the network fails", async () => {
  const dir = scratch();
  const path = join(dir, "compat.json");
  writeFileSync(path, JSON.stringify({ fetchedAt: Date.now() - CACHE_TTL_MS - 1, tags: TAGS }));

  const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  const result = await loadCompatTags({ cachePath: path, fetchImpl: failing });

  expect(result.tags).toEqual(TAGS);
  expect(result.degraded).toBe(true);
});

test("a missing cache fetches and writes one", async () => {
  const dir = scratch();
  const path = join(dir, "compat.json");
  const fakeFetch = (async (url: string) => {
    if (String(url).includes("token")) return new Response(JSON.stringify({ token: "t" }));
    return new Response(JSON.stringify({ tags: ["26.4"] }));
  }) as unknown as typeof fetch;

  const result = await loadCompatTags({ cachePath: path, fetchImpl: fakeFetch });
  expect(result.fromCache).toBe(false);
  expect(existsSync(path)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/compat-cache.test.ts`
Expected: FAIL — cannot resolve module `../src/compat-cache`.

- [ ] **Step 3: Write the implementation**

Create `src/compat-cache.ts`:

```ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fetchAllRepoTags, type RepoTags } from "./compat";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CACHE_PATH = join(homedir(), ".expo-builder", "compat.json");

interface CacheFile {
  fetchedAt: number;
  tags: RepoTags[];
}

export function isStale(fetchedAt: number, now: number = Date.now()): boolean {
  return now - fetchedAt > CACHE_TTL_MS;
}

export interface LoadCompatOptions {
  cachePath?: string;
  fetchImpl?: typeof fetch;
  forceRefresh?: boolean;
}

export interface CompatResult {
  tags: RepoTags[];
  fromCache: boolean;
  /** True when the network failed and stale cached data was used instead. */
  degraded: boolean;
}

function readCache(path: string): CacheFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
  } catch {
    return undefined;
  }
}

function writeCache(path: string, tags: RepoTags[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), tags } satisfies CacheFile, null, 2));
}

/**
 * Return image tags, preferring a fresh cache so builds never block on the
 * network. Falls back to stale cached data when the registry is unreachable.
 */
export async function loadCompatTags(opts: LoadCompatOptions = {}): Promise<CompatResult> {
  const path = opts.cachePath ?? DEFAULT_CACHE_PATH;
  const cached = readCache(path);

  if (!opts.forceRefresh && cached && !isStale(cached.fetchedAt)) {
    return { tags: cached.tags, fromCache: true, degraded: false };
  }

  const fetched = await fetchAllRepoTags(opts.fetchImpl ?? fetch);
  const gotAnything = fetched.some((r) => r.tags.length > 0);

  if (!gotAnything) {
    if (cached) return { tags: cached.tags, fromCache: true, degraded: true };
    return { tags: [], fromCache: false, degraded: true };
  }

  writeCache(path, fetched);
  return { tags: fetched, fromCache: false, degraded: false };
}
```

- [ ] **Step 4: Add the --refresh flag**

In `src/args.ts`, add `refresh: boolean;` to the `Flags` interface, `"--refresh": "refresh",` to `BOOLEAN_FLAGS`, and `refresh: false,` to the flags initialiser inside `parseArgs`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/compat-cache.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/compat-cache.ts test/compat-cache.test.ts src/args.ts
git commit -m "feat: cache image tag data so builds never block on the network"
```

---

## Task 7: Volume validation and image retention

Implements the external-storage checks from spec §6. The APFS check is a **hard error**: without `clonefile`, every `tart clone` becomes a full ~80 GB byte copy, silently.

**Files:**
- Create: `src/remote/storage.ts`
- Create: `test/storage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/storage.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseDiskutilInfo, validateVolume, deriveKeepImages, GB } from "../src/remote/storage";

const apfsSsd = `
   Device Identifier:        disk5s1
   Volume Name:              BuildSSD
   Mounted:                  Yes
   File System Personality:  APFS
   Type (Bundle):            apfs
   Owners:                   Enabled
   Protocol:                 USB
   SMART Status:             Verified
   Solid State:              Yes
   Volume Free Space:        900.0 GB (900000000000 Bytes)
`;

test("parses an APFS SSD volume", () => {
  const v = parseDiskutilInfo(apfsSsd);
  expect(v.isAPFS).toBe(true);
  expect(v.ownershipEnabled).toBe(true);
  expect(v.solidState).toBe(true);
  expect(v.freeBytes).toBe(900000000000);
});

test("an APFS SSD with ownership enabled passes cleanly", () => {
  const r = validateVolume(parseDiskutilInfo(apfsSsd));
  expect(r.errors).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("a non-APFS volume is a hard error mentioning clonefile cost", () => {
  const v = parseDiskutilInfo(apfsSsd.replace("APFS", "ExFAT").replace("apfs", "exfat"));
  const r = validateVolume(v);
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toContain("APFS");
  expect(r.errors[0]).toContain("copy");
});

test("ownership disabled is an error with the enableOwnership remedy", () => {
  const v = parseDiskutilInfo(apfsSsd.replace("Owners:                   Enabled", "Owners:                   Disabled"));
  const r = validateVolume(v);
  expect(r.errors.join(" ")).toContain("enableOwnership");
});

test("rotational media warns but does not block", () => {
  const v = parseDiskutilInfo(apfsSsd.replace("Solid State:              Yes", "Solid State:              No"));
  const r = validateVolume(v);
  expect(r.errors).toEqual([]);
  expect(r.warnings.join(" ")).toContain("slower");
});

test("network volumes are rejected", () => {
  const v = parseDiskutilInfo(apfsSsd.replace("Protocol:                 USB", "Protocol:                 SMB"));
  const r = validateVolume(v);
  expect(r.errors.join(" ")).toContain("Network");
});

test("keepImages is 1 below the 150GB threshold", () => {
  expect(deriveKeepImages(100 * GB, "auto")).toBe(1);
  expect(deriveKeepImages(149 * GB, "auto")).toBe(1);
});

test("keepImages grows with free space, capped at 3", () => {
  expect(deriveKeepImages(200 * GB, "auto")).toBe(2);
  expect(deriveKeepImages(400 * GB, "auto")).toBe(3);
  expect(deriveKeepImages(2000 * GB, "auto")).toBe(3);
});

test("an explicit keepImages overrides derivation", () => {
  expect(deriveKeepImages(100 * GB, 3)).toBe(3);
});

test("eviction keeps the most recently accessed images up to the limit", () => {
  const evict = planImageEviction(
    [
      { name: "expo-builder-xcode-26.6", accessed: 300 },
      { name: "expo-builder-xcode-26.4", accessed: 200 },
      { name: "expo-builder-xcode-26.2", accessed: 100 },
    ],
    2,
  );
  expect(evict).toEqual(["expo-builder-xcode-26.2"]);
});

test("eviction is empty when under the limit", () => {
  expect(planImageEviction([{ name: "a", accessed: 1 }], 3)).toEqual([]);
});
```

Update the import line at the top of this file to include the eviction helper:

```ts
import { parseDiskutilInfo, validateVolume, deriveKeepImages, planImageEviction, GB } from "../src/remote/storage";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/storage.test.ts`
Expected: FAIL — cannot resolve module `../src/remote/storage`.

- [ ] **Step 3: Write the implementation**

Create `src/remote/storage.ts`:

```ts
export const GB = 1024 * 1024 * 1024;

/** Below this much free space, only one provisioned image is affordable. */
export const SINGLE_IMAGE_THRESHOLD = 150 * GB;
/** Roughly one provisioned image plus its share of the retained OCI cache. */
export const BYTES_PER_IMAGE = 92 * GB;
export const MAX_KEPT_IMAGES = 3;

export interface VolumeInfo {
  name: string;
  isAPFS: boolean;
  ownershipEnabled: boolean;
  solidState: boolean;
  isNetwork: boolean;
  freeBytes: number;
}

const NETWORK_PROTOCOLS = ["smb", "nfs", "afp", "network"];

function field(text: string, label: string): string {
  const match = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "mi"));
  return match?.[1]?.trim() ?? "";
}

export function parseDiskutilInfo(text: string): VolumeInfo {
  const personality = field(text, "File System Personality").toLowerCase();
  const bundle = field(text, "Type \\(Bundle\\)").toLowerCase();
  const protocol = field(text, "Protocol").toLowerCase();
  const freeRaw = field(text, "Volume Free Space");
  const bytesMatch = freeRaw.match(/\((\d+)\s*Bytes\)/i);

  return {
    name: field(text, "Volume Name"),
    isAPFS: personality.includes("apfs") || bundle.includes("apfs"),
    ownershipEnabled: field(text, "Owners").toLowerCase().startsWith("enabled"),
    solidState: field(text, "Solid State").toLowerCase().startsWith("yes"),
    isNetwork: NETWORK_PROTOCOLS.some((p) => protocol.includes(p)),
    freeBytes: bytesMatch ? parseInt(bytesMatch[1]!, 10) : 0,
  };
}

export interface VolumeValidation {
  errors: string[];
  warnings: string[];
}

export function validateVolume(v: VolumeInfo): VolumeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (v.isNetwork) {
    errors.push(
      `Network volumes cannot back a Tart VM disk. Use a locally attached APFS volume.`
    );
    return { errors, warnings };
  }

  if (!v.isAPFS) {
    errors.push(
      `Volume "${v.name}" is not APFS. Tart relies on APFS clonefile(2) for copy-on-write; ` +
      `without it every build would copy the full VM image (~80 GB) before starting. ` +
      `Reformat as APFS.`
    );
  }

  if (!v.ownershipEnabled) {
    errors.push(
      `Ownership is disabled on "${v.name}", which makes Tart fail with permission errors. ` +
      `Fix with: sudo diskutil enableOwnership /Volumes/${v.name}`
    );
  }

  if (!v.solidState) {
    warnings.push(
      `Volume "${v.name}" is not solid state. VM builds are random-I/O heavy and will be ` +
      `substantially slower on rotational media. An external SSD is strongly recommended.`
    );
  }

  return { errors, warnings };
}

/** Retention derived from free space, per spec §7. */
export function deriveKeepImages(freeBytes: number, setting: number | "auto"): number {
  if (setting !== "auto") return setting;
  if (freeBytes < SINGLE_IMAGE_THRESHOLD) return 1;
  const affordable = Math.floor(freeBytes / BYTES_PER_IMAGE);
  return Math.max(1, Math.min(MAX_KEPT_IMAGES, affordable));
}

export interface ImageEntry {
  name: string;
  /** Epoch seconds of last access; higher is more recent. */
  accessed: number;
}

/**
 * Least-recently-accessed images beyond the retention limit.
 * Lives here rather than in commands/vm.ts because setup/tart.ts also needs
 * it, and importing it from the command module would create a cycle.
 */
export function planImageEviction(images: ImageEntry[], keep: number): string[] {
  return [...images]
    .sort((a, b) => b.accessed - a.accessed)
    .slice(keep)
    .map((i) => i.name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/storage.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote/storage.ts test/storage.test.ts
git commit -m "feat: validate Tart storage volumes and derive image retention"
```

---

## Task 8: Marker protocol parsing

**Files:**
- Create: `src/remote/markers.ts`
- Create: `test/markers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/markers.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseMarker } from "../src/remote/markers";

test("parses a phase marker", () => {
  expect(parseMarker("::phase::build")).toEqual({ kind: "phase", value: "build" });
});

test("parses vm-ip, boot-wait, version, stale and error markers", () => {
  expect(parseMarker("::vm-ip::192.168.64.7")).toEqual({ kind: "vm-ip", value: "192.168.64.7" });
  expect(parseMarker("::boot-wait::12")).toEqual({ kind: "boot-wait", value: "12" });
  expect(parseMarker("::version::4 → 5")).toEqual({ kind: "version", value: "4 → 5" });
  expect(parseMarker("::stale::expo-builder-build-1")).toEqual({ kind: "stale", value: "expo-builder-build-1" });
  expect(parseMarker("::error::it broke")).toEqual({ kind: "error", value: "it broke" });
});

test("returns null for ordinary output", () => {
  expect(parseMarker("Compiling AppDelegate.swift")).toBeNull();
  expect(parseMarker("::not-a-marker")).toBeNull();
});

test("unknown marker kinds are ignored rather than misparsed", () => {
  expect(parseMarker("::teleport::somewhere")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/markers.test.ts`
Expected: FAIL — cannot resolve module `../src/remote/markers`.

- [ ] **Step 3: Write the implementation**

Create `src/remote/markers.ts`:

```ts
export const MARKER_KINDS = [
  "phase", "vm-ip", "boot-wait", "version", "stale", "error", "vm-resources", "image-size",
] as const;

export type MarkerKind = (typeof MARKER_KINDS)[number];

export interface Marker {
  kind: MarkerKind;
  value: string;
}

const MARKER_RE = /^::([a-z-]+)::(.*)$/;

export function parseMarker(line: string): Marker | null {
  const match = line.match(MARKER_RE);
  if (!match) return null;
  const kind = match[1] as MarkerKind;
  if (!(MARKER_KINDS as readonly string[]).includes(kind)) return null;
  return { kind, value: match[2] ?? "" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/markers.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote/markers.ts test/markers.test.ts
git commit -m "feat: add marker protocol parsing"
```

---

## Task 9: Config discovery and merging

Replaces the old `.env`-in-the-tool-directory model, which is impossible once the tool lives in `node_modules`.

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/config.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mergeConfig, parseMacTarget, findMobileDir, resolveExpoToken } from "../src/config";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "expo-builder-test-"));
}

test("parseMacTarget accepts the shorthand string form", () => {
  expect(parseMacTarget("mingu@defymac")).toEqual({ user: "mingu", host: "defymac" });
});

test("parseMacTarget accepts a host with no user", () => {
  expect(parseMacTarget("defymac")).toEqual({ host: "defymac" });
});

test("parseMacTarget passes through the object form", () => {
  expect(parseMacTarget({ host: "defymac", user: "mingu" })).toEqual({ host: "defymac", user: "mingu" });
});

test("project config wins over user config", () => {
  const merged = mergeConfig(
    { mac: { host: "user-mac" }, cache: { budgetGB: 30 } },
    { mac: { host: "project-mac" } },
  );
  expect(merged.mac?.host).toBe("project-mac");
  expect(merged.cache?.budgetGB).toBe(30);
});

test("findMobileDir picks the cwd when it holds an Expo project", () => {
  const dir = scratch();
  writeFileSync(join(dir, "app.json"), "{}");
  writeFileSync(join(dir, "eas.json"), "{}");
  expect(findMobileDir(dir, dir)).toBe(dir);
});

test("findMobileDir searches one level down from the root", () => {
  const root = scratch();
  const mobile = join(root, "mobile");
  mkdirSync(mobile);
  writeFileSync(join(mobile, "app.config.ts"), "");
  writeFileSync(join(mobile, "eas.json"), "{}");
  expect(findMobileDir(root, root)).toBe(mobile);
});

test("findMobileDir returns undefined when several candidates exist", () => {
  const root = scratch();
  for (const name of ["mobile", "other"]) {
    const d = join(root, name);
    mkdirSync(d);
    writeFileSync(join(d, "app.json"), "{}");
    writeFileSync(join(d, "eas.json"), "{}");
  }
  expect(findMobileDir(root, root)).toBeUndefined();
});

test("resolveExpoToken prefers the environment", () => {
  const dir = scratch();
  writeFileSync(join(dir, ".env"), "EXPO_TOKEN=from_file\n");
  expect(resolveExpoToken({ EXPO_TOKEN: "from_env" }, [join(dir, ".env")])).toBe("from_env");
});

test("resolveExpoToken falls back to the first env file that has it", () => {
  const dir = scratch();
  writeFileSync(join(dir, ".env"), "OTHER=1\nEXPO_TOKEN=from_file\n");
  expect(resolveExpoToken({}, [join(dir, ".env")])).toBe("from_file");
});

test("resolveExpoToken returns undefined when absent everywhere", () => {
  expect(resolveExpoToken({}, [])).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — cannot resolve module `../src/config`.

- [ ] **Step 3: Write the implementation**

Create `src/config.ts`:

```ts
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

export interface MacTarget {
  host: string;
  user?: string;
  sshKey?: string;
  tartHome?: string;
}

export interface VmConfig {
  xcode?: string | "auto" | "latest";
  name?: string;
  keepImages?: number | "auto";
}

export interface CacheConfig {
  enabled?: boolean;
  budgetGB?: number;
}

export interface UserConfig {
  mac?: MacTarget | string;
  mobileDir?: string;
  syncPaths?: string[];
  vm?: VmConfig;
  cache?: CacheConfig;
}

export interface ResolvedConfig {
  mac: MacTarget;
  projectRoot: string;
  mobileDir: string;
  slug: string;
  syncPaths: string[];
  vm: Required<Pick<VmConfig, "xcode" | "name">> & { keepImages: number | "auto" };
  cache: Required<CacheConfig>;
  expoToken?: string;
}

export const CONFIG_FILENAME = "expo-builder.json";
export const USER_CONFIG_PATH = join(homedir(), ".expo-builder", "config.json");

const EXPO_CONFIG_FILES = ["app.json", "app.config.js", "app.config.ts"];

export function parseMacTarget(mac: MacTarget | string): MacTarget {
  if (typeof mac !== "string") return mac;
  const at = mac.indexOf("@");
  if (at === -1) return { host: mac };
  return { user: mac.slice(0, at), host: mac.slice(at + 1) };
}

/** Project config wins over user config; nested objects merge one level deep. */
export function mergeConfig(user: UserConfig, project: UserConfig): UserConfig {
  return {
    ...user,
    ...project,
    mac: project.mac ?? user.mac,
    vm: { ...user.vm, ...project.vm },
    cache: { ...user.cache, ...project.cache },
    syncPaths: project.syncPaths ?? user.syncPaths,
  };
}

function isExpoProject(dir: string): boolean {
  const hasExpoConfig = EXPO_CONFIG_FILES.some((f) => existsSync(join(dir, f)));
  return hasExpoConfig && existsSync(join(dir, "eas.json"));
}

/**
 * Locate the Expo project. Prefers cwd, else searches one level below root.
 * Returns undefined when ambiguous so the caller can prompt or error clearly.
 */
export function findMobileDir(cwd: string, root: string): string | undefined {
  if (isExpoProject(cwd)) return cwd;
  if (isExpoProject(root)) return root;

  const candidates: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const dir = join(root, entry.name);
    if (isExpoProject(dir)) candidates.push(dir);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const match = readFileSync(path, "utf-8").match(new RegExp(`^${key}=(.+)$`, "m"));
  return match?.[1]?.trim();
}

/** Environment first, then each candidate .env file in order. Never from config JSON. */
export function resolveExpoToken(
  env: Record<string, string | undefined>,
  envFiles: string[],
): string | undefined {
  if (env.EXPO_TOKEN) return env.EXPO_TOKEN;
  for (const file of envFiles) {
    const value = readEnvValue(file, "EXPO_TOKEN");
    if (value) return value;
  }
  return undefined;
}

export function readConfigFile(path: string): UserConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as UserConfig;
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
}

export function readSlug(mobileDir: string): string {
  const appJson = join(mobileDir, "app.json");
  if (existsSync(appJson)) {
    try {
      const parsed = JSON.parse(readFileSync(appJson, "utf-8")) as { expo?: { slug?: string } };
      if (parsed.expo?.slug) return parsed.expo.slug;
    } catch { /* fall through to package.json */ }
  }
  const pkg = join(mobileDir, "package.json");
  if (existsSync(pkg)) {
    try {
      const parsed = JSON.parse(readFileSync(pkg, "utf-8")) as { name?: string };
      if (parsed.name) return parsed.name.replace(/^@[^/]+\//, "");
    } catch { /* fall through to directory name */ }
  }
  return resolve(mobileDir).split(/[\\/]/).pop() ?? "app";
}

export function readExpoSdkRange(mobileDir: string): string | undefined {
  const pkg = join(mobileDir, "package.json");
  if (!existsSync(pkg)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pkg, "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    return parsed.dependencies?.expo;
  } catch {
    return undefined;
  }
}

export const CONFIG_DEFAULTS = {
  vm: { xcode: "auto" as const, name: "expo-builder", keepImages: "auto" as const },
  cache: { enabled: true, budgetGB: 15 },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: discover config from the project instead of the tool directory"
```

---

## Task 10: Sync-set computation

The old `collectSyncFiles` walked the entire monorepo. On the real project that dragged in a 20 GB `admin/runpod` directory. This scopes it to the mobile dir plus what it actually needs.

**Files:**
- Create: `src/remote/sync.ts`
- Create: `test/sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/sync.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveWorkspaceDeps, computeSyncRoots, collectFiles } from "../src/remote/sync";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "expo-builder-sync-"));
}

test("resolveWorkspaceDeps finds direct workspace dependencies", () => {
  const root = scratch();
  mkdirSync(join(root, "packages", "shared"), { recursive: true });
  mkdirSync(join(root, "mobile"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*", "mobile"] }));
  writeFileSync(join(root, "packages", "shared", "package.json"), JSON.stringify({ name: "@app/shared" }));
  writeFileSync(join(root, "mobile", "package.json"), JSON.stringify({
    name: "mobile",
    dependencies: { "@app/shared": "workspace:*" },
  }));

  expect(resolveWorkspaceDeps(root, join(root, "mobile"))).toEqual([join(root, "packages", "shared")]);
});

test("resolveWorkspaceDeps resolves transitively without infinite looping on cycles", () => {
  const root = scratch();
  for (const name of ["a", "b"]) mkdirSync(join(root, "packages", name), { recursive: true });
  mkdirSync(join(root, "mobile"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*", "mobile"] }));
  writeFileSync(join(root, "packages", "a", "package.json"), JSON.stringify({
    name: "@app/a", dependencies: { "@app/b": "workspace:*" },
  }));
  writeFileSync(join(root, "packages", "b", "package.json"), JSON.stringify({
    name: "@app/b", dependencies: { "@app/a": "workspace:*" },
  }));
  writeFileSync(join(root, "mobile", "package.json"), JSON.stringify({
    name: "mobile", dependencies: { "@app/a": "workspace:*" },
  }));

  const deps = resolveWorkspaceDeps(root, join(root, "mobile")).sort();
  expect(deps).toEqual([join(root, "packages", "a"), join(root, "packages", "b")].sort());
});

test("resolveWorkspaceDeps ignores non-workspace dependencies", () => {
  const root = scratch();
  mkdirSync(join(root, "mobile"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["mobile"] }));
  writeFileSync(join(root, "mobile", "package.json"), JSON.stringify({
    name: "mobile", dependencies: { react: "19.2.3" },
  }));
  expect(resolveWorkspaceDeps(root, join(root, "mobile"))).toEqual([]);
});

test("computeSyncRoots includes the mobile dir, workspace deps and explicit paths", () => {
  const root = scratch();
  const roots = computeSyncRoots({
    projectRoot: root,
    mobileDir: join(root, "mobile"),
    workspaceDeps: [join(root, "packages", "shared")],
    syncPaths: ["config"],
  });
  expect(roots).toContain("mobile");
  expect(roots).toContain("packages/shared");
  expect(roots).toContain("config");
});

test("computeSyncRoots includes root manifests when the mobile dir is nested", () => {
  const root = scratch();
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "bun.lock"), "");
  const roots = computeSyncRoots({
    projectRoot: root,
    mobileDir: join(root, "mobile"),
    workspaceDeps: [],
    syncPaths: [],
  });
  expect(roots).toContain("package.json");
  expect(roots).toContain("bun.lock");
});

test("computeSyncRoots omits root manifests when the mobile dir is the root", () => {
  const root = scratch();
  writeFileSync(join(root, "package.json"), "{}");
  const roots = computeSyncRoots({
    projectRoot: root,
    mobileDir: root,
    workspaceDeps: [],
    syncPaths: [],
  });
  expect(roots).toEqual(["."]);
});

test("collectFiles honours .gitignore and always excludes .git", () => {
  const root = scratch();
  mkdirSync(join(root, "mobile", "src"), { recursive: true });
  mkdirSync(join(root, "mobile", "node_modules"), { recursive: true });
  mkdirSync(join(root, "mobile", ".git"), { recursive: true });
  writeFileSync(join(root, "mobile", ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "mobile", "src", "index.ts"), "");
  writeFileSync(join(root, "mobile", "node_modules", "dep.js"), "");
  writeFileSync(join(root, "mobile", ".git", "HEAD"), "");

  const files = collectFiles(root, ["mobile"]);
  expect(files).toContain("mobile/src/index.ts");
  expect(files).not.toContain("mobile/node_modules/dep.js");
  expect(files.some((f) => f.includes(".git/"))).toBe(false);
});

test("collectFiles honours .easignore in addition to .gitignore", () => {
  const root = scratch();
  mkdirSync(join(root, "mobile", "fixtures"), { recursive: true });
  writeFileSync(join(root, "mobile", ".easignore"), "fixtures/\n");
  writeFileSync(join(root, "mobile", "fixtures", "big.bin"), "");
  writeFileSync(join(root, "mobile", "app.json"), "{}");

  const files = collectFiles(root, ["mobile"]);
  expect(files).toContain("mobile/app.json");
  expect(files).not.toContain("mobile/fixtures/big.bin");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/sync.test.ts`
Expected: FAIL — cannot resolve module `../src/remote/sync`.

- [ ] **Step 3: Write the implementation**

Create `src/remote/sync.ts`:

```ts
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import ignore, { type Ignore } from "ignore";

/** Root-level files a nested mobile dir needs for a workspace install to succeed. */
const ROOT_MANIFESTS = [
  "package.json",
  "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "turbo.json", "nx.json",
  "tsconfig.json", "tsconfig.base.json",
  ".npmrc", ".nvmrc",
];

const ALWAYS_EXCLUDE = [".git", "node_modules", ".expo", ".temp", ".ssh-key"];

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function readPackageJson(dir: string): { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: string[] | { packages?: string[] } } | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function workspacePatterns(root: string): string[] {
  const pkg = readPackageJson(root);
  if (!pkg?.workspaces) return [];
  return Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages ?? [];
}

/** Expand simple `dir/*` and literal workspace globs into directories. */
function expandWorkspaces(root: string, patterns: string[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const pattern of patterns) {
    const dirs: string[] = [];
    if (pattern.endsWith("/*")) {
      const parent = join(root, pattern.slice(0, -2));
      if (existsSync(parent)) {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (entry.isDirectory()) dirs.push(join(parent, entry.name));
        }
      }
    } else {
      const dir = join(root, pattern);
      if (existsSync(dir)) dirs.push(dir);
    }
    for (const dir of dirs) {
      const name = readPackageJson(dir)?.name;
      if (name) byName.set(name, dir);
    }
  }
  return byName;
}

/**
 * Transitively resolve `workspace:`-protocol dependencies of the mobile package.
 * Cycle-safe. Returns absolute directories, excluding the mobile dir itself.
 */
export function resolveWorkspaceDeps(projectRoot: string, mobileDir: string): string[] {
  const byName = expandWorkspaces(projectRoot, workspacePatterns(projectRoot));
  const seen = new Set<string>();
  const out: string[] = [];

  const visit = (dir: string) => {
    const pkg = readPackageJson(dir);
    if (!pkg) return;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(deps)) {
      if (!range.startsWith("workspace:")) continue;
      const target = byName.get(name);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      out.push(target);
      visit(target);
    }
  };

  visit(mobileDir);
  return out.filter((d) => resolve(d) !== resolve(mobileDir));
}

export interface SyncRootsOptions {
  projectRoot: string;
  mobileDir: string;
  workspaceDeps: string[];
  syncPaths: string[];
}

/**
 * Compute the set of paths to sync, relative to projectRoot.
 * Returns ["."] when the mobile dir *is* the project root.
 */
export function computeSyncRoots(opts: SyncRootsOptions): string[] {
  const { projectRoot, mobileDir, workspaceDeps, syncPaths } = opts;
  const mobileRel = toPosix(relative(projectRoot, mobileDir));

  if (mobileRel === "" || mobileRel === ".") return ["."];

  const roots = new Set<string>([mobileRel]);
  for (const dep of workspaceDeps) roots.add(toPosix(relative(projectRoot, dep)));
  for (const extra of syncPaths) roots.add(toPosix(extra));
  for (const manifest of ROOT_MANIFESTS) {
    if (existsSync(join(projectRoot, manifest))) roots.add(manifest);
  }
  return [...roots];
}

function loadIgnores(dir: string): Ignore {
  const ig = ignore().add(ALWAYS_EXCLUDE);
  for (const name of [".gitignore", ".easignore"]) {
    const path = join(dir, name);
    if (existsSync(path)) ig.add(readFileSync(path, "utf-8"));
  }
  return ig;
}

/**
 * Walk each sync root and return POSIX-relative file paths suitable for
 * `rsync --files-from`. Ignore rules are loaded per root directory.
 */
export function collectFiles(projectRoot: string, roots: string[]): string[] {
  const files: string[] = [];

  const walk = (absDir: string, relDir: string, ig: Ignore) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const testPath = entry.isDirectory() ? `${entry.name}/` : entry.name;
      if (ig.ignores(testPath) || ig.ignores(relPath)) continue;
      if (entry.isDirectory()) {
        walk(join(absDir, entry.name), relPath, ig);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  };

  for (const root of roots) {
    const abs = root === "." ? projectRoot : join(projectRoot, root);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) {
      files.push(toPosix(root));
      continue;
    }
    const ig = loadIgnores(abs);
    walk(abs, root === "." ? "" : toPosix(root), ig);
  }

  return files;
}
```

Note on the ignore check: `ig.ignores` is called with both the bare entry name and the root-relative path, because `ignore` matches patterns like `node_modules/` against a path segment while patterns like `mobile/build` need the fuller path.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/sync.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote/sync.ts test/sync.test.ts
git commit -m "feat: scope the sync set to the mobile dir and its workspace deps"
```

---

## Task 11: VM build script generation

The bash that runs **inside** the ephemeral VM. Two behavioural changes from the old version: `EAS_NO_VCS=1` replaces the per-build `git init`, and the build happens on the VM's own disk rather than in the mounted directory.

**Files:**
- Create: `src/remote/vm-script.ts`
- Create: `test/vm-script.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/vm-script.test.ts`:

```ts
import { expect, test } from "bun:test";
import { generateVmScript, type VmScriptOptions } from "../src/remote/vm-script";

const base: VmScriptOptions = {
  expoToken: "expo_test_token",
  profile: "preview",
  platform: "ios",
  submit: false,
  optimize: true,
  cacheEnabled: true,
  mountName: "my-app",
  mobileRelPath: "mobile",
  javaVersion: "17",
};

test("sets EAS_NO_VCS so no git repo is required", () => {
  expect(generateVmScript(base)).toContain("export EAS_NO_VCS=1");
});

test("never runs git init", () => {
  expect(generateVmScript(base)).not.toContain("git init");
});

test("copies source off the mount and builds on the VM's own disk", () => {
  const script = generateVmScript(base);
  expect(script).toContain("/Volumes/My Shared Files/my-app");
  expect(script).toContain("$HOME/work");
  const buildLine = script.split("\n").find((l) => l.includes("eas build --local"))!;
  expect(buildLine).toContain("$HOME/out/");
});

test("writes the artifact outside the mounted directory", () => {
  expect(generateVmScript(base)).not.toContain("--output build/output");
});

test("emits phase markers in order", () => {
  const script = generateVmScript(base);
  const phases = [...script.matchAll(/::phase::(\S+)/g)].map((m) => m[1]);
  expect(phases).toEqual(["stage", "env-pull", "install", "build", "version"]);
});

test("includes a submit phase only when submitting", () => {
  expect(generateVmScript(base)).not.toContain("::phase::submit");
  expect(generateVmScript({ ...base, submit: true })).toContain("::phase::submit");
});

test("points cache env vars at the mounted cache when enabled", () => {
  const script = generateVmScript(base);
  expect(script).toContain("BUN_INSTALL_CACHE_DIR=");
  expect(script).toContain("CP_HOME_DIR=");
  expect(script).toContain("GRADLE_USER_HOME=");
  expect(script).toContain("/Volumes/My Shared Files/expo-builder-cache");
});

test("omits cache env vars when caching is disabled", () => {
  const script = generateVmScript({ ...base, cacheEnabled: false });
  expect(script).not.toContain("expo-builder-cache");
});

test("writes gradle config into GRADLE_USER_HOME, not ~/.gradle", () => {
  const script = generateVmScript({ ...base, platform: "android" });
  expect(script).toContain('"$GRADLE_USER_HOME"/gradle.properties');
  expect(script).not.toContain("~/.gradle/gradle.properties");
});

test("android builds disable lintVital", () => {
  expect(generateVmScript({ ...base, platform: "android" })).toContain("lintVital");
});

test("injects the config plugin only when optimizing", () => {
  expect(generateVmScript(base)).toContain("withBuildOptimizations");
  expect(generateVmScript({ ...base, optimize: false })).not.toContain("withBuildOptimizations");
});

test("uses the ipa extension for ios and aab for android", () => {
  expect(generateVmScript(base)).toContain("app.ipa");
  expect(generateVmScript({ ...base, platform: "android" })).toContain("app.aab");
});

test("selects the right version field per platform", () => {
  expect(generateVmScript(base)).toContain("buildNumber");
  expect(generateVmScript({ ...base, platform: "android" })).toContain("versionCode");
});

test("uses set -euo pipefail", () => {
  expect(generateVmScript(base)).toContain("set -euo pipefail");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/vm-script.test.ts`
Expected: FAIL — cannot resolve module `../src/remote/vm-script`.

- [ ] **Step 3: Write the implementation**

Create `src/remote/vm-script.ts`:

```ts
import type { Profile } from "../args";

export interface VmScriptOptions {
  expoToken: string;
  profile: Profile;
  platform: "android" | "ios";
  submit: boolean;
  optimize: boolean;
  cacheEnabled: boolean;
  /** Tart --dir mount name for the synced source. */
  mountName: string;
  /** Mobile dir relative to the sync root; "" when they are the same. */
  mobileRelPath: string;
  javaVersion: string;
}

export const CACHE_MOUNT_NAME = "expo-builder-cache";

/** Where Tart exposes --dir mounts inside the guest. */
function mountPath(name: string): string {
  return `/Volumes/My Shared Files/${name}`;
}

export function generateVmScript(opts: VmScriptOptions): string {
  const {
    expoToken, profile, platform, submit, optimize, cacheEnabled,
    mountName, mobileRelPath, javaVersion,
  } = opts;

  const ext = platform === "ios" ? "ipa" : "aab";
  const artifact = `$HOME/out/app.${ext}`;
  const versionField = platform === "ios" ? "buildNumber" : "versionCode";
  const workDir = mobileRelPath ? `$HOME/work/${mobileRelPath}` : "$HOME/work";

  const lines: string[] = [
    "set -euo pipefail",
    `export PATH="$HOME/.bun/bin:/opt/homebrew/opt/openjdk@${javaVersion}/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"`,
    `export JAVA_HOME="/opt/homebrew/opt/openjdk@${javaVersion}"`,
    'export ANDROID_HOME="$HOME/Library/Android/sdk"',
    `export EXPO_TOKEN="${expoToken}"`,
    "",
    "# EAS packages the project itself and honours .gitignore/.easignore,",
    "# so no git repository is needed on the builder.",
    "export EAS_NO_VCS=1",
    "",
  ];

  if (cacheEnabled) {
    const cache = mountPath(CACHE_MOUNT_NAME);
    lines.push(
      "# Shared, budget-bounded caches mounted from the Mac host",
      `export BUN_INSTALL_CACHE_DIR="${cache}/bun"`,
      `export CP_HOME_DIR="${cache}/cocoapods"`,
      `export GRADLE_USER_HOME="${cache}/gradle"`,
      'mkdir -p "$BUN_INSTALL_CACHE_DIR" "$CP_HOME_DIR" "$GRADLE_USER_HOME"',
      "",
    );
  } else {
    lines.push('export GRADLE_USER_HOME="$HOME/.gradle"', "");
  }

  // Stage source onto the VM's own disk. The mount is read-only and slow;
  // building in place would also leave node_modules and artifacts on the Mac.
  lines.push(
    'echo "::phase::stage"',
    'mkdir -p "$HOME/work" "$HOME/out"',
    `rsync -a --delete "${mountPath(mountName)}/" "$HOME/work/"`,
    `cd "${workDir}"`,
    "",
  );

  if (optimize) {
    lines.push(
      "# Inject the iOS build optimization plugin via an app.config wrapper",
      "if [ -f app.config.ts ]; then",
      "  mv app.config.ts _app.config.original.ts",
      "  cat > app.config.ts << 'PLUGINEOF'",
      "// @ts-nocheck — build-time wrapper, auto-generated by expo-builder",
      'import original from "./_app.config.original";',
      'const plug = "./plugins/withBuildOptimizations";',
      "const inject = (c: any) => ({ ...c, plugins: [...(c.plugins || []), plug] });",
      "export default typeof original === 'function' ? (...a: any[]) => inject((original as any)(...a)) : inject(original);",
      "PLUGINEOF",
      "fi",
      "",
    );

    if (platform === "android") {
      lines.push(
        "# Gradle tuning: dynamic heap, no lint, limited workers",
        'mkdir -p "$GRADLE_USER_HOME"',
        "TOTAL_MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))",
        "JVM_MAX_GB=$(( TOTAL_MEM_GB > 4 ? TOTAL_MEM_GB - 2 : 2 ))",
        'cat > "$GRADLE_USER_HOME"/gradle.properties << GEOF',
        "org.gradle.caching=true",
        "org.gradle.workers.max=2",
        "reactNativeArchitectures=arm64-v8a",
        "org.gradle.jvmargs=-Xmx${JVM_MAX_GB}g -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError",
        "GEOF",
        `cat > "$GRADLE_USER_HOME"/init.gradle << 'GEOF'`,
        "allprojects {",
        "    afterEvaluate {",
        "        tasks.matching { it.name.contains('lintVital') }.configureEach {",
        "            enabled = false",
        "        }",
        "    }",
        "}",
        "GEOF",
        "",
      );
    }
  }

  lines.push(
    'echo "::phase::env-pull"',
    `eas env:pull --environment ${profile} --non-interactive`,
    "",
    'echo "::phase::install"',
    "bun install --frozen-lockfile",
    "",
    'echo "::phase::build"',
    "[ ! -f .env.local ] && touch .env.local",
    `dotenv -e .env.local -- eas build --local --platform ${platform} --profile ${profile} --output ${artifact} --non-interactive 2>&1`,
    "",
    'echo "::phase::version"',
    `VERSION_JSON=$(eas build:version:get -p ${platform} --profile ${profile} --json --non-interactive 2>/dev/null || echo '{}')`,
    `CUR=$(echo "$VERSION_JSON" | bun -e "const d=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.${versionField}??0))")`,
    "NEXT=$((CUR + 1))",
    'echo "::version::$CUR → $NEXT"',
    `echo "$NEXT" | eas build:version:set -p ${platform} --profile ${profile} || echo "::error::Version increment failed"`,
  );

  if (submit) {
    lines.push(
      "",
      'echo "::phase::submit"',
      `eas submit --platform ${platform} --profile ${profile} --path ${artifact} --non-interactive`,
    );
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/vm-script.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote/vm-script.ts test/vm-script.test.ts
git commit -m "feat: generate VM build script using EAS_NO_VCS and off-mount builds"
```

---

## Task 12: Mac host script — VM lifecycle

**This is the highest-risk code in the project.** The old version (`scripts/eas.ts:493-556`) had four defects, all of which the tests below pin down:

1. `trap cleanup EXIT` was registered *after* `tart clone`, so a failure in between leaked the VM.
2. The trap did not include `HUP`, and bash does not run `EXIT` traps on an untrapped `SIGHUP` — so an SSH disconnect leaked the VM.
3. `tart delete` immediately followed `tart stop` and could lose the lock race, with the failure swallowed by `|| true`.
4. The stale sweep matched any `build-*` VM regardless of state, so it could destroy a concurrent build.

**Files:**
- Create: `src/remote/host-script.ts`
- Create: `test/host-script.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/host-script.test.ts`:

```ts
import { expect, test } from "bun:test";
import { generateHostScript, type HostScriptOptions } from "../src/remote/host-script";

const base: HostScriptOptions = {
  imageName: "expo-builder",
  mountName: "my-app",
  remotePath: "/Users/mingu/.expo-builder/projects/my-app",
  cachePath: "/Users/mingu/.expo-builder/cache",
  artifactDir: "/Users/mingu/.expo-builder/artifacts/my-app/20260806",
  artifactExt: "ipa",
  stateFile: "/tmp/expo-builder-vm-123",
  vmScript: "echo hello",
  timestamp: 1770000000,
};

function lineIndex(script: string, needle: string): number {
  const lines = script.split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  if (i === -1) throw new Error(`not found in script: ${needle}`);
  return i;
}

test("the cleanup trap is registered before the VM is cloned", () => {
  const script = generateHostScript(base);
  expect(lineIndex(script, "trap cleanup")).toBeLessThan(lineIndex(script, "tart clone"));
});

test("the trap covers HUP so an SSH disconnect still tears down", () => {
  const script = generateHostScript(base);
  const trapLine = script.split("\n").find((l) => l.startsWith("trap cleanup"))!;
  for (const sig of ["EXIT", "INT", "TERM", "HUP"]) {
    expect(trapLine).toContain(sig);
  }
});

test("cleanup is guarded so it is a no-op when no VM was created", () => {
  const script = generateHostScript(base);
  expect(script).toContain("VM_CREATED=0");
  expect(script).toContain('[ "$VM_CREATED" = 1 ]');
  expect(lineIndex(script, "VM_CREATED=1")).toBeGreaterThan(lineIndex(script, "tart clone"));
});

test("teardown stops with a timeout, waits for the VM to leave running, then deletes", () => {
  const script = generateHostScript(base);
  expect(script).toContain("tart stop -t 30");
  expect(script).toContain("Running");
  expect(lineIndex(script, "tart stop -t 30")).toBeLessThan(lineIndex(script, "tart delete"));
});

test("delete is retried and a persistent failure is reported, not swallowed", () => {
  const script = generateHostScript(base);
  const destroy = script.slice(script.indexOf("destroy_vm()"), script.indexOf("cleanup()"));
  expect(destroy).toContain("for");
  expect(destroy).toContain("::error::");
  expect(destroy).not.toMatch(/tart delete "\$VM" 2>\/dev\/null \|\| true\s*$/m);
});

test("the stale sweep skips running VMs", () => {
  const script = generateHostScript(base);
  const sweep = script.slice(script.indexOf("# Stale VM sweep"), script.indexOf("echo \"::phase::clone-vm\""));
  expect(sweep).toContain("Running");
  expect(sweep).toContain("false");
});

test("the stale sweep matches both new and legacy VM name prefixes", () => {
  const script = generateHostScript(base);
  expect(script).toContain("expo-builder-build-");
  expect(script).toContain("^build-");
});

test("the stale sweep does not delete a VM whose owning process is alive", () => {
  const script = generateHostScript(base);
  expect(script).toContain("kill -0");
});

test("the VM name embeds the shell PID so liveness can be checked", () => {
  expect(generateHostScript(base)).toContain('VM="expo-builder-build-$$-1770000000"');
});

test("the source mount is read-only", () => {
  expect(generateHostScript(base)).toContain(
    '--dir=my-app:/Users/mingu/.expo-builder/projects/my-app:ro'
  );
});

test("the cache mount is read-write when a cache path is given", () => {
  const script = generateHostScript(base);
  expect(script).toContain("--dir=expo-builder-cache:/Users/mingu/.expo-builder/cache");
  expect(script).not.toContain("--dir=expo-builder-cache:/Users/mingu/.expo-builder/cache:ro");
});

test("the cache mount is omitted when no cache path is given", () => {
  const script = generateHostScript({ ...base, cachePath: undefined });
  expect(script).not.toContain("expo-builder-cache");
});

test("TART_HOME is exported when configured", () => {
  const script = generateHostScript({ ...base, tartHome: "/Volumes/BuildSSD/.tart" });
  expect(script).toContain('export TART_HOME="/Volumes/BuildSSD/.tart"');
});

test("the artifact is copied out of the VM before teardown", () => {
  const script = generateHostScript(base);
  expect(script).toContain("app.ipa");
  expect(script).toContain(base.artifactDir);
  expect(lineIndex(script, base.artifactDir)).toBeLessThan(lineIndex(script, "trap - EXIT"));
});

test("uses set -euo pipefail", () => {
  expect(generateHostScript(base)).toContain("set -euo pipefail");
});

test("a VMEOF sentinel inside the VM script cannot break the heredoc", () => {
  const script = generateHostScript({ ...base, vmScript: "echo a\nVMEOF\necho b" });
  const heredocs = script.split("\n").filter((l) => l === "VMEOF");
  expect(heredocs.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/host-script.test.ts`
Expected: FAIL — cannot resolve module `../src/remote/host-script`.

- [ ] **Step 3: Write the implementation**

Create `src/remote/host-script.ts`:

```ts
import { CACHE_MOUNT_NAME } from "./vm-script";

export interface HostScriptOptions {
  /** Local Tart image to clone from. */
  imageName: string;
  /** Tart --dir mount name for the synced source. */
  mountName: string;
  /** Synced source directory on the Mac. */
  remotePath: string;
  /** Shared cache directory on the Mac, or undefined to disable caching. */
  cachePath?: string;
  /** Where the built artifact is copied on the Mac. */
  artifactDir: string;
  artifactExt: string;
  stateFile: string;
  /** Bash to execute inside the VM. */
  vmScript: string;
  timestamp: number;
  tartHome?: string;
}

export function generateHostScript(opts: HostScriptOptions): string {
  const {
    imageName, mountName, remotePath, cachePath, artifactDir, artifactExt,
    stateFile, vmScript, timestamp, tartHome,
  } = opts;

  // Neutralise any line that would terminate the heredoc early.
  const safeVmScript = vmScript.replace(/^VMEOF$/gm, "VM_EOF_ESCAPED");

  const mounts = [`--dir=${mountName}:${remotePath}:ro`];
  if (cachePath) mounts.push(`--dir=${CACHE_MOUNT_NAME}:${cachePath}`);

  return `set -euo pipefail

# Non-interactive SSH does not source the login shell, so Homebrew tools
# (tart, rsync) are not on PATH. Import it explicitly.
eval "$($SHELL -lc 'echo export PATH="$PATH"')"
${tartHome ? `export TART_HOME="${tartHome}"\n` : ""}
VM="expo-builder-build-$$-${timestamp}"
VM_CREATED=0
echo "$VM" > ${stateFile}

# Wait for a VM to leave the running state, then delete it with retries.
# A silent failure here is what leaks VMs, so a persistent failure is reported.
destroy_vm() {
  local name="$1"
  tart stop -t 30 "$name" 2>/dev/null || true

  local waited=0
  while [ $waited -lt 60 ]; do
    if ! tart list --format json 2>/dev/null \\
      | grep -A5 "\\"Name\\" : \\"$name\\"" | grep -q '"Running" : true'; then
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done

  local attempt=0
  while [ $attempt -lt 5 ]; do
    if tart delete "$name" 2>/dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done

  if tart list --quiet 2>/dev/null | grep -qx "$name"; then
    echo "::error::Failed to delete VM $name after 5 attempts. Run: tart delete $name"
  fi
}

cleanup() {
  local rc=$?
  if [ "$VM_CREATED" = 1 ]; then
    echo "::phase::cleanup"
    destroy_vm "$VM"
  fi
  rm -f ${stateFile}
  exit $rc
}

# Registered BEFORE any VM exists, and covering HUP: bash does not run EXIT
# traps on an untrapped SIGHUP, so without HUP an SSH disconnect leaks the VM.
trap cleanup EXIT INT TERM HUP

# Stale VM sweep. Only removes VMs that are not running and whose owning
# shell is gone, so a concurrent build is never destroyed.
for STALE in $(tart list --quiet 2>/dev/null | grep -E '^expo-builder-build-|^build-' || true); do
  if tart list --format json 2>/dev/null \\
    | grep -A5 "\\"Name\\" : \\"$STALE\\"" | grep -q '"Running" : true'; then
    continue
  fi
  STALE_PID=$(echo "$STALE" | sed -n 's/^expo-builder-build-\\([0-9]*\\)-.*$/\\1/p')
  if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
    continue
  fi
  echo "::stale::$STALE"
  destroy_vm "$STALE"
done

echo "::phase::clone-vm"
tart clone ${imageName} "$VM"
VM_CREATED=1

TOTAL_CPU=$(sysctl -n hw.ncpu)
TOTAL_MEM_MB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
VM_CPU=$((TOTAL_CPU > 4 ? TOTAL_CPU - 2 : TOTAL_CPU))
VM_MEM_MB=$((TOTAL_MEM_MB > 8192 ? TOTAL_MEM_MB - 4096 : TOTAL_MEM_MB))
tart set "$VM" --cpu $VM_CPU --memory $VM_MEM_MB
echo "::vm-resources::$VM_CPU CPUs, $((VM_MEM_MB / 1024))GB RAM"

echo "::phase::boot-vm"
mkdir -p ${cachePath ? `"${cachePath}" ` : ""}"${artifactDir}"
tart run ${mounts.join(" ")} --no-graphics "$VM" &

VM_IP=""
for i in $(seq 1 30); do
  VM_IP=$(tart ip "$VM" 2>/dev/null) && [ -n "$VM_IP" ] && break
  echo "::boot-wait::$((i * 3))"
  sleep 3
done

if [ -z "$VM_IP" ]; then
  echo "::error::VM failed to boot within 90 seconds"
  exit 1
fi
echo "::vm-ip::$VM_IP"

VM_SSH="ssh -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i $HOME/.ssh/id_ed25519 -o ConnectTimeout=30 admin@$VM_IP"

$VM_SSH bash -s <<'VMEOF'
${safeVmScript}
VMEOF

echo "::phase::artifact"
scp -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" \\
  "admin@$VM_IP:out/app.${artifactExt}" "${artifactDir}/app.${artifactExt}"

trap - EXIT
cleanup
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/host-script.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Add a golden-file snapshot**

Append to `test/host-script.test.ts`:

```ts
test("host script matches the approved snapshot", () => {
  expect(generateHostScript(base)).toMatchSnapshot();
});

test("host script without cache matches the approved snapshot", () => {
  expect(generateHostScript({ ...base, cachePath: undefined })).toMatchSnapshot();
});
```

Run: `bun test test/host-script.test.ts`
Expected: PASS, 18 tests. A snapshot file is written to `test/__snapshots__/host-script.test.ts.snap`.

Review that snapshot by eye before committing — it is the actual bash that will run on the Mac. Confirm the trap appears before `tart clone` and that `HUP` is in the trap list.

- [ ] **Step 6: Commit**

```bash
git add src/remote/host-script.ts test/host-script.test.ts test/__snapshots__
git commit -m "feat: harden VM lifecycle against leaks on failure and disconnect"
```

---

## Task 13: SSH key discovery

**Correctness requirement:** the old `ensureSshKeyPermissions` (`scripts/eas.ts:163-195`) rewrote the key file in place to normalise CRLF and tightened its ACL. That was tolerable against a dedicated copy in `.ssh-key/id`. It is **not** acceptable against a user's real `~/.ssh/id_ed25519`. Normalisation now writes a separate copy.

**Files:**
- Create: `src/remote/ssh.ts`
- Create: `test/ssh.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/ssh.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pickSshKey, normalizedKeyCopy, loginWrap, toRsyncPath } from "../src/remote/ssh";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "expo-builder-ssh-"));
}

test("pickSshKey prefers the explicit override", () => {
  const dir = scratch();
  const key = join(dir, "custom");
  writeFileSync(key, "x");
  expect(pickSshKey({ override: key, configured: undefined, sshDir: dir })).toBe(key);
});

test("pickSshKey falls back to id_ed25519 then id_rsa", () => {
  const dir = scratch();
  writeFileSync(join(dir, "id_rsa"), "x");
  expect(pickSshKey({ sshDir: dir })).toBe(join(dir, "id_rsa"));
  writeFileSync(join(dir, "id_ed25519"), "x");
  expect(pickSshKey({ sshDir: dir })).toBe(join(dir, "id_ed25519"));
});

test("pickSshKey returns undefined when nothing exists", () => {
  expect(pickSshKey({ sshDir: scratch() })).toBeUndefined();
});

test("normalizedKeyCopy never modifies the source key", () => {
  const dir = scratch();
  const src = join(dir, "id_ed25519");
  const original = "-----BEGIN-----\r\nabc\r\n-----END-----\r\n";
  writeFileSync(src, original);

  const copy = normalizedKeyCopy(src, join(dir, "cache"));
  expect(readFileSync(src, "utf-8")).toBe(original);
  expect(readFileSync(copy, "utf-8")).toBe("-----BEGIN-----\nabc\n-----END-----\n");
  expect(copy).not.toBe(src);
});

test("normalizedKeyCopy returns the original when no normalisation is needed", () => {
  const dir = scratch();
  const src = join(dir, "id_ed25519");
  writeFileSync(src, "already\nclean\n");
  expect(normalizedKeyCopy(src, join(dir, "cache"))).toBe(src);
});

test("loginWrap escapes single quotes", () => {
  expect(loginWrap("echo 'hi'")).toContain(`'\\''`);
});

test("toRsyncPath converts Windows paths to cygwin form", () => {
  expect(toRsyncPath("D:\\Work\\app", "win32")).toBe("/cygdrive/d/Work/app");
  expect(toRsyncPath("/Users/mingu/app", "darwin")).toBe("/Users/mingu/app");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/ssh.test.ts`
Expected: FAIL — cannot resolve module `../src/remote/ssh`.

- [ ] **Step 3: Write the implementation**

Create `src/remote/ssh.ts`:

```ts
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { BuildError } from "../errors";

export interface PickKeyOptions {
  override?: string;
  configured?: string;
  sshDir?: string;
}

const KEY_CANDIDATES = ["id_ed25519", "id_rsa", "id_ecdsa"];

export function pickSshKey(opts: PickKeyOptions = {}): string | undefined {
  const sshDir = opts.sshDir ?? join(homedir(), ".ssh");
  for (const candidate of [opts.override, opts.configured]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const name of KEY_CANDIDATES) {
    const path = join(sshDir, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * cwRsync's cygwin ssh rejects CRLF keys. Rather than rewriting the user's
 * key in place, write a normalised copy into our own cache directory.
 * Returns the original path when no change is needed.
 */
export function normalizedKeyCopy(keyPath: string, cacheDir: string): string {
  const raw = readFileSync(keyPath, "utf-8");
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withNewline = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  if (withNewline === raw) return keyPath;

  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash("sha256").update(keyPath).digest("hex").slice(0, 16);
  const dest = join(cacheDir, hash);
  writeFileSync(dest, withNewline, { mode: 0o600 });
  try { chmodSync(dest, 0o600); } catch { /* best effort on Windows */ }
  return dest;
}

/** Force a login shell so Homebrew-installed tools are on PATH over SSH. */
export function loginWrap(cmd: string): string {
  return `$SHELL -lc '${cmd.replace(/'/g, "'\\''")}'`;
}

/** Windows: D:\foo → /cygdrive/d/foo, which is what cwRsync expects. */
export function toRsyncPath(localPath: string, platform: string = process.platform): string {
  if (platform !== "win32") return localPath;
  return localPath
    .replace(/\\/g, "/")
    .replace(/^([A-Z]):/i, (_, drive: string) => `/cygdrive/${drive.toLowerCase()}`);
}

export interface SshTarget {
  host: string;
  user?: string;
}

export function sshTargetString(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

/** Run a command on the Mac and return stdout. Throws BuildError on failure. */
export function ssh(target: SshTarget, cmd: string, opts?: { allowFailure?: boolean }): string {
  try {
    return execFileSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", sshTargetString(target), loginWrap(cmd)],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch (err) {
    if (opts?.allowFailure) return "";
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
    throw new BuildError(
      `SSH command failed on ${sshTargetString(target)}: ${cmd}`,
      stderr || `Check that you can run: ssh ${sshTargetString(target)}`,
    );
  }
}

/** Locate cwRsync's bundled cygwin ssh.exe. Win32-OpenSSH breaks rsync's protocol. */
export function findCwrsyncSsh(): string {
  try {
    const rsyncPath = execFileSync("where.exe", ["rsync.exe"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n")[0]!.trim();
    const chocoLib = join(rsyncPath, "..", "..", "lib", "rsync", "tools", "bin", "ssh.exe");
    if (existsSync(chocoLib)) return chocoLib;
    const sibling = join(rsyncPath, "..", "ssh.exe");
    if (existsSync(sibling)) return sibling;
  } catch { /* fall through to the error below */ }
  throw new BuildError(
    "Could not find cwRsync's bundled ssh.exe",
    "Install rsync with: choco install rsync",
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/ssh.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote/ssh.ts test/ssh.test.ts
git commit -m "feat: discover SSH keys without mutating the user's private key"
```

---

## Task 14: Output filtering and phase spinners

Ported from `scripts/eas.ts:748-959`, which is worth reading first. Behaviour is preserved; only the structure changes.

**Files:**
- Create: `src/ui/output.ts`
- Create: `src/ui/phases.ts`
- Create: `test/output.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/output.test.ts`:

```ts
import { expect, test } from "bun:test";
import { OutputFilter } from "../src/ui/output";

test("suppresses known noise", () => {
  const f = new OutputFilter();
  expect(f.classify("    at Object.<anonymous> (foo.js:1)", "build")).toBe("hide");
  expect(f.classify("npm warn deprecated", "build")).toBe("hide");
});

test("collapses consecutive duplicates", () => {
  const f = new OutputFilter();
  expect(f.classify("[EXPO] building", "build")).toBe("show");
  expect(f.classify("[EXPO] building", "build")).toBe("duplicate");
  expect(f.duplicateCount).toBe(1);
});

test("resets the duplicate counter on a new line", () => {
  const f = new OutputFilter();
  f.classify("[EXPO] a", "build");
  f.classify("[EXPO] a", "build");
  expect(f.classify("[EXPO] b", "build")).toBe("show");
  expect(f.duplicateCount).toBe(0);
});

test("shows lines matching the phase pattern and hides others", () => {
  const f = new OutputFilter();
  expect(f.classify("[RUN_FASTLANE] step", "build")).toBe("show");
  expect(f.classify("some unrelated chatter", "build")).toBe("hide");
});

test("extracts the EAS sub-phase label from a build line", () => {
  const f = new OutputFilter();
  expect(f.easPhase("[RUN_FASTLANE] doing things")).toBe("run fastlane");
  expect(f.easPhase("not a phase")).toBeUndefined();
});

test("retains a bounded tail for error context", () => {
  const f = new OutputFilter();
  for (let i = 0; i < 100; i++) f.record(`line ${i}`);
  expect(f.tail().length).toBe(50);
  expect(f.tail()[49]).toBe("line 99");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/output.test.ts`
Expected: FAIL — cannot resolve module `../src/ui/output`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/output.ts`:

```ts
export type LineVerdict = "show" | "hide" | "duplicate";

const NOISE = /^(\s+at\s)|^npm (warn|notice)\b/;

/** Lines worth surfacing during each phase. Everything else goes to the log only. */
const SHOW_PATTERNS: Record<string, RegExp> = {
  "stage": /rsync|files/i,
  "env-pull": /pulled|downloaded|secret/i,
  "install": /installed|resolved|packages/i,
  "build": /^\[([A-Z][A-Z_]+)\]/,
  "version": /version|warning/i,
  "submit": /submitted|upload|error/i,
  "artifact": /app\.(ipa|aab)/i,
};

const TAIL_SIZE = 50;

export class OutputFilter {
  private previous = "";
  private tailBuffer: string[] = [];
  duplicateCount = 0;

  classify(line: string, phase: string): LineVerdict {
    if (NOISE.test(line)) return "hide";

    if (line === this.previous) {
      this.duplicateCount++;
      return "duplicate";
    }
    this.previous = line;
    this.duplicateCount = 0;

    const pattern = SHOW_PATTERNS[phase];
    return pattern?.test(line) ? "show" : "hide";
  }

  /** "[RUN_FASTLANE] ..." → "run fastlane" */
  easPhase(line: string): string | undefined {
    const match = line.match(/^\[([A-Z][A-Z_]+)\]/);
    return match ? match[1]!.toLowerCase().replace(/_/g, " ") : undefined;
  }

  record(line: string): void {
    this.tailBuffer.push(line);
    if (this.tailBuffer.length > TAIL_SIZE) this.tailBuffer.shift();
  }

  tail(): string[] {
    return [...this.tailBuffer];
  }
}

/** Render one line with the │ bar, truncated to the terminal width. */
export function showLine(text: string): void {
  const cols = process.stdout.columns || 80;
  const prefix = "│  ";
  const max = cols - prefix.length - 1;
  const display = text.length > max ? `${text.slice(0, max - 3)}...` : text;
  process.stdout.write(`\x1b[2K\r${prefix}${display}\n`);
}

export function showBar(): void {
  process.stdout.write("\x1b[2K\r│\n");
}
```

Create `src/ui/phases.ts`:

```ts
import * as p from "@clack/prompts";

export const PHASE_START: Record<string, string> = {
  "clone-vm": "Cloning VM...",
  "boot-vm": "Booting VM...",
  "stage": "Staging source in VM...",
  "env-pull": "Pulling credentials from EAS...",
  "install": "Installing dependencies...",
  "build": "Building...",
  "version": "Updating version...",
  "submit": "Submitting to store...",
  "artifact": "Retrieving artifact...",
  "cleanup": "Cleaning up VM...",
};

export const PHASE_DONE: Record<string, string> = {
  "clone-vm": "VM cloned",
  "boot-vm": "VM booted",
  "stage": "Source staged",
  "env-pull": "Credentials ready",
  "install": "Dependencies installed",
  "build": "Build complete",
  "version": "Version updated",
  "submit": "Submitted to store",
  "artifact": "Artifact retrieved",
  "cleanup": "VM cleaned up",
};

/** Drives one spinner at a time, keyed on the current phase. */
export class PhaseTracker {
  private spinner: ReturnType<typeof p.spinner> | null = null;
  current = "";

  start(phase: string, label?: string): void {
    this.stop(true);
    this.current = phase;
    this.spinner = p.spinner();
    this.spinner.start(label ?? PHASE_START[phase] ?? phase);
  }

  message(text: string): void {
    this.spinner?.message(text);
  }

  stop(ok: boolean): void {
    if (!this.spinner || !this.current) return;
    this.spinner.stop(
      ok
        ? PHASE_DONE[this.current] ?? `${this.current} done`
        : `Failed during: ${PHASE_START[this.current] ?? this.current}`,
    );
    this.spinner = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/output.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/output.ts src/ui/phases.ts test/output.test.ts
git commit -m "feat: extract output filtering and phase spinner tracking"
```

---

## Task 15: CLI entry point and help

**Files:**
- Create: `src/cli.ts`
- Modify: `src/args.ts`
- Create: `test/help.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/help.test.ts`:

```ts
import { expect, test } from "bun:test";
import { helpText, COMMAND_HELP } from "../src/args";
import { COMMANDS } from "../src/args";

test("global help lists every command except interactive", () => {
  const text = helpText();
  for (const cmd of COMMANDS) {
    if (cmd === "interactive") continue;
    expect(text).toContain(cmd);
  }
});

test("global help documents the flags that change build destination", () => {
  const text = helpText();
  expect(text).toContain("--remote");
  expect(text).toContain("--cloud");
  expect(text).toContain("--no-optimize");
});

test("every command has its own help entry", () => {
  for (const cmd of COMMANDS) {
    if (cmd === "interactive") continue;
    expect(COMMAND_HELP[cmd]).toBeDefined();
    expect(helpText(cmd).length).toBeGreaterThan(20);
  }
});

test("command help includes usage and an example", () => {
  const text = helpText("build");
  expect(text).toContain("Usage:");
  expect(text).toContain("expo-builder build");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/help.test.ts`
Expected: FAIL — `helpText` is not exported.

- [ ] **Step 3: Add help text to args.ts**

Append to `src/args.ts`:

```ts
export const COMMAND_HELP: Record<string, { summary: string; usage: string; example: string }> = {
  build: {
    summary: "Build the app on EAS Cloud or in a Tart VM on your Mac",
    usage: "expo-builder build [profile] [platform] [--remote|--cloud] [--no-optimize] [--no-cache]",
    example: "expo-builder build preview ios --remote",
  },
  submit: {
    summary: "Submit an existing build to the App Store / Play Store",
    usage: "expo-builder submit [profile] [platform]",
    example: "expo-builder submit production ios",
  },
  deploy: {
    summary: "Build and then submit to the stores",
    usage: "expo-builder deploy [profile] [platform] [--remote|--cloud]",
    example: "expo-builder deploy production all --remote",
  },
  update: {
    summary: "Push an over-the-air JS update (no native rebuild)",
    usage: "expo-builder update [profile] -m <message>",
    example: 'expo-builder update preview -m "fix crash on launch"',
  },
  run: {
    summary: "Build locally and install on a connected device (macOS/Linux)",
    usage: "expo-builder run <android|ios>",
    example: "expo-builder run android",
  },
  init: {
    summary: "Create expo-builder.json and verify the connection to your Mac",
    usage: "expo-builder init",
    example: "expo-builder init",
  },
  doctor: {
    summary: "Check local tools, the Mac, the VM image, and SDK compatibility",
    usage: "expo-builder doctor [--refresh] [--json]",
    example: "expo-builder doctor",
  },
  clean: {
    summary: "Report and reclaim disk space on the build Mac",
    usage: "expo-builder clean [--deep] [--dry-run] [--yes]",
    example: "expo-builder clean --dry-run",
  },
  vm: {
    summary: "Manage the Tart image: list, rebuild, delete, migrate",
    usage: "expo-builder vm <list|rebuild|delete|migrate> [--xcode <version>] [--to <path>]",
    example: "expo-builder vm rebuild",
  },
  logs: {
    summary: "Show build logs",
    usage: "expo-builder logs [--last]",
    example: "expo-builder logs --last",
  },
};

const GLOBAL_FLAGS = `
Global flags:
  -h, --help           Show help
  -V, --version        Show version
      --json           Machine-readable output
      --verbose        Show all output, unfiltered
  -y, --yes            Assume yes for confirmations
      --project <path> Path to the Expo project
      --ssh-key <path> SSH key to use for the Mac

Build flags:
      --remote         Build in a Tart VM on your Mac
      --cloud          Build on EAS Cloud
      --no-optimize    Skip build optimizations
      --no-cache       Skip the shared dependency cache
      --dry-run        Print what would happen without doing it
      --download <p>   Also download the artifact locally
`.trimEnd();

export function helpText(command?: Command): string {
  if (command && command !== "interactive" && COMMAND_HELP[command]) {
    const help = COMMAND_HELP[command]!;
    return [
      help.summary,
      "",
      `Usage:\n  ${help.usage}`,
      "",
      `Example:\n  ${help.example}`,
      GLOBAL_FLAGS,
    ].join("\n");
  }

  const rows = Object.entries(COMMAND_HELP)
    .map(([name, h]) => `  ${name.padEnd(9)} ${h.summary}`)
    .join("\n");

  return [
    "expo-builder — build Expo apps in ephemeral Tart VMs on a remote Mac",
    "",
    "Usage:\n  expo-builder <command> [options]",
    "",
    `Commands:\n${rows}`,
    "",
    "Run with no arguments for interactive mode.",
    GLOBAL_FLAGS,
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/help.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the CLI entry point**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node
import { parseArgs, helpText } from "./args";
import { formatError, exitCodeFor } from "./errors";
import pkg from "../package.json" with { type: "json" };

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.flags.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  if (parsed.flags.help) {
    process.stdout.write(`${helpText(parsed.command)}\n`);
    return 0;
  }

  switch (parsed.command) {
    case "interactive": {
      const { runInteractive } = await import("./commands/interactive");
      return runInteractive(parsed);
    }
    case "build": {
      const { runBuild } = await import("./commands/build");
      return runBuild(parsed);
    }
    case "submit": {
      const { runSubmit } = await import("./commands/submit");
      return runSubmit(parsed);
    }
    case "deploy": {
      const { runDeploy } = await import("./commands/deploy");
      return runDeploy(parsed);
    }
    case "update": {
      const { runUpdate } = await import("./commands/update");
      return runUpdate(parsed);
    }
    case "run": {
      const { runLocal } = await import("./commands/run");
      return runLocal(parsed);
    }
    case "init": {
      const { runInit } = await import("./commands/init");
      return runInit(parsed);
    }
    case "doctor": {
      const { runDoctor } = await import("./commands/doctor");
      return runDoctor(parsed);
    }
    case "clean": {
      const { runClean } = await import("./commands/clean");
      return runClean(parsed);
    }
    case "vm": {
      const { runVm } = await import("./commands/vm");
      return runVm(parsed);
    }
    case "logs": {
      const { runLogs } = await import("./commands/logs");
      return runLogs(parsed);
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`\n${formatError(err)}\n`);
    process.exit(exitCodeFor(err));
  });
```

This will not compile until the command modules exist (Tasks 16-22). That is expected — the next tasks fill them in.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/args.ts test/help.test.ts
git commit -m "feat: add CLI entry point with per-command help"
```

---

## Task 16: Config loading orchestration

Task 9 built the pieces. This assembles them into the single `loadConfig` every command calls.

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts`:

```ts
import { loadConfig } from "../src/config";
import { UsageError } from "../src/errors";

test("loadConfig assembles a full config from a minimal project file", () => {
  const root = scratch();
  const mobile = join(root, "mobile");
  mkdirSync(mobile);
  writeFileSync(join(mobile, "app.json"), JSON.stringify({ expo: { slug: "my-app" } }));
  writeFileSync(join(mobile, "eas.json"), "{}");
  writeFileSync(join(mobile, "package.json"), JSON.stringify({
    name: "mobile", dependencies: { expo: "^57.0.0" },
  }));
  writeFileSync(join(root, "expo-builder.json"), JSON.stringify({ mac: "mingu@defymac" }));

  const cfg = loadConfig({ cwd: root, projectRoot: root, userConfigPath: join(root, "nonexistent.json"), env: {} });
  expect(cfg.mac).toEqual({ user: "mingu", host: "defymac" });
  expect(cfg.slug).toBe("my-app");
  expect(cfg.mobileDir).toBe(mobile);
  expect(cfg.vm.xcode).toBe("auto");
  expect(cfg.vm.name).toBe("expo-builder");
  expect(cfg.cache.budgetGB).toBe(15);
});

test("loadConfig errors helpfully when mac is missing", () => {
  const root = scratch();
  writeFileSync(join(root, "app.json"), JSON.stringify({ expo: { slug: "x" } }));
  writeFileSync(join(root, "eas.json"), "{}");
  writeFileSync(join(root, "expo-builder.json"), "{}");
  expect(() =>
    loadConfig({ cwd: root, projectRoot: root, userConfigPath: join(root, "none.json"), env: {} })
  ).toThrow(UsageError);
});

test("loadConfig errors helpfully when no Expo project is found", () => {
  const root = scratch();
  writeFileSync(join(root, "expo-builder.json"), JSON.stringify({ mac: "u@h" }));
  expect(() =>
    loadConfig({ cwd: root, projectRoot: root, userConfigPath: join(root, "none.json"), env: {} })
  ).toThrow(UsageError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — `loadConfig` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/config.ts`:

```ts
import { execFileSync } from "child_process";
import { UsageError } from "./errors";

export function gitRoot(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

export interface LoadConfigOptions {
  cwd: string;
  projectRoot?: string;
  userConfigPath?: string;
  env?: Record<string, string | undefined>;
  overrides?: { project?: string; sshKey?: string; xcode?: string };
}

export function loadConfig(opts: LoadConfigOptions): ResolvedConfig {
  const cwd = opts.overrides?.project ? resolve(opts.overrides.project) : opts.cwd;
  const projectRoot = opts.projectRoot ?? gitRoot(cwd) ?? cwd;
  const env = opts.env ?? process.env;

  const userConfig = readConfigFile(opts.userConfigPath ?? USER_CONFIG_PATH);
  const projectConfig = readConfigFile(join(projectRoot, CONFIG_FILENAME));
  const merged = mergeConfig(userConfig, projectConfig);

  if (!merged.mac) {
    throw new UsageError(
      `No Mac configured.`,
      `Add one to ${CONFIG_FILENAME}:\n\n  { "mac": "user@host" }\n\nOr run: expo-builder init`,
    );
  }
  const mac = parseMacTarget(merged.mac);
  if (opts.overrides?.sshKey) mac.sshKey = opts.overrides.sshKey;

  const mobileDir = merged.mobileDir
    ? resolve(projectRoot, merged.mobileDir)
    : findMobileDir(cwd, projectRoot);

  if (!mobileDir) {
    throw new UsageError(
      `Could not find an Expo project.`,
      `Looked for a directory containing eas.json and app.json/app.config.* in ` +
      `${cwd} and one level below ${projectRoot}.\n\n` +
      `Set it explicitly in ${CONFIG_FILENAME}:\n\n  { "mobileDir": "mobile" }`,
    );
  }

  return {
    mac,
    projectRoot,
    mobileDir,
    slug: readSlug(mobileDir),
    syncPaths: merged.syncPaths ?? [],
    vm: {
      xcode: opts.overrides?.xcode ?? merged.vm?.xcode ?? CONFIG_DEFAULTS.vm.xcode,
      name: merged.vm?.name ?? CONFIG_DEFAULTS.vm.name,
      keepImages: merged.vm?.keepImages ?? CONFIG_DEFAULTS.vm.keepImages,
    },
    cache: {
      enabled: merged.cache?.enabled ?? CONFIG_DEFAULTS.cache.enabled,
      budgetGB: merged.cache?.budgetGB ?? CONFIG_DEFAULTS.cache.budgetGB,
    },
    expoToken: resolveExpoToken(env, [
      join(projectRoot, ".env"),
      join(mobileDir, ".env"),
      join(homedir(), ".expo-builder", "env"),
    ]),
  };
}

/** Canonical remote paths on the Mac, derived rather than configured. */
export function remotePaths(slug: string) {
  return {
    project: `$HOME/.expo-builder/projects/${slug}`,
    cache: `$HOME/.expo-builder/cache`,
    artifacts: `$HOME/.expo-builder/artifacts/${slug}`,
    imageRecord: `$HOME/.expo-builder/image.json`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/config.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat: assemble full config from project, user, and auto-detection"
```

---

## Task 17: `doctor` command

**Files:**
- Create: `src/commands/doctor.ts`
- Create: `test/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/doctor.test.ts`:

```ts
import { expect, test } from "bun:test";
import { buildReport, type DoctorInputs } from "../src/commands/doctor";

const healthy: DoctorInputs = {
  sdkMajor: 57,
  imageRecord: { repo: "ghcr.io/cirruslabs/macos-sequoia-xcode", tag: "26.6", xcode: "26.6", node: "22.14.0", jdk: "17" },
  resolved: { repo: "ghcr.io/cirruslabs/macos-sequoia-xcode", tag: "26.6", warnings: [] },
  freeBytes: 300 * 1024 * 1024 * 1024,
  volumeErrors: [],
  volumeWarnings: [],
  legacyImagePresent: false,
};

test("a healthy setup produces no problems", () => {
  const report = buildReport(healthy);
  expect(report.problems).toEqual([]);
  expect(report.ok).toBe(true);
});

test("flags an image whose Xcode is below the SDK floor", () => {
  const report = buildReport({
    ...healthy,
    imageRecord: { ...healthy.imageRecord!, tag: "26.2", xcode: "26.2" },
  });
  expect(report.ok).toBe(false);
  expect(report.problems.join(" ")).toContain("26.2");
  expect(report.problems.join(" ")).toContain("26.4");
  expect(report.remedies.join(" ")).toContain("expo-builder vm rebuild");
});

test("flags a Node version below the SDK floor", () => {
  const report = buildReport({
    ...healthy,
    imageRecord: { ...healthy.imageRecord!, node: "20.11.0" },
  });
  expect(report.problems.join(" ")).toContain("Node");
});

test("flags a missing image", () => {
  const report = buildReport({ ...healthy, imageRecord: undefined });
  expect(report.problems.join(" ")).toContain("No VM image");
  expect(report.remedies.join(" ")).toContain("expo-builder vm rebuild");
});

test("warns on low disk", () => {
  const report = buildReport({ ...healthy, freeBytes: 20 * 1024 * 1024 * 1024 });
  expect(report.warnings.join(" ")).toContain("disk");
});

test("volume errors become problems", () => {
  const report = buildReport({ ...healthy, volumeErrors: ["not APFS"] });
  expect(report.ok).toBe(false);
  expect(report.problems).toContain("not APFS");
});

test("a legacy eas-builder image is reported with the migration remedy", () => {
  const report = buildReport({ ...healthy, legacyImagePresent: true });
  expect(report.remedies.join(" ")).toContain("tart clone eas-builder expo-builder");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/doctor.test.ts`
Expected: FAIL — cannot resolve module `../src/commands/doctor`.

- [ ] **Step 3: Write the report builder**

Create `src/commands/doctor.ts`:

```ts
import * as p from "@clack/prompts";
import { compareVersions, requirementsFor, resolveImage, parseSdkMajor } from "../compat";
import { loadCompatTags } from "../compat-cache";
import { loadConfig, readExpoSdkRange, remotePaths } from "../config";
import { ssh, sshTargetString } from "../remote/ssh";
import { parseDiskutilInfo, validateVolume, GB } from "../remote/storage";
import type { ParsedArgs } from "../args";

export interface ImageRecord {
  repo: string;
  tag: string;
  xcode: string;
  node: string;
  jdk: string;
}

export interface DoctorInputs {
  sdkMajor?: number;
  imageRecord?: ImageRecord;
  resolved: { repo?: string; tag?: string; warnings: string[] };
  freeBytes: number;
  volumeErrors: string[];
  volumeWarnings: string[];
  legacyImagePresent: boolean;
}

export interface DoctorReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
  remedies: string[];
}

export const LOW_DISK_BYTES = 40 * GB;

export function buildReport(input: DoctorInputs): DoctorReport {
  const problems: string[] = [...input.volumeErrors];
  const warnings: string[] = [...input.volumeWarnings, ...input.resolved.warnings];
  const remedies: string[] = [];

  if (!input.imageRecord) {
    problems.push("No VM image has been provisioned on the Mac.");
    remedies.push("expo-builder vm rebuild");
  } else {
    const req = input.sdkMajor === undefined ? undefined : requirementsFor(input.sdkMajor);
    if (req) {
      if (compareVersions(input.imageRecord.xcode, req.minXcode) < 0) {
        problems.push(
          `VM image has Xcode ${input.imageRecord.xcode}, but Expo SDK ${input.sdkMajor} requires ${req.minXcode} or newer.`,
        );
        remedies.push(`expo-builder vm rebuild${input.resolved.tag ? ` --xcode ${input.resolved.tag}` : ""}`);
      }
      if (compareVersions(input.imageRecord.node, req.minNode) < 0) {
        problems.push(
          `VM image has Node ${input.imageRecord.node}, but Expo SDK ${input.sdkMajor} requires ${req.minNode} or newer.`,
        );
        remedies.push("expo-builder vm rebuild");
      }
      if (compareVersions(input.imageRecord.jdk, req.minJdk) < 0) {
        problems.push(
          `VM image has JDK ${input.imageRecord.jdk}, but Expo SDK ${input.sdkMajor} requires ${req.minJdk} or newer.`,
        );
        remedies.push("expo-builder vm rebuild");
      }
    }
    if (
      input.resolved.tag &&
      compareVersions(input.imageRecord.tag, input.resolved.tag) !== 0 &&
      problems.length === 0
    ) {
      warnings.push(
        `A better-matching image is available: Xcode ${input.resolved.tag} (currently ${input.imageRecord.tag}).`,
      );
    }
  }

  if (input.freeBytes > 0 && input.freeBytes < LOW_DISK_BYTES) {
    warnings.push(
      `Low disk on the Mac: ${(input.freeBytes / GB).toFixed(1)} GB free. Run: expo-builder clean`,
    );
  }

  if (input.legacyImagePresent) {
    remedies.push(
      'Legacy image found. Migrate for free (APFS clone): tart clone eas-builder expo-builder && tart delete eas-builder',
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    remedies: [...new Set(remedies)],
  };
}

export async function runDoctor(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const target = { host: cfg.mac.host, user: cfg.mac.user };
  const paths = remotePaths(cfg.slug);

  p.intro(`expo-builder doctor — ${cfg.slug}`);

  const sdkRange = readExpoSdkRange(cfg.mobileDir);
  const sdkMajor = sdkRange ? parseSdkMajor(sdkRange) : undefined;

  const compat = await loadCompatTags({ forceRefresh: args.flags.refresh });
  if (compat.degraded) {
    p.log.warn("Could not reach ghcr; using cached image data, which may be out of date.");
  }
  const resolved = resolveImage(sdkMajor, compat.tags, cfg.vm.xcode);

  const recordJson = ssh(target, `cat ${paths.imageRecord} 2>/dev/null || true`, { allowFailure: true });
  let imageRecord: ImageRecord | undefined;
  try { imageRecord = recordJson ? (JSON.parse(recordJson) as ImageRecord) : undefined; } catch { /* absent */ }

  const tartHome = cfg.mac.tartHome;
  const volumeTarget = tartHome ?? "$HOME";
  const diskutil = ssh(target, `diskutil info "${volumeTarget}" 2>/dev/null || true`, { allowFailure: true });
  const volume = diskutil ? parseDiskutilInfo(diskutil) : undefined;
  const validation = volume ? validateVolume(volume) : { errors: [], warnings: [] };

  const images = ssh(target, "tart list --quiet 2>/dev/null || true", { allowFailure: true });

  const report = buildReport({
    sdkMajor,
    imageRecord,
    resolved,
    freeBytes: volume?.freeBytes ?? 0,
    volumeErrors: validation.errors,
    volumeWarnings: validation.warnings,
    legacyImagePresent: images.split("\n").some((l) => l.trim() === "eas-builder"),
  });

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ ...report, sdkMajor, imageRecord, resolved }, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  p.log.info(`Mac: ${sshTargetString(target)}`);
  p.log.info(`Expo SDK: ${sdkMajor ?? "unknown"}`);
  p.log.info(`VM image: ${imageRecord ? `${imageRecord.repo}:${imageRecord.tag} (Xcode ${imageRecord.xcode})` : "none"}`);
  p.log.info(`Recommended: ${resolved.tag ? `${resolved.repo}:${resolved.tag}` : "could not resolve"}`);
  if (volume) p.log.info(`Free space: ${(volume.freeBytes / GB).toFixed(1)} GB`);

  for (const w of report.warnings) p.log.warn(w);
  for (const problem of report.problems) p.log.error(problem);
  if (report.remedies.length > 0) {
    p.log.message(`Suggested:\n${report.remedies.map((r) => `  ${r}`).join("\n")}`);
  }

  p.outro(report.ok ? "All checks passed" : "Problems found");
  return report.ok ? 0 : 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/doctor.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts test/doctor.test.ts
git commit -m "feat: add doctor command checking SDK, image, and storage health"
```

---

## Task 18: `clean` command and build preflight

**Files:**
- Create: `src/commands/clean.ts`
- Create: `test/clean.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/clean.test.ts`:

```ts
import { expect, test } from "bun:test";
import { planCleanup, type CleanInputs, GB_BYTES } from "../src/commands/clean";

const inputs: CleanInputs = {
  staleVms: ["expo-builder-build-99-1", "build-1741000000"],
  legacyDirs: ["/Users/mingu/eas/buddy"],
  artifactDirs: ["a5", "a4", "a3", "a2", "a1"],
  cacheBytes: 25 * GB_BYTES,
  cacheBudgetBytes: 15 * GB_BYTES,
  ociCacheBytes: 80 * GB_BYTES,
  deep: false,
};

test("stale VMs and legacy dirs are always removed", () => {
  const plan = planCleanup(inputs);
  expect(plan.vmsToDelete).toEqual(["expo-builder-build-99-1", "build-1741000000"]);
  expect(plan.dirsToDelete).toContain("/Users/mingu/eas/buddy");
});

test("only artifacts beyond the newest three are removed", () => {
  const plan = planCleanup(inputs);
  expect(plan.artifactsToDelete).toEqual(["a2", "a1"]);
});

test("the cache is trimmed to budget", () => {
  const plan = planCleanup(inputs);
  expect(plan.trimCacheToBytes).toBe(15 * GB_BYTES);
});

test("the OCI cache is retained by default", () => {
  const plan = planCleanup(inputs);
  expect(plan.pruneOciCache).toBe(false);
});

test("--deep prunes the OCI cache and warns about the re-download", () => {
  const plan = planCleanup({ ...inputs, deep: true });
  expect(plan.pruneOciCache).toBe(true);
  expect(plan.warnings.join(" ")).toContain("re-download");
});

test("reclaimable bytes exclude the OCI cache unless deep", () => {
  expect(planCleanup(inputs).reclaimableBytes).toBe(10 * GB_BYTES);
  expect(planCleanup({ ...inputs, deep: true }).reclaimableBytes).toBe(90 * GB_BYTES);
});

test("an already-clean system yields an empty plan", () => {
  const plan = planCleanup({
    staleVms: [], legacyDirs: [], artifactDirs: ["a1"],
    cacheBytes: 5 * GB_BYTES, cacheBudgetBytes: 15 * GB_BYTES,
    ociCacheBytes: 80 * GB_BYTES, deep: false,
  });
  expect(plan.isEmpty).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/clean.test.ts`
Expected: FAIL — cannot resolve module `../src/commands/clean`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/clean.ts`:

```ts
import * as p from "@clack/prompts";
import { loadConfig, remotePaths } from "../config";
import { ssh } from "../remote/ssh";
import type { ParsedArgs } from "../args";

export const GB_BYTES = 1024 * 1024 * 1024;
export const ARTIFACTS_KEPT = 3;

export interface CleanInputs {
  staleVms: string[];
  legacyDirs: string[];
  /** Artifact directory names, newest first. */
  artifactDirs: string[];
  cacheBytes: number;
  cacheBudgetBytes: number;
  ociCacheBytes: number;
  deep: boolean;
}

export interface CleanPlan {
  vmsToDelete: string[];
  dirsToDelete: string[];
  artifactsToDelete: string[];
  trimCacheToBytes?: number;
  pruneOciCache: boolean;
  reclaimableBytes: number;
  warnings: string[];
  isEmpty: boolean;
}

export function planCleanup(input: CleanInputs): CleanPlan {
  const warnings: string[] = [];
  const artifactsToDelete = input.artifactDirs.slice(ARTIFACTS_KEPT);
  const cacheOverBudget = Math.max(0, input.cacheBytes - input.cacheBudgetBytes);

  if (input.deep) {
    warnings.push(
      "Pruning the OCI cache means the next 'vm rebuild' must re-download ~62 GB.",
    );
  }

  const reclaimableBytes = cacheOverBudget + (input.deep ? input.ociCacheBytes : 0);

  const isEmpty =
    input.staleVms.length === 0 &&
    input.legacyDirs.length === 0 &&
    artifactsToDelete.length === 0 &&
    cacheOverBudget === 0 &&
    !input.deep;

  return {
    vmsToDelete: input.staleVms,
    dirsToDelete: input.legacyDirs,
    artifactsToDelete,
    trimCacheToBytes: cacheOverBudget > 0 ? input.cacheBudgetBytes : undefined,
    pruneOciCache: input.deep,
    reclaimableBytes,
    warnings,
    isEmpty,
  };
}

/** Gather current state from the Mac. Read-only. */
export async function inspectMac(
  target: { host: string; user?: string },
  slug: string,
  cacheBudgetGB: number,
  deep: boolean,
): Promise<CleanInputs> {
  const paths = remotePaths(slug);

  const vmList = ssh(target, "tart list --format json 2>/dev/null || echo '[]'", { allowFailure: true });
  let staleVms: string[] = [];
  try {
    const parsed = JSON.parse(vmList) as { Name: string; Running: boolean; Source: string }[];
    staleVms = parsed
      .filter((v) => v.Source === "local" && !v.Running)
      .filter((v) => /^expo-builder-build-|^build-\d/.test(v.Name))
      .map((v) => v.Name);
  } catch { /* leave empty */ }

  const legacyRaw = ssh(target, "ls -d $HOME/eas/* 2>/dev/null || true", { allowFailure: true });
  const legacyDirs = legacyRaw.split("\n").map((s) => s.trim()).filter(Boolean);

  const artifactsRaw = ssh(target, `ls -1t ${paths.artifacts} 2>/dev/null || true`, { allowFailure: true });
  const artifactDirs = artifactsRaw.split("\n").map((s) => s.trim()).filter(Boolean);

  const cacheKb = ssh(target, `du -sk ${paths.cache} 2>/dev/null | cut -f1 || echo 0`, { allowFailure: true });
  const ociKb = ssh(target, "du -sk \"${TART_HOME:-$HOME/.tart}\"/cache 2>/dev/null | cut -f1 || echo 0", { allowFailure: true });

  return {
    staleVms,
    legacyDirs,
    artifactDirs,
    cacheBytes: (parseInt(cacheKb, 10) || 0) * 1024,
    cacheBudgetBytes: cacheBudgetGB * GB_BYTES,
    ociCacheBytes: (parseInt(ociKb, 10) || 0) * 1024,
    deep,
  };
}

export async function applyCleanup(
  target: { host: string; user?: string },
  slug: string,
  plan: CleanPlan,
): Promise<void> {
  const paths = remotePaths(slug);

  for (const vm of plan.vmsToDelete) {
    ssh(target, `tart delete ${vm} 2>/dev/null || true`, { allowFailure: true });
  }
  for (const dir of plan.dirsToDelete) {
    ssh(target, `rm -rf "${dir}"`, { allowFailure: true });
  }
  for (const artifact of plan.artifactsToDelete) {
    ssh(target, `rm -rf "${paths.artifacts}/${artifact}"`, { allowFailure: true });
  }
  if (plan.trimCacheToBytes !== undefined) {
    // Delete least-recently-used cache subdirectories until under budget.
    const budgetKb = Math.floor(plan.trimCacheToBytes / 1024);
    ssh(target, [
      `BUDGET=${budgetKb}`,
      `cd ${paths.cache} 2>/dev/null || exit 0`,
      `for d in $(ls -1tr); do`,
      `  USED=$(du -sk . | cut -f1)`,
      `  [ "$USED" -le "$BUDGET" ] && break`,
      `  rm -rf "$d"`,
      `done`,
    ].join("; "), { allowFailure: true });
  }
  if (plan.pruneOciCache) {
    ssh(target, "tart prune --entries caches --space-budget 0", { allowFailure: true });
  }
}

export async function runClean(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const target = { host: cfg.mac.host, user: cfg.mac.user };

  p.intro(`expo-builder clean — ${cfg.slug}`);

  const inputs = await inspectMac(target, cfg.slug, cfg.cache.budgetGB, args.flags.deep);
  const plan = planCleanup(inputs);

  if (plan.isEmpty) {
    p.outro("Nothing to clean");
    return 0;
  }

  if (plan.vmsToDelete.length) p.log.info(`Stale VMs: ${plan.vmsToDelete.join(", ")}`);
  if (plan.dirsToDelete.length) p.log.info(`Legacy directories: ${plan.dirsToDelete.join(", ")}`);
  if (plan.artifactsToDelete.length) p.log.info(`Old artifacts: ${plan.artifactsToDelete.length}`);
  if (plan.trimCacheToBytes !== undefined) p.log.info(`Trim cache to ${cfg.cache.budgetGB} GB`);
  if (plan.pruneOciCache) p.log.info("Prune the Tart OCI cache");
  for (const w of plan.warnings) p.log.warn(w);
  p.log.message(`Reclaimable: ~${(plan.reclaimableBytes / GB_BYTES).toFixed(1)} GB`);

  if (args.flags.dryRun) {
    p.outro("Dry run — nothing was removed");
    return 0;
  }

  if (!args.flags.yes) {
    const ok = await p.confirm({ message: "Proceed?" });
    if (p.isCancel(ok) || !ok) {
      p.cancel("Cancelled");
      return 0;
    }
  }

  await applyCleanup(target, cfg.slug, plan);
  p.outro("Cleaned");
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/clean.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/clean.ts test/clean.test.ts
git commit -m "feat: add clean command retaining the OCI cache by default"
```

---

## Task 19: Build preflight

Prevents a build dying halfway through on a full disk.

**Files:**
- Create: `src/commands/preflight.ts`
- Create: `test/preflight.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/preflight.test.ts`:

```ts
import { expect, test } from "bun:test";
import { assessPreflight, BUILD_HEADROOM_BYTES } from "../src/commands/preflight";
import { GB } from "../src/remote/storage";

test("plenty of space proceeds without cleaning", () => {
  const r = assessPreflight({ freeBytes: 200 * GB, reclaimableBytes: 10 * GB });
  expect(r.action).toBe("proceed");
});

test("short on space but reclaimable triggers a clean first", () => {
  const r = assessPreflight({ freeBytes: 10 * GB, reclaimableBytes: 40 * GB });
  expect(r.action).toBe("clean-then-proceed");
});

test("short on space with nothing to reclaim refuses", () => {
  const r = assessPreflight({ freeBytes: 5 * GB, reclaimableBytes: 1 * GB });
  expect(r.action).toBe("refuse");
  expect(r.message).toContain("disk");
});

test("the headroom threshold matches the documented build budget", () => {
  expect(BUILD_HEADROOM_BYTES).toBe(25 * GB);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/preflight.test.ts`
Expected: FAIL — cannot resolve module `../src/commands/preflight`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/preflight.ts`:

```ts
import { GB } from "../remote/storage";

/** Transient CoW clone plus build writes, per spec §6. */
export const BUILD_HEADROOM_BYTES = 25 * GB;

export interface PreflightInputs {
  freeBytes: number;
  reclaimableBytes: number;
}

export interface PreflightResult {
  action: "proceed" | "clean-then-proceed" | "refuse";
  message?: string;
}

export function assessPreflight(input: PreflightInputs): PreflightResult {
  if (input.freeBytes >= BUILD_HEADROOM_BYTES) return { action: "proceed" };

  if (input.freeBytes + input.reclaimableBytes >= BUILD_HEADROOM_BYTES) {
    return {
      action: "clean-then-proceed",
      message:
        `Only ${(input.freeBytes / GB).toFixed(1)} GB free; a build needs about ` +
        `${(BUILD_HEADROOM_BYTES / GB).toFixed(0)} GB. Reclaiming space first.`,
    };
  }

  return {
    action: "refuse",
    message:
      `Not enough disk on the Mac: ${(input.freeBytes / GB).toFixed(1)} GB free, ` +
      `about ${(BUILD_HEADROOM_BYTES / GB).toFixed(0)} GB needed, and only ` +
      `${(input.reclaimableBytes / GB).toFixed(1)} GB can be reclaimed automatically.\n\n` +
      `Try: expo-builder clean --deep\n` +
      `Or move Tart storage to an external APFS SSD by setting mac.tartHome.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/preflight.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/preflight.ts test/preflight.test.ts
git commit -m "feat: refuse or auto-clean before a build rather than failing mid-run"
```

---

## Task 20: rsync transfer

**Files:**
- Modify: `src/remote/sync.ts`
- Modify: `test/sync.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/sync.test.ts`:

```ts
import { buildRsyncArgs } from "../src/remote/sync";

test("rsync args include --delete and the files-from stdin marker", () => {
  const args = buildRsyncArgs({
    sshCommand: "ssh -i /key",
    source: "/Users/mingu/app/",
    destination: "mingu@defymac:/Users/mingu/.expo-builder/projects/my-app/",
    remoteRsyncPath: undefined,
  });
  expect(args).toContain("--delete");
  expect(args).toContain("--files-from=-");
  expect(args).toContain("-rltz");
});

test("rsync args include --rsync-path when Homebrew rsync is present", () => {
  const args = buildRsyncArgs({
    sshCommand: "ssh",
    source: "/a/",
    destination: "h:/b/",
    remoteRsyncPath: "/opt/homebrew/bin/rsync",
  });
  const idx = args.indexOf("--rsync-path");
  expect(idx).toBeGreaterThan(-1);
  expect(args[idx + 1]).toBe("/opt/homebrew/bin/rsync");
});

test("source and destination are the final two arguments in order", () => {
  const args = buildRsyncArgs({
    sshCommand: "ssh", source: "/a/", destination: "h:/b/", remoteRsyncPath: undefined,
  });
  expect(args[args.length - 2]).toBe("/a/");
  expect(args[args.length - 1]).toBe("h:/b/");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/sync.test.ts`
Expected: FAIL — `buildRsyncArgs` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/remote/sync.ts`:

```ts
export interface RsyncOptions {
  sshCommand: string;
  source: string;
  destination: string;
  remoteRsyncPath?: string;
}

/**
 * --delete is the important change from the previous implementation: without
 * it, anything ever synced stayed on the Mac forever.
 */
export function buildRsyncArgs(opts: RsyncOptions): string[] {
  return [
    "-rltz",
    "--delete",
    "-e", opts.sshCommand,
    ...(opts.remoteRsyncPath ? ["--rsync-path", opts.remoteRsyncPath] : []),
    "--files-from=-",
    opts.source,
    opts.destination,
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/sync.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote/sync.ts test/sync.test.ts
git commit -m "feat: add --delete to rsync so removed files do not linger"
```

---

## Task 21: Remote build orchestration

Wires everything together. Port the streaming/marker loop from `scripts/eas.ts:748-959` — read it before starting.

**Files:**
- Create: `src/commands/build.ts`
- Create: `src/commands/remote-build.ts`

- [ ] **Step 1: Write the remote build driver**

Create `src/commands/remote-build.ts`:

```ts
import { spawn, spawnSync, execFileSync } from "child_process";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import * as p from "@clack/prompts";
import type { Platform, Profile, ParsedArgs } from "../args";
import { BuildError } from "../errors";
import type { ResolvedConfig } from "../config";
import { remotePaths } from "../config";
import { ssh, sshTargetString, pickSshKey, normalizedKeyCopy, toRsyncPath, findCwrsyncSsh, loginWrap } from "../remote/ssh";
import { resolveWorkspaceDeps, computeSyncRoots, collectFiles, buildRsyncArgs } from "../remote/sync";
import { generateVmScript } from "../remote/vm-script";
import { generateHostScript } from "../remote/host-script";
import { parseMarker } from "../remote/markers";
import { OutputFilter, showLine, showBar } from "../ui/output";
import { PhaseTracker } from "../ui/phases";
import { inspectMac, planCleanup, applyCleanup } from "./clean";
import { assessPreflight } from "./preflight";
import { loadCompatTags } from "../compat-cache";
import { resolveImage, parseSdkMajor, compareVersions, requirementsFor } from "../compat";
import { readExpoSdkRange } from "../config";

export interface RemoteBuildOptions {
  cfg: ResolvedConfig;
  profile: Profile;
  platform: Platform;
  submit: boolean;
  optimize: boolean;
  cache: boolean;
  dryRun: boolean;
  download?: string;
}

export async function runRemoteBuild(opts: RemoteBuildOptions): Promise<number> {
  const { cfg, profile, platform, submit, optimize, cache, dryRun } = opts;
  const target = { host: cfg.mac.host, user: cfg.mac.user };
  const paths = remotePaths(cfg.slug);
  const platforms: ("android" | "ios")[] =
    platform === "all" ? ["ios", "android"] : [platform];

  if (!cfg.expoToken) {
    throw new BuildError(
      "EXPO_TOKEN is not set.",
      "Create one at expo.dev → Account Settings → Access Tokens, then set it in your\n" +
      "environment, the project's .env, or ~/.expo-builder/env",
    );
  }

  // ── Image compatibility (cached; never blocks on the network) ────────
  if (!dryRun) {
    const sdkRange = readExpoSdkRange(cfg.mobileDir);
    const sdkMajor = sdkRange ? parseSdkMajor(sdkRange) : undefined;
    const compat = await loadCompatTags();
    const resolved = resolveImage(sdkMajor, compat.tags, cfg.vm.xcode);

    const recordJson = ssh(target, `cat ${paths.imageRecord} 2>/dev/null || true`, { allowFailure: true });
    let record: { tag: string; xcode: string } | undefined;
    try { record = recordJson ? JSON.parse(recordJson) : undefined; } catch { /* absent */ }

    const req = sdkMajor === undefined ? undefined : requirementsFor(sdkMajor);
    if (record && req && compareVersions(record.xcode, req.minXcode) < 0) {
      throw new BuildError(
        `The VM image has Xcode ${record.xcode}, but Expo SDK ${sdkMajor} requires ${req.minXcode} or newer.`,
        `Rebuild the image:\n\n  expo-builder vm rebuild${resolved.tag ? ` --xcode ${resolved.tag}` : ""}`,
      );
    }
    if (record && resolved.tag && compareVersions(record.tag, resolved.tag) !== 0) {
      p.log.warn(
        `A better-matching image is available: Xcode ${resolved.tag} (currently ${record.tag}). ` +
        `Run: expo-builder vm rebuild`,
      );
    }
  }

  // ── Preflight ────────────────────────────────────────────────────────
  if (!dryRun) {
    const s = p.spinner();
    s.start("Checking disk space on the Mac...");
    const inputs = await inspectMac(target, cfg.slug, cfg.cache.budgetGB, false);
    const plan = planCleanup(inputs);
    const freeRaw = ssh(target, "df -k \"${TART_HOME:-$HOME}\" | tail -1 | awk '{print $4}'", { allowFailure: true });
    const freeBytes = (parseInt(freeRaw, 10) || 0) * 1024;
    const verdict = assessPreflight({ freeBytes, reclaimableBytes: plan.reclaimableBytes });

    if (verdict.action === "refuse") {
      s.stop("Not enough disk space");
      throw new BuildError(verdict.message!);
    }
    if (verdict.action === "clean-then-proceed") {
      s.message(verdict.message!);
      await applyCleanup(target, cfg.slug, plan);
    }
    s.stop("Disk space OK");
  }

  // ── Sync ─────────────────────────────────────────────────────────────
  const workspaceDeps = resolveWorkspaceDeps(cfg.projectRoot, cfg.mobileDir);
  const roots = computeSyncRoots({
    projectRoot: cfg.projectRoot,
    mobileDir: cfg.mobileDir,
    workspaceDeps,
    syncPaths: cfg.syncPaths,
  });
  const files = collectFiles(cfg.projectRoot, roots);

  if (dryRun) {
    p.log.info(`Would sync ${files.length} files from ${roots.join(", ")}`);
  } else {
    const s = p.spinner();
    s.start(`Syncing ${files.length} files to the Mac...`);

    const keyPath = pickSshKey({ configured: cfg.mac.sshKey });
    if (!keyPath) {
      throw new BuildError(
        "No SSH key found.",
        `Looked in ~/.ssh for id_ed25519, id_rsa, id_ecdsa.\n` +
        `Specify one with --ssh-key, or set mac.sshKey in expo-builder.json.`,
      );
    }
    const usableKey = normalizedKeyCopy(keyPath, join(homedir(), ".expo-builder", "ssh"));

    const sshCommand = process.platform === "win32"
      ? `${toRsyncPath(findCwrsyncSsh())} -i ${toRsyncPath(usableKey)} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`
      : `ssh -i ${usableKey} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;

    ssh(target, `mkdir -p ${paths.project} ${paths.cache} ${paths.artifacts}`);

    const remoteRsync = ssh(target, "[ -x /opt/homebrew/bin/rsync ] && echo /opt/homebrew/bin/rsync || true", { allowFailure: true });

    const result = spawnSync("rsync", buildRsyncArgs({
      sshCommand,
      source: `${toRsyncPath(cfg.projectRoot)}/`,
      destination: `${sshTargetString(target)}:${paths.project.replace("$HOME", "~")}/`,
      remoteRsyncPath: remoteRsync || undefined,
    }), {
      cwd: cfg.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      input: `${files.join("\n")}\n`,
    });

    if (result.status !== 0) {
      s.stop("rsync failed");
      throw new BuildError(
        `rsync exited with code ${result.status}`,
        result.stderr?.toString().trim(),
      );
    }
    s.stop(`Synced ${files.length} files`);

    // Copy the optimization plugin next to the project's own plugins.
    if (optimize) {
      const pluginSrc = resolve(import.meta.dirname, "..", "..", "plugins", "withBuildOptimizations.js");
      if (existsSync(pluginSrc)) {
        const mobileRel = roots.includes(".") ? "" : computeMobileRel(cfg);
        const dest = mobileRel
          ? `${paths.project}/${mobileRel}/plugins/withBuildOptimizations.js`
          : `${paths.project}/plugins/withBuildOptimizations.js`;
        spawnSync("ssh", [sshTargetString(target), `mkdir -p "$(dirname ${dest})" && cat > ${dest}`], {
          stdio: ["pipe", "pipe", "pipe"],
          input: readFileSync(pluginSrc, "utf-8"),
        });
      }
    }
  }

  // ── Build each platform ──────────────────────────────────────────────
  for (let i = 0; i < platforms.length; i++) {
    const plat = platforms[i]!;
    const label = platforms.length > 1 ? ` [${i + 1}/${platforms.length}]` : "";
    p.log.step(`${submit ? "Build + Submit" : "Build"}: ${plat} (${profile})${label}`);

    const timestamp = Date.now();
    const vmScript = generateVmScript({
      expoToken: cfg.expoToken,
      profile,
      platform: plat,
      submit,
      optimize,
      cacheEnabled: cache && cfg.cache.enabled,
      mountName: cfg.slug,
      mobileRelPath: computeMobileRel(cfg),
      javaVersion: "17",
    });

    const stateFile = `/tmp/expo-builder-vm-${cfg.slug}-${timestamp}-${i}`;
    // Keep the $HOME form: the host script uses this inside double quotes,
    // where "~" would not expand but "$HOME" does.
    const artifactDir = `${paths.artifacts}/${timestamp}`;
    const hostScript = generateHostScript({
      imageName: cfg.vm.name,
      mountName: cfg.slug,
      remotePath: paths.project,
      cachePath: cache && cfg.cache.enabled ? paths.cache : undefined,
      artifactDir,
      artifactExt: plat === "ios" ? "ipa" : "aab",
      stateFile,
      vmScript,
      timestamp,
      tartHome: cfg.mac.tartHome,
    });

    if (dryRun) {
      process.stdout.write(`\n===== Mac host script (${plat}) =====\n${hostScript}\n`);
      process.stdout.write(`\n===== VM script (${plat}) =====\n${vmScript}\n`);
      continue;
    }

    const exitCode = await streamRemoteScript({
      target, hostScript, stateFile, plat, profile,
      projectRoot: cfg.projectRoot, slug: cfg.slug, timestamp,
    });

    if (exitCode !== 0) {
      throw new BuildError(`Remote build failed (${plat}, ${profile})`);
    }
    p.log.success(`${plat} ${submit ? "built and submitted" : "build complete"}`);
  }

  return 0;
}

function computeMobileRel(cfg: ResolvedConfig): string {
  const rel = resolve(cfg.mobileDir).slice(resolve(cfg.projectRoot).length).replace(/\\/g, "/").replace(/^\//, "");
  return rel;
}

interface StreamOptions {
  target: { host: string; user?: string };
  hostScript: string;
  stateFile: string;
  plat: string;
  profile: string;
  projectRoot: string;
  slug: string;
  timestamp: number;
}

/**
 * Push the host script to the Mac, run it, and translate marker output into
 * spinners. No PTY: -tt puts the local terminal into raw mode and breaks
 * spinner rendering.
 */
async function streamRemoteScript(opts: StreamOptions): Promise<number> {
  const { target, hostScript, stateFile, plat, profile, projectRoot, timestamp } = opts;
  const targetStr = sshTargetString(target);
  const scriptPath = `/tmp/expo-builder-build-${opts.slug}-${timestamp}.sh`;

  spawnSync("ssh", [targetStr, `cat > ${scriptPath} && chmod +x ${scriptPath}`], {
    stdio: ["pipe", "pipe", "pipe"],
    input: hostScript,
  });

  const logDir = resolve(projectRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, `${plat}-${profile}-${new Date(timestamp).toISOString().replace(/[:.]/g, "-")}.log`);
  const log = (text: string) => appendFileSync(logFile, `${text}\n`);

  return new Promise<number>((done, fail) => {
    const child = spawn("ssh", [targetStr, `bash ${scriptPath}; rm -f ${scriptPath}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const phases = new PhaseTracker();
    const filter = new OutputFilter();
    let failed = false;
    let hadOutput = false;
    let easPhase = "";

    const flushBar = () => { if (hadOutput) { showBar(); hadOutput = false; } };

    const processLine = (line: string, isStderr = false) => {
      log(line);
      filter.record(line);

      const marker = parseMarker(line);
      if (marker) {
        switch (marker.kind) {
          case "phase":
            phases.start(marker.value, marker.value === "build" ? `Building ${plat} (${profile})...` : undefined);
            easPhase = "";
            return;
          case "boot-wait": flushBar(); phases.message(`Booting VM... (${marker.value}s)`); return;
          case "vm-ip": flushBar(); phases.message(`VM booted (${marker.value})`); return;
          case "vm-resources": showLine(`VM: ${marker.value}`); hadOutput = true; return;
          case "version": flushBar(); phases.message(`Version: ${marker.value}`); return;
          case "stale": showLine(`Removing stale VM: ${marker.value}`); hadOutput = true; return;
          case "image-size": showLine(`Image: ${marker.value}`); hadOutput = true; return;
          case "error":
            phases.stop(false);
            failed = true;
            p.log.error(marker.value);
            return;
        }
      }

      if (isStderr) { showLine(line); hadOutput = true; return; }

      const verdict = filter.classify(line, phases.current);
      if (verdict !== "show") return;

      if (phases.current === "build") {
        const sub = filter.easPhase(line);
        if (sub && sub !== easPhase) {
          flushBar();
          easPhase = sub;
          phases.message(`Building ${plat}: ${sub}`);
        }
      }
      showLine(line);
      hadOutput = true;
    };

    const makeReader = (isStderr: boolean) => {
      let buf = "";
      return (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.replace(/\r/g, "").trim();
          if (line) processLine(line, isStderr);
        }
      };
    };

    child.stdout!.on("data", makeReader(false));
    child.stderr!.on("data", makeReader(true));

    let interrupted = false;
    const onSignal = () => {
      if (interrupted) return;
      interrupted = true;
      phases.stop(false);
      p.log.warn("Interrupted — cleaning up the VM on the Mac...");
      try {
        execFileSync("ssh", ["-o", "ConnectTimeout=15", targetStr, loginWrap(
          `VM=$(cat ${stateFile} 2>/dev/null); ` +
          `[ -n "$VM" ] && tart stop -t 30 "$VM" 2>/dev/null; ` +
          `[ -n "$VM" ] && tart delete "$VM" 2>/dev/null; ` +
          `rm -f ${stateFile} ${scriptPath}`,
        )], { stdio: "pipe", timeout: 60000 });
        p.log.info("VM cleaned up");
      } catch {
        p.log.warn("Could not confirm VM cleanup — the next build will sweep it");
      }
      child.kill("SIGTERM");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);

    child.on("close", (code) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      phases.stop(!failed && code === 0);
      if (failed || code !== 0) {
        p.log.message("Last output:");
        for (const l of filter.tail().slice(-15)) process.stdout.write(`│  ${l}\n`);
        showBar();
      }
      p.log.info(`Log: ${logFile}`);
      done(code ?? 1);
    });
    child.on("error", fail);
  });
}
```

- [ ] **Step 2: Write the build command**

Create `src/commands/build.ts`:

```ts
import * as p from "@clack/prompts";
import { execFileSync } from "child_process";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { runRemoteBuild } from "./remote-build";

export async function runBuild(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const profile = args.profile ?? "development";
  const platform = args.platform ?? "all";

  if (args.flags.remote) {
    p.intro(`expo-builder — ${cfg.slug}`);
    const code = await runRemoteBuild({
      cfg, profile, platform,
      submit: false,
      optimize: args.flags.optimize,
      cache: args.flags.cache,
      dryRun: args.flags.dryRun,
      download: args.flags.download,
    });
    p.outro("Done");
    return code;
  }

  execFileSync("bunx", ["eas", "build", "--platform", platform, "--profile", profile, "--non-interactive"], {
    stdio: "inherit",
    cwd: cfg.mobileDir,
  });
  return 0;
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `bun run typecheck`
Expected: errors only about the not-yet-created command modules (`submit`, `deploy`, `update`, `run`, `init`, `vm`, `logs`, `interactive`). No errors in `build.ts` or `remote-build.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/build.ts src/commands/remote-build.ts
git commit -m "feat: orchestrate remote builds with preflight, scoped sync, and artifact retrieval"
```

---

## Task 22: Cloud commands and local run

**Files:**
- Create: `src/commands/submit.ts`, `src/commands/deploy.ts`, `src/commands/update.ts`, `src/commands/run.ts`
- Create: `test/guards.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/guards.test.ts`:

```ts
import { expect, test } from "bun:test";
import { assertSubmittable } from "../src/commands/guards";
import { UsageError } from "../src/errors";

test("development builds cannot be submitted", () => {
  expect(() => assertSubmittable("development")).toThrow(UsageError);
});

test("the error explains why development is rejected", () => {
  try {
    assertSubmittable("development");
    throw new Error("should have thrown");
  } catch (err) {
    expect((err as UsageError).message).toContain("internal distribution");
  }
});

test("preview and production are submittable", () => {
  expect(() => assertSubmittable("preview")).not.toThrow();
  expect(() => assertSubmittable("production")).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/guards.test.ts`
Expected: FAIL — cannot resolve module `../src/commands/guards`.

- [ ] **Step 3: Write the implementations**

Create `src/commands/guards.ts`:

```ts
import type { Profile } from "../args";
import { UsageError } from "../errors";

export function assertSubmittable(profile: Profile): void {
  if (profile === "development") {
    throw new UsageError(
      "Development builds use internal distribution (APK), which the stores reject.",
      "Use the preview or production profile instead.",
    );
  }
}
```

Create `src/commands/submit.ts`:

```ts
import { execFileSync } from "child_process";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { assertSubmittable } from "./guards";

export async function runSubmit(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const profile = args.profile ?? "preview";
  assertSubmittable(profile);
  execFileSync("bunx", [
    "eas", "submit",
    "--platform", args.platform ?? "all",
    "--profile", profile,
    "--non-interactive", "--latest",
  ], { stdio: "inherit", cwd: cfg.mobileDir });
  return 0;
}
```

Create `src/commands/deploy.ts`:

```ts
import { execFileSync } from "child_process";
import * as p from "@clack/prompts";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { assertSubmittable } from "./guards";
import { runRemoteBuild } from "./remote-build";

export async function runDeploy(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const profile = args.profile ?? "preview";
  const platform = args.platform ?? "all";
  assertSubmittable(profile);

  if (args.flags.remote) {
    p.intro(`expo-builder — ${cfg.slug}`);
    const code = await runRemoteBuild({
      cfg, profile, platform,
      submit: true,
      optimize: args.flags.optimize,
      cache: args.flags.cache,
      dryRun: args.flags.dryRun,
      download: args.flags.download,
    });
    p.outro("Done");
    return code;
  }

  // --auto-submit ties the exact build to its submission, avoiding --latest guessing.
  execFileSync("bunx", [
    "eas", "build",
    "--platform", platform,
    "--profile", profile,
    "--non-interactive", "--auto-submit",
  ], { stdio: "inherit", cwd: cfg.mobileDir });
  return 0;
}
```

Create `src/commands/update.ts`:

```ts
import { execFileSync } from "child_process";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { UsageError } from "../errors";

export async function runUpdate(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const profile = args.profile ?? "production";
  const message = args.flags.message ?? args.positionals.join(" ");
  if (!message) {
    throw new UsageError(
      "An update message is required.",
      'Example: expo-builder update preview -m "fix crash on launch"',
    );
  }
  execFileSync("bunx", [
    "eas", "update",
    "--channel", profile,
    "--environment", profile,
    "--message", message,
    "--non-interactive",
  ], { stdio: "inherit", cwd: cfg.mobileDir });
  return 0;
}
```

Create `src/commands/run.ts`:

```ts
import { execFileSync } from "child_process";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { UsageError, BuildError } from "../errors";

export async function runLocal(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const platform = args.platform;
  if (platform !== "android" && platform !== "ios") {
    throw new UsageError(
      "run requires a single platform.",
      "Example: expo-builder run android",
    );
  }

  const ext = platform === "android" ? "apk" : "ipa";
  const output = `build/${cfg.slug}-dev.${ext}`;

  execFileSync("bunx", [
    "eas", "build",
    "--platform", platform,
    "--profile", "development",
    "--local", "--output", output,
  ], { stdio: "inherit", cwd: cfg.mobileDir });

  if (platform === "android") {
    execFileSync("adb", ["install", output], { stdio: "inherit", cwd: cfg.mobileDir });
    return 0;
  }

  const listing = execFileSync("xcrun", ["devicectl", "list", "devices", "-j", "/dev/stdout"], {
    encoding: "utf-8", cwd: cfg.mobileDir, stdio: ["pipe", "pipe", "inherit"],
  });
  const devices = (JSON.parse(listing) as { result?: { devices?: unknown[] } }).result?.devices ?? [];
  const wired = (devices as { connectionProperties?: { transportType?: string }; identifier?: string }[])
    .find((d) => d.connectionProperties?.transportType === "wired");
  if (!wired?.identifier) {
    throw new BuildError("No wired iOS device found.", "Connect a device over USB and try again.");
  }
  execFileSync("xcrun", ["devicectl", "device", "install", "app", "--device", wired.identifier, output], {
    stdio: "inherit", cwd: cfg.mobileDir,
  });
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/guards.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/guards.ts src/commands/submit.ts src/commands/deploy.ts src/commands/update.ts src/commands/run.ts test/guards.test.ts
git commit -m "feat: add cloud build, submit, deploy, update, and local run commands"
```

---

## Task 23: `vm` command

**Files:**
- Create: `src/commands/vm.ts`
- Create: `test/vm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/vm.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseVmSubcommand, planImageEviction } from "../src/commands/vm";
import { UsageError } from "../src/errors";

test("valid subcommands are accepted", () => {
  for (const sub of ["list", "rebuild", "delete", "migrate"]) {
    expect(parseVmSubcommand([sub])).toBe(sub);
  }
});

test("a missing subcommand is a usage error listing the options", () => {
  try {
    parseVmSubcommand([]);
    throw new Error("should have thrown");
  } catch (err) {
    expect((err as UsageError).hint).toContain("rebuild");
  }
});

test("an unknown subcommand is rejected", () => {
  expect(() => parseVmSubcommand(["frobnicate"])).toThrow(UsageError);
});

test("planImageEviction is re-exported from the vm command module", () => {
  expect(planImageEviction([{ name: "a", accessed: 1 }], 0)).toEqual(["a"]);
});
```

The eviction logic itself is tested in `test/storage.test.ts` (Task 7), where it lives. This
case only confirms the re-export, which exists so `setup/tart.ts` and `commands/vm.ts` do not
form an import cycle.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/vm.test.ts`
Expected: FAIL — cannot resolve module `../src/commands/vm`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/vm.ts`:

```ts
import * as p from "@clack/prompts";
import type { ParsedArgs } from "../args";
import { UsageError, BuildError } from "../errors";
import { loadConfig, readExpoSdkRange } from "../config";
import { ssh } from "../remote/ssh";
import { parseSdkMajor, resolveImage } from "../compat";
import { loadCompatTags } from "../compat-cache";
import { provisionImage } from "../setup/tart";
import { parseDiskutilInfo, validateVolume, deriveKeepImages } from "../remote/storage";

const SUBCOMMANDS = ["list", "rebuild", "delete", "migrate"] as const;
export type VmSubcommand = (typeof SUBCOMMANDS)[number];

export function parseVmSubcommand(positionals: string[]): VmSubcommand {
  const sub = positionals[0];
  if (!sub) {
    throw new UsageError(
      "vm requires a subcommand.",
      `Valid subcommands: ${SUBCOMMANDS.join(", ")}`,
    );
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(
      `Unknown vm subcommand: ${sub}`,
      `Valid subcommands: ${SUBCOMMANDS.join(", ")}`,
    );
  }
  return sub as VmSubcommand;
}

// Re-exported so `expo-builder vm` remains the natural place to find these,
// while the implementation lives in remote/storage.ts to avoid an import cycle
// with setup/tart.ts.
export { planImageEviction, type ImageEntry } from "../remote/storage";

export async function runVm(args: ParsedArgs): Promise<number> {
  const sub = parseVmSubcommand(args.positionals);
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const target = { host: cfg.mac.host, user: cfg.mac.user };

  switch (sub) {
    case "list": {
      const out = ssh(target, "tart list", { allowFailure: true });
      process.stdout.write(`${out}\n`);
      return 0;
    }

    case "delete": {
      if (!args.flags.yes) {
        const ok = await p.confirm({ message: `Delete the image "${cfg.vm.name}"?` });
        if (p.isCancel(ok) || !ok) return 0;
      }
      ssh(target, `tart delete ${cfg.vm.name}`, { allowFailure: true });
      p.log.success(`Deleted ${cfg.vm.name}`);
      return 0;
    }

    case "migrate": {
      const to = args.flags.to;
      if (!to) {
        throw new UsageError(
          "vm migrate requires a destination.",
          "Example: expo-builder vm migrate --to /Volumes/BuildSSD/.tart",
        );
      }
      const info = ssh(target, `diskutil info "${to}" 2>/dev/null || true`, { allowFailure: true });
      if (!info) {
        throw new BuildError(`Could not inspect ${to} on the Mac. Is the volume mounted?`);
      }
      const validation = validateVolume(parseDiskutilInfo(info));
      for (const w of validation.warnings) p.log.warn(w);
      if (validation.errors.length > 0) {
        throw new BuildError(validation.errors.join("\n\n"));
      }
      const s = p.spinner();
      s.start(`Moving Tart storage to ${to}...`);
      ssh(target, `mkdir -p "${to}" && rsync -a "\${TART_HOME:-$HOME/.tart}/" "${to}/"`);
      s.stop("Storage moved");
      p.log.info(
        `Add this to expo-builder.json:\n\n  { "mac": { "host": "${cfg.mac.host}", "tartHome": "${to}" } }\n\n` +
        `Then verify with: expo-builder doctor\n` +
        `Once verified, remove the old copy on the Mac manually.`,
      );
      return 0;
    }

    case "rebuild": {
      const sdkRange = readExpoSdkRange(cfg.mobileDir);
      const sdkMajor = sdkRange ? parseSdkMajor(sdkRange) : undefined;
      const { tags } = await loadCompatTags({ forceRefresh: true });
      const resolved = resolveImage(sdkMajor, tags, args.flags.xcode ?? cfg.vm.xcode);

      for (const w of resolved.warnings) p.log.warn(w);
      if (!resolved.repo || !resolved.tag) {
        throw new BuildError(
          "Could not resolve a Tart image for this project.",
          resolved.warnings.join("\n"),
        );
      }

      const freeRaw = ssh(target, "df -k \"${TART_HOME:-$HOME}\" | tail -1 | awk '{print $4}'", { allowFailure: true });
      const freeBytes = (parseInt(freeRaw, 10) || 0) * 1024;
      const keep = deriveKeepImages(freeBytes, cfg.vm.keepImages);
      p.log.info(`Retaining up to ${keep} image${keep === 1 ? "" : "s"} (${(freeBytes / 1024 ** 3).toFixed(0)} GB free)`);

      return provisionImage({
        target,
        imageName: cfg.vm.name,
        source: `${resolved.repo}:${resolved.tag}`,
        keepImages: keep,
        yes: args.flags.yes,
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/vm.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/vm.ts test/vm.test.ts
git commit -m "feat: add vm list, rebuild, delete, and migrate subcommands"
```

---

## Task 24: Image provisioning with slimming

Replaces `scripts/setup-tart.ts`. Two behavioural changes: step failures are **fatal** (the old version warned and continued, silently producing a broken image), and the image is slimmed before freezing.

**Files:**
- Create: `src/setup/tart.ts`
- Create: `test/provision.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/provision.test.ts`:

```ts
import { expect, test } from "bun:test";
import { slimCommands, provisionSteps, parseVersions } from "../src/setup/tart";

test("slimming removes simulator runtimes we never use", () => {
  const cmds = slimCommands().join("\n");
  expect(cmds).toContain("simctl");
  expect(cmds).toContain("CoreSimulator");
});

test("slimming removes non-iOS platform support", () => {
  const cmds = slimCommands().join("\n");
  expect(cmds).toMatch(/AppleTVOS|WatchOS/);
});

test("slimming never touches the iPhoneOS platform", () => {
  const cmds = slimCommands().join("\n");
  expect(cmds).not.toMatch(/rm -rf[^\n]*iPhoneOS\.platform/);
});

test("provisioning installs the toolchain in dependency order", () => {
  const labels = provisionSteps({ javaVersion: "17", androidPlatform: "android-36", androidBuildTools: "36.0.0", androidNdk: "27.1.12297006" })
    .map((s) => s.label);
  expect(labels.some((l) => l.includes("Xcode license"))).toBe(true);
  expect(labels.indexOf(labels.find((l) => l.includes("bun"))!))
    .toBeLessThan(labels.indexOf(labels.find((l) => l.includes("eas-cli"))!));
});

test("parseVersions extracts xcode, node and jdk from probe output", () => {
  const probe = [
    "XCODE=26.6",
    "NODE=v22.14.0",
    "JDK=17.0.12",
  ].join("\n");
  expect(parseVersions(probe)).toEqual({ xcode: "26.6", node: "22.14.0", jdk: "17.0.12" });
});

test("parseVersions tolerates missing fields", () => {
  expect(parseVersions("XCODE=26.6")).toEqual({ xcode: "26.6", node: "", jdk: "" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/provision.test.ts`
Expected: FAIL — cannot resolve module `../src/setup/tart`.

- [ ] **Step 3: Write the implementation**

Create `src/setup/tart.ts`:

```ts
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
    { label: "Accepting the Xcode license", command: "xcodebuild -license accept && xcodebuild -runFirstLaunch", sudo: true },
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
    { label: "Installing the Android SDK", command: [
      "brew install --cask android-commandlinetools",
      'export ANDROID_HOME="$HOME/Library/Android/sdk"',
      'mkdir -p "$ANDROID_HOME"',
      'SDKMANAGER="/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/sdkmanager"',
      `yes | $SDKMANAGER --sdk_root="$ANDROID_HOME" "platforms;${cfg.androidPlatform}" "build-tools;${cfg.androidBuildTools}" "platform-tools" "ndk;${cfg.androidNdk}"`,
    ].join(" && ") },
    { label: "Installing CocoaPods and Fastlane", command: "brew install cocoapods fastlane" },
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
  'echo "XCODE=$(xcodebuild -version | head -1 | awk \'{print $2}\')"',
  'echo "NODE=$(node --version 2>/dev/null)"',
  'echo "JDK=$(java -version 2>&1 | head -1 | sed -E \'s/.*"([0-9.]+)".*/\\1/\')"',
].join("; ");

async function sshStream(target: SshTarget, cmd: string): Promise<{ code: number; tail: string[] }> {
  return new Promise((done) => {
    const child = spawn("ssh", [sshTargetString(target), loginWrap(cmd)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const tail: string[] = [];
    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        tail.push(trimmed);
        if (tail.length > 30) tail.shift();
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("close", (code) => done({ code: code ?? 1, tail }));
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
    ssh(target, `tart delete ${imageName}`, { allowFailure: true });
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
  ssh(target, `sshpass -p admin ssh-copy-id -o StrictHostKeyChecking=no admin@${vmIp}`, { allowFailure: true });
  const verified = ssh(
    target,
    `ssh -o BatchMode=yes -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no -o ConnectTimeout=10 admin@${vmIp} echo ok`,
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

  const vmSsh = `ssh -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 admin@${vmIp}`;
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
  const beforeKb = parseInt(ssh(target, `du -sk "\${TART_HOME:-$HOME/.tart}/vms/${imageName}" | cut -f1`, { allowFailure: true }), 10) || 0;
  await sshStream(target, inVm(slimCommands().join("\n"), false));
  const afterKb = parseInt(ssh(target, `du -sk "\${TART_HOME:-$HOME/.tart}/vms/${imageName}" | cut -f1`, { allowFailure: true }), 10) || 0;
  const savedGb = Math.max(0, (beforeKb - afterKb) / 1024 / 1024);
  slim.stop(`Image slimmed (${savedGb.toFixed(1)} GB reclaimed)`);

  const probe = p.spinner();
  probe.start("Recording installed versions...");
  const probeOut = await new Promise<string>((done) => {
    let out = "";
    const child = spawn("ssh", [sshTargetString(target), loginWrap(inVm(VERSION_PROBE))], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    child.on("close", () => done(out));
  });
  const versions = parseVersions(probeOut);
  const record = JSON.stringify({
    repo: source.split(":")[0],
    tag: source.split(":").pop(),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/provision.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/setup/tart.ts test/provision.test.ts
git commit -m "feat: provision images with slimming and fatal step failures"
```

---

## Task 25: `init`, `interactive`, and `logs`

**Files:**
- Create: `src/commands/init.ts`, `src/commands/interactive.ts`, `src/commands/logs.ts`
- Create: `schema.json`

- [ ] **Step 1: Write the config schema**

Create `schema.json`:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "expo-builder configuration",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string" },
    "mac": {
      "description": "The build Mac. Either \"user@host\" or an object.",
      "oneOf": [
        { "type": "string" },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["host"],
          "properties": {
            "host": { "type": "string" },
            "user": { "type": "string" },
            "sshKey": { "type": "string" },
            "tartHome": {
              "type": "string",
              "description": "Relocate Tart storage. Must be an APFS volume with ownership enabled."
            }
          }
        }
      ]
    },
    "mobileDir": { "type": "string" },
    "syncPaths": { "type": "array", "items": { "type": "string" } },
    "vm": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "xcode": { "type": "string", "description": "\"auto\" (default), \"latest\", or an exact version." },
        "name": { "type": "string" },
        "keepImages": { "oneOf": [{ "type": "number" }, { "const": "auto" }] }
      }
    },
    "cache": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "enabled": { "type": "boolean" },
        "budgetGB": { "type": "number" }
      }
    }
  }
}
```

- [ ] **Step 2: Write init**

Create `src/commands/init.ts`:

```ts
import * as p from "@clack/prompts";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import type { ParsedArgs } from "../args";
import { CONFIG_FILENAME, gitRoot, findMobileDir, readSlug } from "../config";
import { ssh, pickSshKey } from "../remote/ssh";

export async function runInit(args: ParsedArgs): Promise<number> {
  p.intro("expo-builder init");

  const cwd = process.cwd();
  const projectRoot = gitRoot(cwd) ?? cwd;
  const configPath = join(projectRoot, CONFIG_FILENAME);

  if (existsSync(configPath) && !args.flags.yes) {
    const overwrite = await p.confirm({ message: `${CONFIG_FILENAME} exists. Overwrite?` });
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("Cancelled");
      return 0;
    }
  }

  const mobileDir = findMobileDir(cwd, projectRoot);
  if (mobileDir) {
    p.log.success(`Found the Expo project at ${mobileDir} (slug: ${readSlug(mobileDir)})`);
  } else {
    p.log.warn("Could not auto-detect the Expo project — you will need to set mobileDir.");
  }

  const mac = await p.text({
    message: "Which Mac should builds run on?",
    placeholder: "user@host",
    validate: (v) => (!v ? "Required" : undefined),
  });
  if (p.isCancel(mac)) { p.cancel("Cancelled"); return 0; }

  const [user, host] = mac.includes("@") ? mac.split("@") : [undefined, mac];
  const target = { host: host!, user };

  const s = p.spinner();
  s.start(`Testing SSH to ${mac}...`);
  const reachable = ssh(target, "echo ok", { allowFailure: true }) === "ok";
  if (!reachable) {
    s.stop("Could not connect");
    const key = pickSshKey();
    p.log.error(
      `Could not SSH to ${mac}.\n\n` +
      `Verify manually with: ssh ${mac}\n` +
      (key ? `Using key: ${key}` : "No key found in ~/.ssh"),
    );
    return 1;
  }
  s.stop(`Connected to ${mac}`);

  const config: Record<string, unknown> = {
    $schema: "https://unpkg.com/expo-builder/schema.json",
    mac,
  };
  if (mobileDir && mobileDir !== projectRoot) {
    config.mobileDir = mobileDir.slice(projectRoot.length + 1).replace(/\\/g, "/");
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  p.log.success(`Wrote ${CONFIG_FILENAME}`);
  p.outro("Next: expo-builder doctor");
  return 0;
}
```

- [ ] **Step 3: Write interactive and logs**

Create `src/commands/interactive.ts`:

```ts
import * as p from "@clack/prompts";
import type { ParsedArgs, Platform, Profile } from "../args";
import { loadConfig } from "../config";
import { runRemoteBuild } from "./remote-build";
import { runBuild } from "./build";
import { runSubmit } from "./submit";
import { runUpdate } from "./update";

type Action = "build" | "deploy" | "submit" | "update" | "doctor" | "clean" | "exit";

export async function runInteractive(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  p.intro(`expo-builder — ${cfg.slug}`);

  const action = await p.select<Action>({
    message: "What do you want to do?",
    options: [
      { value: "build", label: "Build", hint: "EAS Cloud or a Tart VM on your Mac" },
      { value: "deploy", label: "Build + Submit", hint: "build then submit to the stores" },
      { value: "submit", label: "Submit", hint: "submit an existing build" },
      { value: "update", label: "OTA Update", hint: "push a JS update, no native rebuild" },
      { value: "doctor", label: "Doctor", hint: "check the setup" },
      { value: "clean", label: "Clean", hint: "reclaim disk on the Mac" },
      { value: "exit", label: "Exit" },
    ],
  });
  if (p.isCancel(action) || action === "exit") { p.cancel("Goodbye"); return 0; }

  if (action === "doctor") {
    const { runDoctor } = await import("./doctor");
    return runDoctor(args);
  }
  if (action === "clean") {
    const { runClean } = await import("./clean");
    return runClean({ ...args, flags: { ...args.flags } });
  }
  if (action === "submit") {
    const profile = await selectProfile(["preview", "production"]);
    if (!profile) return 0;
    const platform = await selectPlatform();
    if (!platform) return 0;
    return runSubmit({ ...args, profile, platform });
  }
  if (action === "update") {
    const profile = await selectProfile(["development", "preview", "production"]);
    if (!profile) return 0;
    const message = await p.text({
      message: "Update message?",
      validate: (v) => (!v ? "Required" : undefined),
    });
    if (p.isCancel(message)) return 0;
    return runUpdate({ ...args, profile, flags: { ...args.flags, message } });
  }

  const where = await p.select<"remote" | "cloud">({
    message: "Where should it build?",
    options: [
      { value: "remote", label: "Your Mac", hint: "ephemeral Tart VM" },
      { value: "cloud", label: "EAS Cloud", hint: "Expo's servers" },
    ],
  });
  if (p.isCancel(where)) return 0;

  const profile = await selectProfile(
    action === "deploy" ? ["preview", "production"] : ["development", "preview", "production"],
  );
  if (!profile) return 0;
  const platform = await selectPlatform();
  if (!platform) return 0;

  if (where === "cloud") {
    return runBuild({ ...args, profile, platform, flags: { ...args.flags, remote: false } });
  }

  const code = await runRemoteBuild({
    cfg, profile, platform,
    submit: action === "deploy",
    optimize: args.flags.optimize,
    cache: args.flags.cache,
    dryRun: args.flags.dryRun,
  });
  p.outro("Done");
  return code;
}

async function selectProfile(options: Profile[]): Promise<Profile | undefined> {
  const hints: Record<Profile, string> = {
    development: "dev client for internal testing",
    preview: "release build for beta testers",
    production: "store release",
  };
  const value = await p.select<Profile>({
    message: "Which profile?",
    options: options.map((o) => ({ value: o, label: o[0]!.toUpperCase() + o.slice(1), hint: hints[o] })),
  });
  return p.isCancel(value) ? undefined : value;
}

async function selectPlatform(): Promise<Platform | undefined> {
  const value = await p.select<Platform>({
    message: "Which platform?",
    options: [
      { value: "all", label: "Both", hint: "iOS + Android" },
      { value: "ios", label: "iOS" },
      { value: "android", label: "Android" },
    ],
  });
  return p.isCancel(value) ? undefined : value;
}
```

Create `src/commands/logs.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import * as p from "@clack/prompts";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";

export async function runLogs(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const logDir = resolve(cfg.projectRoot, "logs");

  if (!existsSync(logDir)) {
    p.log.info("No logs yet. Run a remote build first.");
    return 0;
  }

  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .sort()
    .reverse();

  if (files.length === 0) {
    p.log.info("No logs yet.");
    return 0;
  }

  if (args.flags.last) {
    process.stdout.write(readFileSync(join(logDir, files[0]!), "utf-8"));
    return 0;
  }

  process.stdout.write(`${files.map((f) => join(logDir, f)).join("\n")}\n`);
  return 0;
}
```

Add `last` to the `Flags` interface and `BOOLEAN_FLAGS` in `src/args.ts`:

```ts
// In the Flags interface, alongside the other booleans:
  last: boolean;

// In BOOLEAN_FLAGS:
  "--last": "last",

// In the flags initialiser inside parseArgs:
    last: false,
```

- [ ] **Step 4: Verify the whole build compiles and all tests pass**

Run: `bun run typecheck && bun test && bun run build`
Expected: no type errors, all tests pass, `dist/cli.js` produced.

- [ ] **Step 5: Verify the CLI runs**

```bash
node dist/cli.js --version
node dist/cli.js --help
node dist/cli.js build --help
node dist/cli.js --remot 2>&1 | head -3
```

Expected: version prints; both help screens render; the last command exits non-zero with `Unknown flag: --remot` and a suggestion of `--remote`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts src/commands/interactive.ts src/commands/logs.ts src/args.ts schema.json
git commit -m "feat: add init, interactive, and logs commands"
```

---

## Task 26: Remove the old implementation and rewrite the docs

**Files:**
- Delete: `scripts/eas.ts`, `scripts/setup-tart.ts`, `.env.example`, `.ssh-key/`
- Modify: `README.md`, `CLAUDE.md`, `.gitignore`

- [ ] **Step 1: Delete the replaced files**

```bash
git rm -r scripts .env.example .ssh-key
```

- [ ] **Step 2: Remove stale .gitignore entries**

In `.gitignore`, delete these lines (the directory no longer exists):

```
# SSH key for remote Mac builds (README.md is tracked)
.ssh-key/*
!.ssh-key/README.md
```

- [ ] **Step 3: Rewrite README.md**

Replace `README.md` with content covering, in this order:

1. **What it is** — one paragraph: build Expo apps in ephemeral Tart VMs on a remote Mac, from any OS.
2. **Install** — `bun add -d expo-builder` / `bunx expo-builder` / `npm i -D expo-builder`.
3. **Quick start** — `bunx expo-builder init`, then `bunx expo-builder build preview ios --remote`.
4. **Configuration** — the minimal `{ "mac": "user@host" }` file, then the full form with every field from `schema.json`. State that `EXPO_TOKEN` comes from the environment or `.env`, never from this file.
5. **Commands** — a table matching `COMMAND_HELP` in `src/args.ts`.
6. **How image selection works** — that `vm.xcode: "auto"` targets the Xcode EAS Cloud uses for your SDK, that newest is deliberately *not* the default because Expo documents an upper bound, and that `doctor` tells you when to rebuild.
7. **Storage on the Mac** — per-version cost (~92 GB), the `keepImages` derivation, `clean` vs `clean --deep`, and the external-volume option including the **APFS requirement** and `diskutil enableOwnership`.
8. **Migrating from the submodule** — remove the `eas-builder` submodule, `bun add -d expo-builder`, run `init`, then `expo-builder vm rebuild` to replace the legacy image (note the rename is a free APFS clone).
9. **Troubleshooting** — carry over the entries from the current README that still apply: cwRsync on Windows, `Permission denied (publickey)`, VM boot timeout, Gradle OOM.

- [ ] **Step 4: Rewrite CLAUDE.md**

Replace `CLAUDE.md` so it describes the new structure: the `src/` module layout and each module's responsibility, config discovery precedence, the marker protocol, image resolution rules, the storage model (retain the OCI cache, why slimming and retention interact), and the coding conventions (Bun, TypeScript, `@clack/prompts`). Delete every reference to `TOOL_ROOT`, `PROJECT_ROOT`, `.env`, `scripts/eas.ts`, and `eas-builder`.

- [ ] **Step 5: Verify no stale references remain**

Run: `grep -rn "eas-builder\|TOOL_ROOT\|scripts/eas.ts" --include="*.ts" --include="*.md" --include="*.json" . | grep -v node_modules | grep -v docs/superpowers`

Expected: only matches inside migration instructions that intentionally mention the legacy `eas-builder` image name.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: rewrite for the package layout and remove the old scripts"
```

---

## Task 27: End-to-end verification against the real Mac

This is the only task requiring the physical build Mac (`mingu@defymac`).

- [ ] **Step 1: Confirm the CLI resolves the right image**

From a real Expo project directory:

```bash
node dist/cli.js doctor
```

Expected: reports the project's Expo SDK, the recommended image, and — before any rebuild — flags that the existing image has Xcode 26.2 while SDK 57 needs 26.4, recommending `expo-builder vm rebuild`.

- [ ] **Step 2: Inspect the scripts without running a build**

```bash
node dist/cli.js build preview ios --remote --dry-run
```

Expected: prints both generated scripts. Confirm by eye that `trap cleanup EXIT INT TERM HUP` appears before `tart clone`, that the source mount ends in `:ro`, and that `EAS_NO_VCS=1` is present with no `git init` anywhere.

- [ ] **Step 3: Rebuild the image**

```bash
node dist/cli.js vm rebuild
```

Expected: pulls `macos-sequoia-xcode:26.6`, provisions, slims, and reports the reclaimed size. **Record the actual slimming saving** — the spec's 20–35 GB estimate is unverified and must be replaced with the measured number.

- [ ] **Step 4: Update the spec with measured figures**

Edit `docs/superpowers/specs/2026-08-06-expo-builder-redesign-design.md`, replacing the estimated slimming saving and the ~12 GB tooling figure in §6 and §7 with the measured values from `~/.expo-builder/image.json` and Step 3.

```bash
git add docs/superpowers/specs
git commit -m "docs: replace estimated image sizes with measured values"
```

- [ ] **Step 5: Run a real iOS build**

```bash
node dist/cli.js build preview ios --remote
```

Expected: completes and produces an artifact under `~/.expo-builder/artifacts/<slug>/<timestamp>/app.ipa` on the Mac. This is the actual SDK 57 fix being confirmed.

- [ ] **Step 6: Verify no VM leaked**

```bash
ssh defymac '$SHELL -lc "tart list"'
```

Expected: only the provisioned image. No `expo-builder-build-*` entries.

- [ ] **Step 7: Verify interrupt cleanup**

Start a build, wait until the spinner reads "Building", press Ctrl+C, then re-run the check from Step 6.

Expected: the CLI reports cleanup, and `tart list` shows no leftover build VM.

- [ ] **Step 8: Verify the mounted directory stays clean**

```bash
ssh defymac 'ls -la ~/.expo-builder/projects/*/mobile/ | grep -E "node_modules|build" || echo "clean"'
```

Expected: `clean` — the build ran on the VM's own disk, so no `node_modules` or build output was written to the Mac's synced copy.

- [ ] **Step 9: Commit any fixes**

```bash
git add -A
git commit -m "fix: issues found during end-to-end verification"
```

---

## Notes for the implementer

**Do not skip Task 12's snapshot review.** The generated bash is what actually manages VMs on a machine you may not be watching. Read the snapshot rather than accepting it.

**Task 27 requires the physical Mac.** Everything before it runs offline with mocked I/O. If you do not have Mac access, complete Tasks 1-26 and stop — do not mark Task 27 done or claim the SDK 57 fix is verified.

**The slimming figure is a guess until Task 27 Step 3.** The spec says so explicitly. If the measurement comes in well below 20 GB, the §6 footprint table stops fitting on internal storage and the cache budget needs revisiting — raise it rather than quietly proceeding.

**Windows specifics are preserved from the old implementation:** cwRsync's cygwin `ssh.exe` is mandatory (Win32-OpenSSH breaks rsync's binary protocol), and paths need `/cygdrive/x/` form. Both are covered by tests in Task 13.

**Two subtleties that caused real bugs while this plan was being written**, both now handled — do not undo them:

1. `planImageEviction` lives in `src/remote/storage.ts`, not `src/commands/vm.ts`, because `setup/tart.ts` needs it and importing from the command module creates a cycle. `commands/vm.ts` re-exports it for discoverability.
2. Remote paths carry the literal `$HOME` prefix rather than `~`. The host script uses them inside double quotes, where `~` does **not** expand but `$HOME` does. Do not "tidy" these into `~`.

## Task order

Tasks 1-8 and 6b are pure logic with no I/O and can be done in any order after Task 2.
Tasks 9-20 build on them. Task 21 depends on 9-20. Tasks 22-25 depend on 21.
Task 26 must come after 25. Task 27 is last and needs the physical Mac.

