// OPR.0.5.5.19 — THE FORMAL ACTIVITY TAXONOMY: the declared state language every surface
// renders from (TUI, `rig ps`, node-inventory). Three orthogonal axes plus derived
// diagnoses, ratified at product/from-openrig.dev/taxonomy-agent-state-ADDENDUM-2026-08-26.md
// (founder ruling 22:00Z); reconciliation vs herdr/omnigent lives in
// docs/reference/agent-state-taxonomy.md — the doc CITES the addendum, never forks it.
//
// BINDING EXCLUSIONS (SPEC mini-req 1, adversarially held — verdict 1229a4b7):
//  - attention and needs-input are NEVER values of the activity enum. needs-input rides
//    as a count + short reason phrase (the omnigent pending_elicitations_count +
//    blocked_on shape); attention stays in its own machinery (attentionCount).
//  - UNKNOWN is a first-class honest value — the oracle saying "cannot tell", never an
//    error and never a guess. Unknown beats a confident wrong answer.
//  - Derived diagnoses (PARKED, HELD-is-not-parked, DONE-UNSEEN) are computed at read
//    time from the axes + the queue's obligation face; they are never stored as states.
//
// The addendum's human-facing activity list shows four values (working / idle /
// needs-input / unknown). The typed enum carries THREE: needs-input is derived for
// display from the count+reason fields via `deriveDisplayActivity` — the one bridge —
// so no store or transition ever holds "needs-input" as a state. That reconciliation
// is documented in the reference doc's addendum-mapping section.

/** Activity axis — what a present agent is doing. */
export type ActivityValue = "working" | "idle-at-prompt" | "unknown";
export const ACTIVITY_VALUES: ReadonlySet<string> = new Set<ActivityValue>([
  "working",
  "idle-at-prompt",
  "unknown",
]);

/** Session axis — does a process exist. */
export type SessionPresenceValue = "present" | "detached" | "exited" | "absent";
export const SESSION_PRESENCE_VALUES: ReadonlySet<string> = new Set<SessionPresenceValue>([
  "present",
  "detached",
  "exited",
  "absent",
]);

/** Resumability axis — orthogonal to both: revival optimism is never blended into
 *  reachability (the omnigent strict-liveness split). */
export type ResumabilityValue = "live" | "resumable" | "context-walled";
export const RESUMABILITY_VALUES: ReadonlySet<string> = new Set<ResumabilityValue>([
  "live",
  "resumable",
  "context-walled",
]);

/** needs-input as COUNT + short reason phrase — never a status value. count=0 means
 *  none; reason is the short human phrase ("permission prompt", "usage limit",
 *  "classifier hold") naming WHY nothing is moving. */
export interface NeedsInput {
  count: number;
  reason: string | null;
}

/** The addendum's human-facing display value: the four-value list human surfaces show. */
export type DisplayActivityValue = "working" | "idle" | "needs-input" | "unknown";

/** THE one bridge from the typed axes to the addendum's human-facing value. needs-input
 *  renders whenever the count is positive — visible needs-input evidence outranks a
 *  working self-report for THIS signal (herdr's arbitration cut) — without "needs-input"
 *  ever existing as a stored state. A non-taxonomy activity value refuses loudly: the
 *  surface-local vocabularies this slice retires must not leak back in through display. */
export function deriveDisplayActivity(activity: string, needsInput: NeedsInput): DisplayActivityValue {
  if (!ACTIVITY_VALUES.has(activity)) {
    throw new Error(
      `"${activity}" is not a taxonomy activity value (working | idle-at-prompt | unknown) — ` +
      `surface-local vocabulary must be mapped at its adapter, never rendered`,
    );
  }
  if (needsInput.count > 0) return "needs-input";
  if (activity === "idle-at-prompt") return "idle";
  return activity as "working" | "unknown";
}

// ── The evidence ladder + adapter contract (SPEC mini-reqs 2, 5, 7; AM-1/AM-2) ──

/** The named rungs, in ARBITRATION RANK order for the working/idle decision (top first).
 *  needs-input-chrome is special-cased: it outranks self-report for the needs-input
 *  signal ONLY, never for working/idle. window-sampling is the fallback floor. */
export type EvidenceRungId = "self-report" | "lifecycle-hooks" | "needs-input-chrome" | "window-sampling";
export const EVIDENCE_RUNG_RANK: readonly EvidenceRungId[] = [
  "self-report",
  "lifecycle-hooks",
  "window-sampling",
];

/** AM-2 symmetric admission: a rung EARNS authority the way lower rungs retire.
 *  authoritative — consulted for state; trial — admitted by fixture pass, measured for
 *  agreement, NOT consulted; identity-only — usable for identity/resume refs only
 *  (partial-coverage honesty, and the AM-1 degradation target); absent — not staffed. */
export type RungTrust = "authoritative" | "trial" | "identity-only" | "absent";

export interface RungDeclaration {
  rung: EvidenceRungId;
  /** herdr's cut: only full lifecycle coverage can ever be authoritative. */
  lifecycleCoverage: "full" | "partial" | "none";
  /** The trust the rung STARTS with on this adapter (promotion may raise trial). */
  initialTrust: RungTrust;
}

/** What an adapter declares about itself — arbitration ranks what each source can
 *  actually observe. Re-declared at every occupant swap (AM-1 corollary): a successor
 *  never inherits its predecessor's rung authority. */
export interface AdapterRungInventory {
  adapterId: string;
  runtime: "claude-code" | "codex" | "tmux-generic";
  rungs: RungDeclaration[];
}

/** One piece of evidence an adapter reports into the oracle. Every rung's evidence is
 *  SELF-DATED except historically the hook rung — which is exactly why hook authority is
 *  time-bounded (AM-1): observedAt here is the ingest clock for hooks. */
export interface ActivityEvidence {
  seatNodeId: string;
  sessionName: string;
  rung: EvidenceRungId;
  /** Stable source id, e.g. "claude:pid-json", "codex:hooks", "tmux:window-activity". */
  sourceId: string;
  /** Monotonic per source — stale or reordered reports are dropped. */
  seq: number;
  observedAt: string;
  activity?: ActivityValue;
  needsInput?: NeedsInput;
}

/** A visible rung-health transition (AM-1): arbitration can never make a silently-dead
 *  source authoritative, and the degradation itself must be observable. */
export interface RungHealthEvent {
  seatNodeId: string;
  rung: EvidenceRungId;
  sourceId: string;
  from: RungTrust;
  to: RungTrust;
  reason: string;
  at: string;
}

/** The arbitrated, seat-keyed answer every surface renders from. */
export interface ArbitratedSeatState {
  seatNodeId: string;
  activity: ActivityValue;
  needsInput: NeedsInput;
  /** Which rung decided `activity` — confidence made visible. */
  decidedBy: EvidenceRungId | null;
  /** Monotonic arbitrated-state sequence (wait-after-seq consumes it). */
  seq: number;
  changedAt: string;
  rungs: Array<{ rung: EvidenceRungId; sourceId: string; trust: RungTrust; lastEvidenceAt: string | null }>;
  /** The occupant swap is its OWN visible event, never an activity transition. */
  lastSwap: { generation: string; at: string } | null;
}
