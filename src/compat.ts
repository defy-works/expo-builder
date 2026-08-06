export interface SdkRequirement {
  /** Minimum Xcode Expo publishes for this SDK. */
  minXcode: string;
  /** The Xcode EAS Cloud actually builds this SDK with — the target we aim for. */
  knownGoodXcode: string;
  minNode: string;
  minJdk: string;
}

/**
 * Seeded only with entries verified against Expo's published requirements
 * on 2026-08-06. Older SDKs are added as verified, never guessed.
 *
 * Sources:
 *   https://docs.expo.dev/versions/latest/                 (floors)
 *   https://docs.expo.dev/build-reference/infrastructure/  (EAS default image)
 */
export const SDK_REQUIREMENTS: Record<number, SdkRequirement> = {
  57: { minXcode: "26.4", knownGoodXcode: "26.6", minNode: "22.13.0", minJdk: "17" },
  56: { minXcode: "26.4", knownGoodXcode: "26.4", minNode: "20.19.4", minJdk: "17" },
  55: { minXcode: "26.2", knownGoodXcode: "26.2", minNode: "20.19.4", minJdk: "17" },
  54: { minXcode: "16.1", knownGoodXcode: "26.0", minNode: "20.19.4", minJdk: "17" },
  53: { minXcode: "16.1", knownGoodXcode: "16.4", minNode: "18.18.0", minJdk: "17" },
};

export function requirementsFor(sdkMajor: number): SdkRequirement | undefined {
  return SDK_REQUIREMENTS[sdkMajor];
}

/** Numeric, segment-wise version comparison. Returns <0, 0, or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Extract the major version from a package.json dependency range. */
export function parseSdkMajor(range: string): number | undefined {
  const match = range.match(/(\d+)\./);
  if (!match) return undefined;
  const major = parseInt(match[1]!, 10);
  return Number.isNaN(major) ? undefined : major;
}

export interface RepoTags {
  repo: string;
  tags: string[];
}

export interface ImageChoice {
  repo?: string;
  tag?: string;
  warnings: string[];
}

/** Tahoe is EAS's base for SDK 56+; sequoia below that. Used only to break ties. */
function preferredRepoFor(sdkMajor: number | undefined): string {
  return sdkMajor !== undefined && sdkMajor >= 56 ? "tahoe" : "sequoia";
}

const STABLE_TAG = /^\d+(\.\d+)*$/;

interface Candidate { repo: string; tag: string }

function stableCandidates(repos: RepoTags[]): Candidate[] {
  const out: Candidate[] = [];
  for (const { repo, tags } of repos) {
    for (const tag of tags) {
      if (STABLE_TAG.test(tag)) out.push({ repo, tag });
    }
  }
  return out;
}

/** Newest first; ties broken toward the preferred macOS base. */
function sortCandidates(candidates: Candidate[], prefer: string): Candidate[] {
  return [...candidates].sort((a, b) => {
    const byVersion = compareVersions(b.tag, a.tag);
    if (byVersion !== 0) return byVersion;
    const aPref = a.repo.includes(prefer) ? 0 : 1;
    const bPref = b.repo.includes(prefer) ? 0 : 1;
    return aPref - bPref;
  });
}

/**
 * Choose the Tart image for a project's Expo SDK.
 *
 * Targets the Xcode that EAS Cloud builds this SDK with, bounded below by
 * Expo's published floor. Deliberately NOT "newest wins" — Expo documents
 * that an Xcode newer than an SDK supports may fail.
 */
export function resolveImage(
  sdkMajor: number | undefined,
  repos: RepoTags[],
  override?: string,
): ImageChoice {
  const warnings: string[] = [];
  const candidates = stableCandidates(repos);
  const prefer = preferredRepoFor(sdkMajor);
  const sorted = sortCandidates(candidates, prefer);

  if (override && override !== "auto") {
    if (override === "latest") {
      const newest = sorted[0];
      warnings.push(
        'vm.xcode is "latest". Expo documents that an Xcode newer than an SDK supports may fail. ' +
        'Prefer "auto".'
      );
      if (!newest) {
        warnings.push("No stable image tags available.");
        return { warnings };
      }
      return { repo: newest.repo, tag: newest.tag, warnings };
    }
    const exact = sorted.find((c) => compareVersions(c.tag, override) === 0);
    if (!exact) {
      warnings.push(`Xcode ${override} is not available as a Tart image.`);
      return { warnings };
    }
    return { repo: exact.repo, tag: exact.tag, warnings };
  }

  const req = sdkMajor === undefined ? undefined : requirementsFor(sdkMajor);

  if (!req) {
    const newest = sorted[0];
    warnings.push(
      `Unknown Expo SDK${sdkMajor === undefined ? "" : ` ${sdkMajor}`}. ` +
      `Using the newest stable image; compatibility is unverified.`
    );
    if (!newest) {
      warnings.push("No stable image tags available.");
      return { warnings };
    }
    return { repo: newest.repo, tag: newest.tag, warnings };
  }

  const inRange = sorted.filter(
    (c) =>
      compareVersions(c.tag, req.minXcode) >= 0 &&
      compareVersions(c.tag, req.knownGoodXcode) <= 0
  );
  if (inRange[0]) return { repo: inRange[0].repo, tag: inRange[0].tag, warnings };

  const aboveFloor = sorted.filter((c) => compareVersions(c.tag, req.minXcode) >= 0);
  const fallback = aboveFloor[aboveFloor.length - 1];
  if (fallback) {
    warnings.push(
      `Xcode ${fallback.tag} exceeds ${req.knownGoodXcode}, which EAS Cloud uses for SDK ${sdkMajor}. ` +
      `Builds may fail.`
    );
    return { repo: fallback.repo, tag: fallback.tag, warnings };
  }

  warnings.push(
    `No image meets Expo SDK ${sdkMajor}'s minimum of Xcode ${req.minXcode}.`
  );
  return { warnings };
}

export const IMAGE_REPOS = [
  "cirruslabs/macos-tahoe-xcode",
  "cirruslabs/macos-sequoia-xcode",
] as const;

/**
 * List tags for a ghcr repo. Anonymous pull-scoped tokens work, so no
 * credentials are needed. Never throws — a registry failure degrades to
 * an empty tag list so callers can fall back to cached data.
 */
export async function fetchRepoTags(
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoTags> {
  const full = `ghcr.io/${repo}`;
  try {
    const tokenRes = await fetchImpl(
      `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${repo}:pull`)}&service=ghcr.io`
    );
    if (!tokenRes.ok) return { repo: full, tags: [] };
    const { token } = (await tokenRes.json()) as { token?: string };
    if (!token) return { repo: full, tags: [] };

    const tagsRes = await fetchImpl(`https://ghcr.io/v2/${repo}/tags/list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!tagsRes.ok) return { repo: full, tags: [] };
    const body = (await tagsRes.json()) as { tags?: string[] };
    return { repo: full, tags: body.tags ?? [] };
  } catch {
    return { repo: full, tags: [] };
  }
}

export async function fetchAllRepoTags(fetchImpl: typeof fetch = fetch): Promise<RepoTags[]> {
  return Promise.all(IMAGE_REPOS.map((r) => fetchRepoTags(r, fetchImpl)));
}
