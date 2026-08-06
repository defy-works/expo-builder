import * as p from "@clack/prompts";
import type { ParsedArgs } from "../args";
import { UsageError, BuildError } from "../errors";
import { loadConfig, readExpoSdkRange } from "../config";
import { ssh, type SshTarget } from "../remote/ssh";
import { parseSdkMajor, resolveImage } from "../compat";
import { loadCompatTags } from "../compat-cache";
import { provisionImage } from "../setup/tart";
import { parseDiskutilInfo, validateVolume, deriveKeepImages, GB } from "../remote/storage";

const SUBCOMMANDS = ["list", "rebuild", "delete", "migrate"] as const;
export type VmSubcommand = (typeof SUBCOMMANDS)[number];

export function parseVmSubcommand(positionals: string[]): VmSubcommand {
  const sub = positionals[0];
  if (!sub) {
    throw new UsageError(
      "vm requires a subcommand.",
      `Valid subcommands: ${SUBCOMMANDS.join(", ")}`,
    );
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(
      `Unknown vm subcommand: ${sub}`,
      `Valid subcommands: ${SUBCOMMANDS.join(", ")}`,
    );
  }
  return sub as VmSubcommand;
}

// Re-exported so `expo-builder vm` remains the natural place to find these,
// while the implementation lives in remote/storage.ts to avoid an import cycle
// with setup/tart.ts.
export { planImageEviction, type ImageEntry } from "../remote/storage";

export async function runVm(args: ParsedArgs): Promise<number> {
  const sub = parseVmSubcommand(args.positionals);
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const target: SshTarget = { host: cfg.mac.host, user: cfg.mac.user };

  switch (sub) {
    case "list": {
      const out = ssh(target, "tart list", { allowFailure: true });
      process.stdout.write(`${out}\n`);
      return 0;
    }

    case "delete": {
      if (!args.flags.yes) {
        const ok = await p.confirm({ message: `Delete the image "${cfg.vm.name}"?` });
        if (p.isCancel(ok) || !ok) return 0;
      }
      ssh(target, `tart delete ${cfg.vm.name}`, { allowFailure: true });
      p.log.success(`Deleted ${cfg.vm.name}`);
      return 0;
    }

    case "migrate": {
      const to = args.flags.to;
      if (!to) {
        throw new UsageError(
          "vm migrate requires a destination.",
          "Example: expo-builder vm migrate --to /Volumes/BuildSSD/.tart",
        );
      }
      const info = ssh(target, `diskutil info "${to}" 2>/dev/null || true`, { allowFailure: true });
      if (!info) {
        throw new BuildError(`Could not inspect ${to} on the Mac. Is the volume mounted?`);
      }
      const validation = validateVolume(parseDiskutilInfo(info));
      for (const w of validation.warnings) p.log.warn(w);
      if (validation.errors.length > 0) {
        throw new BuildError(validation.errors.join("\n\n"));
      }
      const s = p.spinner();
      s.start(`Moving Tart storage to ${to}...`);
      ssh(target, `mkdir -p "${to}" && rsync -a "\${TART_HOME:-$HOME/.tart}/" "${to}/"`);
      s.stop("Storage moved");
      p.log.info(
        `Add this to expo-builder.json:\n\n  { "mac": { "host": "${cfg.mac.host}", "tartHome": "${to}" } }\n\n` +
        `Then verify with: expo-builder doctor\n` +
        `Once verified, remove the old copy on the Mac manually.`,
      );
      return 0;
    }

    case "rebuild": {
      const sdkRange = readExpoSdkRange(cfg.mobileDir);
      const sdkMajor = sdkRange ? parseSdkMajor(sdkRange) : undefined;
      const { tags } = await loadCompatTags({ forceRefresh: true });
      const resolved = resolveImage(sdkMajor, tags, args.flags.xcode ?? cfg.vm.xcode);

      for (const w of resolved.warnings) p.log.warn(w);
      if (!resolved.repo || !resolved.tag) {
        throw new BuildError(
          "Could not resolve a Tart image for this project.",
          resolved.warnings.join("\n"),
        );
      }

      const freeRaw = ssh(target, 'df -k "${TART_HOME:-$HOME}" | tail -1 | awk \'{print $4}\'', { allowFailure: true });
      const freeBytes = (parseInt(freeRaw, 10) || 0) * 1024;
      const keep = deriveKeepImages(freeBytes, cfg.vm.keepImages);
      p.log.info(`Retaining up to ${keep} image${keep === 1 ? "" : "s"} (${(freeBytes / GB).toFixed(0)} GB free)`);

      return provisionImage({
        target,
        imageName: cfg.vm.name,
        source: `${resolved.repo}:${resolved.tag}`,
        keepImages: keep,
        yes: args.flags.yes,
      });
    }
  }
}
