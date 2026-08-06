import * as p from "@clack/prompts";
import type { ParsedArgs, Platform, Profile } from "../args";
import { loadConfig } from "../config";
import { runRemoteBuild } from "./remote-build";
import { runBuild } from "./build";
import { runSubmit } from "./submit";
import { runUpdate } from "./update";

type Action = "build" | "deploy" | "submit" | "update" | "doctor" | "clean" | "exit";

async function selectProfile(options: Profile[]): Promise<Profile | undefined> {
  const hints: Record<Profile, string> = {
    development: "dev client for internal testing",
    preview: "release build for beta testers",
    production: "store release",
  };
  const value = await p.select<Profile>({
    message: "Which profile?",
    options: options.map((o) => ({ value: o, label: o[0]!.toUpperCase() + o.slice(1), hint: hints[o] })),
  });
  return p.isCancel(value) ? undefined : value;
}

async function selectPlatform(): Promise<Platform | undefined> {
  const value = await p.select<Platform>({
    message: "Which platform?",
    options: [
      { value: "all", label: "Both", hint: "iOS + Android" },
      { value: "ios", label: "iOS" },
      { value: "android", label: "Android" },
    ],
  });
  return p.isCancel(value) ? undefined : value;
}

export async function runInteractive(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  p.intro(`expo-builder — ${cfg.slug}`);

  const action = await p.select<Action>({
    message: "What do you want to do?",
    options: [
      { value: "build", label: "Build", hint: "EAS Cloud or a Tart VM on your Mac" },
      { value: "deploy", label: "Build + Submit", hint: "build then submit to the stores" },
      { value: "submit", label: "Submit", hint: "submit an existing build" },
      { value: "update", label: "OTA Update", hint: "push a JS update, no native rebuild" },
      { value: "doctor", label: "Doctor", hint: "check the setup" },
      { value: "clean", label: "Clean", hint: "reclaim disk on the Mac" },
      { value: "exit", label: "Exit" },
    ],
  });
  if (p.isCancel(action) || action === "exit") { p.cancel("Goodbye"); return 0; }

  if (action === "doctor") {
    const { runDoctor } = await import("./doctor");
    return runDoctor(args);
  }
  if (action === "clean") {
    const { runClean } = await import("./clean");
    return runClean(args);
  }
  if (action === "submit") {
    const profile = await selectProfile(["preview", "production"]);
    if (!profile) return 0;
    const platform = await selectPlatform();
    if (!platform) return 0;
    return runSubmit({ ...args, profile, platform });
  }
  if (action === "update") {
    const profile = await selectProfile(["development", "preview", "production"]);
    if (!profile) return 0;
    const message = await p.text({
      message: "Update message?",
      validate: (v) => (!v ? "Required" : undefined),
    });
    if (p.isCancel(message)) return 0;
    return runUpdate({ ...args, profile, flags: { ...args.flags, message } });
  }

  const where = await p.select<"remote" | "cloud">({
    message: "Where should it build?",
    options: [
      { value: "remote", label: "Your Mac", hint: "ephemeral Tart VM" },
      { value: "cloud", label: "EAS Cloud", hint: "Expo's servers" },
    ],
  });
  if (p.isCancel(where)) return 0;

  const profile = await selectProfile(
    action === "deploy" ? ["preview", "production"] : ["development", "preview", "production"],
  );
  if (!profile) return 0;
  const platform = await selectPlatform();
  if (!platform) return 0;

  if (where === "cloud") {
    return runBuild({ ...args, profile, platform, flags: { ...args.flags, remote: false } });
  }

  const code = await runRemoteBuild({
    cfg, profile, platform,
    submit: action === "deploy",
    optimize: args.flags.optimize,
    cache: args.flags.cache,
    dryRun: args.flags.dryRun,
  });
  p.outro("Done");
  return code;
}
