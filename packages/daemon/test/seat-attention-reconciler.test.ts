// OPR.0.3.4.10 — seat attention reconciler tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { decodeTime } from "ulid";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore, hookEventState, latestHookWaitsOnPerson } from "../src/domain/agent-activity-store.js";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { makePromptStateReader } from "../src/domain/queue-wake-ladder.js";
import { evidenceFromHookActivity } from "../src/routes/activity.js";
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

  it.each([
    { newer: "UserPromptSubmit", older: "StopFailure", ok: true },
    { newer: "StopFailure", older: "Stop", ok: false },
  ])("attention clearing uses the newer Claude $newer when $older arrives later", async ({ newer, older, ok }) => {
    const seat = "worker@r-hook-order";
    seedAttentionSeat("r-hook-order", seat);
    const now = Date.now();
    for (const [index, hookEvent] of [newer, older].entries()) {
      expect(activityStore.recordHookEvent({ runtime: "claude-code", sessionName: seat, hookEvent,
        subtype: hookEvent === "StopFailure" ? "rate_limit" : null,
        occurredAt: new Date(now - (index + 1) * 1000).toISOString() }).ok).toBe(true);
    }
    expect(await reconciler.clearAttention(seat)).toMatchObject({ ok, code: ok ? "cleared" : "not_demonstrably_responsive" });
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

  describe("a latest hook that still says the seat waits on a person (a prompt declined or answered with no hook after)", () => {
    function readySeat(name: string, hookEvent: string, ageMs = 600_000): string {
      const rig = rigRepo.createRig(name);
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, `worker@${name}`);
      sessionRegistry.updateStartupStatus(session.id, "ready");
      activityStore.recordHookEvent({ sessionName: `worker@${name}`, runtime: "claude-code", hookEvent,
        occurredAt: new Date(Date.now() - ageMs).toISOString() });
      return `worker@${name}`;
    }

    it("is an attention class: without --reason it says what to do, not 'not in attention'", async () => {
      const seat = readySeat("r-hook-1", "PermissionPromptConfirmed");
      const result = await reconciler.clearAttention(seat);
      expect(result).toMatchObject({ ok: false, code: "not_demonstrably_responsive" });
      expect(result.detail).toContain("PermissionPromptConfirmed");
      expect(result.detail).toContain('rerun with --reason "<what you saw>"');
    });

    it("with --reason it records the prompt cleared, so the hook no longer reads as a waiting person", async () => {
      const seat = readySeat("r-hook-2", "PermissionPromptConfirmed");
      const result = await reconciler.clearAttention(seat, { reason: "declined; composer empty" });
      expect(result).toMatchObject({ ok: true, code: "cleared", clearedBy: "operator_attestation", clearedClasses: ["needs_input_hook"] });
      const latest = activityStore.getLatestForNode({ sessionName: seat });
      expect(latest?.rawEvent).toBe("PermissionPromptCleared");
      expect(latestHookWaitsOnPerson(latest, "claude-code")).toBe(false);
      const cleared = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
      expect(JSON.parse(cleared.payload)).toMatchObject({ from: "needs_input_hook", clearedBy: "operator_attestation", reason: "declined; composer empty" });
    });

    it("a ready seat whose latest hook shows work is still not in attention", async () => {
      const seat = readySeat("r-hook-3", "UserPromptSubmit", 5_000);
      expect(await reconciler.clearAttention(seat, { reason: "nothing to clear" })).toMatchObject({ ok: false, code: "not_in_attention" });
    });

    it.each([
      { newer: "UserPromptSubmit", older: "PermissionPromptConfirmed", code: "not_in_attention" },
      { newer: "PermissionPromptConfirmed", older: "Stop", code: "not_demonstrably_responsive" },
    ])("the hook-only attention class keeps $newer over a delayed older $older", async ({ newer, older, code }) => {
      const seat = readySeat("r-hook-only-order", newer, 1000);
      expect(activityStore.recordHookEvent({ sessionName: seat, runtime: "claude-code", hookEvent: older,
        occurredAt: new Date(Date.now() - 2000).toISOString() }).ok).toBe(true);
      expect(await reconciler.clearAttention(seat)).toMatchObject({ ok: false, code });
    });

    it("also settles the activity service's pending prompt, so the wake ladder and the inventory agree with the clear", async () => {
      const rig = rigRepo.createRig("r-hook-4");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const seat = "worker@r-hook-4";
      sessionRegistry.updateStartupStatus(sessionRegistry.registerSession(node.id, seat).id, "ready");
      let nowMs = Date.now() - 60_000;
      let visible: boolean | null = true;
      const service = new SeatActivityService({
        tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date(nowMs),
        permissionPromptReader: async () => visible,
        // As startup wires it: the poller records what it sees as hooks.
        permissionPromptChanged: (sessionName, confirmed, runtime) => activityStore.recordHookEvent({ sessionName, runtime,
          hookEvent: confirmed ? "PermissionPromptConfirmed" : "PermissionPromptCleared", occurredAt: new Date(nowMs).toISOString() }),
      });
      service.declareRungInventory({ seatNodeId: node.id, sessionName: seat }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
      // Claude's permission-prompt hook, and the poller sees the prompt.
      service.reportEvidence(evidenceFromHookActivity({ seatNodeId: node.id, sessionName: seat, runtime: "claude-code", seq: 1,
        activity: { state: hookEventState("Notification", "permission_prompt", "claude-code"), reason: "permission_prompt",
          rawEvent: "Notification", rawSubtype: "permission_prompt", evidenceSource: "runtime_hook",
          sampledAt: new Date(nowMs).toISOString(), evidence: null } })!);
      await service.pollSeat(seat);
      // Declined: the screen after it isn't one the poller recognizes, so the request stays confirmed.
      visible = null;
      nowMs += 5_000;
      await service.pollSeat(seat);
      expect(service.getSeatState(node.id)!.needsInput.count).toBe(1);
      const refusedAt = new Date(nowMs).toISOString();
      const promptState = makePromptStateReader({ db, getSeatState: id => service.getSeatState(id),
        getLatestHook: sessionName => activityStore.getLatestForNode({ sessionName }) });
      expect(promptState(seat, refusedAt)).toBe("blocked");

      const withService = new SeatAttentionReconciler({ sessionRegistry, eventBus, agentActivityStore: activityStore,
        settlePermissionPrompt: sessionName => service.settlePermissionPrompt(sessionName) });
      expect(await withService.clearAttention(seat, { reason: "declined; composer empty" })).toMatchObject({ ok: true, clearedClasses: ["needs_input_hook"] });
      expect(service.getSeatState(node.id)!.needsInput.count).toBe(0);
      expect(promptState(seat, refusedAt)).toBe("clear");
      // The next poll has no request to re-confirm.
      nowMs += 5_000;
      await service.pollSeat(seat);
      expect(service.getSeatState(node.id)!.needsInput.count).toBe(0);
    });
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
      // The missing-pane observation belongs to this freshly registered occupant.
      observedAt: new Date(Math.max(Date.now(), decodeTime(session.id)) + 1).toISOString(),
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
      // The missing-pane observation belongs to this freshly registered occupant.
      observedAt: new Date(Math.max(Date.now(), decodeTime(session.id)) + 1).toISOString(),
    });
    expect(getNodeInventory(db, rig.id)[0]!.lifecycleState).toBe("attention_required");
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
    // clearAttention re-observes with the wall clock, and the inventory ignores a
    // verdict from the registration's own millisecond (applicableVerdict).
    while (Date.now() <= decodeTime(session.id)) await new Promise((resolve) => setTimeout(resolve, 1));

    const result = await paneReconciler.clearAttention(session.sessionName, { reason: "reattached" });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Uncleared attention class pane_identity");
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%old");
    // Re-observation confirmed the whole session missing, rather than just
    // the registered pane process being gone. Preserve that stronger fact.
    expect(getNodeInventory(db, rig.id)[0]!).toMatchObject({
      lifecycleState: "detached", sessionStatus: "detached",
      storedSessionStatus: "running", identityVerdict: { reason: "session_missing" },
    });
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

  it.each([
    ["a previous restore attempt", "assisted_startup", true, false],
    ["another startup failure", "readiness_check", false, false],
    ["another occupant", "assisted_startup", false, true],
  ] as const)("doesn't acknowledge full-restore attention from %s as this seat's assisted startup", async (_case, stage, oldAttempt, otherOccupant) => {
    const { rigId, nodeId, sessionId } = seedAttentionSeat("assisted-control", "worker@assisted-control");
    sessionRegistry.updateStatus(sessionId, "running");
    db.prepare("UPDATE nodes SET runtime='synth' WHERE id=?").run(nodeId);
    sessionRegistry.recordCommunityHarnessSelection(sessionId, "synth");
    const start = () => eventBus.emit({ type: "restore.started", rigId, snapshotId: "snapshot" });
    if (!oldAttempt) start();
    eventBus.emit({ type: "node.startup_failed", rigId, nodeId,
      sessionId: otherOccupant ? "retired-occupant" : sessionId, stage, error: "Needs attention" });
    if (oldAttempt) start();
    eventBus.emit({ type: "restore.completed", rigId, snapshotId: "snapshot", result: {
      snapshotId: "snapshot", preRestoreSnapshotId: null, rigResult: "partially_restored",
      nodes: [{ nodeId, logicalId: "worker", status: "attention_required" }], warnings: [],
    } });
    const strict = vi.fn(async () => ({ ok: false as const, code: "runtime_unsupported", detail: "Not an assisted startup acknowledgement." }));
    const checked = new SeatAttentionReconciler({ db, sessionRegistry, eventBus, agentActivityStore: activityStore, reconcileRestoreOutcome: strict });
    expect(await checked.clearAttention("worker@assisted-control", { reason: "Checked startup" })).toMatchObject({ ok: false });
    expect(strict).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id=?").get(sessionId)).toEqual({ startup_status: "attention_required" });
    expect(db.prepare("SELECT seq FROM events WHERE type='restore.outcome_reconciled'").all()).toEqual([]);
  });

  it("OPR.0.5.9.14: refuses derived-class clear without strict evidence even with operator attestation", async () => {
    const { rigId, nodeId, sessionId } = seedDerivedAttentionSeat("r-derived-refuse", "worker@r-derived-refuse");
    const before = db.prepare("SELECT payload FROM events WHERE type = 'restore.completed'").all();
    const sendVerify = vi.fn(async () => ({ ok: true }));
    const capture = vi.fn(async (sessionName: string) => ({ ok: true, sessionName, content: "fixture" }));
    const derivedReconciler = new SeatAttentionReconciler({
      sessionRegistry, eventBus, agentActivityStore: activityStore, db, sendVerify, capture,
    });

    const result = await derivedReconciler.clearAttention("worker@r-derived-refuse", { reason: "operator verified" });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_demonstrably_responsive");
    expect(result.detail).toContain("strict restore reconciler is unavailable");
    const refusals = db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_clear_refused'").all() as { payload: string }[];
    expect(refusals).toHaveLength(1);
    expect(JSON.parse(refusals[0]!.payload)).toEqual({
      type: "seat.attention_clear_refused", rigId, nodeId, sessionId,
      sessionName: "worker@r-derived-refuse", attentionClass: "restore_outcome", code: "strict_reconciler_unavailable",
    });
    expect(db.prepare("SELECT payload FROM events WHERE type = 'restore.completed'").all()).toEqual(before);
    expect(db.prepare("SELECT payload FROM events WHERE type = 'seat.attention_cleared'").all()).toHaveLength(0);
    expect(sendVerify).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all();
    expect(events).toHaveLength(0);
  });

  // #116 — clear-attention and the projection fence the same restore outcomes.
  describe("restore outcomes fenced by a ready current-generation fresh launch (#116)", () => {
    function seedRunningSeat(rigName: string, sessionName: string): { rigId: string; nodeId: string } {
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStartupStatus(session.id, "ready");
      sessionRegistry.updateStatus(session.id, "running");
      return { rigId: rig.id, nodeId: node.id };
    }

    function launchFreshOccupant(rigId: string, nodeId: string, sessionName: string, status: "ready" | "attention_required" = "ready") {
      const session = sessionRegistry.registerSession(nodeId, sessionName, "fresh");
      sessionRegistry.updateStartupStatus(session.id, "ready");
      sessionRegistry.updateStatus(session.id, "running");
      eventBus.emit({
        type: "seat.fresh_launched", rigId, nodeId, logicalId: "worker", sessionName, sessionId: session.id,
        supersededSessionIds: [], retiringGeneration: null,
        newGeneration: sessionRegistry.currentOccupantTenure(nodeId)!.generationUuid,
        nativeSessionId: null, model: null, startupPolicyHash: "test", reason: "fresh occupant", operator: null, status,
      });
    }

    function failedRestoreResult(nodeId: string) {
      return { snapshotId: "snap-1", preRestoreSnapshotId: "snap-0", rigResult: "failed", nodes: [{ nodeId, logicalId: "worker", status: "failed" }], warnings: [] };
    }

    function refusingStrictReconciler() {
      const strict = vi.fn(async () => ({ ok: false as const, code: "no_attempt_proof", detail: "test refusal" }));
      const fenced = new SeatAttentionReconciler({
        sessionRegistry, eventBus, agentActivityStore: activityStore, db, reconcileRestoreOutcome: strict as any,
      });
      return { strict, fenced };
    }

    function reconciledEvents() {
      return db.prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'").all() as { payload: string }[];
    }

    it("a ready fresh launch after a failed full restore leaves no restore class to clear", async () => {
      const { rigId, nodeId } = seedDerivedAttentionSeat("r-116-fresh", "worker@r-116-fresh");
      launchFreshOccupant(rigId, nodeId, "worker@r-116-fresh");
      const { strict, fenced } = refusingStrictReconciler();

      const result = await fenced.clearAttention("worker@r-116-fresh", { reason: "operator verified" });

      expect(result).toMatchObject({ ok: false, code: "not_in_attention" });
      expect(strict).not.toHaveBeenCalled();
      expect(reconciledEvents()).toHaveLength(0);
      expect(getNodeInventory(db, rigId)[0]).toMatchObject({ restoreOutcome: "n-a", lifecycleState: "running" });
    });

    it("a fresh launch that needed attention still needs the strict reconciler", async () => {
      const { rigId, nodeId } = seedDerivedAttentionSeat("r-116-unready", "worker@r-116-unready");
      launchFreshOccupant(rigId, nodeId, "worker@r-116-unready", "attention_required");
      const { strict, fenced } = refusingStrictReconciler();

      const result = await fenced.clearAttention("worker@r-116-unready", { reason: "operator verified" });

      expect(result).toMatchObject({ ok: false, code: "not_demonstrably_responsive" });
      expect(strict).toHaveBeenCalledWith(rigId, nodeId);
      expect(reconciledEvents()).toHaveLength(0);
      expect(getNodeInventory(db, rigId)[0]).toMatchObject({ restoreOutcome: "failed", lifecycleState: "attention_required" });
    });

    it("a restore attempt started after the fresh launch still needs the strict reconciler", async () => {
      const { rigId, nodeId } = seedRunningSeat("r-116-new-attempt", "worker@r-116-new-attempt");
      launchFreshOccupant(rigId, nodeId, "worker@r-116-new-attempt");
      eventBus.emit({ type: "restore.started", rigId, snapshotId: "snap-1" });
      eventBus.emit({ type: "restore.completed", rigId, snapshotId: "snap-1", result: failedRestoreResult(nodeId) } as any);
      const { strict, fenced } = refusingStrictReconciler();

      const result = await fenced.clearAttention("worker@r-116-new-attempt");

      expect(result).toMatchObject({ ok: false, code: "not_demonstrably_responsive" });
      expect(strict).toHaveBeenCalledWith(rigId, nodeId);
    });

    it("a full restore completing after the fresh launch, for an attempt started before it, is fenced", async () => {
      const { rigId, nodeId } = seedRunningSeat("r-116-late", "worker@r-116-late");
      eventBus.emit({ type: "restore.started", rigId, snapshotId: "snap-1" });
      launchFreshOccupant(rigId, nodeId, "worker@r-116-late");
      eventBus.emit({ type: "restore.completed", rigId, snapshotId: "snap-1", result: failedRestoreResult(nodeId) } as any);
      const { strict, fenced } = refusingStrictReconciler();

      const result = await fenced.clearAttention("worker@r-116-late");

      expect(result).toMatchObject({ ok: false, code: "not_in_attention" });
      expect(strict).not.toHaveBeenCalled();
      expect(getNodeInventory(db, rigId)[0]).toMatchObject({ restoreOutcome: "n-a", lifecycleState: "running" });
    });

    // A subset restore records no start, so a completion after the fresh launch
    // stays current (unresolved) and keeps the subset path.
    it("a subset completion after the fresh launch keeps the subset path", async () => {
      const { rigId, nodeId } = seedRunningSeat("r-116-subset", "worker@r-116-subset");
      launchFreshOccupant(rigId, nodeId, "worker@r-116-subset");
      eventBus.emit({
        type: "restore.subset_completed", rigId, snapshotId: "snap-subset",
        result: { ...failedRestoreResult(nodeId), snapshotId: "snap-subset", nodes: [{ nodeId, logicalId: "worker", status: "attention_required" }] },
      } as any);
      emitActivity(rigId, nodeId, "worker@r-116-subset", "running");
      const { strict, fenced } = refusingStrictReconciler();

      const result = await fenced.clearAttention("worker@r-116-subset");

      expect(result.ok).toBe(true);
      expect(strict).not.toHaveBeenCalled();
      expect(result.clearedClasses).toContain("restore_outcome");
      expect(JSON.parse(reconciledEvents()[0]!.payload)).toMatchObject({ attemptId: 0, from: "attention_required" });
      // The clear's zero attemptId acknowledges that late subset outcome, as on main.
      expect(getNodeInventory(db, rigId)[0]).toMatchObject({ restoreOutcome: "operator_recovered" });
    });

    it("a zero-ID acknowledgment after a full attempt started after the fresh launch still needs strict proof", async () => {
      const { rigId, nodeId } = seedRunningSeat("r-116-zero-ack", "worker@r-116-zero-ack");
      launchFreshOccupant(rigId, nodeId, "worker@r-116-zero-ack");
      eventBus.emit({ type: "restore.started", rigId, snapshotId: "snap-1" });
      eventBus.emit({ type: "restore.completed", rigId, snapshotId: "snap-1",
        result: { ...failedRestoreResult(nodeId), nodes: [{ nodeId, logicalId: "worker", status: "attention_required" }] } } as any);
      eventBus.emit({ type: "restore.outcome_reconciled", rigId, nodeId, attemptId: 0, from: "attention_required", to: "operator_recovered",
        evidence: { source: "operator_attestation" } });
      const { strict, fenced } = refusingStrictReconciler();

      const result = await fenced.clearAttention("worker@r-116-zero-ack", { reason: "operator verified" });

      expect(result).toMatchObject({ ok: false, code: "not_demonstrably_responsive" });
      expect(strict).toHaveBeenCalledWith(rigId, nodeId);
    });
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
