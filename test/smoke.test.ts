import { expect, test } from "bun:test";
import pkgJson from "../package.json";

const pkg = pkgJson as {
  name: string;
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
};

test("package is named expo-builder and exposes a bin", () => {
  expect(pkg.name).toBe("expo-builder");
  expect(pkg.bin["expo-builder"]).toBe("./dist/cli.js");
});

test("package declares no runtime dependencies", () => {
  expect(pkg.dependencies ?? {}).toEqual({});
});
