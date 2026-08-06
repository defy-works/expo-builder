export const MARKER_KINDS = [
  "phase", "vm-ip", "boot-wait", "version", "stale", "error", "vm-resources", "image-size",
] as const;

export type MarkerKind = (typeof MARKER_KINDS)[number];

export interface Marker {
  kind: MarkerKind;
  value: string;
}

const MARKER_RE = /^::([a-z-]+)::(.*)$/;

export function parseMarker(line: string): Marker | null {
  const match = line.match(MARKER_RE);
  if (!match) return null;
  const kind = match[1] as MarkerKind;
  if (!(MARKER_KINDS as readonly string[]).includes(kind)) return null;
  return { kind, value: match[2] ?? "" };
}
