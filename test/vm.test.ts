import { expect, test } from "bun:test";
import { parseVmSubcommand, planImageEviction } from "../src/commands/vm";
import { UsageError } from "../src/errors";

test("valid subcommands are accepted", () => {
  for (const sub of ["list", "rebuild", "delete", "migrate"] as const) {
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
