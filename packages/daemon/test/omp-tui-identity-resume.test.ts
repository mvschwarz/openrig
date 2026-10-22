// The native-TUI seat hosts the OMP process: its runner announces the "omp"
// runtime, while the seat's own runtime is "omp-tui". The identity route must
// accept that announcement — a strict runtime comparison refused it, so the
// seat never received a resume token and could never be resumed. The seat's
// runtime (not the emitter's) decides the resume type.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { RigEvent } from "../src/domain/types.js";
import { activityRoutes } from "../src/routes/activity.js";

const NODE = "omp-tui-node";
const NAME = "worker@omp-tui-test";
const GENERATION = "generation-current";

const databases: Database.Database[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(seatRuntime: string) {
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
    INSERT INTO nodes VALUES ('${NODE}', 'rig', '${seatRuntime}');
    INSERT INTO sessions(id, node_id, session_name) VALUES (1, '${NODE}', '${NAME}');
    INSERT INTO occupant_tenures VALUES ('current', '${NODE}', 1, '${GENERATION}', 'fresh', NULL, '2026-10-21');
  `);
  const events: RigEvent[] = [];
  const eventBus = { emit(event: RigEvent) { events.push(event); return event; } } as EventBus;
  const registry = new SessionRegistry(db);
  const store = new AgentActivityStore({ db, eventBus });
  // The seat's own runner sidecar: the seat's session file, materialized.
  const ownFile = { current: "" };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    c.set("runtimeAdapters" as never, {
      omp: { readSessionFile: () => (ownFile.current ? { ok: true, sessionFile: ownFile.current } : { ok: false, reason: "missing_sidecar" }) },
    } as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tui-identity-"));
  roots.push(root);
  const sessionFile = path.join(root, "turn.jsonl");
  fs.writeFileSync(sessionFile, "persisted turn");
  ownFile.current = sessionFile;
  const post = (payload: Record<string, unknown>) => app.request("/api/activity/hooks", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
    body: JSON.stringify({
      eventFamily: "session_identity", nodeId: NODE, sessionName: NAME, sessionId: "native-session",
      sessionFile, generation: GENERATION, ...payload,
    }),
  });
  const token = () => db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1").get() as {
    resume_type: string | null; resume_token: string | null; resume_provenance: string | null;
  };
  return { db, events, post, sessionFile, token };
}

describe("the omp-tui seat's session identity", () => {
  it("accepts the OMP process's announcement and stamps the seat's own resume type", async () => {
    const f = fixture("omp-tui");
    // The runner behind the native TUI reports the OMP process runtime.
    const res = await f.post({ runtime: "omp" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tokenPersisted: true, provenance: "bridge" });
    expect(f.token()).toMatchObject({
      resume_type: "omp-tui_session_file",
      resume_token: f.sessionFile,
      resume_provenance: "hook",
    });
    expect(f.events).toEqual([expect.objectContaining({
      type: "agent.session_identity",
      runtime: "omp-tui",
      provenance: "bridge",
      sessionId: "native-session",
    })]);
  });

  it("refuses an identity from another runtime and persists nothing", async () => {
    const f = fixture("omp-tui");
    const res = await f.post({ runtime: "codex" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "runtime_mismatch", tokenPersisted: false });
    expect(f.token()).toMatchObject({ resume_type: null, resume_token: null });
    expect(f.events).toEqual([]);
  });

  it("keeps an omp seat exclusive: an omp-tui-labelled emitter cannot claim it", async () => {
    const f = fixture("omp");
    const res = await f.post({ runtime: "omp-tui" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "runtime_mismatch", tokenPersisted: false });
    expect(f.token()).toMatchObject({ resume_type: null, resume_token: null });
    expect(f.events).toEqual([]);
  });
});
