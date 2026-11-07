import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityRoutes } from "../src/routes/activity.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { attachAgentActivity, attachTerminalActivityAndWork, getNodeInventory } from "../src/domain/node-inventory.js";
import { WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { createDaemon } from "../src/startup.js";
import { createFullTestDb } from "./helpers/test-app.js";

const require = createRequire(import.meta.url);
const { buildOpenRigPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (native: Record<string, unknown>, env: Record<string, string>, now: () => Date) => Record<string, unknown>;
};
const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(visible: boolean | null = false) {
  const db = createFullTestDb();
  databases.push(db);
  const repo = new RigRepository(db);
  const rig = repo.createRig("batch-permission");
  const node = repo.addNode(rig.id, "worker", { runtime: "claude-code" });
  const registry = new SessionRegistry(db);
  const sessionName = "worker@batch-permission";
  const session = registry.registerSession(node.id, sessionName);
  registry.updateStatus(session.id, "running");
  registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName });
  const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
  let nowMs = Date.parse("2026-10-28T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now,
    resolveOccupantGeneration: id => registry.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, value) => registry.isOccupantGenerationRegistered(id, value),
  });
  const reader = vi.fn(async (): Promise<boolean | null> => visible);
  const changed = vi.fn((name: string, confirmed: boolean, runtime: string) => {
    const latest = store.getLatestForNode({ sessionName: name });
    store.recordHookEvent({ sessionName: name, runtime, generation: latest?.generation,
      hookEvent: confirmed ? "PermissionPromptConfirmed" : "PermissionPromptCleared" });
  });
  const service = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3, now, permissionPromptReader: reader, permissionPromptChanged: changed });
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.set("agentActivityStore" as never, store as never);
    context.set("activityHookToken" as never, "batch-test-token" as never);
    context.set("seatActivityService" as never, service as never);
    context.set("sessionRegistry" as never, registry as never);
    await next();
  });
  app.route("/activity", activityRoutes);
  const hook = async (event: string, native: Record<string, unknown> = {}, wire: Record<string, unknown> = {}) => {
    nowMs += 10;
    const payload = buildOpenRigPayload({ hook_event_name: event, session_id: "native-session", permission_mode: "auto",
      ...(event === "Notification" ? { notification_type: "permission_prompt" } : {}), ...native }, {
      OPENRIG_SESSION_NAME: sessionName, OPENRIG_NODE_ID: node.id,
      OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation,
    }, now);
    const response = await app.request("/activity/hooks", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer batch-test-token" },
      body: JSON.stringify({ ...payload, ...wire }),
    });
    expect(response.status).toBe(200);
    return payload;
  };
  return { app, db, node, registry, session, sessionName, generation, store, service, reader, changed, hook, now,
    advance: (delta: number) => { nowMs += delta; },
    count: () => service.getSeatState(node.id)!.needsInput.count,
    latest: () => {
      // sampledAt is the read's clock; the retained source event and its meaning must stay unchanged.
      const { sampledAt: _, ...activity } = store.getLatestForNode({ nodeId: node.id, sessionName })!;
      return activity;
    },
  };
}

