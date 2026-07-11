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

import { useFilesRead, FilesReadError } from "./useFiles.js";
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
  /** R1 (release-0.4.7) — WHY status is unknown, so a consumer can stop
   *  conflating a genuinely-absent PROGRESS.md with an infra read failure:
   *  `absent` (404) | `read_error` (5xx / a 200 without payload — NOT an
   *  empty file) | null (not a read failure: gated, loading, or read ok).
   *  The sole consumer today (ProjectTreeView quiet badge) does not branch
   *  on it — it is the discriminant a later slice uses to stop the tree
   *  from lying, without re-plumbing this hook. */
  reason: "absent" | "read_error" | null;
}

export function useMissionProgressStatus(
  root: string | null,
  missionPath: string | null,
): UseMissionProgressStatusResult {
  const progressPath =
    root && missionPath ? `${missionPath}/PROGRESS.md` : null;
  const readQuery = useFilesRead(root, progressPath);

  if (!root || !missionPath) {
    // caller gated (no root / no mission path) — not a read failure
    return { status: "unknown", isLoading: false, unavailable: true, mtime: null, reason: null };
  }

  if (readQuery.isLoading) {
    return { status: "unknown", isLoading: true, unavailable: false, mtime: null, reason: null };
  }

  if (readQuery.isError || !readQuery.data) {
    // R1: split a genuinely-absent PROGRESS.md (404) from a read failure. A
    // 5xx/other read error — or a 200 with no payload — is infra, NOT an
    // empty/absent file; only 404 is "the file isn't there". `unavailable`
    // stays true either way (status is still "unknown"); `reason` carries WHY.
    const err = readQuery.error;
    const reason: "absent" | "read_error" =
      readQuery.isError && err instanceof FilesReadError && err.code === "absent"
        ? "absent"
        : "read_error";
    return { status: "unknown", isLoading: false, unavailable: true, mtime: null, reason };
  }

  return {
    status: parseMissionStatus(readQuery.data.content),
    isLoading: false,
    unavailable: false,
    mtime: readQuery.data.mtime ?? null,
    reason: null,
  };
}
