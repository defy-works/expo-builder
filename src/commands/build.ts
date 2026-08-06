import * as p from "@clack/prompts";
import { execFileSync } from "child_process";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";
import { runRemoteBuild } from "./remote-build";

export async function runBuild(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const profile = args.profile ?? "development";
  const platform = args.platform ?? "all";

  if (args.flags.remote) {
    p.intro(`expo-builder — ${cfg.slug}`);
    const code = await runRemoteBuild({
      cfg, profile, platform,
      submit: false,
      optimize: args.flags.optimize,
      cache: args.flags.cache,
      dryRun: args.flags.dryRun,
      download: args.flags.download,
    });
    p.outro("Done");
    return code;
  }

  execFileSync(
    "bunx",
    ["eas", "build", "--platform", platform, "--profile", profile, "--non-interactive"],
    { stdio: "inherit", cwd: cfg.mobileDir },
  );
  return 0;
}