describe("Claude tool-batch completion resolves its permission notification", () => {
  it.each([false, null])("clears an unseen permission after the batch finishes, with capture=%s", async visible => {
    const subject = fixture(visible);
    await subject.hook("UserPromptSubmit");
    await subject.hook("Notification");
    await subject.service.pollSeat(subject.sessionName);
    expect(subject.count()).toBe(1);
    await subject.hook("PostToolBatch", { tool_calls: [{ tool_name: "Bash", tool_use_id: "tool-1", tool_response: "finished" }] });
    expect(subject.count()).toBe(0);
    expect(subject.service.getSeatState(subject.node.id)).toMatchObject({ activity: "working",
      needsInputEvidence: { rung: "lifecycle-hooks" } });
    expect(subject.latest()).toMatchObject({ rawEvent: "PermissionPromptCleared", reason: "permission_prompt_cleared" });
    const calls = subject.changed.mock.calls.length;
    await subject.hook("PostToolBatch");
    expect(subject.changed).toHaveBeenCalledTimes(calls);
  });

  it.each([undefined, "child-1"])("carries native actor %s without sending tool inputs or results", async agentId => {
    const subject = fixture();
    const payload = await subject.hook("Notification", { agent_id: agentId, tool_input: { command: "private" } });
    expect(payload).toHaveProperty("hookAgentId", agentId ?? null);
    const recorded = subject.db.prepare("SELECT payload FROM events WHERE type = 'agent.activity' AND json_extract(payload, '$.activity.rawEvent') = 'Notification' ORDER BY seq DESC LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(recorded.payload).activity).toHaveProperty("hookAgentId", agentId ?? null);
    const batch = await subject.hook("PostToolBatch", { agent_id: agentId,
      tool_calls: [{ tool_name: "Bash", tool_use_id: "tool-1", tool_response: "private result" }] });
    expect(batch).toHaveProperty("hookAgentId", agentId ?? null);
    expect(batch).not.toHaveProperty("tool_calls");
    expect(payload).not.toHaveProperty("tool_input");
    expect(subject.count()).toBe(0);
  });

  it("does not treat one parallel tool finishing as the whole batch finishing", async () => {
    const subject = fixture();
    await subject.hook("Notification");
    await subject.hook("PostToolUse", { tool_use_id: "other-tool" });
    expect(subject.count()).toBe(1);
    await subject.hook("PostToolBatch");
    expect(subject.count()).toBe(0);
  });

  it("settles only the completed actor when main and subagent permissions overlap", async () => {
    const subject = fixture();
    await subject.hook("Notification");
    await subject.hook("Notification", { agent_id: "child-1" });
    expect(subject.count()).toBe(2);
    await subject.hook("PostToolBatch", { agent_id: "child-1" });
    expect(subject.count()).toBe(1);
    await subject.hook("PostToolBatch");
    expect(subject.count()).toBe(0);
  });

  it("does not attribute the same visible dialog to two outstanding actors", async () => {
    const subject = fixture();
    await subject.hook("Notification");
    await subject.hook("Notification", { agent_id: "child-1" });
    subject.reader.mockResolvedValue(true);
    subject.reader.mockClear();
    subject.advance(1_000);
    await subject.service.pollSeat(subject.sessionName);
    expect(subject.reader).toHaveBeenCalledOnce();
    subject.reader.mockResolvedValue(false);
    subject.advance(1_000);
    await subject.service.pollSeat(subject.sessionName);
    expect(subject.count()).toBe(2);
    await subject.hook("PostToolBatch");
    expect(subject.count()).toBe(1);
    await subject.hook("PostToolBatch", { agent_id: "child-1" });
    expect(subject.count()).toBe(0);
  });

  it("uses the current node identity when a relay only carries nodeId", async () => {
    const subject = fixture();
    await subject.hook("Notification");
    await subject.hook("PostToolBatch", {}, { sessionName: null });
    expect(subject.count()).toBe(0);
  });

  it("does not let the completed batch mask later self-reported attention", async () => {
    const subject = fixture();
    await subject.hook("Notification");
    await subject.hook("PostToolBatch");
    subject.service.reportEvidence({ seatNodeId: subject.node.id, sessionName: subject.sessionName,
      rung: "self-report", sourceId: "claude:pid-json", seq: 1, observedAt: subject.now().toISOString(),
      needsInput: { count: 1, reason: "dialog owns input" } });
    expect(subject.count()).toBe(1);
  });

  it.each(["child-1", "child-2"])("ignores actor %s finishing while the main request is pending", async agentId => {
    const subject = fixture();
    await subject.hook("Notification");
    const before = subject.latest();
    await subject.hook("PostToolBatch", { agent_id: agentId });
    expect(subject.count()).toBe(1);
    expect(subject.latest()).toEqual(before);
  });

  it.each([-1, 0])("does not resolve a notification with a batch timestamp offset of %s ms", async offset => {
    const subject = fixture();
    await subject.hook("Notification");
    const before = subject.latest();
    const occurredAt = new Date(subject.now().getTime() + offset).toISOString();
    await subject.hook("PostToolBatch", {}, { occurredAt });
    expect(subject.count()).toBe(1);
    expect(subject.latest()).toEqual(before);
  });

  it("does not let a delayed older notification make a newer request eligible for an old batch", async () => {
    const subject = fixture();
    const at = (offset: number) => new Date(Date.parse("2026-10-28T00:00:00.000Z") + offset).toISOString();
    await subject.hook("Notification", {}, { occurredAt: at(30) });
    await subject.hook("Notification", {}, { occurredAt: at(10) });
    await subject.hook("PostToolBatch", {}, { occurredAt: at(20) });
    expect(subject.count()).toBe(1);
    expect(subject.latest().state).toBe("needs_input");
    await subject.hook("PostToolBatch", {}, { occurredAt: at(40) });
    expect(subject.count()).toBe(0);
  });

  it("does not guess an actor for notifications from an older relay", async () => {
    const subject = fixture();
    await subject.hook("Notification", {}, { hookAgentId: undefined });
    const before = subject.latest();
    await subject.hook("PostToolBatch");
    expect(subject.count()).toBe(1);
    expect(subject.latest()).toEqual(before);
  });

  it.each([undefined, "child-1"])("does not revive actor %s after its completed notification arrives again", async agentId => {
    const subject = fixture();
    await subject.hook("UserPromptSubmit");
    const notification = await subject.hook("Notification", { agent_id: agentId });
    const batch = await subject.hook("PostToolBatch", { agent_id: agentId });
    const before = subject.latest();
    for (const occurredAt of [notification.occurredAt,
      new Date(Date.parse(String(batch.occurredAt)) - 1).toISOString()]) {
      await subject.hook("Notification", { agent_id: agentId }, { occurredAt });
      expect(subject.count()).toBe(0);
      expect(subject.latest()).toEqual(before);
    }
  });

  it.each([undefined, "child-1"])("remembers actor %s completing before its first notification arrives", async agentId => {
    const subject = fixture();
    const batch = await subject.hook("PostToolBatch", { agent_id: agentId });
    await subject.hook("Notification", { agent_id: agentId },
      { occurredAt: new Date(Date.parse(String(batch.occurredAt)) - 1).toISOString() });
    expect(subject.count()).toBe(0);
    expect(subject.store.getLatestForNode({ sessionName: subject.sessionName })?.state).not.toBe("needs_input");
    expect(subject.changed).not.toHaveBeenCalled();
  });

  it.each([0, 1])("keeps a new notification whose timestamp is %s ms after the prior batch", async offset => {
    const subject = fixture();
    await subject.hook("Notification");
    const batch = await subject.hook("PostToolBatch");
    await subject.hook("Notification", {},
      { occurredAt: new Date(Date.parse(String(batch.occurredAt)) + offset).toISOString() });
    expect(subject.count()).toBe(1);
    expect(subject.latest().state).toBe("needs_input");
  });

  it("retains the latest completion per actor even when older batches arrive later", async () => {
    const subject = fixture();
    await subject.hook("UserPromptSubmit");
    const completedAt = subject.now().getTime() + 100;
    const at = (offset: number) => new Date(completedAt + offset).toISOString();
    await subject.hook("PostToolBatch", { agent_id: "child-1" }, { occurredAt: at(0) });
    await subject.hook("PostToolBatch", { agent_id: "child-1" }, { occurredAt: at(-20) });
    await subject.hook("Notification", { agent_id: "child-1" }, { occurredAt: at(-10) });
    expect(subject.count()).toBe(0);
    await subject.hook("Notification", {}, { occurredAt: at(-10) });
    expect(subject.count()).toBe(1);
    expect(subject.latest().state).toBe("needs_input");
  });

  it("keeps an unattributed legacy notification even after the main actor completed", async () => {
    const subject = fixture();
    const batch = await subject.hook("PostToolBatch");
    await subject.hook("Notification", {}, { hookAgentId: undefined,
      occurredAt: new Date(Date.parse(String(batch.occurredAt)) - 1).toISOString() });
    expect(subject.count()).toBe(1);
    expect(subject.latest().state).toBe("needs_input");
  });

  it.each(["forget", "swap"] as const)("discards the prior occupant's completion on %s", async action => {
    const subject = fixture();
    const batch = await subject.hook("PostToolBatch");
    let generation = subject.generation;
    if (action === "forget") subject.service.forgetSeat(subject.sessionName);
    else {
      generation = subject.registry.mintOccupantTenure(subject.node.id, "initial").generationUuid;
      subject.service.declareOccupantSwap(subject.node.id, generation);
    }
    await subject.hook("Notification", {}, { generation,
      occurredAt: new Date(Date.parse(String(batch.occurredAt)) - 1).toISOString() });
    expect(subject.count()).toBe(1);
    expect(subject.latest().state).toBe("needs_input");
  });

  it.each(["PostToolBatch", "Notification"])("returns a named 503 for %s when the occupant ledger cannot be read", async hookEvent => {
    const subject = fixture();
    await subject.hook("Notification");
    const before = subject.latest();
    const resolver = vi.spyOn(subject.registry, "currentOccupantTenure")
      .mockImplementation(() => { throw new Error("fixture occupant ledger unavailable"); });
    try {
      const response = await subject.app.request("/activity/hooks", { method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer batch-test-token" },
        body: JSON.stringify({ runtime: "claude-code", hookEvent, subtype: "permission_prompt",
          sessionName: subject.sessionName, nodeId: subject.node.id, generation: subject.generation,
          hookAgentId: null, occurredAt: new Date(subject.now().getTime() + 1).toISOString() }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, code: "generation_resolver_error" });
    } finally {
      resolver.mockRestore();
    }
    expect(subject.count()).toBe(1);
    expect(subject.latest()).toEqual(before);
    await subject.hook(hookEvent);
    expect(subject.count()).toBe(hookEvent === "PostToolBatch" ? 0 : 1);
  });

  it.each([{ generation: null }, { generation: "retired-generation" }, { hookAgentId: undefined },
    { hookAgentId: 42 }, { occurredAt: "invalid" }, { sessionName: "old@batch-permission" }])(
    "preserves attention when batch attribution is unusable: %j", async wire => {
      const subject = fixture();
      await subject.hook("Notification");
      const before = subject.latest();
      await subject.hook("PostToolBatch", {}, wire);
      expect(subject.count()).toBe(1);
      expect(subject.latest()).toEqual(before);
    });

  it("does not clear an elicitation that replaced the permission request", async () => {
    const subject = fixture();
    await subject.hook("Notification");
    await subject.hook("Notification", { notification_type: "elicitation_dialog" });
    const before = subject.latest();
    await subject.hook("PostToolBatch");
    expect(subject.count()).toBe(1);
    expect(subject.latest()).toEqual(before);
  });

  it("does not revive a completed request from an in-flight pane capture", async () => {
    const subject = fixture();
    let finish!: (visible: boolean) => void;
    subject.reader.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await subject.hook("Notification");
    expect(finish).toBeTypeOf("function");
    await subject.hook("PostToolBatch");
    expect(subject.count()).toBe(0);
    finish(true);
    await subject.service.pollSeat(subject.sessionName);
    expect(subject.count()).toBe(0);
  });

  it("does not apply a batch to a retired session", async () => {
    const subject = fixture();
    await subject.hook("Notification");
    subject.registry.updateStatus(subject.session.id, "stopped");
    const before = subject.latest();
    await subject.hook("PostToolBatch");
    expect(subject.count()).toBe(1);
    expect(subject.latest()).toEqual(before);
  });

  it("clears displayed attention and retries the existing refused handoff once through daemon wiring", async () => {
    const originalNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      expect(String(input)).toBe("https://github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz");
      return new Response(null, { status: 404 });
    });
    const captures = JSON.parse(readFileSync(new URL("./fixtures/claude-permission-2.1.300.json", import.meta.url), "utf8"));
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon({ dbPath: ":memory:",
        tmuxExec: async command => command.includes("capture-pane") ? captures.approvedBash : "", cmuxExec: async () => "" });
      const { rigRepo, sessionRegistry, queueRepo, outboxHandler, agentActivityStore, seatActivityService,
        seatStructuralActivityService, tmuxAdapter, activityHookToken } = daemon.deps;
      const rig = rigRepo.createRig("batch-wake");
      const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
      const sessionName = "worker@batch-wake";
      const session = sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName });
      const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
      const hook = async (event: string, native: Record<string, unknown> = {}) => {
        const payload = buildOpenRigPayload({ hook_event_name: event,
          ...(event === "Notification" ? { notification_type: "permission_prompt" } : {}), ...native }, {
          OPENRIG_SESSION_NAME: sessionName, OPENRIG_NODE_ID: node.id,
          OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation,
        }, () => new Date(event === "PostToolBatch" ? Date.now() : Date.now() - 1_000));
        const response = await daemon!.app.request("/api/activity/hooks", { method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${activityHookToken}` },
          body: JSON.stringify(payload) });
        expect(response.status).toBe(200);
      };
      const inventory = async () => attachTerminalActivityAndWork(await attachAgentActivity(getNodeInventory(daemon!.db, rig.id),
        { tmuxAdapter, activityStore: agentActivityStore, structuralActivity: seatStructuralActivityService }),
      { db: daemon!.db, seatActivity: seatActivityService, agentActivity: agentActivityStore })[0]!;
      await seatStructuralActivityService!.pollSeat(sessionName, null, "claude-code");
      await hook("UserPromptSubmit");
      await hook("Notification");
      await seatActivityService!.pollSeat(sessionName);
      expect(await inventory()).toMatchObject({ needsAttention: true, agentActivity: { state: "needs_input" },
        activityState: { display: "needs-input", needsInput: { count: 1 } } });

      let refused = true;
      const send = vi.fn(async () => refused
        ? { ok: false, sent: false, reason: "target_needs_input", error: `Refused: '${sessionName}' is at an interactive prompt (permission_prompt). No text was sent.` }
        : { ok: true, verified: true });
      queueRepo!.attachTransport({ send });
      const source = await queueRepo!.create({ sourceSession: "planner@batch-wake", destinationSession: "builder@batch-wake",
        body: "build", nudge: false });
      const { created } = await queueRepo!.handoff({ qitemId: source.qitemId, fromSession: "builder@batch-wake",
        toSession: sessionName, body: "review the finished work" });
      const wakeId = WAKE_INTENT_PREFIX + created.qitemId;
      await vi.waitFor(() => expect(outboxHandler!.getById(wakeId)?.deliveryState).toBe("failed"));
      const original = outboxHandler!.getById(wakeId)!;
      refused = false;
      await hook("PostToolBatch", { agent_id: "other-actor" });
      expect(send).toHaveBeenCalledOnce();
      expect((await inventory()).needsAttention).toBe(true);
      await hook("PostToolBatch");
      await vi.waitFor(() => expect(outboxHandler!.getById(wakeId)?.deliveryState).toBe("delivered"));
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][1]).toContain(original.body);
      expect(agentActivityStore!.getLatestForNode({ sessionName })).toMatchObject({ rawEvent: "PermissionPromptCleared" });
      expect(await inventory()).toMatchObject({ needsAttention: false, agentActivity: { state: "running" },
        activityState: { display: "working", needsInput: { count: 0 } } });
      await hook("PostToolBatch");
      await seatStructuralActivityService!.pollSeat(sessionName, null, "claude-code");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(send).toHaveBeenCalledTimes(2);
      expect(queueRepo!.list({ limit: 100 })).toHaveLength(2);
    } finally {
      daemon?.eventLoopMonitor.stop();
      daemon?.db.close();
      fetch.mockRestore();
      if (originalNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = originalNoKernel;
    }
  }, 10_000);
});
