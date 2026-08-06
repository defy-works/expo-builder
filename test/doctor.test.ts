import { expect, test } from "bun:test";
import { buildReport, type DoctorInputs } from "../src/commands/doctor";

const healthy: DoctorInputs = {
  sdkMajor: 57,
  imageRecord: {
    repo: "ghcr.io/cirruslabs/macos-sequoia-xcode",
    tag: "26.6", xcode: "26.6", node: "22.14.0", jdk: "17",
  },
  resolved: { repo: "ghcr.io/cirruslabs/macos-sequoia-xcode", tag: "26.6", warnings: [] },
  freeBytes: 300 * 1024 * 1024 * 1024,
  volumeErrors: [],
  volumeWarnings: [],
  legacyImagePresent: false,
};

test("a healthy setup produces no problems", () => {
  const report = buildReport(healthy);
  expect(report.problems).toEqual([]);
  expect(report.ok).toBe(true);
});

test("flags an image whose Xcode is below the SDK floor", () => {
  const report = buildReport({
    ...healthy,
    imageRecord: { ...healthy.imageRecord!, tag: "26.2", xcode: "26.2" },
  });
  expect(report.ok).toBe(false);
  expect(report.problems.join(" ")).toContain("26.2");
  expect(report.problems.join(" ")).toContain("26.4");
  expect(report.remedies.join(" ")).toContain("expo-builder vm rebuild");
});

test("flags a Node version below the SDK floor", () => {
  const report = buildReport({
    ...healthy,
    imageRecord: { ...healthy.imageRecord!, node: "20.11.0" },
  });
  expect(report.problems.join(" ")).toContain("Node");
});

test("flags a missing image", () => {
  const report = buildReport({ ...healthy, imageRecord: undefined });
  expect(report.problems.join(" ")).toContain("No VM image");
  expect(report.remedies.join(" ")).toContain("expo-builder vm rebuild");
});

test("warns on low disk", () => {
  const report = buildReport({ ...healthy, freeBytes: 20 * 1024 * 1024 * 1024 });
  expect(report.warnings.join(" ")).toContain("disk");
});

test("volume errors become problems", () => {
  const report = buildReport({ ...healthy, volumeErrors: ["not APFS"] });
  expect(report.ok).toBe(false);
  expect(report.problems).toContain("not APFS");
});

test("a legacy eas-builder image is reported with the migration remedy", () => {
  const report = buildReport({ ...healthy, legacyImagePresent: true });
  expect(report.remedies.join(" ")).toContain("tart clone eas-builder expo-builder");
});
