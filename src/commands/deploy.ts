import { execFileSync } from "child_process";
import * as p from "@clack/prompts";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { assertSubmittable } from "./guards";
import { runRemoteBuild } from "./remote-build";

export async function runDeploy(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const profile = args.profile ?? "preview";
  const platform = args.platform ?? "all";
  assertSubmittable(profile);

  if (args.flags.remote) {
    p.intro(`expo-builder — ${cfg.slug}`);
    const code = await runRemoteBuild({
      cfg, profile, platform,
      submit: true,
      optimize: args.flags.optimize,
      cache: args.flags.cache,
      dryRun: args.flags.dryRun,
      download: args.flags.download,
    });
    p.outro("Done");
    return code;
  }

  // --auto-submit ties the exact build to its submission, avoiding --latest guessing.
  execFileSync("bunx", [
    "eas", "build",
    "--platform", platform,
    "--profile", profile,
    "--non-interactive", "--auto-submit",
  ], { stdio: "inherit", cwd: cfg.mobileDir });
  return 0;
}
