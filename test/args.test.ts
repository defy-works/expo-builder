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

test("invalid profile values are rejected", () => {
  expect(() => parseArgs(["build", "--profile", "staging"])).toThrow(UsageError);
});
