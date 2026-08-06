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
  expect(planCleanup(inputs).trimCacheToBytes).toBe(15 * GB_BYTES);
});

test("the OCI cache is retained by default", () => {
  expect(planCleanup(inputs).pruneOciCache).toBe(false);
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
