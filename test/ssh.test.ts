import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pickSshKey, normalizedKeyCopy, loginWrap, toRsyncPath } from "../src/remote/ssh";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "expo-builder-ssh-"));
}

test("pickSshKey prefers the explicit override", () => {
  const dir = scratch();
  const key = join(dir, "custom");
  writeFileSync(key, "x");
  expect(pickSshKey({ override: key, configured: undefined, sshDir: dir })).toBe(key);
});

test("pickSshKey falls back to id_ed25519 then id_rsa", () => {
  const dir = scratch();
  writeFileSync(join(dir, "id_rsa"), "x");
  expect(pickSshKey({ sshDir: dir })).toBe(join(dir, "id_rsa"));
  writeFileSync(join(dir, "id_ed25519"), "x");
  expect(pickSshKey({ sshDir: dir })).toBe(join(dir, "id_ed25519"));
});

test("pickSshKey returns undefined when nothing exists", () => {
  expect(pickSshKey({ sshDir: scratch() })).toBeUndefined();
});

test("normalizedKeyCopy never modifies the source key", () => {
  const dir = scratch();
  const src = join(dir, "id_ed25519");
  const original = "-----BEGIN-----\r\nabc\r\n-----END-----\r\n";
  writeFileSync(src, original);

  const copy = normalizedKeyCopy(src, join(dir, "cache"));
  expect(readFileSync(src, "utf-8")).toBe(original);
  expect(readFileSync(copy, "utf-8")).toBe("-----BEGIN-----\nabc\n-----END-----\n");
  expect(copy).not.toBe(src);
});

test("normalizedKeyCopy returns the original when no normalisation is needed", () => {
  const dir = scratch();
  const src = join(dir, "id_ed25519");
  writeFileSync(src, "already\nclean\n");
  expect(normalizedKeyCopy(src, join(dir, "cache"))).toBe(src);
});

test("loginWrap escapes single quotes", () => {
  expect(loginWrap("echo 'hi'")).toContain(`'\\''`);
});

test("toRsyncPath converts Windows paths to cygwin form", () => {
  expect(toRsyncPath("D:\\Work\\app", "win32")).toBe("/cygdrive/d/Work/app");
  expect(toRsyncPath("/Users/mingu/app", "darwin")).toBe("/Users/mingu/app");
});
