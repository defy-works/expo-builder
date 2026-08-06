import { expect, test } from "bun:test";
import {
  compareVersions, requirementsFor, parseSdkMajor,
  resolveImage, type RepoTags, IMAGE_REPOS, fetchRepoTags,
} from "../src/compat";

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
