// Slice 18 — For You per-card dismiss state, soft-keyed by event seq.
//
// Dismissed seqs persist in localStorage so the same operator session
// stays clean across reloads. Entries auto-prune as soon as their seq
// falls below the minimum seq currently in the activity buffer — at
// that point the source event has aged out and the dismissed entry
// can never re-surface, so storing it would only grow the set forever.

import { useCallback, useEffect, useMemo, useState } from "react";

export const DISMISSED_SEQS_STORAGE_KEY = "forYou.dismissedSeqs";

function readDismissedFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem(DISMISSED_SEQS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const numbers = parsed.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return new Set(numbers);
  } catch {
    return new Set();
  }
}

function writeDismissedToStorage(seqs: Set<number>): void {
  try {
    localStorage.setItem(DISMISSED_SEQS_STORAGE_KEY, JSON.stringify(Array.from(seqs)));
  } catch {
    // localStorage may be unavailable (private mode, quota, etc.) — swallow.
  }
}

export interface UseDismissedSeqsResult {
  dismissedSeqs: Set<number>;
  dismiss(seq: number): void;
  undismiss(seq: number): void;
}

export function useDismissedSeqs(currentSeqs: number[]): UseDismissedSeqsResult {
  const [dismissedSeqs, setDismissedSeqs] = useState<Set<number>>(() => readDismissedFromStorage());

  const minCurrentSeq = useMemo(() => {
    if (currentSeqs.length === 0) return null;
    let min = currentSeqs[0]!;
    for (const seq of currentSeqs) {
      if (seq < min) min = seq;
    }
    return min;
  }, [currentSeqs]);

  useEffect(() => {
    if (minCurrentSeq === null) return;
    let changed = false;
    const next = new Set<number>();
    for (const seq of dismissedSeqs) {
      if (seq >= minCurrentSeq) {
        next.add(seq);
      } else {
        changed = true;
      }
    }
    if (changed) {
      setDismissedSeqs(next);
      writeDismissedToStorage(next);
    }
  }, [minCurrentSeq, dismissedSeqs]);

  const dismiss = useCallback((seq: number) => {
    setDismissedSeqs((prev) => {
      if (prev.has(seq)) return prev;
      const next = new Set(prev);
      next.add(seq);
      writeDismissedToStorage(next);
      return next;
    });
  }, []);

  const undismiss = useCallback((seq: number) => {
    setDismissedSeqs((prev) => {
      if (!prev.has(seq)) return prev;
      const next = new Set(prev);
      next.delete(seq);
      writeDismissedToStorage(next);
      return next;
    });
  }, []);

  return { dismissedSeqs, dismiss, undismiss };
}
