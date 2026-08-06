import { execFileSync } from "child_process";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { UsageError } from "../errors";

export async function runUpdate(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const profile = args.profile ?? "production";
  const message = args.flags.message ?? args.positionals.join(" ");
  if (!message) {
    throw new UsageError(
      "An update message is required.",
      'Example: expo-builder update preview -m "fix crash on launch"',
    );
  }
  execFileSync("bunx", [
    "eas", "update",
    "--channel", profile,
    "--environment", profile,
    "--message", message,
    "--non-interactive",
  ], { stdio: "inherit", cwd: cfg.mobileDir });
  return 0;
}
