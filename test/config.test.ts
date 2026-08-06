import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  mergeConfig, parseMacTarget, findMobileDir, resolveExpoToken, loadConfig,
} from "../src/config";
import { UsageError } from "../src/errors";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "expo-builder-test-"));
}

test("parseMacTarget accepts the shorthand string form", () => {
  expect(parseMacTarget("mingu@defymac")).toEqual({ user: "mingu", host: "defymac" });
});

test("parseMacTarget accepts a host with no user", () => {
  expect(parseMacTarget("defymac")).toEqual({ host: "defymac" });
});

test("parseMacTarget passes through the object form", () => {
  expect(parseMacTarget({ host: "defymac", user: "mingu" })).toEqual({ host: "defymac", user: "mingu" });
});

test("project config wins over user config", () => {
  const merged = mergeConfig(
    { mac: { host: "user-mac" }, cache: { budgetGB: 30 } },
    { mac: { host: "project-mac" } },
  );
  expect((merged.mac as { host: string }).host).toBe("project-mac");
  expect(merged.cache?.budgetGB).toBe(30);
});

test("findMobileDir picks the cwd when it holds an Expo project", () => {
  const dir = scratch();
  writeFileSync(join(dir, "app.json"), "{}");
  writeFileSync(join(dir, "eas.json"), "{}");
  expect(findMobileDir(dir, dir)).toBe(dir);
});

test("findMobileDir searches one level down from the root", () => {
  const root = scratch();
  const mobile = join(root, "mobile");
  mkdirSync(mobile);
  writeFileSync(join(mobile, "app.config.ts"), "");
  writeFileSync(join(mobile, "eas.json"), "{}");
  expect(findMobileDir(root, root)).toBe(mobile);
});

test("findMobileDir returns undefined when several candidates exist", () => {
  const root = scratch();
  for (const name of ["mobile", "other"]) {
    const d = join(root, name);
    mkdirSync(d);
    writeFileSync(join(d, "app.json"), "{}");
    writeFileSync(join(d, "eas.json"), "{}");
  }
  expect(findMobileDir(root, root)).toBeUndefined();
});

test("resolveExpoToken prefers the environment", () => {
  const dir = scratch();
  writeFileSync(join(dir, ".env"), "EXPO_TOKEN=from_file\n");
  expect(resolveExpoToken({ EXPO_TOKEN: "from_env" }, [join(dir, ".env")])).toBe("from_env");
});

test("resolveExpoToken falls back to the first env file that has it", () => {
  const dir = scratch();
  writeFileSync(join(dir, ".env"), "OTHER=1\nEXPO_TOKEN=from_file\n");
  expect(resolveExpoToken({}, [join(dir, ".env")])).toBe("from_file");
});

test("resolveExpoToken returns undefined when absent everywhere", () => {
  expect(resolveExpoToken({}, [])).toBeUndefined();
});

test("loadConfig assembles a full config from a minimal project file", () => {
  const root = scratch();
  const mobile = join(root, "mobile");
  mkdirSync(mobile);
  writeFileSync(join(mobile, "app.json"), JSON.stringify({ expo: { slug: "my-app" } }));
  writeFileSync(join(mobile, "eas.json"), "{}");
  writeFileSync(join(mobile, "package.json"), JSON.stringify({
    name: "mobile", dependencies: { expo: "^57.0.0" },
  }));
  writeFileSync(join(root, "expo-builder.json"), JSON.stringify({ mac: "mingu@defymac" }));

  const cfg = loadConfig({ cwd: root, projectRoot: root, userConfigPath: join(root, "nonexistent.json"), env: {} });
  expect(cfg.mac).toEqual({ user: "mingu", host: "defymac" });
  expect(cfg.slug).toBe("my-app");
  expect(cfg.mobileDir).toBe(mobile);
  expect(cfg.vm.xcode).toBe("auto");
  expect(cfg.vm.name).toBe("expo-builder");
  expect(cfg.cache.budgetGB).toBe(15);
});

test("loadConfig errors helpfully when mac is missing", () => {
  const root = scratch();
  writeFileSync(join(root, "app.json"), JSON.stringify({ expo: { slug: "x" } }));
  writeFileSync(join(root, "eas.json"), "{}");
  writeFileSync(join(root, "expo-builder.json"), "{}");
  expect(() =>
    loadConfig({ cwd: root, projectRoot: root, userConfigPath: join(root, "none.json"), env: {} })
  ).toThrow(UsageError);
});

test("loadConfig errors helpfully when no Expo project is found", () => {
  const root = scratch();
  writeFileSync(join(root, "expo-builder.json"), JSON.stringify({ mac: "u@h" }));
  expect(() =>
    loadConfig({ cwd: root, projectRoot: root, userConfigPath: join(root, "none.json"), env: {} })
  ).toThrow(UsageError);
});
