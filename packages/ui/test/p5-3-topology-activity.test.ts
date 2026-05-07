import { describe, expect, it } from "vitest";
import {
  HOT_POTATO_CROSS_RIG_DURATION_MS,
  HOT_POTATO_TRAIL_TTL_MS,
  HOT_POTATO_WITHIN_RIG_DURATION_MS,
  TOPOLOGY_NODE_ACTIVITY_TTL_MS,
  TOPOLOGY_RIG_ACTIVITY_TTL_MS,
  buildTopologySessionIndex,
  computeActivityVisual,
  getBaselineActivityState,
  makeHotPotatoPacket,
  parseTopologyActivityEvent,
  resolveTopologySession,
} from "../src/lib/topology-activity.js";

describe("P5.3 topology activity parser and resolver", () => {
  const index = buildTopologySessionIndex([
    {
      nodeId: "rig-a::orch.lead",
      rigId: "rig-a",
      rigName: "openrig-a",
      logicalId: "orch.lead",
      canonicalSessionName: "orch.lead@openrig-a",
    },
    {
      nodeId: "rig-b::dev.driver",
      rigId: "rig-b",
      rigName: "openrig-b",
      logicalId: "dev.driver",
      canonicalSessionName: "dev.driver@openrig-b",
    },
  ]);

  it("resolves canonical sessions, logicalId@rigName, and prefixed node ids", () => {
    expect(resolveTopologySession(index, "orch.lead@openrig-a")?.nodeId).toBe("rig-a::orch.lead");
    expect(resolveTopologySession(index, "dev.driver@openrig-b")?.nodeId).toBe("rig-b::dev.driver");
    expect(resolveTopologySession(index, "rig-a::orch.lead")?.nodeId).toBe("rig-a::orch.lead");
    expect(resolveTopologySession(index, "missing@openrig-a")).toBeNull();
  });

  it("queue created and handed-off events create directional packets", () => {
    expect(parseTopologyActivityEvent({
      type: "queue.created",
      qitemId: "q1",
      sourceSession: "orch.lead@openrig-a",
      destinationSession: "dev.driver@openrig-b",
    })?.packet).toEqual({
      sourceSession: "orch.lead@openrig-a",
      targetSession: "dev.driver@openrig-b",
    });
    expect(parseTopologyActivityEvent({
      type: "queue.handed_off",
      qitemId: "q2",
      fromSession: "dev.driver@openrig-b",
      toSession: "orch.lead@openrig-a",
    })?.packet).toEqual({
      sourceSession: "dev.driver@openrig-b",
      targetSession: "orch.lead@openrig-a",
    });
  });

  it("claimed flashes destination only while update packets require a closure target", () => {
    const claimed = parseTopologyActivityEvent({
      type: "queue.claimed",
      qitemId: "q1",
      destinationSession: "dev.driver@openrig-b",
    });
    expect(claimed?.packet).toBeUndefined();
    expect(claimed?.sessions[0]).toEqual({
      session: "dev.driver@openrig-b",
      state: "active",
      flash: "target",
    });

    const updated = parseTopologyActivityEvent({
      type: "queue.updated",
      qitemId: "q2",
      actorSession: "orch.lead@openrig-a",
      toState: "done",
      closureTarget: "dev.driver@openrig-b",
    });
    expect(updated?.packet).toEqual({
      sourceSession: "orch.lead@openrig-a",
      targetSession: "dev.driver@openrig-b",
    });
  });

  it("classifies baseline activity without using StatusPip semantics", () => {
    expect(getBaselineActivityState({
      agentActivity: { state: "running", reason: "x", evidenceSource: "test", sampledAt: "now" },
    })).toBe("active");
    expect(getBaselineActivityState({
      agentActivity: { state: "needs_input", reason: "x", evidenceSource: "test", sampledAt: "now" },
    })).toBe("needs_input");
    expect(getBaselineActivityState({ currentQitems: [{ qitemId: "q", bodyExcerpt: "work", tier: null }] })).toBe("active");
    expect(getBaselineActivityState({ startupStatus: "failed" })).toBe("blocked");
    expect(getBaselineActivityState({
      agentActivity: { state: "idle", reason: "x", evidenceSource: "test", sampledAt: "now" },
    })).toBe("idle");
  });

  it("expires event-driven activity after the shared TTL", () => {
    const nowMs = 10_000;
    expect(computeActivityVisual({
      baseline: null,
      recent: { state: "active", lastActiveAt: nowMs - 1_000 },
      nowMs,
    }).state).toBe("active");
    expect(computeActivityVisual({
      baseline: null,
      recent: { state: "active", lastActiveAt: nowMs - TOPOLOGY_NODE_ACTIVITY_TTL_MS - 1 },
      nowMs,
    }).state).toBe("idle");
  });

  it("uses shared constants for packet duration and retention", () => {
    const source = resolveTopologySession(index, "orch.lead@openrig-a")!;
    const target = resolveTopologySession(index, "dev.driver@openrig-b")!;
    const crossRig = makeHotPotatoPacket({
      eventType: "queue.created",
      sourceSession: source,
      targetSession: target,
      createdAt: 1,
      sequence: 1,
    });
    expect(crossRig.crossRig).toBe(true);
    expect(crossRig.durationMs).toBe(HOT_POTATO_CROSS_RIG_DURATION_MS);
    expect(HOT_POTATO_WITHIN_RIG_DURATION_MS).toBeGreaterThanOrEqual(900);
    expect(HOT_POTATO_WITHIN_RIG_DURATION_MS).toBeLessThanOrEqual(1_300);
    expect(HOT_POTATO_CROSS_RIG_DURATION_MS).toBeGreaterThanOrEqual(1_400);
    expect(HOT_POTATO_CROSS_RIG_DURATION_MS).toBeLessThanOrEqual(1_800);
    expect(HOT_POTATO_TRAIL_TTL_MS).toBeGreaterThanOrEqual(2_000);
    expect(HOT_POTATO_TRAIL_TTL_MS).toBeLessThanOrEqual(4_000);
    expect(TOPOLOGY_RIG_ACTIVITY_TTL_MS).toBeGreaterThanOrEqual(3_000);
    expect(TOPOLOGY_RIG_ACTIVITY_TTL_MS).toBeLessThanOrEqual(5_000);
  });
});
