import { describe, it, expect } from "vitest";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { AgentActivity } from "../src/domain/types.js";

/**
 * OPR.0.4.3 healthz-wedge amplification fix — proof that attachAgentActivity is
 * CHEAP by default (no per-node tmux capture) and only runs the expensive
 * probeSessionActivity fallback when captureFallback:true is requested
 * (?full/?refresh). The per-node tmux capture under the CLI `rig ps --nodes`
 * fan-out + the graph/nodes polls was the fleet-scale storm; cheap-default
 * removes it from the hot path while the SeatActivityService snapshot serves
 * running/idle and getLatestForNode serves hook activity.
 */

// A capture-counting tmux adapter — capturePaneContent is the expensive call.
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
  return [
    {
      canonicalSessionName: sessionName,
      runtime: "claude-code",
      attachmentType: "tmux",
      logicalId: "dev.impl",
    },
  ] as never;
}

describe("OPR.0.4.3 healthz-wedge — attachAgentActivity cheap default", () => {
  it("cheap default (no captureFallback): a hook-less seat gets an honest unknown/no_runtime_hook placeholder and NO per-node tmux capture", async () => {
    const counter = { captures: 0 };
    const store = { getLatestForNode: () => null } as never; // no runtime hook
    const out = (await attachAgentActivity(entries("dev.impl@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: store,
    })) as Array<{ agentActivity: AgentActivity }>;

    expect(counter.captures).toBe(0); // THE cure: no per-node tmux capture on the hot path
    expect(out[0]!.agentActivity.state).toBe("unknown");
    expect(out[0]!.agentActivity.reason).toBe("no_runtime_hook");
    expect(out[0]!.agentActivity.evidenceSource).toBe("session_registry");
    expect(out[0]!.agentActivity.fallback).toBe(true);
  });

  it("captureFallback:true: a hook-less seat runs the per-node tmux capture (opt-in freshness via ?full/?refresh)", async () => {
    const counter = { captures: 0 };
    const store = { getLatestForNode: () => null } as never;
    await attachAgentActivity(entries("dev.impl@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: store,
      captureFallback: true,
    });
    expect(counter.captures).toBeGreaterThan(0); // full mode DOES capture
  });

  it("hook present: uses the store snapshot in BOTH modes, never captures tmux", async () => {
    const counter = { captures: 0 };
    const hook: AgentActivity = {
      state: "running",
      reason: "hook",
      evidenceSource: "runtime_hook",
      sampledAt: "2026-07-03T00:00:00.000Z",
      evidence: null,
    };
    const store = { getLatestForNode: () => hook } as never;

    const cheap = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: store,
    })) as Array<{ agentActivity: AgentActivity }>;
    const full = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: store,
      captureFallback: true,
    })) as Array<{ agentActivity: AgentActivity }>;

    expect(counter.captures).toBe(0);
    expect(cheap[0]!.agentActivity).toEqual(hook);
    expect(full[0]!.agentActivity).toEqual(hook);
  });
});
