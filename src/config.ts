import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { UsageError } from "./errors";

export interface MacTarget {
  host: string;
  user?: string;
  sshKey?: string;
  tartHome?: string;
}

export interface VmConfig {
  xcode?: string;
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
  vm: { xcode: string; name: string; keepImages: number | "auto" };
  cache: { enabled: boolean; budgetGB: number };
  expoToken?: string;
}

export const CONFIG_FILENAME = "expo-builder.json";
export const USER_CONFIG_PATH = join(homedir(), ".expo-builder", "config.json");

const EXPO_CONFIG_FILES = ["app.json", "app.config.js", "app.config.ts"];

export const CONFIG_DEFAULTS = {
  vm: { xcode: "auto", name: "expo-builder", keepImages: "auto" as const },
  cache: { enabled: true, budgetGB: 15 },
};

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
    throw new UsageError(`Failed to parse ${path}`, (err as Error).message);
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
