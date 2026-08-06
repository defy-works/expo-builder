import { expect, test } from "bun:test";
import { OutputFilter } from "../src/ui/output";

test("suppresses known noise", () => {
  const f = new OutputFilter();
  expect(f.classify("    at Object.<anonymous> (foo.js:1)", "build")).toBe("hide");
  expect(f.classify("npm warn deprecated", "build")).toBe("hide");
});

test("collapses consecutive duplicates", () => {
  const f = new OutputFilter();
  expect(f.classify("[EXPO] building", "build")).toBe("show");
  expect(f.classify("[EXPO] building", "build")).toBe("duplicate");
  expect(f.duplicateCount).toBe(1);
});

test("resets the duplicate counter on a new line", () => {
  const f = new OutputFilter();
  f.classify("[EXPO] a", "build");
  f.classify("[EXPO] a", "build");
  expect(f.classify("[EXPO] b", "build")).toBe("show");
  expect(f.duplicateCount).toBe(0);
});

test("shows lines matching the phase pattern and hides others", () => {
  const f = new OutputFilter();
  expect(f.classify("[RUN_FASTLANE] step", "build")).toBe("show");
  expect(f.classify("some unrelated chatter", "build")).toBe("hide");
});

test("extracts the EAS sub-phase label from a build line", () => {
  const f = new OutputFilter();
  expect(f.easPhase("[RUN_FASTLANE] doing things")).toBe("run fastlane");
  expect(f.easPhase("not a phase")).toBeUndefined();
});

test("retains a bounded tail for error context", () => {
  const f = new OutputFilter();
  for (let i = 0; i < 100; i++) f.record(`line ${i}`);
  expect(f.tail().length).toBe(50);
  expect(f.tail()[49]).toBe("line 99");
});
