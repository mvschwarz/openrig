import { PageRead } from "./page-read.js";
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
/** One passive whole-snapshot read per quiet daemon sample window, while the activity stream isn't connected. */
export const QUIET_REFRESH_MS = 30_000;
/** The quiet window while the activity stream is connected: pushes report changes, so this only catches a missed one. */
export const CONNECTED_QUIET_REFRESH_MS = 300_000;
/** Activity pushes refresh at most once per this window; pushes inside it share one trailing refresh. */
export const PUSH_REFRESH_FLOOR_MS = 15_000;

export interface QuietTimerHandle {
  unref?: () => void;
}

export interface LiveRefreshDeps {
  hydrate: (page: PageRead, signal: AbortSignal) => Promise<FleetSnapshot>;
  scopeKey?: () => string;
  /** draw callback — invoked when the load lifecycle or data changes, so the
   * in-flight frame is actually DRAWN at start and cleared on settle */
  onFrame: () => void;
  now: () => number;
  /** injected by deterministic tests; production uses the Node timeout */
  setTimeout?: (callback: () => void, delayMs: number) => QuietTimerHandle;
  clearTimeout?: (handle: QuietTimerHandle) => void;
}

export interface LiveRefresh {
  /** run one refresh (single-flight); NEVER rejects — a failed hydrate
   * releases in-flight, keeps the prior snapshot, and the next call retries */
  refresh: () => Promise<void>;
  invalidate: () => Promise<void>;
  /** an activity push: refreshes now, or once at the end of the floor window when a refresh started inside it */
  pushed: () => void;
  connectionStatus: (status: NonNullable<LoadState["connection"]>) => void;
  snapshot: () => FleetSnapshot;
  load: () => LoadState;
  flashes: () => RowFlash[];
  /** stop the quiet fallback during TUI shutdown */
  close: () => void;
  /** stop the quiet fallback for good and say why (the daemon's build differs from this TUI's);
   *  a refresh the operator asks for still runs */
  stopBackground: (message: string) => void;
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
  let invalidation = 0;
  let lastConfirmedAt: number | null = null;
  let snapshot = emptySnapshot();
  let load: LoadState = { inFlight: false, settled: false };
  let flashes: RowFlash[] = [];
  let scope = deps.scopeKey?.() ?? "";
  let generation = 0;
  let controller = new AbortController();
  let page = new PageRead(deps.now, forgetDenied);
  // Bounded history local to this client. Returning revalidates the page's own reads.
  const pages = new Map<string, { page: PageRead; snapshot: FleetSnapshot; load: LoadState; lastConfirmedAt: number | null }>();
  function forgetDenied(url: string): void {
    // A denial in one view also invalidates historical views of that same URL.
    // Unrelated pages and successful sibling reads in this page remain intact.
    for (const [key, entry] of pages) if (entry.page.has(url)) pages.delete(key);
  }
  function syncScope(): void {
    const next = deps.scopeKey?.() ?? "";
    if (next === scope) return;
    pages.delete(scope);
    pages.set(scope, { page, snapshot, load: { ...load, inFlight: false }, lastConfirmedAt });
    while (pages.size > 12) pages.delete(pages.keys().next().value!);
    const prior = pages.get(next);
    const navigator = snapshot;
    scope = next; generation += 1; controller.abort(); controller = new AbortController();
    page = prior?.page ?? new PageRead(deps.now, forgetDenied);
    snapshot = prior?.snapshot ?? { ...emptySnapshot(), hosts: navigator.hosts, specs: navigator.specs,
      projects: navigator.projects, projectRead: navigator.projectRead, scopes: navigator.scopes,
      terminals: navigator.terminals && { catalog: navigator.terminals.catalog, catalogLoaded: navigator.terminals.catalogLoaded, preview: null } };
    flashes = [];
    lastConfirmedAt = prior?.lastConfirmedAt ?? null;
    load = prior ? { ...prior.load, stale: true, inFlight: false } : { inFlight: false, settled: false };
    // An old transport may take time to unwind. It cannot delay the new page.
    const expected = generation;
    runRefresh = singleFlight(() => expected === generation ? readPage() : Promise.resolve());
  }
  let quietTimer: QuietTimerHandle | null = null;
  let pushTimer: QuietTimerHandle | null = null;
  let lastReadAt: number | null = null;
  let closed = false;
  let skew: string | undefined;
  let refresh: () => Promise<void>;
  const scheduleTimeout = deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimeout = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  function clearQuietTimer(): void {
    if (quietTimer === null) return;
    cancelTimeout(quietTimer);
    quietTimer = null;
  }

