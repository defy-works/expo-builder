import { expect, test } from "bun:test";
import {
  generateVmScript, DEFAULT_OPTIMIZE, NO_OPTIMIZE, type VmScriptOptions,
} from "../src/remote/vm-script";

const base: VmScriptOptions = {
  expoToken: "expo_test_token",
  profile: "preview",
  platform: "ios",
  submit: false,
  optimize: DEFAULT_OPTIMIZE,
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
  const buildLine = script.split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .find((l) => l.includes("eas build --local"))!;
  expect(buildLine).toContain("$HOME/out/");
});

test("installs BEFORE pulling env", () => {
  // `eas env:pull` evaluates app.config.ts, which may reference plugins that
  // need node_modules. Reversing these leaves the pull failing on a fresh VM.
  const script = generateVmScript(base);
  expect(script.indexOf("::phase::install")).toBeLessThan(script.indexOf("::phase::env-pull"));
});

test("emits phase markers in order", () => {
  const script = generateVmScript(base);
  const phases = [...script.matchAll(/::phase::([a-z-]+)/g)].map((m) => m[1]);
  expect(phases).toEqual(["stage", "cache-setup", "install", "env-pull", "build", "version"]);
});

test("includes a submit phase only when submitting", () => {
  expect(generateVmScript(base)).not.toContain("::phase::submit");
  expect(generateVmScript({ ...base, submit: true })).toContain("::phase::submit");
});

test("uses --backend=copyfile when the cache is mounted over VirtioFS", () => {
  // bun defaults to clonefile on macOS, which fails across VirtioFS.
  expect(generateVmScript(base)).toContain("bun install --frozen-lockfile --backend=copyfile");
});

test("omits --backend=copyfile when there is no VirtioFS cache", () => {
  const script = generateVmScript({ ...base, cacheEnabled: false });
  expect(script).toContain("bun install --frozen-lockfile");
  expect(script).not.toContain("--backend=copyfile");
});

test("symlinks the caches rather than relying on env vars", () => {
  const script = generateVmScript(base);
  expect(script).toContain("~/.bun/install/cache");
  expect(script).toContain("~/.gradle/caches");
  expect(script).toContain("~/Library/Caches/CocoaPods");
});

test("sets up ccache with wrappers around the resolved Xcode clang", () => {
  const script = generateVmScript(base);
  expect(script).toContain("ccache.conf");
  expect(script).toContain("xcrun -f clang");
  expect(script).toContain("/tmp/ccache-bin/clang");
});

test("omits ccache when that flag is off but keeps other caches", () => {
  const script = generateVmScript({ ...base, optimize: { ...DEFAULT_OPTIMIZE, ccache: false } });
  expect(script).not.toContain("ccache.conf");
  expect(script).toContain("$CACHE_DIR/bun");
});

test("exports the optimize flags the config plugin reads", () => {
  const script = generateVmScript(base);
  expect(script).toContain('export OPTIMIZE_INDEX_STORE="true"');
  expect(script).toContain('export OPTIMIZE_SKIP_DSYM="true"');
  expect(script).toContain('export OPTIMIZE_CCACHE="true"');
  expect(generateVmScript({ ...base, optimize: NO_OPTIMIZE }))
    .toContain('export OPTIMIZE_CCACHE="false"');
});

test("injects the plugin in place, not via a wrapper module", () => {
  // @expo/config cannot resolve .ts imports from a wrapper module, so the
  // wrapper approach silently broke config evaluation.
  const script = generateVmScript(base);
  expect(script).toContain("inject-plugin.mjs");
  expect(script).toContain("withBuildOptimizations");
  // The wrapper was created by renaming the original aside; that must not happen.
  expect(script).not.toContain("mv app.config.ts _app.config.original.ts");
});

test("cleans up a wrapper left by an older interrupted build", () => {
  expect(generateVmScript(base)).toContain("mv _app.config.original.ts app.config.ts");
});

test("plugin injection runs after install so the config is resolvable", () => {
  const script = generateVmScript(base);
  expect(script.indexOf("::phase::install")).toBeLessThan(script.indexOf("inject-plugin.mjs"));
});

test("omits plugin injection when no iOS optimization is enabled", () => {
  expect(generateVmScript({ ...base, optimize: NO_OPTIMIZE })).not.toContain("inject-plugin.mjs");
});

test("sets the version through the GraphQL helper, not the interactive CLI", () => {
  // `eas build:version:set` has no --version and no --non-interactive on v18+.
  const script = generateVmScript(base);
  expect(script).toContain("set-version.ts ios");
  // It may appear in a comment explaining why it is avoided, but never as a
  // command. Check executable lines only.
  const executable = script.split("\n").filter((l) => !l.trimStart().startsWith("#"));
  expect(executable.some((l) => l.includes("eas build:version:set"))).toBe(false);
});

test("still reads the current version from the CLI", () => {
  expect(generateVmScript(base)).toContain("eas build:version:get");
});

test("android tuning applies only to android builds", () => {
  expect(generateVmScript({ ...base, platform: "android" })).toContain("lintVital");
  expect(generateVmScript(base)).not.toContain("lintVital");
});

test("android tuning is skipped when that flag is off", () => {
  const script = generateVmScript({
    ...base, platform: "android", optimize: { ...DEFAULT_OPTIMIZE, android: false },
  });
  expect(script).not.toContain("lintVital");
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
