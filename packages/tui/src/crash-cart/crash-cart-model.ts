// Crash-cart cockpit view MODEL (5.2 Wave B, plan c015d9ed §C3). The pre-daemon recovery view:
// bare `rig` with the daemon DOWN. View-local data model + builders (mirrors pulse-model.ts) — the
// renderer (render-crash-cart.ts) turns it into rows. Live data comes from the C2 daemon-down direct
// read (readCrashCartDiscovery); this builder adapts that discovery into the view model, keeping the
// renderer pure + testable.
//
// PM ruling (binding): the header stop-reason + prior-uptime are EXPLICIT honest-unknown — the slot
// says unavailable + WHY (no shutdown record is persisted), never blank, never inferred. Structure
// and ordering stay per the approved mock (3d3c90a0).

/** The honest-unknown text for the two unrecoverable header slots (PM ruling). */
export const NO_SHUTDOWN_RECORD = "unavailable — no shutdown record";

export interface CrashCartHeaderVM {
  /** Last activity time (HH:MM) derived from the newest durable write; "unknown" if none. */
  lastSeen: string;
  /** Always the honest-unknown text — prior uptime is not persisted. */
  uptimeText: string;
  /** Always the honest-unknown text — stop reason is not persisted. */
  reasonText: string;
}

export interface CrashCartRigVM {
  name: string;
  seatCount: number;
  lastActive: string; // HH:MM or "unknown"
  resumableCount: number;
}

export interface CrashCartStoppedVM {
  session: string;
  summary: string;
  time: string; // HH:MM or "unknown"
}

export interface CrashCartModel {
  /** recovery = evidence of prior life (rigs and/or last activity) → the crash cockpit.
   *  first-run = DOWN + no DB (no rigs, no prior activity) → onboarding framing, never a crash story. */
  mode: "recovery" | "first-run";
  header: CrashCartHeaderVM;
  foundOnHost: CrashCartRigVM[];
  /** In-progress work at crash time; empty ⇒ the renderer shows only the idle-clean line. */
  whereWorkStopped: CrashCartStoppedVM[];
}

/** The subset of the C2 discovery the view consumes (structurally the daemon's CrashCartDiscovery;
 *  kept local so the pure view has no cross-package import — the integration passes the real one). */
export interface CrashCartDiscoveryInput {
  header: { lastActivityAt: string | null };
  foundOnHost: Array<{
    rigName: string;
    seatCount: number;
    resumableCount: number;
    lastActiveAt: string | null;
  }>;
  whereWorkStopped: Array<{
    destinationSession: string;
    summary: string | null;
    tsUpdated: string;
  }>;
}

/** Extract HH:MM from an ISO-Z or SQLite `datetime('now')` timestamp (format-agnostic, no timezone
 *  math — the crash-cart shows wall times as recorded); null/unparseable ⇒ "unknown". */
export function hhmm(ts: string | null): string {
  if (!ts) return "unknown";
  const m = /[T ](\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : "unknown";
}

/** Adapt the C2 daemon-down discovery into the crash-cart view model. */
export function buildCrashCartModel(discovery: CrashCartDiscoveryInput): CrashCartModel {
  // Crash language requires evidence of PRIOR LIFE: no rigs AND no last-activity ⇒ a fresh host, not
  // a crash — render onboarding framing (PM ruling), never a crash story.
  const mode: CrashCartModel["mode"] =
    discovery.foundOnHost.length === 0 && !discovery.header.lastActivityAt ? "first-run" : "recovery";
  return {
    mode,
    header: {
      lastSeen: hhmm(discovery.header.lastActivityAt),
      uptimeText: NO_SHUTDOWN_RECORD,
      reasonText: NO_SHUTDOWN_RECORD,
    },
    foundOnHost: discovery.foundOnHost.map((r) => ({
      name: r.rigName,
      seatCount: r.seatCount,
      lastActive: hhmm(r.lastActiveAt),
      resumableCount: r.resumableCount,
    })),
    whereWorkStopped: discovery.whereWorkStopped.map((w) => ({
      session: w.destinationSession,
      summary: w.summary ?? "(no summary)",
      time: hhmm(w.tsUpdated),
    })),
  };
}

/** Static fixture reproducing the approved mock's data (with the PM honest-unknown header). Used by
 *  the demo screen + the strip-invariant test. */
export function demoCrashCartModel(): CrashCartModel {
  return {
    mode: "recovery",
    header: { lastSeen: "08:12", uptimeText: NO_SHUTDOWN_RECORD, reasonText: NO_SHUTDOWN_RECORD },
    foundOnHost: [
      { name: "openrig-pm", seatCount: 13, lastActive: "08:11", resumableCount: 7 },
      { name: "kernel", seatCount: 4, lastActive: "08:12", resumableCount: 4 },
      { name: "oversight", seatCount: 3, lastActive: "07:58", resumableCount: 3 },
    ],
    whereWorkStopped: [{ session: "pm-openrig", summary: "cut packet assembly", time: "08:09" }],
  };
}
