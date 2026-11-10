import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { RunnerCore } from "../src/adapters/pi-runner.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { RigEvent } from "../src/domain/types.js";
import { activityRoutes } from "../src/routes/activity.js";

// F1: real runner -> route -> registry with only in-memory persistence and
// injected runner effects. The independent review first reproduced these four
// preservation failures; no daemon, native process, filesystem or network here.
const NODE = "pi-node", NAME = "worker@pi-test", CURRENT = "pi-current";
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE nodes (id TEXT, rig_id TEXT, runtime TEXT);
    CREATE TABLE sessions (id INTEGER, node_id TEXT, session_name TEXT, resume_type TEXT,
      resume_token TEXT, resume_provenance TEXT, resume_last_verified TEXT, resume_last_probe_status TEXT,
      resume_rotated_from TEXT, resume_rotated_process TEXT, resume_launch_token TEXT);
    CREATE TABLE events (seq INTEGER PRIMARY KEY, node_id TEXT, type TEXT, payload TEXT);
    CREATE TABLE occupant_tenures (id TEXT, node_id TEXT, generation_ordinal INTEGER,
      generation_uuid TEXT, kind TEXT, native_session_id_at_boot TEXT, boot_at TEXT);
    INSERT INTO nodes VALUES ('pi-node', 'rig', 'pi'), ('other-node', 'rig', 'pi');
    INSERT INTO sessions(id, node_id, session_name) VALUES (1, 'pi-node', 'worker@pi-test');
    INSERT INTO occupant_tenures VALUES
      ('old', 'pi-node', 1, 'pi-prior', 'initial', NULL, '2026-09-27'),
      ('current', 'pi-node', 2, 'pi-current', 'fresh', NULL, '2026-09-27'),
      ('foreign', 'other-node', 1, 'other-current', 'initial', NULL, '2026-09-27');
  `);
  const events: RigEvent[] = [];
  const eventBus = { emit(event: RigEvent) { events.push(event); return event; } } as EventBus;
  const registry = new SessionRegistry(db);
  const store = new AgentActivityStore({ db, eventBus });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const post = (payload: Record<string, unknown>) => app.request("/api/activity/hooks", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
    body: JSON.stringify({ eventFamily: "session_identity", runtime: "pi", nodeId: NODE,
      sessionName: NAME, sessionId: "native-current", sessionFile: "/fixture/current.jsonl",
      generation: CURRENT, ...payload }),
  });
  const pending: Promise<Response>[] = [];
  const runner = (generation: string | undefined = CURRENT) => new RunnerCore({
    sendRpc() {}, mirrorLine() {}, mirrorAppend() {}, writeSidecar() {},
    now: () => "2026-09-27T16:20:00.000Z",
    postActivity(payload) { pending.push(Promise.resolve(post(payload))); },
  }, { nodeId: NODE, sessionName: NAME, generation });
  const identity = async (core: RunnerCore, label: string) => {
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state",
      data: { sessionId: label, sessionFile: `/fixture/${label}.jsonl` } }));
    const responses = await Promise.all(pending.splice(0));
    expect(responses).toHaveLength(1);
    return responses[0]!;
  };
  const token = () => db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1").get();
  return { db, registry, events, post, runner, identity, token };
}

describe("Pi SessionStart occupant binding", () => {
  it("persists and emits the registered current runner's identity", async () => {
    const f = fixture();
    const response = await f.identity(f.runner(), "current");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tokenPersisted: true, provenance: "rpc" });
    expect(f.token()).toMatchObject({ resume_type: "pi_session_file", resume_token: "/fixture/current.jsonl" });
    expect(f.events).toEqual([expect.objectContaining({ type: "agent.session_identity", sessionId: "current", nodeId: NODE })]);
  });

  it.each([
    [null, "generation_unverifiable"], ["", "generation_unverifiable"], ["  ", "generation_unverifiable"],
    [37, "generation_unverifiable"], ["pi-prior", "generation_mismatch"],
    ["other-current", "generation_unresolvable"], ["unregistered", "generation_unresolvable"],
  ])("ignores generation %s without changing any resume metadata or publishing identity", async (generation, code) => {
    const f = fixture();
    await f.identity(f.runner(), "current");
    const before = f.token(), events = [...f.events];
    const response = await f.post({ generation, sessionId: "ignored", sessionFile: "/fixture/ignored.jsonl" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code, tokenPersisted: false });
    expect(f.token()).toEqual(before);
    expect(f.events).toEqual(events);
  });

  it("preserves the successor row and identity when the old runner answers after renewal", async () => {
    const f = fixture(), old = f.runner();
    await f.identity(old, "old");
    f.db.exec(`INSERT INTO occupant_tenures VALUES ('next', 'pi-node', 3, 'pi-next', 'fresh', NULL, '2026-09-27');
      INSERT INTO sessions(id, node_id, session_name) VALUES (2, 'pi-node', 'worker@pi-test');`);
    expect((await f.identity(f.runner("pi-next"), "successor")).status).toBe(200);
    const before = f.token(), events = [...f.events];
    expect((await f.identity(old, "old")).status).toBe(409);
    expect(f.token()).toEqual(before);
    expect(f.events).toEqual(events);
  });

  it.each([
    ["DELETE FROM occupant_tenures WHERE node_id = 'pi-node'", 409, "generation_unresolvable"],
    ["DROP TABLE occupant_tenures", 503, "generation_resolver_error"],
  ])("abstains when the tenure ledger is unavailable: %s", async (sql, status, code) => {
    const f = fixture();
    await f.identity(f.runner(), "current");
    const before = f.token(), events = [...f.events];
    f.db.exec(sql as string);
    const response = await f.identity(f.runner(), "ignored");
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, code, tokenPersisted: false });
    expect(f.token()).toEqual(before);
    expect(f.events).toEqual(events);
  });

  it("retains Pi path validation and higher-provenance resume tokens", async () => {
    const f = fixture();
    f.registry.updateResumeToken("1", "pi_session_file", "/fixture/operator.jsonl", "operator");
    const before = f.token();
    const invalid = await f.post({ sessionFile: "relative.jsonl" });
    expect(await invalid.json()).toMatchObject({ tokenPersisted: false });
    expect((await f.identity(f.runner(), "current")).status).toBe(200);
    expect(f.token()).toEqual(before);
  });

  it.each([["codex", "codex_id"], ["claude-code", "claude_id"], ["unmapped", null]])(
    "preserves %s identity handling without requiring a Pi generation", async (runtime, resumeType) => {
      const f = fixture();
      f.db.exec("DROP TABLE occupant_tenures");
      f.db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(runtime, NODE);
      const response = await f.post({ runtime, generation: null, sessionId: "native-id" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ tokenPersisted: resumeType !== null, provenance: "hook" });
      expect(f.token()).toMatchObject({ resume_type: resumeType, resume_token: resumeType ? "native-id" : null });
      expect(f.events).toEqual([expect.objectContaining({ type: "agent.session_identity", runtime, sessionId: "native-id" })]);
    },
  );
});

// A protocol: pi-rpc fork (omo) beside a preset's own runner (dsh), through the same runner -> route -> registry path.
// agent_runner is the launch record: 2 for OpenRig's hosted Pi-protocol runner, 1 for a preset's own runner.
function forkFixture(opts: { runtime: string; agentRunner: number; token?: { type: string; value: string; provenance: string } }) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE nodes (id TEXT, rig_id TEXT, runtime TEXT);
    CREATE TABLE sessions (id INTEGER, node_id TEXT, session_name TEXT, resume_type TEXT,
      resume_token TEXT, resume_provenance TEXT, resume_last_verified TEXT, resume_last_probe_status TEXT,
      resume_rotated_from TEXT, resume_rotated_process TEXT, resume_launch_token TEXT, agent_app TEXT, agent_runner INTEGER);
    CREATE TABLE events (seq INTEGER PRIMARY KEY, node_id TEXT, type TEXT, payload TEXT);
    CREATE TABLE occupant_tenures (id TEXT, node_id TEXT, generation_ordinal INTEGER,
      generation_uuid TEXT, kind TEXT, native_session_id_at_boot TEXT, boot_at TEXT);
    INSERT INTO occupant_tenures VALUES ('current', 'fork-node', 1, 'fork-current', 'initial', NULL, '2026-11-09');
  `);
  db.prepare("INSERT INTO nodes VALUES ('fork-node', 'rig', ?)").run(opts.runtime);
  db.prepare(`INSERT INTO sessions (id, node_id, session_name, agent_app, agent_runner, resume_type, resume_token, resume_provenance)
    VALUES (1, 'fork-node', 'worker@fork-test', ?, ?, ?, ?, ?)`)
    .run(opts.runtime, opts.agentRunner, opts.token?.type ?? null, opts.token?.value ?? null, opts.token?.provenance ?? null);
  // Activity is read back from the events table, and only with a resolvable current generation.
  const insertEvent = db.prepare("INSERT INTO events (node_id, type, payload) VALUES (?, ?, ?)");
  const eventBus = { emit(event: RigEvent) {
    const e = event as RigEvent & { nodeId?: string; sessionName?: string; activity?: unknown };
    insertEvent.run(e.nodeId ?? null, event.type, JSON.stringify(e.activity ? { sessionName: e.sessionName, activity: e.activity } : event));
    return event;
  } } as EventBus;
  const registry = new SessionRegistry(db);
  // The store reads on the runner's clock, so the runner's hooks are fresh at read rather than aged by the wall clock.
  const clock = "2026-11-09T16:20:00.000Z";
  const store = new AgentActivityStore({ db, eventBus, now: () => new Date(clock),
    resolveOccupantGeneration: (nodeId) => registry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) => registry.isOccupantGenerationRegistered(nodeId, generation) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const post = (payload: Record<string, unknown>) => app.request("/api/activity/hooks", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
    body: JSON.stringify(payload),
  });
  const pending: Promise<Response>[] = [];
  const posts: Array<Record<string, unknown>> = [];
  const runner = (requestedSessionFile?: string) => new RunnerCore({
    sendRpc() {}, mirrorLine() {}, mirrorAppend() {}, writeSidecar() {},
    now: () => clock,
    postActivity(payload) { posts.push(payload as Record<string, unknown>); pending.push(Promise.resolve(post(payload))); },
  }, { nodeId: "fork-node", sessionName: "worker@fork-test", generation: "fork-current" },
  { runtime: opts.runtime, ...(requestedSessionFile ? { requestedSessionFile } : {}) });
  const getState = (core: RunnerCore, sessionFile: string | null) => core.handlePiLine(JSON.stringify({
    type: "response", id: "pi-runner-get-state", data: { sessionId: "fork-session", sessionFile } }));
  const settle = () => Promise.all(pending.splice(0));
  const token = () => db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = 1").get();
  const latest = () => store.getLatestForNode({ nodeId: "fork-node", sessionName: "worker@fork-test" });
  const identities = () => db.prepare("SELECT payload FROM events WHERE type = 'agent.session_identity'").all();
  return { post, runner, getState, settle, token, latest, posts, identities };
}