  function armQuietTimer(): void {
    clearQuietTimer();
    if (closed || skew !== undefined) return;
    quietTimer = scheduleTimeout(() => {
      quietTimer = null;
      void refresh();
    }, load.connection === "connected" ? CONNECTED_QUIET_REFRESH_MS : QUIET_REFRESH_MS);
    quietTimer.unref?.();
  }

  const readPage = async () => {
    clearQuietTimer();
    // A read that starts now reflects every push so far, so a waiting trailing refresh isn't needed.
    if (pushTimer !== null) { cancelTimeout(pushTimer); pushTimer = null; }
    lastReadAt = deps.now();
    syncScope();
    const startedGeneration = generation;
    const activePage = page;
    activePage.begin();
    const startedAtInvalidation = invalidation;
    load.inFlight = true;
    deps.onFrame();
    try {
      const next = await deps.hydrate(activePage, controller.signal);
      syncScope();
      if (startedGeneration !== generation || closed) return;
      activePage.end();
      next.readErrors = [...new Set([...next.readErrors, ...activePage.errors])];
      load.retainedAt = activePage.retainedAt;
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
      load.stale = startedAtInvalidation !== invalidation || next.readErrors.length > 0;
      if (!load.stale) lastConfirmedAt = deps.now();
      load.lastSuccessAt = lastConfirmedAt ?? undefined;
    } catch {
      if (startedGeneration !== generation || closed) return;
      load.stale = true;
      // rejection-release: the prior snapshot stays (nothing fabricated),
      // in-flight clears below, and the next requested refresh retries
    } finally {
      if (startedGeneration !== generation || closed) return;
      load.inFlight = false;
      load.settled = true;
      deps.onFrame();
      armQuietTimer();
    }
  };
  let runRefresh = singleFlight(() => generation === 0 ? readPage() : Promise.resolve());

  refresh = () => {
    if (closed) return Promise.resolve();
    syncScope();
    clearQuietTimer();
    return runRefresh();
  };

  const invalidate = () => { invalidation += 1; load.stale = true; return refresh(); };

  return {
    refresh,
    invalidate,
    pushed: () => {
      // The page isn't marked stale while it waits: it shows the last read until the trailing refresh runs.
      if (closed || skew !== undefined || pushTimer !== null) return;
      const wait = lastReadAt === null ? 0 : lastReadAt + PUSH_REFRESH_FLOOR_MS - deps.now();
      if (wait <= 0) { void invalidate(); return; }
      pushTimer = scheduleTimeout(() => { pushTimer = null; void invalidate(); }, wait);
      pushTimer.unref?.();
    },
    connectionStatus: (status) => {
      load.connection = status;
      if (status !== "connected") {
        load.stale = true;
        // Without the stream, the quiet window goes back to 30 s.
        if (quietTimer !== null) armQuietTimer();
      } else if (skew === undefined) void refresh();
      deps.onFrame();
    },
    snapshot: () => { syncScope(); return snapshot; },
    // A read older than one quiet window plus 30 s is overdue: 60 s without the stream, as before, and 5.5 minutes
    // while it's connected, so an idle page isn't called stale between its 5-minute reads. A drop marks it stale at once.
    load: () => {
      syncScope();
      const overdueAfter = (load.connection === "connected" ? CONNECTED_QUIET_REFRESH_MS : QUIET_REFRESH_MS) + 30_000;
      return { ...load, ...(skew !== undefined ? { skew } : {}), ...(lastConfirmedAt !== null && deps.now() - lastConfirmedAt > overdueAfter ? { stale: true } : {}) };
    },
    flashes: () => [...flashes],
    close: () => {
      closed = true;
      controller.abort();
      clearQuietTimer();
      if (pushTimer !== null) { cancelTimeout(pushTimer); pushTimer = null; }
    },
    stopBackground: (message) => {
      skew = message;
      clearQuietTimer();
      if (pushTimer !== null) { cancelTimeout(pushTimer); pushTimer = null; }
      deps.onFrame();
    },
  };
}
