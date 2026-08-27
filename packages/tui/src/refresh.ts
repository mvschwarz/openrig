/** Coalesce overlapping refresh requests with a TRAILING pass (Wave-O B3, R2 508e383d).
 *
 * The old shape returned the active promise for every overlapping request, so an
 * oracle push arriving AFTER the in-flight hydrate had read its snapshot but BEFORE it
 * settled simply disappeared — the open view stayed stale (AM-R18 violation). Now an
 * overlapping request marks the flight DIRTY and the runner performs at most ONE
 * trailing pass per overlap window before settling: every event window is represented,
 * work stays bounded (N overlapping requests = one trailing run), a quiet refresh does
 * exactly one pass, and a task failure neither breaks the loop nor rejects the caller
 * (the task itself owns error handling; the guard here is belt-and-braces). */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null;
  let dirty = false;
  const run = async (): Promise<void> => {
    do {
      dirty = false;
      try {
        await task();
      } catch {
        // the task owns its errors (live.ts never rejects); never break the coalescer
      }
    } while (dirty);
  };
  return () => {
    if (active) {
      dirty = true; // the trailing pass will represent this request
      return active;
    }
    active = run().finally(() => { active = null; });
    return active;
  };
}
