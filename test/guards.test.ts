import { expect, test } from "bun:test";
import { assertSubmittable } from "../src/commands/guards";
import { UsageError } from "../src/errors";
import { assessPreflight, BUILD_HEADROOM_BYTES } from "../src/commands/preflight";
import { GB } from "../src/remote/storage";

test("development builds cannot be submitted", () => {
  expect(() => assertSubmittable("development")).toThrow(UsageError);
});

test("the error explains why development is rejected", () => {
  try {
    assertSubmittable("development");
    throw new Error("should have thrown");
  } catch (err) {
    expect((err as UsageError).message).toContain("internal distribution");
  }
});

test("preview and production are submittable", () => {
  expect(() => assertSubmittable("preview")).not.toThrow();
  expect(() => assertSubmittable("production")).not.toThrow();
});

test("plenty of space proceeds without cleaning", () => {
  expect(assessPreflight({ freeBytes: 200 * GB, reclaimableBytes: 10 * GB }).action).toBe("proceed");
});

test("short on space but reclaimable triggers a clean first", () => {
  expect(assessPreflight({ freeBytes: 10 * GB, reclaimableBytes: 40 * GB }).action)
    .toBe("clean-then-proceed");
});

test("short on space with nothing to reclaim refuses", () => {
  const r = assessPreflight({ freeBytes: 5 * GB, reclaimableBytes: 1 * GB });
  expect(r.action).toBe("refuse");
  expect(r.message).toContain("disk");
});

test("the headroom threshold matches the documented build budget", () => {
  expect(BUILD_HEADROOM_BYTES).toBe(25 * GB);
});
