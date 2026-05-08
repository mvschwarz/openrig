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

export function deriveMissionStatusFromSlices(slices: ProjectSliceRow[]): MissionStatus {
  if (slices.length === 0) return "unknown";
  const now = Date.now();
  if (slices.some((s) => s.status === "blocked" && isCurrentProjectSlice(s, now))) {
    return "blocked";
  }
  if (slices.some((s) => isCurrentProjectSlice(s, now))) return "active";
  if (slices.every((s) => s.status === "done")) return "shipped";
  return "unknown";
}

export function projectMissionBucket(mission: ProjectMissionGroup): ProjectMissionBucket {
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
