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
