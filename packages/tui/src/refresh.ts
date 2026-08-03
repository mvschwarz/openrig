/** Coalesce overlapping timer ticks onto the active refresh. */
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null;
  return () => {
    active ??= task().finally(() => { active = null; });
    return active;
  };
}
