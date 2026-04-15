#!/usr/bin/env bun
/**
 * Set EAS remote build version via the Expo GraphQL API.
 *
 * Usage:  bun set-version.ts <ios|android> <buildVersion>
 *
 * Reads app.config.ts from cwd to extract projectId, bundleIdentifier/package,
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

// Load app config — same way EAS CLI resolves it
const configModule = require(`${process.cwd()}/app.config.ts`);
const config = typeof configModule.default === "function"
  ? configModule.default({ config: {} })
  : configModule.default ?? configModule;

const appId = config.extra?.eas?.projectId;
const storeVersion = config.version;
const applicationIdentifier = platform === "ios"
  ? config.ios?.bundleIdentifier
  : config.android?.package;

if (!appId || !storeVersion || !applicationIdentifier) {
  console.error("Could not extract projectId, version, or identifier from app.config.ts");
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
