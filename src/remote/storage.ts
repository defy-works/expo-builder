export const GB = 1024 * 1024 * 1024;

/** Below this much free space, only one provisioned image is affordable. */
export const SINGLE_IMAGE_THRESHOLD = 150 * GB;
/** Roughly one provisioned image plus its share of the retained OCI cache. */
export const BYTES_PER_IMAGE = 92 * GB;
export const MAX_KEPT_IMAGES = 3;

export interface VolumeInfo {
  name: string;
  isAPFS: boolean;
  ownershipEnabled: boolean;
  solidState: boolean;
  isNetwork: boolean;
  freeBytes: number;
}

const NETWORK_PROTOCOLS = ["smb", "nfs", "afp", "network"];

function field(text: string, label: string): string {
  const match = text.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "mi"));
  return match?.[1]?.trim() ?? "";
}

/**
 * Build the shell to inspect the volume backing an arbitrary path.
 * `diskutil info` only accepts a device or mount point — passing a plain
 * directory fails with "Could not find disk" — so resolve the mount point first.
 */
export function diskutilCommandFor(path: string): string {
  return `diskutil info "$(df -P "${path}" | tail -1 | awk '{for(i=6;i<=NF;i++) printf "%s%s", $i, (i<NF?" ":"")}')" 2>/dev/null || true`;
}

export function parseDiskutilInfo(text: string): VolumeInfo {
  const personality = field(text, "File System Personality").toLowerCase();
  const bundle = field(text, "Type \\(Bundle\\)").toLowerCase();
  const protocol = field(text, "Protocol").toLowerCase();
  // APFS internal volumes report "Container Free Space"; others report
  // "Volume Free Space". Accept either.
  const freeRaw = field(text, "Volume Free Space") || field(text, "Container Free Space");
  const bytesMatch = freeRaw.match(/\((\d+)\s*Bytes\)/i);

  return {
    name: field(text, "Volume Name"),
    isAPFS: personality.includes("apfs") || bundle.includes("apfs"),
    ownershipEnabled: field(text, "Owners").toLowerCase().startsWith("enabled"),
    solidState: field(text, "Solid State").toLowerCase().startsWith("yes"),
    isNetwork: NETWORK_PROTOCOLS.some((p) => protocol.includes(p)),
    freeBytes: bytesMatch ? parseInt(bytesMatch[1]!, 10) : 0,
  };
}

export interface VolumeValidation {
  errors: string[];
  warnings: string[];
}

export function validateVolume(v: VolumeInfo): VolumeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (v.isNetwork) {
    errors.push(
      `Network volumes cannot back a Tart VM disk. Use a locally attached APFS volume.`
    );
    return { errors, warnings };
  }

  if (!v.isAPFS) {
    errors.push(
      `Volume "${v.name}" is not APFS. Tart relies on APFS clonefile(2) for copy-on-write; ` +
      `without it every build would copy the full VM image (~80 GB) before starting. ` +
      `Reformat as APFS.`
    );
  }

  if (!v.ownershipEnabled) {
    errors.push(
      `Ownership is disabled on "${v.name}", which makes Tart fail with permission errors. ` +
      `Fix with: sudo diskutil enableOwnership /Volumes/${v.name}`
    );
  }

  if (!v.solidState) {
    warnings.push(
      `Volume "${v.name}" is not solid state. VM builds are random-I/O heavy and will be ` +
      `substantially slower on rotational media. An external SSD is strongly recommended.`
    );
  }

  return { errors, warnings };
}

/** Retention derived from free space, per spec §7. */
export function deriveKeepImages(freeBytes: number, setting: number | "auto"): number {
  if (setting !== "auto") return setting;
  if (freeBytes < SINGLE_IMAGE_THRESHOLD) return 1;
  const affordable = Math.floor(freeBytes / BYTES_PER_IMAGE);
  return Math.max(1, Math.min(MAX_KEPT_IMAGES, affordable));
}

export interface ImageEntry {
  name: string;
  /** Epoch seconds of last access; higher is more recent. */
  accessed: number;
}

/**
 * Least-recently-accessed images beyond the retention limit.
 * Lives here rather than in commands/vm.ts because setup/tart.ts also needs
 * it, and importing it from the command module would create a cycle.
 */
export function planImageEviction(images: ImageEntry[], keep: number): string[] {
  return [...images]
    .sort((a, b) => b.accessed - a.accessed)
    .slice(keep)
    .map((i) => i.name);
}
