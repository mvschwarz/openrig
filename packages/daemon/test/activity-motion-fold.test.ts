// ACTIVITY D1+D2 — fold the window_activity MOTION signal into the ACTIVITY ladder. RED-first.
//
// TWO CAUSES, ONE CODE PATH (attachAgentActivity, node-inventory.ts):
//   D1 (Codex → unknown) = COVERAGE. A Codex seat has no hook, so the positive-hook early return
//     never fires, and the cached STRUCTURAL verdict comes from a Claude-shaped matcher over a fixed
//     8-line tail window. Codex's tall footer pushes `◦ Working (… esc to interrupt)` above that
//     window → no match → unknown. A generating seat reports nothing.
//   D2 (Claude → idle) = PRECEDENCE. A positive `idle` hook early-returns as authoritative, so live
//     motion is NEVER consulted. A Claude seat that Stopped then RESUMED still carries the stale idle
//     hook as latest → reports idle WHILE GENERATING. A perfect motion source alone does not fix this.
//
// THE FIX = a runtime-agnostic MOTION source (tmux `#{window_activity}`, already computed per seat by
// SeatActivityService and already surfaced as `terminalActive` in a SEPARATE column) folded into the
// ACTIVITY ladder, ordered `needs_input(TEXT) > motion > idle`. Motion can only ever UPGRADE to
// running; it never manufactures `idle`, so a hook-less MOTIONLESS seat still reads `unknown` and the
// closed union does not rot.
//
// WHY MOTION AND NOT A BETTER MATCHER: a per-runtime TUI matcher is a treadmill — every provider
// reskin re-breaks it. `window_activity` is a tmux fact about bytes on the pane, identical for Claude,
// Codex, and anything else we ever seat.
//
// LIVE MEASUREMENT BEHIND THIS DESIGN (daemon route, reverted runtime cb662b9d, 2026-08-11 04:52Z):
// terminalActive was TRUE for exactly the two seats generating at that instant (dev-driver,
// dev50-driver) and FALSE for the other 12 — including every Codex seat, whose tall footers do NOT
// keep the window fresh. The motion source discriminates live and is not sprayed by clock-tick
// redraws, which was the design's main risk.
//
// NOTE ON THE NEGATIVE CONTROL: these unit assertions are NOT the gate on their own. The reverted
// runtime is uniformly inert (all 14 seats unknown, reason=generation_unverifiable), so D2 cannot be
// STAGED there — assertions that look satisfied against it can be vacuous. The live control is staged
// separately by deliberately reintroducing the precedence and watching A1 fail BY NAME.

import { describe, it, expect } from "vitest";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { AgentActivity } from "../src/domain/types.js";

function mkTmux(counter: { captures: number }) {
  return {
    hasSession: async () => true,
    getPaneCommand: async () => "claude",
    capturePaneContent: async () => {
      counter.captures++;
      return "some pane output\n> awaiting input";
    },
  } as never;
}

function entries(sessionName: string, runtime = "claude-code") {
  return [{ canonicalSessionName: sessionName, runtime, attachmentType: "tmux", logicalId: "dev.impl" }] as never;
}

/** The cached MOTION observation, as SeatActivityService exposes it. A cache read, never a capture. */
function mkMotion(isActiveWithinWindow: boolean | null) {
  return {
    getSeatActivity: () =>
      isActiveWithinWindow === null
        ? null
        : {
          paneId: "s@rig",
          isActiveWithinWindow,
          silenceWindowSeconds: 3,
          lastObservedAt: "2026-08-11T04:52:00.000Z",
          lastActivityAt: "2026-08-11T04:51:59.000Z",
        },
  } as never;
}

function mkStructural(state: "agent_active" | "agent_idle" | "attention" | "unknown" | null) {
  return {
    getStructuralActivity: () =>
      state
        ? { state, reason: `structural_${state}`, evidence: "pane", observedAt: "2026-08-11T04:52:00.000Z" }
        : null,
  } as never;
}

function hook(state: AgentActivity["state"], reason: string, extra: Partial<AgentActivity> = {}): AgentActivity {
  return {
    state,
    reason,
    evidenceSource: "runtime_hook",
    sampledAt: "2026-08-11T04:30:00.000Z",
    evidence: null,
    ...extra,
  };
}

const store = (activity: AgentActivity | null) => ({ getLatestForNode: () => activity }) as never;

