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

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

function readPackageJson(dir: string): PackageJson | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PackageJson;
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

  const walk = (absDir: string, relDir: string, ig: Ignore, baseRel: string) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      // Path relative to the ignore-file's own directory, which is what
      // `ignore` expects when matching patterns like "fixtures/".
      const igPath = baseRel && relPath.startsWith(`${baseRel}/`)
        ? relPath.slice(baseRel.length + 1)
        : relPath;
      const testPath = entry.isDirectory() ? `${igPath}/` : igPath;
      if (ig.ignores(testPath) || ig.ignores(entry.name) || ig.ignores(`${entry.name}/`)) continue;
      if (entry.isDirectory()) {
        walk(join(absDir, entry.name), relPath, ig, baseRel);
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
    const baseRel = root === "." ? "" : toPosix(root);
    walk(abs, baseRel, ig, baseRel);
  }

  return files;
}

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
