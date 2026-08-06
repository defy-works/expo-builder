import { execFileSync } from "child_process";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { assertSubmittable } from "./guards";

export async function runSubmit(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const profile = args.profile ?? "preview";
  assertSubmittable(profile);
  execFileSync("bunx", [
    "eas", "submit",
    "--platform", args.platform ?? "all",
    "--profile", profile,
    "--non-interactive", "--latest",
  ], { stdio: "inherit", cwd: cfg.mobileDir });
  return 0;
}