async function activityOf(deps: Record<string, unknown>, runtime = "claude-code"): Promise<AgentActivity> {
  const out = (await attachAgentActivity(entries("s@rig", runtime), deps as never)) as Array<{
    agentActivity: AgentActivity;
  }>;
  return out[0]!.agentActivity;
}

describe("ACTIVITY D1+D2 — motion folded into the ladder", () => {
  it("A1 [D2 precedence] a positive IDLE hook + LIVE motion must NOT report idle — it reports running", async () => {
    const counter = { captures: 0 };
    const activity = await activityOf({
      tmuxAdapter: mkTmux(counter),
      activityStore: store(hook("idle", "stop_hook")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(true),
    });
    // The assertion the defect fails BY NAME: a generating Claude seat reporting idle is a false
    // ASSERTION of quiet, strictly worse than an honest unknown — the parking watch reports all-clear
    // over a working seat.
    expect(activity.state).not.toBe("idle");
    expect(activity.state).toBe("running");
    expect(counter.captures).toBe(0); // cache read, never a per-request capture (healthz-wedge invariant)
  });

  it("A2 [D1 coverage] a hook-less seat whose structural matcher MISSES + LIVE motion reports running", async () => {
    // The Codex shape: no hook at all, and the Claude-shaped structural matcher returns unknown
    // because the tall footer pushed the work line out of the 8-line tail window.
    const activity = await activityOf(
      {
        tmuxAdapter: mkTmux({ captures: 0 }),
        activityStore: store(null),
        structuralActivity: mkStructural("unknown"),
        seatActivity: mkMotion(true),
      },
      "codex",
    );
    // RUNNING exactly — "not unknown" is the indicator, and it passes for a generating Codex seat that
    // reads idle (D2 on Codex). Assert the correctness standard, not its shadow.
    expect(activity.state).toBe("running");
  });

  it("A3 [control] a hook-less MOTIONLESS seat still reports unknown — the fix must not relabel the default", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(false),
    });
    expect(activity.state).toBe("unknown");
  });

  it("A3b [honest absence] no motion observation at all → unknown, never a quiet-seat verdict", async () => {
    const noObs = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(null),
    });
    expect(noObs.state).toBe("unknown");

    // And with the dep entirely absent (older wiring), behavior is unchanged.
    const noDep = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
    });
    expect(noDep.state).toBe("unknown");
  });

  it("A4 [order] needs_input TEXT outranks motion — a seat waiting at a prompt keeps redrawing", async () => {
    // Motion cannot tell "waiting at a prompt" from "working": any per-second redraw keeps the window
    // fresh. So a positive needs_input verdict — from the hook OR from the structural text read — must
    // survive live motion, or the fix converts "answer me" into "busy, leave it alone".
    const fromHook = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("needs_input", "permission_prompt")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(true),
    });
    expect(fromHook.state).toBe("needs_input");

    const fromStructural = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("attention"),
      seatActivity: mkMotion(true),
    });
    expect(fromStructural.state).toBe("needs_input");
  });

  it("A5 [unchanged] a positive RUNNING hook keeps its authority with no motion observation", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("running", "prompt_submit")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(null),
    });
    expect(activity.state).toBe("running");
    expect(activity.evidenceSource).toBe("runtime_hook");
  });

  it("A6 [no fabrication] a MOTIONLESS seat with a positive idle hook still reads idle", async () => {
    // The mirror of A1: motion only ever upgrades. Absent motion, the idle hook stands, so the fix
    // cannot be accused of laundering every idle seat into running.
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("idle", "stop_hook")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(false),
    });
    expect(activity.state).toBe("idle");
  });

  it("A7 [no fabrication] a stale/unknown hook + no motion is still delivered honestly, never idle", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("unknown", "generation_unverifiable", { stale: true })),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(false),
    });
    expect(activity.state).toBe("unknown");
    expect(activity.reason).toBe("generation_unverifiable");
  });

  it("A8 [the live fleet shape] an unverifiable-generation hook + LIVE motion reports running", async () => {
    // Measured live: all 14 seats carry state=unknown reason=generation_unverifiable, so on this fleet
    // the demoted hook — not a positive idle one — is what stands between a generating seat and a
    // truthful label. Motion must beat it, or the fix changes nothing on the machine it ships to.
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("unknown", "generation_unverifiable", { stale: true })),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true),
    });
    expect(activity.state).toBe("running");
  });
});
