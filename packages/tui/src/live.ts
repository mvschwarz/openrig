// S19 ROUND-5 (guard NOT-CLEAR at b92c2a58): the refresh OWNER — the one
// component that knows when a hydrate is actually IN FLIGHT and which seat
// produced fresh PANE OUTPUT between refreshes. renderScreen stays pure and
// consumes this state via RenderOptions; main.ts wires it to the terminal.
//
// Event identity (finding 2): the served `terminalActive` derives from tmux
// `#{window_activity}` (SeatActivityService), a timestamp tmux advances ONLY
// when the window receives output. A false→true transition is therefore
// impossible without real new pane output — an honest onset-after-silence
// event with zero false positives. Known substrate limit (flagged to guard):
// the projection serves only the derived boolean, not the raw timestamp, so
// output arriving while a seat is ALREADY active cannot re-trigger; onsets
// after the silence window are the observable events.
import { singleFlight } from "./refresh.js";
import { emptySnapshot } from "./state.js";
import type { FleetSnapshot, LoadState, RowFlash } from "./types.js";

/** one-shot flash window (ms) — matches renderScreen's flashActive window */
export const FLASH_WINDOW_MS = 600;

export interface LiveRefreshDeps {
  hydrate: () => Promise<FleetSnapshot>;
  /** draw callback — invoked when the load lifecycle or data changes, so the
   * in-flight frame is actually DRAWN at start and cleared on settle */
  onFrame: () => void;
  now: () => number;
}

export interface LiveRefresh {
  /** run one refresh (single-flight); NEVER rejects — a failed hydrate
   * releases in-flight, keeps the prior snapshot, and the next call retries */
  refresh: () => Promise<void>;
  snapshot: () => FleetSnapshot;
  load: () => LoadState;
  flashes: () => RowFlash[];
}

/** walk the snapshot topology and key every agent's served pane-activity
 * boolean by the SAME stable key its explorer row carries */
function paneActivity(snap: FleetSnapshot): Map<string, boolean | null | undefined> {
  const map = new Map<string, boolean | null | undefined>();
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents)
          map.set(`agent:${host.name}/${rig.name}/${pod.name}/${agent.name}`, agent.paneActive);
  return map;
}

export function createLiveRefresh(deps: LiveRefreshDeps): LiveRefresh {
  let snapshot = emptySnapshot();
  const load: LoadState = { inFlight: false, settled: false };
  let flashes: RowFlash[] = [];

  const refresh = singleFlight(async () => {
    load.inFlight = true;
    deps.onFrame();
    try {
      const next = await deps.hydrate();
      if (load.settled) {
        // first hydrate is a LOAD, not fresh output — no flash; null (no
        // signal) never flashes either: only a served false→true transition
        const prev = paneActivity(snapshot);
        const now = deps.now();
        flashes = flashes.filter((f) => now - f.at < FLASH_WINDOW_MS);
        for (const [key, active] of paneActivity(next))
          if (active === true && prev.get(key) === false) flashes.push({ key, at: now });
      }
      snapshot = next;
    } catch {
      // rejection-release: the prior snapshot stays (nothing fabricated),
      // in-flight clears below, and the next scheduled refresh retries
    } finally {
      load.inFlight = false;
      load.settled = true;
      deps.onFrame();
    }
  });

  return {
    refresh,
    snapshot: () => snapshot,
    load: () => ({ ...load }),
    flashes: () => [...flashes],
  };
}
