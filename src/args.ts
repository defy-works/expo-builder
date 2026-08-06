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
  refresh: boolean;
  last: boolean;
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
  "--refresh": "refresh",
  "--last": "last",
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
  "--xcode": "xcode",
  "--download": "download",
  "--to": "to",
};

/** Value flags that populate the dedicated profile/platform fields. */
const PROFILE_FLAG = "--profile";
const PLATFORM_FLAG = "--platform";

const ALL_FLAG_NAMES = [
  ...Object.keys(BOOLEAN_FLAGS),
  ...Object.keys(NEGATED_FLAGS),
  ...Object.keys(VALUE_FLAGS),
  PROFILE_FLAG,
  PLATFORM_FLAG,
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
    dryRun: false, deep: false, refresh: false, last: false,
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

    const isProfileFlag = arg === PROFILE_FLAG;
    const isPlatformFlag = arg === PLATFORM_FLAG;

    if (arg in VALUE_FLAGS || isProfileFlag || isPlatformFlag) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`Flag ${arg} requires a value`);
      }
      i++;

      if (isProfileFlag) {
        if (!(PROFILES as readonly string[]).includes(value)) {
          throw new UsageError(
            `Invalid profile: ${value}`,
            `Valid profiles: ${PROFILES.join(", ")}`
          );
        }
        profile = value as Profile;
      } else if (isPlatformFlag) {
        if (!(PLATFORMS as readonly string[]).includes(value)) {
          throw new UsageError(
            `Invalid platform: ${value}`,
            `Valid platforms: ${PLATFORMS.join(", ")}`
          );
        }
        platform = value as Platform;
      } else {
        (flags as Record<string, unknown>)[VALUE_FLAGS[arg]!] = value;
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
