import type { MissionStatus } from "../components/MissionStatusBadge.js";
import type { SliceListEntry } from "../hooks/useSlices.js";

export type ProjectSliceRow = {
  name: string;
  displayName: string;
  status: string;
  rawStatus: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
  missionId?: string | null;
  railItem?: string | null;
};

export type ProjectMissionBucket = "current" | "archive";

export type ProjectMissionGroup = {
  id: string;
  label: string;
  status: MissionStatus;
  /** VM-005: the rendered word — authored missions render the author's raw
   *  word verbatim; derived missions render the enum word. Consumers that
   *  build groups via reconcileMissionStatus set this from `label`. */
  statusLabel?: string;
  /** VM-005: whether `status` came from authored frontmatter or the derived
   *  roll-up — projectMissionBucket's FR-4 shipped-family test reads it. */
  statusSource?: MissionStatusSource;
  slices: ProjectSliceRow[];
};

export const PROJECT_CURRENT_ACTIVITY_WINDOW_MS = 36 * 60 * 60 * 1000;

export function projectSliceFromListEntry(slice: SliceListEntry): ProjectSliceRow {
  return {
    name: slice.name,
    displayName: slice.displayName,
    status: slice.status,
    rawStatus: slice.rawStatus,
    qitemCount: slice.qitemCount,
    hasProofPacket: slice.hasProofPacket,
    lastActivityAt: slice.lastActivityAt,
    missionId: slice.missionId,
    railItem: slice.railItem,
  };
}

export function isRecentProjectActivity(
  lastActivityAt: string | null,
  now = Date.now(),
): boolean {
  if (!lastActivityAt) return false;
  const ts = Date.parse(lastActivityAt);
  if (Number.isNaN(ts)) return false;
  return now - ts <= PROJECT_CURRENT_ACTIVITY_WINDOW_MS;
}

export function isCurrentProjectSlice(slice: ProjectSliceRow, now = Date.now()): boolean {
  if (slice.qitemCount > 0) return true;
  if (slice.status === "blocked") return true;
  if (slice.status === "active" || slice.status === "draft") {
    return !slice.lastActivityAt || isRecentProjectActivity(slice.lastActivityAt, now);
  }
  return false;
}

// VM-005 (release-0.4.7) — the ONE reconciled mission-status home.
// Mission status was answered four independent ways (authored README
// frontmatter · this file's roll-up · the bucket test · a PROGRESS.md live
// override) with no precedence rule, and the roll-up labeled its taxonomy
// hole UNKNOWN — a status that DECAYED by wall clock. reconcileMissionStatus
// is the single answer every chip surface consumes: authored-when-present is
// authoritative (and never consults slices or the clock — no-decay by
// construction); the derived ladder serves only missions with no authored
// status, and every path names a KNOWN state.

export type MissionStatusSource = "authored" | "derived";

export interface ReconciledMissionStatus {
  state: MissionStatus;
  /** The rendered word. Authored-present → the author's raw word VERBATIM
   *  (chip tone via AUTHORED_WORD_TONES); derived → the enum word. */
  label: string;
  source: MissionStatusSource;
}

/** PIN Q3-P1 (arch, VM-005): the authored word→tone normalizer is ONE
 *  exported CLOSED constant — adding a word is one map entry, never new
 *  logic. Unrecognized words get a neutral tone ("idle", the tone-carrier
 *  only) and the authored word still wins and renders verbatim. */
export const AUTHORED_WORD_TONES: Record<string, MissionStatus> = {
  complete: "shipped",
  completed: "shipped",
  done: "shipped",
  shipped: "shipped",
  active: "active",
  "in-progress": "active",
  in_progress: "active",
  "in-flight": "active",
  wip: "active",
  paused: "paused",
  "on-hold": "paused",
  on_hold: "paused",
  blocked: "blocked",
  stalled: "blocked",
  draft: "draft",
  idle: "idle",
};

function normalizeAuthored(authored: string): { state: MissionStatus; label: string } {
  const word = authored.trim();
  const state = AUTHORED_WORD_TONES[word.toLowerCase()] ?? "idle";
  return { state, label: word };
}

