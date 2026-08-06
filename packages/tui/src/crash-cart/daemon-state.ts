// Crash-cart C3 — daemon-state detection (planner+PM ruling; the honest-degraded false-negative rail).
//
// THREE states — the cockpit + the C2 direct read fire ONLY on DOWN, and DOWN requires POSITIVE
// evidence. A probe blip must NEVER fabricate a crash narrative or offer RESTORE EVERYTHING:
//   UP         — /healthz answered (openrig is serving).
//   DOWN       — (no daemon.json OR pid dead) AND /healthz connection-REFUSED. REFUSED is the ONLY
//                strong down signal; a timeout NEVER promotes to DOWN (at any retry count).
//   UNVERIFIED — everything else: timeout, a wedged daemon (pid alive but refused/unresponsive), or a
//                non-openrig process on the port. Renders its own minimal screen, never the cockpit.
//
// All probes + the clock are injected so the verdict is deterministically testable.

export type DaemonState = "up" | "down" | "unverified";

/** The /healthz probe outcome — distinguishes a REFUSED connection (strong down) from a TIMEOUT
 *  (unverified) from a foreign occupant (unverified). */
export type HealthzProbeResult = "answered" | "refused" | "timeout" | "not-openrig";

/** Verbatim evidence rendered on the UNVERIFIED screen (never a crash story — the honest "we cannot
 *  confirm the daemon is down" record). Assembled by the caller from the pid check + last probe. */
export interface DaemonUnverifiedEvidence {
  pidState: string;
  probeResult: string;
  failedSignal: string;
}

/** Minimal daemon.json shape the classifier needs. */
export interface DaemonStateFile {
  pid: number;
  port: number;
  host?: string;
}

export interface ClassifyDaemonDeps {
  openrigHome: string;
  readDaemonJson: (openrigHome: string) => DaemonStateFile | undefined;
  isProcessAlive: (pid: number) => boolean;
  probeHealthz: (url: string) => Promise<HealthzProbeResult>;
  openrigUrl?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7433;

function healthzUrl(deps: ClassifyDaemonDeps, state: DaemonStateFile | undefined): string {
  if (deps.openrigUrl && deps.openrigUrl.trim().length > 0) {
    const base = deps.openrigUrl.trim();
    return `${base.endsWith("/") ? base.slice(0, -1) : base}/healthz`;
  }
  const host = state?.host ?? DEFAULT_HOST;
  const port = state?.port ?? DEFAULT_PORT;
  return `http://${host}:${port}/healthz`;
}

/**
 * SINGLE-SHOT classification (the per-probe primitive; the bounded retry is resolveDaemonState).
 * DOWN only on positive evidence (pid dead/absent AND refused); UP on answered; else UNVERIFIED.
 */
export async function classifyDaemonState(deps: ClassifyDaemonDeps): Promise<DaemonState> {
  const state = deps.readDaemonJson(deps.openrigHome);
  const pidDeadOrAbsent = !state || !deps.isProcessAlive(state.pid);
  const probe = await deps.probeHealthz(healthzUrl(deps, state));
  if (probe === "answered") return "up";
  if (probe === "refused" && pidDeadOrAbsent) return "down";
  // timeout · wedged (pid alive but refused/unresponsive) · foreign occupant → never a crash verdict.
  return "unverified";
}

export interface ResolveDaemonDeps extends ClassifyDaemonDeps {
  /** Injected delay between probes (deterministic in tests). */
  sleep: (ms: number) => Promise<void>;
  /** Max probes (small/bounded, sub-2s feel — default 3). */
  maxProbes?: number;
  /** Delay between probes in ms (default 400 → ~2 gaps under 2s at 3 probes). */
  retryDelayMs?: number;
}

/**
 * Bounded-retry resolution. UP (answered) and DOWN (refused + pid-dead) are DECISIVE — returned on the
 * first probe that yields them, no retry. UNVERIFIED (timeout/wedged/foreign) triggers a bounded retry;
 * if it never resolves to UP or DOWN within maxProbes, the verdict is UNVERIFIED. A timeout NEVER
 * promotes to DOWN at any retry count (the false-negative rail).
 */
export async function resolveDaemonState(deps: ResolveDaemonDeps): Promise<DaemonState> {
  const max = Math.max(1, deps.maxProbes ?? 3);
  const delay = deps.retryDelayMs ?? 400;
  for (let i = 0; i < max; i += 1) {
    const s = await classifyDaemonState(deps);
    if (s === "up" || s === "down") return s; // decisive
    if (i < max - 1) await deps.sleep(delay); // unverified → retry
  }
  return "unverified";
}
