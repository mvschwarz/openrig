// V1 attempt-3 Phase 5 P5-6 — MissionStatusBadge live PROGRESS.md fetch.
//
// Fetches `<missionPath>/PROGRESS.md` via the existing /api/files/read
// daemon route (no new daemon endpoint per SC-29) and parses the
// frontmatter `status:` field via parseMissionStatus(). Per project-tree.md
// L132–L133: "status derives from PROGRESS.md frontmatter or top-level
// status: field. … Driver implements via a thin parser that reads
// PROGRESS.md once per mission node load (NOT on every render); cache
// invalidation on file mtime change."
//
// TanStack Query supplies the cache layer; staleTime + the underlying
// /api/files/read response's `mtime` field together give us mtime-aware
// caching: queries refetch when invalidated, and the daemon's mtime
// metadata lets the UI show a fresh-vs-stale indicator if needed.

import { useFilesRead } from "./useFiles.js";
import { parseMissionStatus, type MissionStatus } from "../components/MissionStatusBadge.js";

export interface UseMissionProgressStatusResult {
  status: MissionStatus;
  isLoading: boolean;
  /** When true, PROGRESS.md does not exist for this mission (or the read
   *  failed); status is "unknown" and the UI may surface a hint. */
  unavailable: boolean;
  /** mtime of PROGRESS.md when known; null otherwise. Useful for fresh
   *  indicators or invalidation hooks. */
  mtime: string | null;
}

export function useMissionProgressStatus(
  root: string | null,
  missionPath: string | null,
): UseMissionProgressStatusResult {
  const progressPath =
    root && missionPath ? `${missionPath}/PROGRESS.md` : null;
  const readQuery = useFilesRead(root, progressPath);

  if (!root || !missionPath) {
    return { status: "unknown", isLoading: false, unavailable: true, mtime: null };
  }

  if (readQuery.isLoading) {
    return { status: "unknown", isLoading: true, unavailable: false, mtime: null };
  }

  if (readQuery.isError || !readQuery.data) {
    // 404 / unreadable PROGRESS.md = unknown; degrade quietly.
    return { status: "unknown", isLoading: false, unavailable: true, mtime: null };
  }

  return {
    status: parseMissionStatus(readQuery.data.content),
    isLoading: false,
    unavailable: false,
    mtime: readQuery.data.mtime ?? null,
  };
}
