import * as p from "@clack/prompts";
import type { ParsedArgs } from "../args";
import { loadConfig, remotePaths } from "../config";
import { ssh, type SshTarget } from "../remote/ssh";

export const GB_BYTES = 1024 * 1024 * 1024;
export const ARTIFACTS_KEPT = 3;

export interface CleanInputs {
  staleVms: string[];
  legacyDirs: string[];
  /** Artifact directory names, newest first. */
  artifactDirs: string[];
  cacheBytes: number;
  cacheBudgetBytes: number;
  ociCacheBytes: number;
  deep: boolean;
}

export interface CleanPlan {
  vmsToDelete: string[];
  dirsToDelete: string[];
  artifactsToDelete: string[];
  trimCacheToBytes?: number;
  pruneOciCache: boolean;
  reclaimableBytes: number;
  warnings: string[];
  isEmpty: boolean;
}

export function planCleanup(input: CleanInputs): CleanPlan {
  const warnings: string[] = [];
  const artifactsToDelete = input.artifactDirs.slice(ARTIFACTS_KEPT);
  const cacheOverBudget = Math.max(0, input.cacheBytes - input.cacheBudgetBytes);

  if (input.deep) {
    warnings.push(
      "Pruning the OCI cache means the next 'vm rebuild' must re-download ~62 GB.",
    );
  }

  const reclaimableBytes = cacheOverBudget + (input.deep ? input.ociCacheBytes : 0);

  const isEmpty =
    input.staleVms.length === 0 &&
    input.legacyDirs.length === 0 &&
    artifactsToDelete.length === 0 &&
    cacheOverBudget === 0 &&
    !input.deep;

  return {
    vmsToDelete: input.staleVms,
    dirsToDelete: input.legacyDirs,
    artifactsToDelete,
    trimCacheToBytes: cacheOverBudget > 0 ? input.cacheBudgetBytes : undefined,
    pruneOciCache: input.deep,
    reclaimableBytes,
    warnings,
    isEmpty,
  };
}

/** Gather current state from the Mac. Read-only. */
export async function inspectMac(
  target: SshTarget,
  slug: string,
  cacheBudgetGB: number,
  deep: boolean,
): Promise<CleanInputs> {
  const paths = remotePaths(slug);

  const vmList = ssh(target, "tart list --format json 2>/dev/null || echo '[]'", { allowFailure: true });
  let staleVms: string[] = [];
  try {
    const parsed = JSON.parse(vmList) as { Name: string; Running: boolean; Source: string }[];
    staleVms = parsed
      .filter((v) => v.Source === "local" && !v.Running)
      .filter((v) => /^expo-builder-build-|^build-\d/.test(v.Name))
      .map((v) => v.Name);
  } catch { /* leave empty */ }

  const legacyRaw = ssh(target, "ls -d $HOME/eas/* 2>/dev/null || true", { allowFailure: true });
  const legacyDirs = legacyRaw.split("\n").map((s) => s.trim()).filter(Boolean);

  const artifactsRaw = ssh(target, `ls -1t ${paths.artifacts} 2>/dev/null || true`, { allowFailure: true });
  const artifactDirs = artifactsRaw.split("\n").map((s) => s.trim()).filter(Boolean);

  const cacheKb = ssh(target, `du -sk ${paths.cache} 2>/dev/null | cut -f1 || echo 0`, { allowFailure: true });
  const ociKb = ssh(target, 'du -sk "${TART_HOME:-$HOME/.tart}"/cache 2>/dev/null | cut -f1 || echo 0', { allowFailure: true });

  return {
    staleVms,
    legacyDirs,
    artifactDirs,
    cacheBytes: (parseInt(cacheKb, 10) || 0) * 1024,
    cacheBudgetBytes: cacheBudgetGB * GB_BYTES,
    ociCacheBytes: (parseInt(ociKb, 10) || 0) * 1024,
    deep,
  };
}

export async function applyCleanup(
  target: SshTarget,
  slug: string,
  plan: CleanPlan,
): Promise<void> {
  const paths = remotePaths(slug);

  for (const vm of plan.vmsToDelete) {
    ssh(target, `tart delete ${vm} 2>/dev/null || true`, { allowFailure: true });
  }
  for (const dir of plan.dirsToDelete) {
    ssh(target, `rm -rf "${dir}"`, { allowFailure: true });
  }
  for (const artifact of plan.artifactsToDelete) {
    ssh(target, `rm -rf "${paths.artifacts}/${artifact}"`, { allowFailure: true });
  }
  if (plan.trimCacheToBytes !== undefined) {
    // Delete least-recently-used cache subdirectories until under budget.
    const budgetKb = Math.floor(plan.trimCacheToBytes / 1024);
    ssh(target, [
      `BUDGET=${budgetKb}`,
      `cd ${paths.cache} 2>/dev/null || exit 0`,
      `for d in $(ls -1tr); do`,
      `  USED=$(du -sk . | cut -f1)`,
      `  [ "$USED" -le "$BUDGET" ] && break`,
      `  rm -rf "$d"`,
      `done`,
    ].join("; "), { allowFailure: true });
  }
  if (plan.pruneOciCache) {
    ssh(target, "tart prune --entries caches --space-budget 0", { allowFailure: true });
  }
}

export async function runClean(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const target: SshTarget = { host: cfg.mac.host, user: cfg.mac.user };

  p.intro(`expo-builder clean — ${cfg.slug}`);

  const inputs = await inspectMac(target, cfg.slug, cfg.cache.budgetGB, args.flags.deep);
  const plan = planCleanup(inputs);

  if (plan.isEmpty) {
    p.outro("Nothing to clean");
    return 0;
  }

  if (plan.vmsToDelete.length) p.log.info(`Stale VMs: ${plan.vmsToDelete.join(", ")}`);
  if (plan.dirsToDelete.length) p.log.info(`Legacy directories: ${plan.dirsToDelete.join(", ")}`);
  if (plan.artifactsToDelete.length) p.log.info(`Old artifacts: ${plan.artifactsToDelete.length}`);
  if (plan.trimCacheToBytes !== undefined) p.log.info(`Trim cache to ${cfg.cache.budgetGB} GB`);
  if (plan.pruneOciCache) p.log.info("Prune the Tart OCI cache");
  for (const w of plan.warnings) p.log.warn(w);
  p.log.message(`Reclaimable: ~${(plan.reclaimableBytes / GB_BYTES).toFixed(1)} GB`);

  if (args.flags.dryRun) {
    p.outro("Dry run — nothing was removed");
    return 0;
  }

  if (!args.flags.yes) {
    const ok = await p.confirm({ message: "Proceed?" });
    if (p.isCancel(ok) || !ok) {
      p.cancel("Cancelled");
      return 0;
    }
  }

  await applyCleanup(target, cfg.slug, plan);
  p.outro("Cleaned");
  return 0;
}
