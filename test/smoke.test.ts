import { expect, test } from "bun:test";
import pkgJson from "../package.json";

const pkg = pkgJson as {
  name: string;
  bin: Record<string, string>;
  files: string[];
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
};

test("package is scoped to the org and exposes an unscoped bin", () => {
  // Scoped so it cannot be mistaken for an official Expo package, while the
  // command itself stays `expo-builder`.
  expect(pkg.name).toBe("@defy-works/expo-builder");
  // No "./" prefix: npm normalises it away on publish and warns if present.
  expect(pkg.bin["expo-builder"]).toBe("dist/cli.js");
});

test("scoped packages must opt into public access explicitly", () => {
  expect(pkg.publishConfig?.access).toBe("public");
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
