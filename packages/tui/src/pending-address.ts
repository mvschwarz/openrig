import type { LoadState, ViewStateStore } from "./types.js";

/** Resolve a pending topology address once the Topology read it opened has
 *  settled. With no live read coming (`load` null), resolve against what is
 *  shown now; the reducer then reports the read as unconfirmed, not absent.
 *  Returns true when it dispatched, so the caller can start the next page read. */
export function resolvePendingAddress(view: ViewStateStore, load: Pick<LoadState, "settled"> | null): boolean {
  if (!view.get().pendingDrill || (load && !load.settled)) return false;
  view.dispatch({ type: "resolve-pending" });
  return true;
}
