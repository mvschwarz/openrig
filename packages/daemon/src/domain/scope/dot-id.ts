// release-0.3.2 slice 12 — dot-ID grammar per
// `openrig-work/conventions/scope-and-versioning/README.md` §1.
//
// Grammar (v0 single-project):
//   project  = <PFX>            (2-3 letter; v0 hardcodes "OPR")
//   mission  = <PFX>.<ver>
//   slice    = <PFX>.<ver>.<n>
//   sub      = <PFX>.<ver>.<n>.<m>
//
// Version inference from mission folder name:
//   release-X.Y[.Z]     → "X.Y[.Z]"         (release train)
//   anything else       → "99.0.<m>" escape band (uniform-numeric;
//                          NO alpha — convention §1 explicit)
//
// The escape-band <m> is assigned by scanning peer non-release missions
// for an existing id and picking max+1. Releases keep their semver.

import type { DotId } from "./types.js";
import { ScopeCliError } from "./types.js";

/** Default project prefix for the OpenRig single-project workspace.
 *  Multi-project work waits for a real second project (convention §1). */
export const DEFAULT_PROJECT_PREFIX = "OPR";

const RELEASE_NAME_RE = /^release-(\d+\.\d+(?:\.\d+)?)$/;
// Strict positional grammar: every segment is a number except for the
// 2-3 letter project prefix at position 0. Accepts 2-5 numeric
// segments after the prefix (mission has 2-3, slice has 3-4, sub-slice
// has 4-5). Tier-aware parse helpers below split version/n/m correctly.
const DOT_ID_RE = /^([A-Z]{2,3})\.(\d+(?:\.\d+){1,4})$/;

/** Parse a dot-ID string into structured parts; returns null when the
 *  string doesn't conform to the §1 positional grammar. When `tier`
 *  is supplied, the trailing segments are peeled off into `n` (slice)
 *  or `n` + `m` (sub-slice). With no tier, all numeric segments are
 *  returned as `version` for backwards compatibility. */
export function parseDotId(
  raw: string,
  tier?: "mission" | "slice" | "sub-slice",
): DotId | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const m = DOT_ID_RE.exec(trimmed);
  if (!m) return null;
  const project = m[1]!;
  const segments = m[2]!.split(".");
  if (!tier) {
    return { project, version: segments.join("."), n: undefined, m: undefined };
  }
  if (tier === "mission") {
    return { project, version: segments.join("."), n: undefined, m: undefined };
  }
  if (tier === "slice") {
    if (segments.length < 3) return null; // slice = ver(>=2) + n
    const verSegs = segments.slice(0, -1);
    const nSeg = segments[segments.length - 1]!;
    return { project, version: verSegs.join("."), n: Number(nSeg), m: undefined };
  }
  // sub-slice
  if (segments.length < 4) return null;
  const verSegs = segments.slice(0, -2);
  const nSeg = segments[segments.length - 2]!;
  const mSeg = segments[segments.length - 1]!;
  return { project, version: verSegs.join("."), n: Number(nSeg), m: Number(mSeg) };
}

/** Validate a mission-ver segments array against the §1 escape-band
 *  rule. The convention defines the non-release escape band as
 *  `<PFX>.99.0.<n>` — the `0` after `99` is FIXED. A version like
 *  `99.7.8` does NOT conform. Shared between isMissionDotId and the
 *  parent-version check inside isSliceDotId so both surfaces stay in
 *  lockstep. */
function isValidMissionVerSegments(segs: string[]): boolean {
  if (segs.length < 2 || segs.length > 3) return false;
  if (segs[0] === "99") {
    // Escape band: exactly [99, "0", "<ordinal>"]. The `0` segment is
    // fixed; `<ordinal>` must be a non-empty numeric string.
    return segs.length === 3 && segs[1] === "0" && /^\d+$/.test(segs[2] ?? "");
  }
  return true;
}

