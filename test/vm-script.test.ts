import { expect, test } from "bun:test";
import { generateVmScript, type VmScriptOptions } from "../src/remote/vm-script";

const base: VmScriptOptions = {
  expoToken: "expo_test_token",
  profile: "preview",
  platform: "ios",
  submit: false,
  optimize: true,
  cacheEnabled: true,
  mountName: "my-app",
  mobileRelPath: "mobile",
  javaVersion: "17",
};

test("sets EAS_NO_VCS so no git repo is required", () => {
  expect(generateVmScript(base)).toContain("export EAS_NO_VCS=1");
});

test("never runs git init", () => {
  expect(generateVmScript(base)).not.toContain("git init");
});

test("copies source off the mount and builds on the VM's own disk", () => {
  const script = generateVmScript(base);
  expect(script).toContain("/Volumes/My Shared Files/my-app");
  expect(script).toContain("$HOME/work");
  const buildLine = script.split("\n").find((l) => l.includes("eas build --local"))!;
  expect(buildLine).toContain("$HOME/out/");
});

test("writes the artifact outside the mounted directory", () => {
  expect(generateVmScript(base)).not.toContain("--output build/output");
});

test("emits phase markers in order", () => {
  const script = generateVmScript(base);
  const phases = [...script.matchAll(/::phase::([a-z-]+)/g)].map((m) => m[1]);
  expect(phases).toEqual(["stage", "env-pull", "install", "build", "version"]);
});

test("includes a submit phase only when submitting", () => {
  expect(generateVmScript(base)).not.toContain("::phase::submit");
  expect(generateVmScript({ ...base, submit: true })).toContain("::phase::submit");
});

test("points cache env vars at the mounted cache when enabled", () => {
  const script = generateVmScript(base);
  expect(script).toContain("BUN_INSTALL_CACHE_DIR=");
  expect(script).toContain("CP_HOME_DIR=");
  expect(script).toContain("GRADLE_USER_HOME=");
  expect(script).toContain("/Volumes/My Shared Files/expo-builder-cache");
});

test("omits cache env vars when caching is disabled", () => {
  const script = generateVmScript({ ...base, cacheEnabled: false });
  expect(script).not.toContain("expo-builder-cache");
});

test("writes gradle config into GRADLE_USER_HOME, not ~/.gradle", () => {
  const script = generateVmScript({ ...base, platform: "android" });
  expect(script).toContain('"$GRADLE_USER_HOME"/gradle.properties');
  expect(script).not.toContain("~/.gradle/gradle.properties");
});

test("android builds disable lintVital", () => {
  expect(generateVmScript({ ...base, platform: "android" })).toContain("lintVital");
});

test("injects the config plugin only when optimizing", () => {
  expect(generateVmScript(base)).toContain("withBuildOptimizations");
  expect(generateVmScript({ ...base, optimize: false })).not.toContain("withBuildOptimizations");
});

test("uses the ipa extension for ios and aab for android", () => {
  expect(generateVmScript(base)).toContain("app.ipa");
  expect(generateVmScript({ ...base, platform: "android" })).toContain("app.aab");
});

test("selects the right version field per platform", () => {
  expect(generateVmScript(base)).toContain("buildNumber");
  expect(generateVmScript({ ...base, platform: "android" })).toContain("versionCode");
});

test("uses set -euo pipefail", () => {
  expect(generateVmScript(base)).toContain("set -euo pipefail");
});
