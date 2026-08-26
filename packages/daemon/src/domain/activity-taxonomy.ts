// OPR.0.5.5.19 — THE FORMAL ACTIVITY TAXONOMY: the declared state language every surface
// renders from (TUI, `rig ps`, node-inventory). Three orthogonal axes plus derived
// diagnoses, ratified at product/from-openrig.dev/taxonomy-agent-state-ADDENDUM-2026-08-26.md
// (founder ruling 22:00Z); reconciliation vs herdr/omnigent lives in
// docs/reference/agent-state-taxonomy.md — the doc CITES the addendum, never forks it.
//
// BINDING EXCLUSIONS (SPEC mini-req 1, adversarially held):
//  - attention and needs-input are NEVER values of the activity enum. needs-input rides
//    as a count + short reason phrase (the omnigent pending_elicitations_count +
//    blocked_on shape); attention stays in its own machinery (attentionCount).
//  - UNKNOWN is a first-class honest value — the oracle saying "cannot tell", never an
//    error and never a guess.
//  - Derived diagnoses (PARKED, HELD-is-not-parked, DONE-UNSEEN) are computed at read
//    time from the axes + the queue's obligation face; they are never stored as states.
//
// S19 RED: skeleton shipped UNWIRED so the pins run and fail at the vocabulary layer.

export type ActivityValue = never; // RED: the enum is not yet declared

export const ACTIVITY_VALUES: ReadonlySet<string> = new Set();
export const SESSION_PRESENCE_VALUES: ReadonlySet<string> = new Set();
export const RESUMABILITY_VALUES: ReadonlySet<string> = new Set();

export interface NeedsInput {
  count: number;
  reason: string | null;
}

export function deriveDisplayActivity(_activity: string, _needsInput: NeedsInput): string {
  throw new Error("not implemented (S19 A1 RED)");
}
