// 5b82324b — make `rig ps` ACTIVITY mean something. RED-first.
//
// Today attachAgentActivity's cheap default emits unknown/no_runtime_hook for a hook-less seat
// (node-inventory.ts:1100-1107), so a LIVE seat producing pane motion shows ACTIVITY=unknown while
// the control plane says nothing — the founder stall (8 seats at empty prompts, nothing surfaced).
//
// The fix lifts STRUCTURAL capture-marker discrimination into the ACTIVITY signal via a CACHED
// structural observation (populated by a background 1Hz service, so the request path stays CAPTURE-FREE
// — the healthz-wedge storm fix is preserved). attachAgentActivity gains a `structuralActivity` dep it
// READS (never captures). Precedence: a fresh POSITIVE hook wins; else the cached structural verdict
// (agent_active→running / agent_idle→idle / attention→needs_input, evidenceSource pane_heuristic);
// else the honest unknown/no_runtime_hook. Structural OVERRIDES an absent OR stale/unknown hook —
// liveness beats hook-arrival age (constraint 2). NEVER a verb allowlist (structural markers catch a
// "Drizzling"-style spinner that an allowlist misses).

import { describe, it, expect } from "vitest";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
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

function entries(sessionName: string) {
  return [{ canonicalSessionName: sessionName, runtime: "claude-code", attachmentType: "tmux", logicalId: "dev.impl" }] as never;
}

// A cached structural observation reader (what the background service exposes). Reading it does NOT
// capture tmux — the capture already happened on the service cadence.
function mkStructural(
  state: "agent_active" | "agent_idle" | "attention" | "unknown" | null,
  observedAt = "2026-08-10T20:00:00.000Z",
) {
  return {
    getStructuralActivity: () =>
      state ? { state, reason: `structural_${state}`, evidence: "pane", observedAt } : null,
  } as never;
}

const staleHook: AgentActivity = {
  state: "unknown",
  reason: "stale_runtime_hook",
  evidenceSource: "runtime_hook",
  sampledAt: "2026-08-10T12:00:00.000Z",
  evidence: null,
  stale: true,
};

describe("5b — structural ACTIVITY signal (lifted into the default derivation, capture-free)", () => {
  it("hook-less + cached structural agent_active → ACTIVITY running, NO capture (cache read, not probe)", async () => {
    const counter = { captures: 0 };
    const out = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: { getLatestForNode: () => null } as never,
      structuralActivity: mkStructural("agent_active"),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(counter.captures).toBe(0); // storm-free: the structural read is a CACHE read
    expect(out[0]!.agentActivity.state).toBe("running");
    expect(out[0]!.agentActivity.evidenceSource).toBe("pane_heuristic");
  });

  it("hook-less + cached structural agent_idle → idle; attention → needs_input", async () => {
    const idle = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: { getLatestForNode: () => null } as never,
      structuralActivity: mkStructural("agent_idle"),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(idle[0]!.agentActivity.state).toBe("idle");
    const attn = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: { getLatestForNode: () => null } as never,
      structuralActivity: mkStructural("attention"),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(attn[0]!.agentActivity.state).toBe("needs_input");
  });

  it("STALE hook + fresh structural agent_active → running (liveness beats hook-arrival age; constraint 2)", async () => {
    const out = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: { getLatestForNode: () => staleHook } as never,
      structuralActivity: mkStructural("agent_active"),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(out[0]!.agentActivity.state).toBe("running");
    expect(out[0]!.agentActivity.evidenceSource).toBe("pane_heuristic");
  });

  it("a fresh POSITIVE hook wins over structural (hook precedence preserved)", async () => {
    const hook: AgentActivity = { state: "running", reason: "hook", evidenceSource: "runtime_hook", sampledAt: "2026-08-10T20:00:00.000Z", evidence: null };
    const out = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: { getLatestForNode: () => hook } as never,
      structuralActivity: mkStructural("agent_idle"), // disagrees; hook must win
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(out[0]!.agentActivity.state).toBe("running");
    expect(out[0]!.agentActivity.evidenceSource).toBe("runtime_hook");
  });

  it("NO structural cache (empty) → honest unknown/no_runtime_hook preserved, still NO capture (healthz-wedge default)", async () => {
    const counter = { captures: 0 };
    const out = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: { getLatestForNode: () => null } as never,
      structuralActivity: mkStructural(null),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(counter.captures).toBe(0);
    expect(out[0]!.agentActivity.state).toBe("unknown");
    expect(out[0]!.agentActivity.reason).toBe("no_runtime_hook");
  });

  it("MF1 fold-fallback: once the REAL service invalidates the obs (capture outage), attachAgentActivity falls back to the honest stale hook — no false-live", async () => {
    let content: string | null = "⠋ Working… esc to interrupt";
    const svc = new SeatStructuralActivityService({ capturePaneContent: async () => content } as never);
    await svc.pollSeat("s@rig"); // agent_active cached
    const call = async () =>
      (await attachAgentActivity(entries("s@rig"), {
        tmuxAdapter: mkTmux({ captures: 0 }),
        activityStore: { getLatestForNode: () => staleHook } as never,
        structuralActivity: svc,
      } as never)) as Array<{ agentActivity: AgentActivity }>;
    const before = await call();
    expect(before[0]!.agentActivity.state).toBe("running"); // structural overrides the stale hook
    content = null; // capture outage
    await svc.pollSeat("s@rig"); // invalidates the row
    const after = await call();
    expect(after[0]!.agentActivity.state).toBe("unknown"); // fell back to the honest stale hook
    expect(after[0]!.agentActivity.reason).toBe("stale_runtime_hook");
  });
});
