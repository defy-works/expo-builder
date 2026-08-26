import * as p from "@clack/prompts";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import type { ParsedArgs } from "../args";
import { CONFIG_FILENAME, gitRoot, findMobileDir, readSlug } from "../config";
import { ssh, pickSshKey, type SshTarget } from "../remote/ssh";

export async function runInit(args: ParsedArgs): Promise<number> {
  p.intro("expo-builder init");

  const cwd = process.cwd();
  const projectRoot = gitRoot(cwd) ?? cwd;
  const configPath = join(projectRoot, CONFIG_FILENAME);

  if (existsSync(configPath) && !args.flags.yes) {
    const overwrite = await p.confirm({ message: `${CONFIG_FILENAME} exists. Overwrite?` });
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("Cancelled");
      return 0;
    }
  }

  const mobileDir = findMobileDir(cwd, projectRoot);
  if (mobileDir) {
    p.log.success(`Found the Expo project at ${mobileDir} (slug: ${readSlug(mobileDir)})`);
  } else {
    p.log.warn("Could not auto-detect the Expo project — you will need to set mobileDir.");
  }

  const mac = await p.text({
    message: "Which Mac should builds run on?",
    placeholder: "user@host",
    validate: (v) => (!v ? "Required" : undefined),
  });
  if (p.isCancel(mac)) { p.cancel("Cancelled"); return 0; }

  const at = mac.indexOf("@");
  const target: SshTarget = at === -1
    ? { host: mac }
    : { user: mac.slice(0, at), host: mac.slice(at + 1) };

  const s = p.spinner();
  s.start(`Testing SSH to ${mac}...`);
  const reachable = ssh(target, "echo ok", { allowFailure: true }) === "ok";
  if (!reachable) {
    s.stop("Could not connect");
    const key = pickSshKey();
    p.log.error(
      `Could not SSH to ${mac}.\n\n` +
      `Verify manually with: ssh ${mac}\n` +
      (key ? `Using key: ${key}` : "No key found in ~/.ssh"),
    );
    return 1;
  }
  s.stop(`Connected to ${mac}`);

  const config: Record<string, unknown> = {
    $schema: "https://unpkg.com/expo-builder/schema.json",
    mac,
  };
  if (mobileDir && mobileDir !== projectRoot) {
    config.mobileDir = mobileDir.slice(projectRoot.length + 1).replace(/\\/g, "/");
  }

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  p.log.success(`Wrote ${CONFIG_FILENAME}`);
  p.outro("Next: expo-builder doctor");
  return 0;
}
