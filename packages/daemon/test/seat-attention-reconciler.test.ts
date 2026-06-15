// OPR.0.3.4.10 — seat attention reconciler tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("SeatAttentionReconciler", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let activityStore: AgentActivityStore;
  let reconciler: SeatAttentionReconciler;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    activityStore = new AgentActivityStore({ db, eventBus });
    reconciler = new SeatAttentionReconciler({ sessionRegistry, eventBus, agentActivityStore: activityStore });
  });

  afterEach(() => { db.close(); });

  function seedAttentionSeat(rigName: string, sessionName: string): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStartupStatus(session.id, "attention_required");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function emitActivity(rigId: string, nodeId: string, sessionName: string, state: string, opts?: { stale?: boolean; eventAt?: string }) {
    const now = new Date();
    const eventAt = opts?.eventAt ?? (opts?.stale ? new Date(now.getTime() - 10 * 60 * 1000).toISOString() : now.toISOString());
    eventBus.emit({
      type: "agent.activity",
      rigId,
      nodeId,
      sessionName,
      runtime: "claude-code",
      activity: {
        state: state as "running" | "needs_input" | "idle" | "unknown",
        reason: state === "unknown" ? "stale_runtime_hook" : `test-${state}`,
        evidenceSource: "runtime_hook",
        sampledAt: now.toISOString(),
        evidence: null,
        eventAt,
      },
    });
  }

  // AC#1: evidence-gated clear works for fresh running
  it("clears attention on fresh running activity", async () => {
    const { rigId, nodeId } = seedAttentionSeat("r1", "worker@r1");
    emitActivity(rigId, nodeId, "worker@r1", "running");

    const result = await reconciler.clearAttention("worker@r1");

    expect(result.ok).toBe(true);
    expect(result.clearedBy).toBe("evidence");
    expect(result.from).toBe("attention_required");
    expect(result.to).toBe("ready");
    expect(result.evidence?.kind).toBe("fresh_activity");
    expect(result.evidence?.state).toBe("running");
  });

  // AC#1: evidence-gated clear works for fresh idle
  it("clears attention on fresh idle activity", async () => {
    const { rigId, nodeId } = seedAttentionSeat("r2", "worker@r2");
    emitActivity(rigId, nodeId, "worker@r2", "idle");

    const result = await reconciler.clearAttention("worker@r2");

    expect(result.ok).toBe(true);
    expect(result.evidence?.state).toBe("idle");
  });

  // needs_input does NOT clear
  it("does NOT clear on needs_input activity", async () => {
    const { rigId, nodeId } = seedAttentionSeat("r3", "worker@r3");
    emitActivity(rigId, nodeId, "worker@r3", "needs_input");

    const result = await reconciler.clearAttention("worker@r3");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
  });

  // unknown does NOT clear
  it("does NOT clear on unknown activity", async () => {
    const { rigId, nodeId } = seedAttentionSeat("r4", "worker@r4");
    emitActivity(rigId, nodeId, "worker@r4", "unknown");

    const result = await reconciler.clearAttention("worker@r4");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
  });

  // STALE activity does NOT clear (the production-reachable trap)
  it("does NOT clear on stale running activity (stale_runtime_hook)", async () => {
    const { rigId, nodeId } = seedAttentionSeat("r5", "worker@r5");
    emitActivity(rigId, nodeId, "worker@r5", "running", { stale: true });

    const result = await reconciler.clearAttention("worker@r5", undefined);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
  });

  // No activity at all does NOT clear
  it("does NOT clear with no activity", async () => {
    seedAttentionSeat("r6", "worker@r6");

    const result = await reconciler.clearAttention("worker@r6");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
    expect(result.detail).toContain("No recent agent activity");
  });

  // Operator attestation override
  it("clears with --reason (operator attestation, no evidence gate)", async () => {
    seedAttentionSeat("r7", "worker@r7");

    const result = await reconciler.clearAttention("worker@r7", { reason: "founder re-authed" });

    expect(result.ok).toBe(true);
    expect(result.clearedBy).toBe("operator_attestation");
    expect(result.reason).toBe("founder re-authed");
  });

  // Honest no-op: already ready
  it("returns not_in_attention for already-ready seat", async () => {
    const rig = rigRepo.createRig("r8");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, "worker@r8");
    sessionRegistry.updateStartupStatus(session.id, "ready");

    const result = await reconciler.clearAttention("worker@r8");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_in_attention");
  });

  // Audit event emitted with distinct clearedBy
  it("emits seat.attention_cleared event on evidence-gated clear", async () => {
    const { rigId, nodeId } = seedAttentionSeat("r9", "worker@r9");
    emitActivity(rigId, nodeId, "worker@r9", "running");

    await reconciler.clearAttention("worker@r9");

    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.clearedBy).toBe("evidence");
    expect(payload.from).toBe("attention_required");
    expect(payload.to).toBe("ready");
  });

  it("emits seat.attention_cleared event on operator attestation with distinct clearedBy", async () => {
    seedAttentionSeat("r10", "worker@r10");

    await reconciler.clearAttention("worker@r10", { reason: "manual check" });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.clearedBy).toBe("operator_attestation");
    expect(payload.reason).toBe("manual check");
  });

  // No event on no-op
  it("does NOT emit event when not clearing", async () => {
    seedAttentionSeat("r11", "worker@r11");

    await reconciler.clearAttention("worker@r11");

    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared'").all();
    expect(events).toHaveLength(0);
  });
});
