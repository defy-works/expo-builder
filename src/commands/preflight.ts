import { GB } from "../remote/storage";

/** Transient CoW clone plus build writes, per spec §6. */
export const BUILD_HEADROOM_BYTES = 25 * GB;

export interface PreflightInputs {
  freeBytes: number;
  reclaimableBytes: number;
}

export interface PreflightResult {
  action: "proceed" | "clean-then-proceed" | "refuse";
  message?: string;
}

export function assessPreflight(input: PreflightInputs): PreflightResult {
  if (input.freeBytes >= BUILD_HEADROOM_BYTES) return { action: "proceed" };

  if (input.freeBytes + input.reclaimableBytes >= BUILD_HEADROOM_BYTES) {
    return {
      action: "clean-then-proceed",
      message:
        `Only ${(input.freeBytes / GB).toFixed(1)} GB free; a build needs about ` +
        `${(BUILD_HEADROOM_BYTES / GB).toFixed(0)} GB. Reclaiming space first.`,
    };
  }

  return {
    action: "refuse",
    message:
      `Not enough disk on the Mac: ${(input.freeBytes / GB).toFixed(1)} GB free, ` +
      `about ${(BUILD_HEADROOM_BYTES / GB).toFixed(0)} GB needed, and only ` +
      `${(input.reclaimableBytes / GB).toFixed(1)} GB can be reclaimed automatically.\n\n` +
      `Try: expo-builder clean --deep\n` +
      `Or move Tart storage to an external APFS SSD by setting mac.tartHome.`,
  };
}
