#!/usr/bin/env bun
export {};
import { existsSync, readFileSync } from "node:fs";
/**
 * Set EAS remote build version via the Expo GraphQL API.
 *
 * Usage:  bun set-version.ts <ios|android> <buildVersion>
 *
 * Reads the app config from cwd to extract projectId, bundleIdentifier/package,
 * and storeVersion. Requires EXPO_TOKEN in env.
 *
 * This replaces the fragile `expect`-based automation of `eas build:version:set`
 * which is interactive-only (no --version flag, no --non-interactive support).
 * The createAppVersion mutation is what the CLI calls under the hood.
 */

const [platform, buildVersion] = process.argv.slice(2);
if (!platform || !buildVersion) {
  console.error("Usage: bun set-version.ts <ios|android> <buildVersion>");
  process.exit(1);
}
if (platform !== "ios" && platform !== "android") {
  console.error(`Invalid platform: ${platform} (expected ios or android)`);
  process.exit(1);
}
if (!process.env.EXPO_TOKEN) {
  console.error("EXPO_TOKEN not set");
  process.exit(1);
}

/**
 * Load the app config the way EAS CLI resolves it.
 *
 * A project may declare itself in any of these, and plenty use only app.json —
 * assuming app.config.ts left those builds failing after a successful compile,
 * with the version never set and the next build reusing the same number.
 * Order matches Expo's own precedence: dynamic config wins over static.
 */
function loadAppConfig(): { config: any; source: string } {
  const cwd = process.cwd();

  for (const name of ["app.config.ts", "app.config.js"]) {
    const path = `${cwd}/${name}`;
    if (!existsSync(path)) continue;
    const mod = require(path);
    const resolved = typeof mod.default === "function"
      ? mod.default({ config: {} })
      : mod.default ?? mod;
    return { config: resolved, source: name };
  }

  for (const name of ["app.config.json", "app.json"]) {
    const path = `${cwd}/${name}`;
    if (!existsSync(path)) continue;
    // Static configs nest everything under `expo`.
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return { config: raw.expo ?? raw, source: name };
  }

  console.error(
    "No app config found. Looked for app.config.ts, app.config.js, " +
    `app.config.json and app.json in ${cwd}`,
  );
  process.exit(1);
}

const { config, source } = loadAppConfig();

const appId = config.extra?.eas?.projectId;
const storeVersion = config.version;
const applicationIdentifier = platform === "ios"
  ? config.ios?.bundleIdentifier
  : config.android?.package;

if (!appId || !storeVersion || !applicationIdentifier) {
  console.error(`Could not extract projectId, version, or identifier from ${source}`);
  process.exit(1);
}

const res = await fetch("https://api.expo.dev/graphql", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.EXPO_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    query: `mutation($i: AppVersionInput!) {
      appVersion {
        createAppVersion(appVersionInput: $i) { id }
      }
    }`,
    variables: {
      i: {
        appId,
        platform: platform === "ios" ? "IOS" : "ANDROID",
        applicationIdentifier,
        storeVersion,
        buildVersion: String(buildVersion),
      },
    },
  }),
});

const json = await res.json() as { errors?: { message: string }[] };
if (json.errors) {
  console.error("Failed to set version:", json.errors.map((e) => e.message).join(", "));
  process.exit(1);
}
