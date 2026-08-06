import * as p from "@clack/prompts";
import { compareVersions, requirementsFor, resolveImage, parseSdkMajor } from "../compat";
import { loadCompatTags } from "../compat-cache";
import { loadConfig, readExpoSdkRange, remotePaths } from "../config";
import { ssh, sshTargetString, type SshTarget } from "../remote/ssh";
import { parseDiskutilInfo, validateVolume, GB } from "../remote/storage";
import type { ParsedArgs } from "../args";

export interface ImageRecord {
  repo: string;
  tag: string;
  xcode: string;
  node: string;
  jdk: string;
}

export interface DoctorInputs {
  sdkMajor?: number;
  imageRecord?: ImageRecord;
  resolved: { repo?: string; tag?: string; warnings: string[] };
  freeBytes: number;
  volumeErrors: string[];
  volumeWarnings: string[];
  legacyImagePresent: boolean;
}

export interface DoctorReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
  remedies: string[];
}

export const LOW_DISK_BYTES = 40 * GB;

export function buildReport(input: DoctorInputs): DoctorReport {
  const problems: string[] = [...input.volumeErrors];
  const warnings: string[] = [...input.volumeWarnings, ...input.resolved.warnings];
  const remedies: string[] = [];

  if (!input.imageRecord) {
    problems.push("No VM image has been provisioned on the Mac.");
    remedies.push("expo-builder vm rebuild");
  } else {
    const req = input.sdkMajor === undefined ? undefined : requirementsFor(input.sdkMajor);
    if (req) {
      if (compareVersions(input.imageRecord.xcode, req.minXcode) < 0) {
        problems.push(
          `VM image has Xcode ${input.imageRecord.xcode}, but Expo SDK ${input.sdkMajor} requires ${req.minXcode} or newer.`,
        );
        remedies.push(`expo-builder vm rebuild${input.resolved.tag ? ` --xcode ${input.resolved.tag}` : ""}`);
      }
      if (input.imageRecord.node && compareVersions(input.imageRecord.node, req.minNode) < 0) {
        problems.push(
          `VM image has Node ${input.imageRecord.node}, but Expo SDK ${input.sdkMajor} requires ${req.minNode} or newer.`,
        );
        remedies.push("expo-builder vm rebuild");
      }
      if (input.imageRecord.jdk && compareVersions(input.imageRecord.jdk, req.minJdk) < 0) {
        problems.push(
          `VM image has JDK ${input.imageRecord.jdk}, but Expo SDK ${input.sdkMajor} requires ${req.minJdk} or newer.`,
        );
        remedies.push("expo-builder vm rebuild");
      }
    }
    if (
      input.resolved.tag &&
      compareVersions(input.imageRecord.tag, input.resolved.tag) !== 0 &&
      problems.length === 0
    ) {
      warnings.push(
        `A better-matching image is available: Xcode ${input.resolved.tag} (currently ${input.imageRecord.tag}).`,
      );
    }
  }

  if (input.freeBytes > 0 && input.freeBytes < LOW_DISK_BYTES) {
    warnings.push(
      `Low disk on the Mac: ${(input.freeBytes / GB).toFixed(1)} GB free. Run: expo-builder clean`,
    );
  }

  if (input.legacyImagePresent) {
    remedies.push(
      "Legacy image found. Migrate for free (APFS clone): tart clone eas-builder expo-builder && tart delete eas-builder",
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    remedies: [...new Set(remedies)],
  };
}

export async function runDoctor(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const target: SshTarget = { host: cfg.mac.host, user: cfg.mac.user };
  const paths = remotePaths(cfg.slug);

  p.intro(`expo-builder doctor — ${cfg.slug}`);

  const sdkRange = readExpoSdkRange(cfg.mobileDir);
  const sdkMajor = sdkRange ? parseSdkMajor(sdkRange) : undefined;

  const compat = await loadCompatTags({ forceRefresh: args.flags.refresh });
  if (compat.degraded) {
    p.log.warn("Could not reach ghcr; using cached image data, which may be out of date.");
  }
  const resolved = resolveImage(sdkMajor, compat.tags, cfg.vm.xcode);

  const recordJson = ssh(target, `cat ${paths.imageRecord} 2>/dev/null || true`, { allowFailure: true });
  let imageRecord: ImageRecord | undefined;
  try { imageRecord = recordJson ? (JSON.parse(recordJson) as ImageRecord) : undefined; } catch { /* absent */ }

  const volumeTarget = cfg.mac.tartHome ?? "$HOME";
  const diskutil = ssh(target, `diskutil info "${volumeTarget}" 2>/dev/null || true`, { allowFailure: true });
  const volume = diskutil ? parseDiskutilInfo(diskutil) : undefined;
  const validation = volume ? validateVolume(volume) : { errors: [], warnings: [] };

  const images = ssh(target, "tart list --quiet 2>/dev/null || true", { allowFailure: true });

  const report = buildReport({
    sdkMajor,
    imageRecord,
    resolved,
    freeBytes: volume?.freeBytes ?? 0,
    volumeErrors: validation.errors,
    volumeWarnings: validation.warnings,
    legacyImagePresent: images.split("\n").some((l) => l.trim() === "eas-builder"),
  });

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ ...report, sdkMajor, imageRecord, resolved }, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }

  p.log.info(`Mac: ${sshTargetString(target)}`);
  p.log.info(`Expo SDK: ${sdkMajor ?? "unknown"}`);
  p.log.info(`VM image: ${imageRecord ? `${imageRecord.repo}:${imageRecord.tag} (Xcode ${imageRecord.xcode})` : "none"}`);
  p.log.info(`Recommended: ${resolved.tag ? `${resolved.repo}:${resolved.tag}` : "could not resolve"}`);
  if (volume) p.log.info(`Free space: ${(volume.freeBytes / GB).toFixed(1)} GB`);

  for (const w of report.warnings) p.log.warn(w);
  for (const problem of report.problems) p.log.error(problem);
  if (report.remedies.length > 0) {
    p.log.message(`Suggested:\n${report.remedies.map((r) => `  ${r}`).join("\n")}`);
  }

  p.outro(report.ok ? "All checks passed" : "Problems found");
  return report.ok ? 0 : 1;
}
