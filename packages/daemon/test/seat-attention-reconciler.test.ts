// OPR.0.3.4.10 — seat attention reconciler tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
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

  it("rebinds a healthy replacement pane and clears the pane-identity attention class", async () => {
    const rig = rigRepo.createRig("r-pane-rebind");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@r-pane-rebind");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%old" });
    new SeatIdentityStore(db).upsert({
      nodeId: node.id,
      verdict: "pane_missing",
      evidenceSource: "pane_process",
      reason: "pane_pid_gone",
      evidence: { registeredPane: "%old", observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: session.sessionName,
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(getNodeInventory(db, rig.id)[0]!.lifecycleState).toBe("attention_required");

    const paneReconciler = new SeatAttentionReconciler({
      sessionRegistry,
      eventBus,
      agentActivityStore: activityStore,
      db,
      tmux: {
        listPanes: vi.fn(async () => [{ id: "%new", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
        getPanePid: vi.fn(async () => 4321),
        getPaneCommand: vi.fn(async () => "claude"),
      },
    });
    const result = await paneReconciler.clearAttention(session.sessionName, { reason: "reattached" });

    expect(result.ok).toBe(true);
    expect(result.clearedClasses).toEqual(["pane_identity"]);
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%new");
    expect(new SeatIdentityStore(db).getForNode(node.id)?.verdict).toBe("verified");
    expect(getNodeInventory(db, rig.id)[0]!.lifecycleState).toBe("running");
  });

  it("names pane_identity when the replacement terminal cannot be resolved exactly", async () => {
    const rig = rigRepo.createRig("r-pane-ambiguous");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@r-pane-ambiguous");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%old" });
    new SeatIdentityStore(db).upsert({
      nodeId: node.id,
      verdict: "pane_missing",
      evidenceSource: "pane_process",
      reason: "pane_pid_gone",
      evidence: { registeredPane: "%old", observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: session.sessionName,
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    const paneReconciler = new SeatAttentionReconciler({
      sessionRegistry,
      eventBus,
      agentActivityStore: activityStore,
      db,
      tmux: {
        listPanes: vi.fn(async () => []),
        getPanePid: vi.fn(async () => null),
        getPaneCommand: vi.fn(async () => null),
      },
    });

    const result = await paneReconciler.clearAttention(session.sessionName, { reason: "reattached" });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Uncleared attention class pane_identity");
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%old");
    expect(getNodeInventory(db, rig.id)[0]!.lifecycleState).toBe("attention_required");
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

  // Send-verify evidence branch
  it("clears on positive send-verify (outcome:delivered) when no fresh activity", async () => {
    const { rigId, nodeId, sessionId } = seedAttentionSeat("r-send", "worker@r-send");
    const sendVerify = vi.fn(async () => ({ ok: true, outcome: "delivered" as const, verified: true }));
    const sendReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify,
    });

    const result = await sendReconciler.clearAttention("worker@r-send");

    expect(result.ok).toBe(true);
    expect(result.clearedBy).toBe("evidence");
    expect(result.evidence?.kind).toBe("send_verify_roundtrip");
    expect(sendVerify).toHaveBeenCalledWith("worker@r-send", expect.stringContaining("liveness probe"), { verify: true });
  });

  it("does NOT clear on send-verify rendered-unconfirmed (without capture confirmation)", async () => {
    seedAttentionSeat("r-unconf", "worker@r-unconf");
    const sendVerify = vi.fn(async () => ({ ok: true, outcome: "rendered-unconfirmed" as const, verified: false }));
    const sendReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify,
    });

    const result = await sendReconciler.clearAttention("worker@r-unconf");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
  });

  it("does NOT clear on send-verify failure", async () => {
    seedAttentionSeat("r-fail", "worker@r-fail");
    const sendVerify = vi.fn(async () => ({ ok: false, outcome: "failed" as const }));
    const sendReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify,
    });

    const result = await sendReconciler.clearAttention("worker@r-fail");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
  });

  it("send-verify audit event has distinct evidence kind", async () => {
    seedAttentionSeat("r-audit-send", "worker@r-audit-send");
    const sendVerify = vi.fn(async () => ({ ok: true, outcome: "delivered" as const, verified: true }));
    const sendReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify,
    });

    await sendReconciler.clearAttention("worker@r-audit-send");

    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.clearedBy).toBe("evidence");
    expect(payload.evidence.kind).toBe("send_verify_roundtrip");
  });

  // Capture-confirmed branch: rendered-unconfirmed + capture confirms exact probe text → clears
  it("clears on rendered-unconfirmed when capture confirms exact probe text", async () => {
    seedAttentionSeat("r-cap-ok", "worker@r-cap-ok");
    let sentProbe = "";
    const sendVerify = vi.fn(async (_session: string, text: string) => {
      sentProbe = text;
      return { ok: true, outcome: "rendered-unconfirmed" as const, verified: false };
    });
    const capture = vi.fn(async (session: string) => ({
      ok: true, sessionName: session, content: `some pane output\n${sentProbe}\nmore output`,
    }));
    const capReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify, capture,
    });

    const result = await capReconciler.clearAttention("worker@r-cap-ok");

    expect(result.ok).toBe(true);
    expect(result.clearedBy).toBe("evidence");
    expect(result.evidence?.kind).toBe("send_verify_capture_confirmed");
    expect(capture).toHaveBeenCalledWith("worker@r-cap-ok", expect.objectContaining({ lines: expect.any(Number) }));
  });

  // Capture-confirmed branch: rendered-unconfirmed + capture does NOT contain probe text → does not clear
  it("does NOT clear on rendered-unconfirmed when capture lacks probe text", async () => {
    seedAttentionSeat("r-cap-miss", "worker@r-cap-miss");
    const sendVerify = vi.fn(async () => ({ ok: true, outcome: "rendered-unconfirmed" as const, verified: false }));
    const capture = vi.fn(async (session: string) => ({
      ok: true, sessionName: session, content: "some unrelated pane output\nno probe here",
    }));
    const capReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify, capture,
    });

    const result = await capReconciler.clearAttention("worker@r-cap-miss");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
  });

  // Capture-confirmed branch: rendered-unconfirmed + capture fails → does not clear
  it("does NOT clear on rendered-unconfirmed when capture fails", async () => {
    seedAttentionSeat("r-cap-fail", "worker@r-cap-fail");
    const sendVerify = vi.fn(async () => ({ ok: true, outcome: "rendered-unconfirmed" as const, verified: false }));
    const capture = vi.fn(async (session: string) => ({
      ok: false, sessionName: session, error: "capture_failed",
    }));
    const capReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify, capture,
    });

    const result = await capReconciler.clearAttention("worker@r-cap-fail");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
  });

  // Discriminator: stale probe in capture from a prior attempt does NOT clear
  it("does NOT clear when capture contains a stale probe from a prior attempt", async () => {
    seedAttentionSeat("r-cap-stale", "worker@r-cap-stale");
    const sendVerify = vi.fn(async () => ({ ok: true, outcome: "rendered-unconfirmed" as const, verified: false }));
    const capture = vi.fn(async (session: string) => ({
      ok: true, sessionName: session, content: "# OpenRig attention-clear liveness probe 1111111111\nold scrollback",
    }));
    const capReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify, capture,
    });

    const result = await capReconciler.clearAttention("worker@r-cap-stale");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared'").all();
    expect(events).toHaveLength(0);
  });

  // Capture-confirmed audit event has distinct evidence kind
  it("capture-confirmed audit event has kind send_verify_capture_confirmed", async () => {
    seedAttentionSeat("r-cap-audit", "worker@r-cap-audit");
    let sentProbe = "";
    const sendVerify = vi.fn(async (_session: string, text: string) => {
      sentProbe = text;
      return { ok: true, outcome: "rendered-unconfirmed" as const, verified: false };
    });
    const capture = vi.fn(async (session: string) => ({
      ok: true, sessionName: session, content: `${sentProbe}\noutput`,
    }));
    const capReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, sendVerify, capture,
    });

    await capReconciler.clearAttention("worker@r-cap-audit");

    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.clearedBy).toBe("evidence");
    expect(payload.evidence.kind).toBe("send_verify_capture_confirmed");
  });

  // No event on no-op
  it("does NOT emit event when not clearing", async () => {
    seedAttentionSeat("r11", "worker@r11");

    await reconciler.clearAttention("worker@r11");

    const events = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared'").all();
    expect(events).toHaveLength(0);
  });

  // OPR.0.4.0.16 — derived-class tests
  function seedDerivedAttentionSeat(rigName: string, sessionName: string): { rigId: string; nodeId: string; sessionId: string; attemptId: number } {
    const rig = rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStartupStatus(session.id, "ready");
    sessionRegistry.updateStatus(session.id, "running");
    const started = eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-1" });
    // Seed a failed restore outcome
    eventBus.emit({
      type: "restore.completed",
      rigId: rig.id,
      snapshotId: "snap-1",
      result: { snapshotId: "snap-1", preRestoreSnapshotId: "snap-0", rigResult: "failed", nodes: [{ nodeId: node.id, logicalId: "worker", status: "failed" }], warnings: [] },
    } as any);
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id, attemptId: started.seq };
  }

  function strictDerivedReconciler() {
    return new SeatAttentionReconciler({
      sessionRegistry,
      eventBus,
      agentActivityStore: activityStore,
      db,
      reconcileRestoreOutcome: async (rigId, nodeId) => {
        const started = db.prepare(
          "SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.started' ORDER BY seq DESC LIMIT 1",
        ).get(rigId) as { seq: number };
        const completed = db.prepare(
          "SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.completed' AND seq > ? ORDER BY seq DESC LIMIT 1",
        ).get(rigId, started.seq) as { payload: string };
        const node = (JSON.parse(completed.payload) as { result: { nodes: Array<{ nodeId: string; status: "failed" | "attention_required" }> } })
          .result.nodes.find((entry) => entry.nodeId === nodeId)!;
        const evidence = { tmux: true, fgProcess: "claude", resumeTokenUsed: true, paneState: "usable" as const };
        eventBus.emit({
          type: "restore.outcome_reconciled",
          rigId,
          nodeId,
          attemptId: started.seq,
          from: node.status,
          to: "operator_recovered",
          evidence,
        });
        return { ok: true as const, attemptId: started.seq, from: node.status, to: "operator_recovered" as const, evidence };
      },
    });
  }

  it("OPR.0.5.9.14: scopes a derived clear to the real restore attempt", async () => {
    const { rigId, nodeId, attemptId } = seedDerivedAttentionSeat("r-attempt-scoped", "worker@r-attempt-scoped");
    emitActivity(rigId, nodeId, "worker@r-attempt-scoped", "running");
    const derivedReconciler = strictDerivedReconciler();

    const result = await derivedReconciler.clearAttention("worker@r-attempt-scoped");

    expect(result.ok).toBe(true);
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).attemptId).toBe(attemptId);
  });

  it("OPR.0.5.9.14: preserves generic reconciliation for a subset restore with no attempt receipt", async () => {
    const rig = rigRepo.createRig("r-subset-derived");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@r-subset-derived");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    sessionRegistry.updateStatus(session.id, "running");
    eventBus.emit({
      type: "restore.subset_completed",
      rigId: rig.id,
      snapshotId: "snap-subset",
      result: {
        snapshotId: "snap-subset",
        preRestoreSnapshotId: null,
        rigResult: "partially_restored",
        nodes: [{ nodeId: node.id, logicalId: "worker", status: "attention_required" }],
        warnings: [],
      },
    } as any);
    emitActivity(rig.id, node.id, "worker@r-subset-derived", "running");
    const strict = vi.fn();
    const subsetReconciler = new SeatAttentionReconciler({
      sessionRegistry,
      eventBus,
      agentActivityStore: activityStore,
      db,
      reconcileRestoreOutcome: strict,
    });

    const result = await subsetReconciler.clearAttention("worker@r-subset-derived");

    expect(result.ok).toBe(true);
    expect(strict).not.toHaveBeenCalled();
    expect(result.clearedClasses).toContain("restore_outcome");
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ attemptId: 0, from: "attention_required" });

    const repeated = await subsetReconciler.clearAttention("worker@r-subset-derived");
    expect(repeated).toMatchObject({ ok: false, code: "not_in_attention" });
    expect(db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all()).toHaveLength(1);
  });

  it("OPR.0.4.0.16: clears derived-only class (startupStatus=ready + restoreOutcome=failed+running)", async () => {
    const { rigId, nodeId } = seedDerivedAttentionSeat("r-derived", "worker@r-derived");
    emitActivity(rigId, nodeId, "worker@r-derived", "running");
    const derivedReconciler = strictDerivedReconciler();

    const result = await derivedReconciler.clearAttention("worker@r-derived");

    expect(result.ok).toBe(true);
    expect(result.clearedClasses).toContain("restore_outcome");
    expect(result.clearedClasses).not.toContain("startup_status");

    const reconcileEvents = db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all() as { payload: string }[];
    expect(reconcileEvents).toHaveLength(1);
    const payload = JSON.parse(reconcileEvents[0]!.payload);
    expect(payload.to).toBe("operator_recovered");
    expect(payload.from).toBe("failed");
    expect(payload.nodeId).toBe(nodeId);
  });

  it("OPR.0.5.9.14: refuses derived-class clear without strict evidence even with operator attestation", async () => {
    seedDerivedAttentionSeat("r-derived-refuse", "worker@r-derived-refuse");
    const derivedReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, db,
    });

    const result = await derivedReconciler.clearAttention("worker@r-derived-refuse", { reason: "operator verified" });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all();
    expect(events).toHaveLength(0);
  });

  it("OPR.0.4.0.16: clears both classes when startupStatus + restoreOutcome both in attention", async () => {
    const rig = rigRepo.createRig("r-both");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@r-both");
    sessionRegistry.updateStartupStatus(session.id, "attention_required");
    sessionRegistry.updateStatus(session.id, "running");
    eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-1" });
    eventBus.emit({
      type: "restore.completed",
      rigId: rig.id, snapshotId: "snap-1",
      result: { snapshotId: "snap-1", preRestoreSnapshotId: "snap-0", rigResult: "failed", nodes: [{ nodeId: node.id, logicalId: "worker", status: "failed" }], warnings: [] },
    } as any);
    emitActivity(rig.id, node.id, "worker@r-both", "running");
    const bothReconciler = strictDerivedReconciler();

    const result = await bothReconciler.clearAttention("worker@r-both");

    expect(result.ok).toBe(true);
    expect(result.clearedClasses).toContain("startup_status");
    expect(result.clearedClasses).toContain("restore_outcome");
  });

  it("OPR.0.5.9.14: operator attestation cannot bypass strict restore lineage", async () => {
    const { attemptId } = seedDerivedAttentionSeat("r-derived-attest", "worker@r-derived-attest");
    const derivedReconciler = strictDerivedReconciler();

    const result = await derivedReconciler.clearAttention("worker@r-derived-attest", { reason: "operator verified" });

    expect(result.ok).toBe(true);
    expect(result.clearedBy).toBe("evidence");
    expect(result.clearedClasses).toContain("restore_outcome");
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.from).toBe("failed");
    expect(payload.attemptId).toBe(attemptId);
    expect(payload.evidence.resumeTokenUsed).toBe(true);
  });

  it("OPR.0.5.9.14: clearAttention returns the strict attempt evidence on its JSON surface", async () => {
    const { rigId, nodeId, attemptId } = seedDerivedAttentionSeat("r-derived-surface", "worker@r-derived-surface");
    emitActivity(rigId, nodeId, "worker@r-derived-surface", "running");
    const surfaceReconciler = strictDerivedReconciler();

    const result = await surfaceReconciler.clearAttention("worker@r-derived-surface");

    expect(result.ok).toBe(true);
    expect(result.clearedClasses).toContain("restore_outcome");
    expect(result.derivedEvidence).toBeDefined();
    expect(result.derivedEvidence).toMatchObject({
      source: "restore_runtime_truth",
      attemptId,
      tmux: true,
      fgProcess: "claude",
      resumeTokenUsed: true,
      paneState: "usable",
    });
    expect(result.derivedEvidence!.runtimeCwdVerified).toBeUndefined();
  });

  it("OPR.0.5.9.14: operator attestation still returns strict attempt evidence", async () => {
    const { attemptId } = seedDerivedAttentionSeat("r-derived-attest-surface", "worker@r-derived-attest-surface");
    const surfaceReconciler = strictDerivedReconciler();

    const result = await surfaceReconciler.clearAttention("worker@r-derived-attest-surface", { reason: "verified manually" });

    expect(result.ok).toBe(true);
    expect(result.clearedBy).toBe("evidence");
    expect(result.derivedEvidence).toMatchObject({ source: "restore_runtime_truth", attemptId });
  });

  it("OPR.0.5.9.14: refuses a non-running derived outcome when strict live lineage is absent", async () => {
    const rig = rigRepo.createRig("r-nonrun-attn");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@r-nonrun-attn");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    // Session is exited, not running
    sessionRegistry.updateStatus(session.id, "exited");
    // Seed restoreOutcome=attention_required
    eventBus.emit({
      type: "restore.completed",
      rigId: rig.id, snapshotId: "snap-1",
      result: { snapshotId: "snap-1", preRestoreSnapshotId: "snap-0", rigResult: "failed",
        nodes: [{ nodeId: node.id, logicalId: "worker", status: "attention_required" }], warnings: [] },
    } as any);
    const nonrunReconciler = new SeatAttentionReconciler({
      sessionRegistry,
      eventBus,
      agentActivityStore: activityStore,
      db,
      reconcileRestoreOutcome: async () => ({
        ok: false,
        code: "tmux_session_missing",
        detail: "Tmux session is not currently alive.",
      }),
    });

    const result = await nonrunReconciler.clearAttention("worker@r-nonrun-attn", { reason: "manually verified" });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("tmux_session_missing");
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all() as { payload: string }[];
    expect(events).toHaveLength(0);
  });

  // REV1 REGRESSION: non-running restoreOutcome=failed does NOT trigger derived class
  it("OPR.0.4.0.16: non-running restoreOutcome=failed does NOT clear derived class (mirrors deriveNodeLifecycleState)", async () => {
    const rig = rigRepo.createRig("r-nonrun-failed");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@r-nonrun-failed");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    sessionRegistry.updateStatus(session.id, "exited");
    eventBus.emit({
      type: "restore.completed",
      rigId: rig.id, snapshotId: "snap-1",
      result: { snapshotId: "snap-1", preRestoreSnapshotId: "snap-0", rigResult: "failed",
        nodes: [{ nodeId: node.id, logicalId: "worker", status: "failed" }], warnings: [] },
    } as any);
    const nonrunReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, db,
    });

    const result = await nonrunReconciler.clearAttention("worker@r-nonrun-failed", { reason: "test" });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_in_attention");
  });
});