describe("a protocol: pi-rpc fork's identity and attention", () => {
  it("a fork recorded as the hosted Pi-protocol runner persists its own session file as community:<runtime>", async () => {
    const f = forkFixture({ runtime: "omo", agentRunner: 2 });
    f.getState(f.runner(), "/fixture/omo/a.jsonl");
    expect((await f.settle()).map((r) => r.status)).toEqual([200]);
    expect(f.token()).toEqual({ resume_type: "community:omo", resume_token: "/fixture/omo/a.jsonl" });
  });

  it("a current-generation identity from another runtime in the seat (a Pi helper) keeps the fork's token and publishes nothing", async () => {
    const f = forkFixture({ runtime: "omo", agentRunner: 2, token: { type: "community:omo", value: "/fixture/omo/a.jsonl", provenance: "hook" } });
    const identity = { eventFamily: "session_identity", nodeId: "fork-node", sessionName: "worker@fork-test", generation: "fork-current" };
    const helper = await f.post({ ...identity, runtime: "pi", sessionId: "helper-1", sessionFile: "/fixture/pi/b.jsonl" });
    expect(await helper.json()).toMatchObject({ ignored: "runtime_mismatch", tokenPersisted: false });
    expect(f.token()).toEqual({ resume_type: "community:omo", resume_token: "/fixture/omo/a.jsonl" });
    expect(f.identities()).toEqual([]);
    // The control: the seat's own runtime, with the same generation, still reports the seat's identity.
    const own = await f.post({ ...identity, runtime: "omo", sessionId: "fork-session", sessionFile: "/fixture/omo/b.jsonl" });
    expect(await own.json()).toMatchObject({ provenance: "rpc", tokenPersisted: true });
    expect(f.token()).toEqual({ resume_type: "community:omo", resume_token: "/fixture/omo/b.jsonl" });
    expect(f.identities()).toHaveLength(1);
  });

  it("a preset's own runner (agent_runner 1) with a current generation and a sessionFile keeps its launcher token", async () => {
    const f = forkFixture({ runtime: "dsh", agentRunner: 1, token: { type: "community:dsh", value: "launcher-conv-1", provenance: "launcher" } });
    await f.post({ eventFamily: "session_identity", runtime: "dsh", nodeId: "fork-node", sessionName: "worker@fork-test",
      sessionId: "dsh-1", sessionFile: "/fixture/dsh/other.jsonl", generation: "fork-current", hookEvent: "SessionStart" });
    expect(f.token()).toEqual({ resume_type: "community:dsh", resume_token: "launcher-conv-1" });
  });

  it("a resume of A that comes up on B never reports B, so A stays stored before and after, and the seat asks for attention", async () => {
    const f = forkFixture({ runtime: "omo", agentRunner: 2, token: { type: "community:omo", value: "/fixture/omo/a.jsonl", provenance: "hook" } });
    const core = f.runner("/fixture/omo/a.jsonl");
    f.getState(core, "/fixture/omo/b.jsonl");
    await f.settle();
    expect(f.token()).toEqual({ resume_type: "community:omo", resume_token: "/fixture/omo/a.jsonl" });
    // A second get_state reply still reports B: still no identity, A still stored, and the attention isn't raised twice.
    f.getState(core, "/fixture/omo/b.jsonl");
    await f.settle();
    expect(f.token()).toEqual({ resume_type: "community:omo", resume_token: "/fixture/omo/a.jsonl" });
    expect(f.posts.map((p) => [p.hookEvent, p.subtype])).toEqual([["Notification", "runtime_error"]]);
    expect(f.latest()).toMatchObject({ state: "needs_input", rawSubtype: "runtime_error", stale: false });
  });

  it("a fork that reports no session file is served as needing input; a preset runner's runtime_error stays unknown", async () => {
    const fork = forkFixture({ runtime: "omo", agentRunner: 2 });
    fork.getState(fork.runner(), null);
    await fork.settle();
    expect(fork.latest()).toMatchObject({ state: "needs_input", rawSubtype: "runtime_error", stale: false });
    const own = forkFixture({ runtime: "dsh", agentRunner: 1 });
    await own.post({ runtime: "dsh", nodeId: "fork-node", sessionName: "worker@fork-test", generation: "fork-current",
      hookEvent: "Notification", subtype: "runtime_error", occurredAt: "2026-11-09T16:20:00.000Z" });
    expect(own.latest()).toMatchObject({ rawSubtype: "runtime_error", stale: false });
    expect(own.latest()?.state).not.toBe("needs_input");
  });
});