/** The reconciled mission status. `now` is injected (never read internally)
 *  so the derived recency window is testable and the authored path is
 *  clock-free by construction. */
export function reconcileMissionStatus(
  authored: string | null,
  slices: ProjectSliceRow[],
  now = Date.now(),
): ReconciledMissionStatus {
  if (authored !== null && authored.trim().length > 0) {
    const { state, label } = normalizeAuthored(authored);
    return { state, label, source: "authored" };
  }
  const state = deriveMissionStatusFromSlices(slices, now);
  return { state, label: state, source: "derived" };
}

/** The derived ladder (fallback-only; pm's ratified vocabulary
 *  empty · blocked · draft · active · shipped · idle — no path returns
 *  the retired UNKNOWN word: every input here is fully known). Internal;
 *  chip consumers go through reconcileMissionStatus. */
function deriveMissionStatusFromSlices(slices: ProjectSliceRow[], now: number): MissionStatus {
  if (slices.length === 0) return "empty";
  if (slices.some((s) => s.status === "blocked" && isCurrentProjectSlice(s, now))) {
    return "blocked";
  }
  // Q2 (VM-005): a mission that is nothing but drafts is honestly "draft",
  // not "active" — fresh scaffolds have recent mtimes and would otherwise
  // read as current. Lands after blocked, before any-current.
  if (slices.every((s) => s.status === "draft")) return "draft";
  if (slices.some((s) => isCurrentProjectSlice(s, now))) return "active";
  if (slices.every((s) => s.status === "done")) return "shipped";
  return "idle";
}

export function projectMissionBucket(mission: ProjectMissionGroup): ProjectMissionBucket {
  // VM-005 FR-4: an AUTHORED shipped-family status buckets archive regardless
  // of slice recency (normalizeAuthored maps complete/completed/done/shipped
  // → "shipped", so source+state is exactly the shipped-family test).
  if (mission.statusSource === "authored" && mission.status === "shipped") return "archive";
  if (mission.slices.some((s) => isCurrentProjectSlice(s))) return "current";
  if (mission.slices.length === 0 && mission.status !== "shipped") return "current";
  return "archive";
}

export function latestProjectMissionActivity(mission: ProjectMissionGroup): number {
  return mission.slices.reduce((latest, slice) => {
    if (!slice.lastActivityAt) return latest;
    const ts = Date.parse(slice.lastActivityAt);
    if (Number.isNaN(ts)) return latest;
    return Math.max(latest, ts);
  }, 0);
}

export function sortProjectMissions(
  a: ProjectMissionGroup,
  b: ProjectMissionGroup,
): number {
  const activityDelta = latestProjectMissionActivity(b) - latestProjectMissionActivity(a);
  if (activityDelta !== 0) return activityDelta;
  return a.label.localeCompare(b.label);
}

export function partitionProjectMissions<T extends ProjectMissionGroup>(
  missions: T[],
): { current: T[]; archive: T[] } {
  const current: T[] = [];
  const archive: T[] = [];
  for (const mission of missions) {
    if (projectMissionBucket(mission) === "current") current.push(mission);
    else archive.push(mission);
  }
  return {
    current: current.sort(sortProjectMissions),
    archive: archive.sort(sortProjectMissions),
  };
}

export function projectSliceMeta(slice: ProjectSliceRow): string {
  const parts: string[] = [];
  if (slice.qitemCount > 0) {
    parts.push(`${slice.qitemCount} qitem${slice.qitemCount === 1 ? "" : "s"}`);
  }
  const staticStatus =
    (slice.status === "active" || slice.status === "draft") && !isCurrentProjectSlice(slice)
      ? `stale ${slice.status}`
      : slice.status;
  if (slice.rawStatus && slice.rawStatus !== slice.status) {
    parts.push(`${staticStatus} from ${slice.rawStatus}`);
  } else {
    parts.push(staticStatus);
  }
  if (slice.hasProofPacket) parts.push("proof");
  return parts.join(" · ");
}
