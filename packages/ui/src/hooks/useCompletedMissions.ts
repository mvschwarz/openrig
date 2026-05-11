// Slice 18 §3.5 — Getting Started complete-and-hide local state.
//
// Mirrors useDismissedSeqs's pattern: localStorage-backed soft state so
// "Mark complete" gives the operator instant visual feedback (mission
// disappears from the storytelling preview). The daemon-side
// POST /api/missions/<id>/complete writes mission frontmatter for the
// audit trail; this hook is the UI's optimistic mirror.

import { useCallback, useState } from "react";

export const COMPLETED_MISSIONS_STORAGE_KEY = "forYou.completedMissionIds";

function readFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(COMPLETED_MISSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const ids = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function writeToStorage(ids: Set<string>): void {
  try {
    localStorage.setItem(COMPLETED_MISSIONS_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // localStorage unavailable; swallow.
  }
}

export interface UseCompletedMissionsResult {
  completedMissionIds: Set<string>;
  markCompleted(id: string): void;
  unmarkCompleted(id: string): void;
}

export function useCompletedMissions(): UseCompletedMissionsResult {
  const [completedMissionIds, setCompletedMissionIds] = useState<Set<string>>(() => readFromStorage());

  const markCompleted = useCallback((id: string) => {
    setCompletedMissionIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      writeToStorage(next);
      return next;
    });
  }, []);

  const unmarkCompleted = useCallback((id: string) => {
    setCompletedMissionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      writeToStorage(next);
      return next;
    });
  }, []);

  return { completedMissionIds, markCompleted, unmarkCompleted };
}
