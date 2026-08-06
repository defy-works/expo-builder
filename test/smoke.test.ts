import { expect, test } from "bun:test";
import pkgJson from "../package.json";

const pkg = pkgJson as {
  name: string;
  bin: Record<string, string>;
  files: string[];
  dependencies?: Record<string, string>;
};

test("package is named expo-builder and exposes a bin", () => {
  expect(pkg.name).toBe("expo-builder");
  expect(pkg.bin["expo-builder"]).toBe("./dist/cli.js");
});

test("package declares no runtime dependencies", () => {
  expect(pkg.dependencies ?? {}).toEqual({});
});

test("everything the CLI needs at runtime is published", () => {
  // remote-build.ts reads scripts/set-version.ts and plugins/ from the installed
  // package. Omitting either from `files` makes every remote build fail, and the
  // tarball is the only place that shows it.
  for (const required of ["dist", "plugins", "scripts", "schema.json"]) {
    expect(pkg.files).toContain(required);
  }
});