/** Depth-based tier discriminator. Per §1 the positional grammar
 *  is fixed:
 *    mission   = <PFX>.<ver>           (ver = 2-3 numeric segments;
 *                                       escape band is exactly 99.0.n)
 *    slice     = <PFX>.<ver>.<n>       (3-4 numeric segments)
 *    sub-slice = <PFX>.<ver>.<n>.<m>   (4-5 numeric segments)
 *  Where a mission shape OVERLAPS with a slice shape (e.g. release
 *  X.Y mission has 2 segments; release X.Y.Z mission has 3 segments
 *  which is also the slice shape for release X.Y missions) the tier
 *  is resolved by depth: mission caps at 3 numeric segments; slice
 *  always has 3-4; sub-slice has 4-5. Escape band is fully unambiguous
 *  because §1 fixes both the 99 marker AND the 0 segment that follows. */
export function isMissionDotId(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const parsed = parseDotId(raw, "mission");
  if (!parsed) return false;
  return isValidMissionVerSegments(parsed.version.split("."));
}

export function isSliceDotId(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const parsed = parseDotId(raw, "slice");
  if (!parsed) return false;
  // Slice = mission-ver + 1 ordinal. Parent ver must itself be a
  // valid mission shape (including the escape-band exact-[99.0.n]
  // rule — a parent like 99.7.8 is not a real mission).
  return isValidMissionVerSegments(parsed.version.split("."));
}

/** Render a DotId back to its canonical dot-string. */
export function formatDotId(id: DotId): string {
  const parts = [id.project, id.version];
  if (id.n !== undefined) parts.push(String(id.n));
  if (id.m !== undefined) parts.push(String(id.m));
  return parts.join(".");
}

/** Compose a slice ID by appending an ordinal to a parent mission ID. */
export function sliceIdFromMission(missionId: string, n: number): string {
  return `${missionId}.${n}`;
}

/** Infer the (project, version) pair from a mission folder name when
 *  no explicit id is supplied. Release missions use their semver; any
 *  other name falls into the escape band where the caller supplies the
 *  next ordinal via the second arg. */
export function inferMissionDotId(
  missionFolderName: string,
  escapeBandOrdinal: number | null,
  projectPrefix: string = DEFAULT_PROJECT_PREFIX,
): string {
  const releaseMatch = RELEASE_NAME_RE.exec(missionFolderName);
  if (releaseMatch) {
    return `${projectPrefix}.${releaseMatch[1]}`;
  }
  if (escapeBandOrdinal === null) {
    throw new ScopeCliError({
      fact: `Mission "${missionFolderName}" doesn't match the release-X.Y[.Z] pattern and no escape-band ordinal was supplied.`,
      consequence: "No dot-ID could be inferred for this mission.",
      action: "Pass an explicit ordinal, or rename the mission to release-X.Y.Z, or supply --id on the CLI.",
    });
  }
  return `${projectPrefix}.99.0.${escapeBandOrdinal}`;
}

/** Pick the next escape-band ordinal by scanning peer mission IDs.
 *  Looks for `<PFX>.99.0.<m>` shapes and returns max(m)+1, starting
 *  at 1 when no peer exists. */
export function nextEscapeBandOrdinal(
  existingIds: ReadonlyArray<string | null>,
  projectPrefix: string = DEFAULT_PROJECT_PREFIX,
): number {
  let max = 0;
  const re = new RegExp(`^${projectPrefix}\\.99\\.0\\.(\\d+)$`);
  for (const id of existingIds) {
    if (!id) continue;
    const m = re.exec(id);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** Does this candidate string parse as a valid §1 dot-ID at ANY
 *  tier? Prefer the tier-specific isMissionDotId/isSliceDotId at use
 *  sites where the tier is known — depth alone doesn't disambiguate
 *  mission vs slice for release IDs with overlapping shapes. */
export function isConformantDotId(raw: unknown): boolean {
  return typeof raw === "string" && parseDotId(raw) !== null;
}
