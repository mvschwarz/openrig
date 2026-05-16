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
// 2-3 letter project prefix at position 0.
const DOT_ID_RE = /^([A-Z]{2,3})\.(\d+(?:\.\d+){0,3})$/;

/** Parse a dot-ID string into structured parts; returns null when the
 *  string doesn't conform to the §1 positional grammar. */
export function parseDotId(raw: string): DotId | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const m = DOT_ID_RE.exec(trimmed);
  if (!m) return null;
  const project = m[1]!;
  const segments = m[2]!.split(".");
  // version is "ver" portion (first 1-3 numeric segments depending on
  // whether the ID is for a mission / slice / sub-slice). We treat
  // version as the prefix that excludes the last segment for slice IDs
  // and the last two for sub-slice IDs. Without context, we cannot
  // distinguish "0.3.2" mission from "0.3.2 slice (with empty n)". The
  // caller asks for `expected: "mission" | "slice" | "sub-slice"` if
  // it cares. By default we return all segments as `version`.
  return {
    project,
    version: segments.join("."),
    n: undefined,
    m: undefined,
  };
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

/** Does this candidate string parse as a valid §1 dot-ID? */
export function isConformantDotId(raw: unknown): boolean {
  return typeof raw === "string" && parseDotId(raw) !== null;
}
