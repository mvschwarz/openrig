import { createRequire } from "node:module";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { PermissionStopObservations } from "../src/domain/permission-stop-observation.js";
import { activityRoutes } from "../src/routes/activity.js";
import { seatRoutes } from "../src/routes/seat.js";
import { createFullTestDb } from "./helpers/test-app.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildOpenRigPayload: (input: object, env: object, now: () => Date) => Record<string, unknown>;
};
const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });
const unavailable = { state: "unavailable", command: "unavailable", origin: "unknown" };

describe("permission observation source-time ordering", () => {
  it.each(["completion-first", "request-first"] as const)(
    "retains the equal-time newer request for %s arrival", order => {
      const now = () => new Date("2026-11-05T01:00:00.010Z");
      const observations = new PermissionStopObservations(now);
      const identity = { nodeId: "node", generation: "generation", actor: null };
      observations.observe({ ...identity, at: "2026-11-05T01:00:00.000Z", command: "Tool: Read", completed: false });
      const completion = { ...identity, at: "2026-11-05T01:00:00.010Z", completed: true };
      const request = { ...identity, at: "2026-11-05T01:00:00.010Z", command: "Tool: Write", completed: false };
      for (const event of order === "completion-first" ? [completion, request] : [request, completion]) {
        observations.observe(event);
      }
      expect(observations.read("node", "generation")).toEqual({
        state: "request_observed", command: "Tool: Write", origin: "harness", source: "PermissionRequest",
        observed_at: "2026-11-05T01:00:00.010Z", actor: "main", pending: "unknown",
      });
    },
  );
});

// Schema-based synthetic Claude harness fixture. No real PermissionRequest delivery was captured.
function fixture() {
  const db = createFullTestDb();
  databases.push(db);
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("diagnostic");
  const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
  const registry = new SessionRegistry(db);
  const sessionName = "worker@diagnostic";
  const session = registry.registerSession(node.id, sessionName);
  registry.updateStatus(session.id, "running");
  const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
  let time = Date.parse("2026-11-05T01:00:00.000Z");
  const now = () => new Date(time);
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now,
    resolveOccupantGeneration: id => registry.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, gen) => registry.isOccupantGenerationRegistered(id, gen) });
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, now, defaultWindowSeconds: 3 });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("rigRepo" as never, rigRepo as never);
    c.set("seatActivityService" as never, oracle as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    await next();
  });
  app.route("/activity", activityRoutes);
  app.route("/seat", seatRoutes);
  const env = { OPENRIG_SESSION_NAME: sessionName, OPENRIG_NODE_ID: node.id,
    OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation };
  const post = async (hookEvent: string, extra: object = {}) => {
    const response = await app.request("/activity/hooks", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
      body: JSON.stringify({ sessionName, nodeId: node.id, runtime: "claude-code", generation,
        hookEvent, hookAgentId: null, occurredAt: now().toISOString(), ...extra }) });
    expect(response.status).toBe(200);
    return response.json();
  };
  const status = async () => {
    const response = await app.request(`/seat/status/${sessionName}`);
    expect(response.status).toBe(200);
    return response.json();
  };
  return { app, db, rigRepo, node, registry, session, sessionName, generation, now, env, store, oracle, post, status,
    tick: (ms = 10) => { time += ms; } };
}

