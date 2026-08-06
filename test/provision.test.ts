import { expect, test } from "bun:test";
import { slimCommands, provisionSteps, parseVersions } from "../src/setup/tart";

test("slimming removes simulator runtimes we never use", () => {
  const cmds = slimCommands().join("\n");
  expect(cmds).toContain("simctl");
  expect(cmds).toContain("CoreSimulator");
});

test("slimming removes non-iOS platform support", () => {
  const cmds = slimCommands().join("\n");
  expect(cmds).toMatch(/AppleTVOS|WatchOS/);
});

test("slimming never touches the iPhoneOS platform", () => {
  const cmds = slimCommands().join("\n");
  expect(cmds).not.toMatch(/rm -rf[^\n]*iPhoneOS\.platform/);
});

test("provisioning installs the toolchain in dependency order", () => {
  const labels = provisionSteps({
    javaVersion: "17", androidPlatform: "android-36",
    androidBuildTools: "36.0.0", androidNdk: "27.1.12297006",
  }).map((s) => s.label);
  expect(labels.some((l) => l.includes("Xcode license"))).toBe(true);
  expect(labels.indexOf(labels.find((l) => l.includes("bun"))!))
    .toBeLessThan(labels.indexOf(labels.find((l) => l.includes("eas-cli"))!));
});

test("ccache is installed in the image, since the iOS cache path needs it", () => {
  const commands = provisionSteps({
    javaVersion: "17", androidPlatform: "android-36",
    androidBuildTools: "36.0.0", androidNdk: "27.1.12297006",
  }).map((s) => s.command).join("\n");
  expect(commands).toContain("ccache");
});

test("parseVersions extracts xcode, node and jdk from probe output", () => {
  const probe = ["XCODE=26.6", "NODE=v22.14.0", "JDK=17.0.12"].join("\n");
  expect(parseVersions(probe)).toEqual({ xcode: "26.6", node: "22.14.0", jdk: "17.0.12" });
});

test("parseVersions tolerates missing fields", () => {
  expect(parseVersions("XCODE=26.6")).toEqual({ xcode: "26.6", node: "", jdk: "" });
});
