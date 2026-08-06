import { execFileSync } from "child_process";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { UsageError, BuildError } from "../errors";

export async function runLocal(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const platform = args.platform;
  if (platform !== "android" && platform !== "ios") {
    throw new UsageError(
      "run requires a single platform.",
      "Example: expo-builder run android",
    );
  }

  const ext = platform === "android" ? "apk" : "ipa";
  const output = `build/${cfg.slug}-dev.${ext}`;

  execFileSync("bunx", [
    "eas", "build",
    "--platform", platform,
    "--profile", "development",
    "--local", "--output", output,
  ], { stdio: "inherit", cwd: cfg.mobileDir });

  if (platform === "android") {
    execFileSync("adb", ["install", output], { stdio: "inherit", cwd: cfg.mobileDir });
    return 0;
  }

  const listing = execFileSync("xcrun", ["devicectl", "list", "devices", "-j", "/dev/stdout"], {
    encoding: "utf-8", cwd: cfg.mobileDir, stdio: ["pipe", "pipe", "inherit"],
  });
  const devices = (JSON.parse(listing) as { result?: { devices?: unknown[] } }).result?.devices ?? [];
  const wired = (devices as { connectionProperties?: { transportType?: string }; identifier?: string }[])
    .find((d) => d.connectionProperties?.transportType === "wired");
  if (!wired?.identifier) {
    throw new BuildError("No wired iOS device found.", "Connect a device over USB and try again.");
  }
  execFileSync("xcrun", ["devicectl", "device", "install", "app", "--device", wired.identifier, output], {
    stdio: "inherit", cwd: cfg.mobileDir,
  });
  return 0;
}
