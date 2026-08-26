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
