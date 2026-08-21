// B1 ROUND 4 — the restore view's key handling as a PURE reducer, so the operator affordances the
// screen advertises can be driven and asserted (r1: drive the test matrix from what the UI ADVERTISES,
// not from the handlers — an advertised-but-unwired key has no handler to enumerate from). main.ts is a
// thin executor over this reducer. The rule this closes: every affordance the screen offers in a state
// MUST act in that state, and the screen must never offer one the state cannot honour.
import { scrollKeyOf, nextScrollOffset } from "./restore-scroll.js";

export interface RestoreInputEvent {
  type: string;
  ch?: string;
  key?: string;
}

export interface RestoreInputContext {
  phase: "running" | "detached" | "done";
  cancelled: boolean;
  offset: number;
  maxOffset: number;
}

export type RestoreAction =
  | { kind: "quit" }
  | { kind: "scroll"; offset: number }
  | { kind: "cancel" }
  | { kind: "reattach" }
  | { kind: "cancel-reattach" }
  | { kind: "dismiss" }
  | { kind: "none" }; // swallowed (running ignores stray keys while the fleet restores)

/** Resolve one key in a restore phase to an action. Order: quit, then scroll (advertised in EVERY phase
 *  when the content overflows — so it must ACT in every phase), then the phase-specific lifecycle keys.
 *  A cancel already requested is NOT re-offered (the render drops `c cancel` once `cancelled`). */
export function restoreKeyAction(ev: RestoreInputEvent, ctx: RestoreInputContext): RestoreAction {
  if (ev.type === "char" && ev.ch === "q") return { kind: "quit" };

  const sk = scrollKeyOf(ev);
  if (sk) {
    const next = nextScrollOffset(sk, ctx.offset, ctx.maxOffset);
    return next === null ? { kind: "none" } : { kind: "scroll", offset: next };
  }

  if (ctx.phase === "running") {
    // c cancels only while it is actually offerable (not already requested); other keys are swallowed
    // (the fleet is restoring — no accidental dismissal).
    if (ev.type === "char" && ev.ch === "c" && !ctx.cancelled) return { kind: "cancel" };
    return { kind: "none" };
  }

  if (ctx.phase === "detached") {
    if (ev.type === "char" && ev.ch === "r") return { kind: "reattach" };
    // c: if not yet requested, cancel + reattach (observable); if already requested, the render no
    // longer offers `c cancel`, so c just reattaches to confirm.
    if (ev.type === "char" && ev.ch === "c") return ctx.cancelled ? { kind: "reattach" } : { kind: "cancel-reattach" };
    return { kind: "dismiss" };
  }

  // done: the triage list is scrollable (handled above); any other key dismisses.
  return { kind: "dismiss" };
}
