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
