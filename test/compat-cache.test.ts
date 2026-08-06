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