describe("passive permission observation through relay, ingress and seat status", () => {
  it("preserves legacy PermissionRequest activity without the new diagnostic field", async () => {
    const f = fixture();
    const response = await f.post("PermissionRequest");
    expect(response).toMatchObject({ ok: true, activity: { state: "needs_input", rawEvent: "PermissionRequest" } });
    expect((await f.status()).permission_stop).toEqual(unavailable);
    expect(f.store.getLatestForNode({ nodeId: f.node.id })?.rawEvent).toBe("PermissionRequest");
  });

  it("sanitizes before transport and does not persist secrets, mutate permissions or create attention", async () => {
    const f = fixture();
    const native = { hook_event_name: "PermissionRequest", tool_name: "Bash",
      tool_input: { command: "git --token=SYNTHETIC_SECRET", description: "SYNTHETIC_SECRET" },
      permission_suggestions: [{ behavior: "allow", destination: "localSettings", secret: "SYNTHETIC_SECRET" }],
      transcript_path: "/SYNTHETIC_SECRET", message: "SYNTHETIC_SECRET", reason: "SYNTHETIC_SECRET" };
    const before = JSON.stringify(native);
    const wire = relay.buildOpenRigPayload(native, f.env, f.now);
    expect(wire).toEqual({ sessionName: f.sessionName, nodeId: f.node.id, runtime: "claude-code", generation: f.generation,
      hookEvent: "PermissionRequest", hookAgentId: null, permissionStopDescriptor: "Bash: git [arguments hidden]",
      occurredAt: f.now().toISOString(), relayRoute: "managed" });
    expect(JSON.stringify(native)).toBe(before);
    const changes = f.db.prepare("SELECT total_changes() AS count").get();
    const result = await f.post("PermissionRequest", wire);
    expect(result).toEqual({ ok: true }); // No decision, updatedInput, updatedPermissions or provider output.
    const report = await f.status();
    expect(report.permission_stop).toEqual({ state: "request_observed", command: "Bash: git [arguments hidden]",
      origin: "harness", source: "PermissionRequest", observed_at: f.now().toISOString(), actor: "main", pending: "unknown" });
    expect(f.oracle.getSeatState(f.node.id)).toBeNull();
    expect(f.store.getLatestForNode({ nodeId: f.node.id })).toBeNull();
    expect(f.db.prepare("SELECT total_changes() AS count").get()).toEqual(changes);
    expect(JSON.stringify([wire, report, f.db.prepare("SELECT payload FROM events").all()])).not.toContain("SYNTHETIC_SECRET");
  });

  it.each(["SYNTHETIC_SECRET", "Bash: git --token=SYNTHETIC_SECRET", "Tool: SYNTHETIC_SECRET", "guard blocked", "Bash: git [arguments hidden]\nsecret", {}, null])(
    "admits only finite descriptors even when claimed sanitized (case %#)", async permissionStopDescriptor => {
      const f = fixture();
      await f.post("PermissionRequest", { permissionStopDescriptor, tool_input: { command: "SYNTHETIC_SECRET" } });
      expect((await f.status()).permission_stop).toEqual(unavailable);
      expect(f.db.prepare("SELECT count(*) AS count FROM events").get()).toEqual({ count: 0 });
    },
  );

  it("settles only the matching actor without joining same-tool observations", async () => {
    const f = fixture();
    await f.post("PermissionRequest", { permissionStopDescriptor: "Bash: git [arguments hidden]" });
    f.tick();
    await f.post("PermissionRequest", { hookAgentId: "child-1", permissionStopDescriptor: "Bash: git [arguments hidden]" });
    f.tick();
    await f.post("PostToolBatch");
    expect((await f.status()).permission_stop).toMatchObject({ state: "request_observed", actor: "subagent", pending: "unknown" });
    await f.post("PostToolBatch", { hookAgentId: "child-1" });
    expect((await f.status()).permission_stop).toMatchObject({ state: "completed", actor: "subagent", pending: false });
  });

  it("withholds an ambiguous latest actor when observations have equal source times", async () => {
    const f = fixture();
    await f.post("PermissionRequest", { permissionStopDescriptor: "Bash: git [arguments hidden]" });
    await f.post("PermissionRequest", { hookAgentId: "child-1", permissionStopDescriptor: "Bash: git [arguments hidden]" });
    expect((await f.status()).permission_stop).toEqual(unavailable);
    f.tick();
    await f.post("PermissionRequest", { hookAgentId: "child-1", permissionStopDescriptor: "Tool: Read" });
    expect((await f.status()).permission_stop).toMatchObject({ actor: "subagent", command: "Tool: Read" });
  });

  it("reports only the latest actor's completion while an older actor observation remains unresolved", async () => {
    const f = fixture();
    await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read" });
    expect((await f.status()).permission_stop).toMatchObject({ actor: "main", state: "request_observed", pending: "unknown" });
    f.tick();
    const latestAt = f.now().toISOString();
    await f.post("PermissionRequest", { hookAgentId: "child-1", permissionStopDescriptor: "Tool: Write" });
    f.tick();
    await f.post("PostToolBatch", { hookAgentId: "child-1" });
    // No completion arrived for main. This is the latest observation, not all actors' pending state.
    expect((await f.status()).permission_stop).toEqual({
      state: "completed", command: "Tool: Write", origin: "harness", source: "PermissionRequest",
      observed_at: latestAt, actor: "subagent", pending: false,
    });
  });

  it("rejects late, replayed, future and already completed requests", async () => {
    const f = fixture();
    const older = f.now().toISOString();
    f.tick();
    await f.post("PostToolBatch");
    await f.post("PermissionRequest", { occurredAt: older, permissionStopDescriptor: "Tool: Read" });
    expect((await f.status()).permission_stop).toEqual(unavailable);
    f.tick();
    const current = f.now().toISOString();
    await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read" });
    await f.post("PermissionRequest", { occurredAt: current, permissionStopDescriptor: "Tool: Write" });
    await f.post("PermissionRequest", { occurredAt: older, permissionStopDescriptor: "Tool: Edit" });
    await f.post("PermissionRequest", { occurredAt: new Date(f.now().getTime() + 1).toISOString(), permissionStopDescriptor: "Tool: Task" });
    expect((await f.status()).permission_stop).toMatchObject({ command: "Tool: Read", observed_at: current });
    f.tick();
    await f.post("PostToolBatch");
    await f.post("PermissionRequest", { occurredAt: current, permissionStopDescriptor: "Tool: Write" });
    expect((await f.status()).permission_stop).toMatchObject({ command: "Tool: Read", state: "completed" });
  });

  it("does not infer completion order from equal timestamps or renew lifetime on a duplicate", async () => {
    const f = fixture();
    const at = f.now().toISOString();
    await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read" });
    await f.post("PostToolBatch");
    expect((await f.status()).permission_stop).toMatchObject({ state: "request_observed", pending: "unknown" });
    f.tick(299_999);
    await f.post("PermissionRequest", { occurredAt: at, permissionStopDescriptor: "Tool: Read" });
    f.tick(1);
    expect((await f.status()).permission_stop).toEqual(unavailable);
  });

  it.each([
    { generation: "stale-generation" }, { generation: null }, { hookAgentId: undefined },
    { hookAgentId: {} }, { hookAgentId: "SYNTHETIC_SECRET\n" }, { sessionName: "other@diagnostic" },
    { nodeId: "other-node" }, { occurredAt: "not a timestamp" },
  ])("refuses missing, stale or misattributed identity (case %#)", async identity => {
    const f = fixture();
    await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read", ...identity });
    expect((await f.status()).permission_stop).toEqual(unavailable);
  });

  it("expires and drops old-generation, retired and exited observations", async () => {
    const f = fixture();
    await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read" });
    f.tick(300_000);
    expect((await f.status()).permission_stop).toEqual(unavailable);
    await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read" });
    f.registry.mintOccupantTenure(f.node.id, "handover");
    expect((await f.status()).permission_stop).toEqual(unavailable);
    const generation = f.registry.currentOccupantTenure(f.node.id)!.generationUuid;
    await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read", generation });
    expect((await f.status()).permission_stop).toMatchObject({ state: "request_observed" });
    f.db.prepare("UPDATE nodes SET occupant_lifecycle = 'retired' WHERE id = ?").run(f.node.id);
    expect((await f.status()).permission_stop).toEqual(unavailable);
    f.db.prepare("UPDATE nodes SET occupant_lifecycle = 'active' WHERE id = ?").run(f.node.id);
    expect((await f.status()).permission_stop).toEqual(unavailable);
    f.registry.updateStatus(f.session.id, "exited");
    expect((await f.status()).permission_stop).toEqual(unavailable);
  });

  it("loses diagnostic evidence honestly on restart without storing raw native payloads", async () => {
    const f = fixture();
    await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read" });
    const restarted = new AgentActivityStore({ db: f.db, eventBus: new EventBus(f.db), now: f.now,
      resolveOccupantGeneration: id => f.registry.currentOccupantTenure(id)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (id, generation) => f.registry.isOccupantGenerationRegistered(id, generation) });
    expect(restarted.getPermissionStopForNode(f.node.id, f.sessionName)).toEqual(unavailable);
  });

  it("keeps unsupported and quoted guard claims unknown without joining a last tool", async () => {
    const f = fixture();
    await f.post("Notification", { subtype: "permission_prompt", tool_input: { command: "SYNTHETIC_SECRET" },
      permissionStopDescriptor: "Bash: git [arguments hidden]" });
    await f.post("PostToolUseFailure", { subtype: "Bash", message: "BLOCKED by guard SYNTHETIC_SECRET", toolDenialKind: "permission-rule" });
    expect((await f.status()).permission_stop).toEqual(unavailable);
    expect(JSON.stringify(f.db.prepare("SELECT payload FROM events").all())).not.toContain("SYNTHETIC_SECRET");
  });

  it("isolates diagnostic errors from status and existing batch completion", async () => {
    const f = fixture();
    const completed = vi.spyOn(f.oracle, "completeClaudeToolBatch");
    vi.spyOn(f.store, "observePermissionStop").mockImplementation(() => { throw new Error("SYNTHETIC_SECRET"); });
    expect(await f.post("PermissionRequest", { permissionStopDescriptor: "Tool: Read" })).toEqual({ ok: true });
    await f.post("PostToolBatch");
    expect(completed).toHaveBeenCalledTimes(1);
    vi.spyOn(f.store, "getPermissionStopForNode").mockImplementation(() => { throw new Error("SYNTHETIC_SECRET"); });
    const status = new SeatStatusService({ rigRepo: f.rigRepo, activityStore: f.store }).getStatus(f.sessionName);
    expect(status).toMatchObject({ ok: true, status: { permission_stop: unavailable, session_status: "running" } });
    expect(JSON.stringify(status)).not.toContain("SYNTHETIC_SECRET");
  });

  it("bounds actors and seats without evicting completion watermarks for strictly older requests", () => {
    const now = () => new Date("2026-11-05T01:00:00Z");
    const observations = new PermissionStopObservations(now);
    const input = { generation: "generation", at: now().toISOString(), actor: null, completed: true };
    for (let i = 0; i < 256; i++) observations.observe({ ...input, nodeId: `node-${i}` });
    observations.observe({ ...input, nodeId: "extra", completed: false, command: "Tool: Read" });
    expect(observations.read("extra", "generation")).toEqual(unavailable);
    observations.observe({ ...input, nodeId: "node-0", at: "2026-11-05T00:59:59.999Z", completed: false, command: "Tool: Read" });
    expect(observations.read("node-0", "generation")).toEqual(unavailable);
    for (let i = 0; i < 15; i++) observations.observe({ ...input, nodeId: "node-0", actor: `child-${i}` });
    observations.observe({ ...input, nodeId: "node-0", actor: "overflow", completed: false, command: "Tool: Read" });
    expect(observations.read("node-0", "generation")).toEqual(unavailable);
  });
});
