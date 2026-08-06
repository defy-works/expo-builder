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
