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

/** A request clock, so observation age is a variable the tests control independently of the cache. */
const NOW = new Date("2026-08-11T04:52:00.000Z");

/** The cached MOTION observation, as SeatActivityService exposes it. A cache read, never a capture.
 *  `lastActivityAt` defaults FRESH relative to NOW; the stale-cache tests override it. */
function mkMotion(
  isActiveWithinWindow: boolean | null,
  lastActivityAt: string | null = "2026-08-11T04:51:59.000Z",
) {
  return {
    getSeatActivity: () =>
      isActiveWithinWindow === null
        ? null
        : {
          paneId: "s@rig",
          isActiveWithinWindow,
          silenceWindowSeconds: 3,
          lastObservedAt: "2026-08-11T04:52:00.000Z",
          lastActivityAt,
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
  const out = (await attachAgentActivity(entries("s@rig", runtime), { now: NOW, ...deps } as never)) as Array<{
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

  // ---------------------------------------------------------------------------------------------
  // STALE-CACHE CONTROLS (dev50-guard HOLD on 29ad1b2b9, 2026-08-11T05:12:46Z).
  //
  // `SeatActivityService.pollSeat` returns null on a tmux error BEFORE it replaces or deletes the
  // cached record (seat-activity-service.ts:74), and `pollAllRunningTmuxSeats` only evicts seats that
  // are no longer running in the DB. So a seat still marked running whose tmux read keeps failing
  // KEEPS its last observation indefinitely — including `isActiveWithinWindow: true`.
  //
  // The original fold read that boolean and never aged the raw fact, so a DEAD OBSERVATION became an
  // affirmative liveness claim. That is this atom's own no-fabrication rule broken in the direction
  // nobody was watching: three guards existed against motion inventing IDLE from silence, and none
  // against an unavailable instrument inventing RUNNING.
  //
  // The nine tests above could not catch it because every one of them varies the cached boolean and
  // none varies observation AGE independently of it. These do.
  // ---------------------------------------------------------------------------------------------

  it("A9 [stale cache] isActiveWithinWindow=true with an HOUR-OLD raw fact must NOT upgrade unknown", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("unknown", "generation_unverifiable", { stale: true })),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true, "2026-08-11T03:59:59.000Z"), // 52 minutes before NOW, window is 3s
    });
    expect(activity.state).toBe("unknown");
    expect(activity.reason).not.toBe("window_activity_motion");
  });

  it("A10 [stale cache] the same stale true must NOT overturn a positive idle hook", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("idle", "stop_hook")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(true, "2026-08-11T03:59:59.000Z"),
    });
    expect(activity.state).toBe("idle");
  });

  it("A11 [fail closed] a cached true whose raw fact cannot be AGED must not upgrade anything", async () => {
    // If the observation carries no usable timestamp there is no way to tell live from long-dead, and
    // an un-ageable affirmative is exactly the input that must not become a liveness claim.
    for (const raw of [null, "not-a-timestamp"]) {
      const activity = await activityOf({
        tmuxAdapter: mkTmux({ captures: 0 }),
        activityStore: store(null),
        structuralActivity: mkStructural("unknown"),
        seatActivity: mkMotion(true, raw),
      });
      expect(activity.state).toBe("unknown");
    }
  });

  it("A12 [not over-corrected] a fresh raw fact still upgrades — the fix must not disable motion", async () => {
    // The mirror of A9. A correction that made every motion read stale would pass A9/A10/A11 and
    // silently restore the original defect, so freshness is pinned from BOTH sides.
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("idle", "stop_hook")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(true, "2026-08-11T04:51:59.000Z"), // 1s before NOW
    });
    expect(activity.state).toBe("running");
    expect(activity.reason).toBe("window_activity_motion");
  });

  it("A13 [boundary] freshness is judged against the seat's OWN silence window, both sides of it", async () => {
    // Just INSIDE the 3s window.
    const inside = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true, "2026-08-11T04:51:57.500Z"), // 2.5s old
    });
    expect(inside.state).toBe("running");

    // Just OUTSIDE it.
    const outside = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true, "2026-08-11T04:51:56.500Z"), // 3.5s old
    });
    expect(outside.state).toBe("unknown");
  });

  it("A14 [clock skew] a raw fact slightly AHEAD of the request clock still reads as live", async () => {
    // pollSeat deliberately treats negative age as active (the daemon's clock can lag tmux briefly).
    // Read-time aging must keep that behavior rather than reading the future as stale.
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true, "2026-08-11T04:52:01.000Z"), // 1s in the future
    });
    expect(activity.state).toBe("running");
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
