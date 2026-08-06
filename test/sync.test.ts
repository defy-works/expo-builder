import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveWorkspaceDeps, computeSyncRoots, collectFiles, buildRsyncArgs,
} from "../src/remote/sync";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "expo-builder-sync-"));
}

test("resolveWorkspaceDeps finds direct workspace dependencies", () => {
  const root = scratch();
  mkdirSync(join(root, "packages", "shared"), { recursive: true });
  mkdirSync(join(root, "mobile"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*", "mobile"] }));
  writeFileSync(join(root, "packages", "shared", "package.json"), JSON.stringify({ name: "@app/shared" }));
  writeFileSync(join(root, "mobile", "package.json"), JSON.stringify({
    name: "mobile",
    dependencies: { "@app/shared": "workspace:*" },
  }));

  expect(resolveWorkspaceDeps(root, join(root, "mobile"))).toEqual([join(root, "packages", "shared")]);
});

test("resolveWorkspaceDeps resolves transitively without infinite looping on cycles", () => {
  const root = scratch();
  for (const name of ["a", "b"]) mkdirSync(join(root, "packages", name), { recursive: true });
  mkdirSync(join(root, "mobile"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*", "mobile"] }));
  writeFileSync(join(root, "packages", "a", "package.json"), JSON.stringify({
    name: "@app/a", dependencies: { "@app/b": "workspace:*" },
  }));
  writeFileSync(join(root, "packages", "b", "package.json"), JSON.stringify({
    name: "@app/b", dependencies: { "@app/a": "workspace:*" },
  }));
  writeFileSync(join(root, "mobile", "package.json"), JSON.stringify({
    name: "mobile", dependencies: { "@app/a": "workspace:*" },
  }));

  const deps = resolveWorkspaceDeps(root, join(root, "mobile")).sort();
  expect(deps).toEqual([join(root, "packages", "a"), join(root, "packages", "b")].sort());
});

test("resolveWorkspaceDeps ignores non-workspace dependencies", () => {
  const root = scratch();
  mkdirSync(join(root, "mobile"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["mobile"] }));
  writeFileSync(join(root, "mobile", "package.json"), JSON.stringify({
    name: "mobile", dependencies: { react: "19.2.3" },
  }));
  expect(resolveWorkspaceDeps(root, join(root, "mobile"))).toEqual([]);
});

test("computeSyncRoots includes the mobile dir, workspace deps and explicit paths", () => {
  const root = scratch();
  const roots = computeSyncRoots({
    projectRoot: root,
    mobileDir: join(root, "mobile"),
    workspaceDeps: [join(root, "packages", "shared")],
    syncPaths: ["config"],
  });
  expect(roots).toContain("mobile");
  expect(roots).toContain("packages/shared");
  expect(roots).toContain("config");
});

test("computeSyncRoots includes root manifests when the mobile dir is nested", () => {
  const root = scratch();
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "bun.lock"), "");
  const roots = computeSyncRoots({
    projectRoot: root,
    mobileDir: join(root, "mobile"),
    workspaceDeps: [],
    syncPaths: [],
  });
  expect(roots).toContain("package.json");
  expect(roots).toContain("bun.lock");
});

test("computeSyncRoots omits root manifests when the mobile dir is the root", () => {
  const root = scratch();
  writeFileSync(join(root, "package.json"), "{}");
  const roots = computeSyncRoots({
    projectRoot: root,
    mobileDir: root,
    workspaceDeps: [],
    syncPaths: [],
  });
  expect(roots).toEqual(["."]);
});

test("collectFiles honours .gitignore and always excludes .git", () => {
  const root = scratch();
  mkdirSync(join(root, "mobile", "src"), { recursive: true });
  mkdirSync(join(root, "mobile", "node_modules"), { recursive: true });
  mkdirSync(join(root, "mobile", ".git"), { recursive: true });
  writeFileSync(join(root, "mobile", ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "mobile", "src", "index.ts"), "");
  writeFileSync(join(root, "mobile", "node_modules", "dep.js"), "");
  writeFileSync(join(root, "mobile", ".git", "HEAD"), "");

  const files = collectFiles(root, ["mobile"]);
  expect(files).toContain("mobile/src/index.ts");
  expect(files).not.toContain("mobile/node_modules/dep.js");
  expect(files.some((f) => f.includes(".git/"))).toBe(false);
});

test("collectFiles honours .easignore in addition to .gitignore", () => {
  const root = scratch();
  mkdirSync(join(root, "mobile", "fixtures"), { recursive: true });
  writeFileSync(join(root, "mobile", ".easignore"), "fixtures/\n");
  writeFileSync(join(root, "mobile", "fixtures", "big.bin"), "");
  writeFileSync(join(root, "mobile", "app.json"), "{}");

  const files = collectFiles(root, ["mobile"]);
  expect(files).toContain("mobile/app.json");
  expect(files).not.toContain("mobile/fixtures/big.bin");
});

test("rsync args include --delete and the files-from stdin marker", () => {
  const args = buildRsyncArgs({
    sshCommand: "ssh -i /key",
    source: "/Users/mingu/app/",
    destination: "mingu@defymac:/Users/mingu/.expo-builder/projects/my-app/",
    remoteRsyncPath: undefined,
  });
  expect(args).toContain("--delete");
  expect(args).toContain("--files-from=-");
  expect(args).toContain("-rltz");
});

test("rsync args include --rsync-path when Homebrew rsync is present", () => {
  const args = buildRsyncArgs({
    sshCommand: "ssh",
    source: "/a/",
    destination: "h:/b/",
    remoteRsyncPath: "/opt/homebrew/bin/rsync",
  });
  const idx = args.indexOf("--rsync-path");
  expect(idx).toBeGreaterThan(-1);
  expect(args[idx + 1]).toBe("/opt/homebrew/bin/rsync");
});

test("source and destination are the final two arguments in order", () => {
  const args = buildRsyncArgs({
    sshCommand: "ssh", source: "/a/", destination: "h:/b/", remoteRsyncPath: undefined,
  });
  expect(args[args.length - 2]).toBe("/a/");
  expect(args[args.length - 1]).toBe("h:/b/");
});
