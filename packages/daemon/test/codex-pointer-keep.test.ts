// #1524 (a): a Codex SessionStart without a transcript keeps the seat's saved conversation pointer, and a known
// earlier occupant's hook neither writes nor publishes a current identity. The shipped relay builds each post from a
// synthetic Codex SessionStart stdin; the real activity route and SQLite registry receive it.
import { createRequire } from "node:module";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";

const relay = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs")) as {
  buildSessionIdentityPayload(p: unknown, env: Record<string, string>): Record<string, unknown> | null;
};
const saved = "019a136b-0000-7000-8000-000000000001";
const incoming = "01a136b4-b45d-75d0-8986-5c27cb403397";
const name = "dev-impl@rig-a";

function seat() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = rigRepo.createRig("rig-a");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/work/repo" });
  const session = registry.registerSession(node.id, name);
  registry.updateStatus(session.id, "running");
  const generation = registry.currentOccupantTenure(node.id)?.generationUuid ?? "";
  registry.updateResumeToken(session.id, "codex_id", saved, "hook");
  const app = new Hono();
  app.use("*", async (c, go) => {
    c.set("agentActivityStore" as never, new AgentActivityStore({ db, eventBus }) as never);
    c.set("activityHookToken" as never, "fixture" as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("eventBus" as never, eventBus as never);
    await go();
  });
  app.route("/api/activity", activityRoutes);
  const env = { OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: node.id, OPENRIG_RUNTIME: "codex", OPENRIG_OCCUPANT_GENERATION: generation };
  const post = async (payload: Record<string, unknown> | null) => {
    const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  /** One Codex SessionStart through the shipped relay's payload builder and the real route. */
  const sessionStart = async (stdin: Record<string, unknown>, envOverride: Record<string, string> = {}) => {
    const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: incoming, source: "startup", ...stdin }, { ...env, ...envOverride });
    return { payload, ...(await post(payload)) };
  };
  const token = () => (db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(session.id) as { resume_token: string | null }).resume_token;
  const identityEvents = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.session_identity'").get() as { n: number }).n;
  return { db, registry, node, session, generation, post, sessionStart, token, identityEvents };
}

describe("#1524 (a): the relay forwards whether Codex sent transcript_path, and its raw value", () => {
  it.each([
    ["explicit null", { transcript_path: null }, true, null],
    ["a path", { transcript_path: "/r.jsonl" }, true, "/r.jsonl"],
    ["an empty string", { transcript_path: "" }, true, ""],
    ["a number", { transcript_path: 7 }, true, 7],
  ])("%s", (_label, stdin, present, value) => {
    const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: incoming, ...stdin },
      { OPENRIG_SESSION_NAME: name, OPENRIG_RUNTIME: "codex" });
    expect(payload).toMatchObject({ transcriptPathPresent: present, transcriptPath: value });
  });

  it("an absent key is forwarded as absent, with no value", () => {
    const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: incoming },
      { OPENRIG_SESSION_NAME: name, OPENRIG_RUNTIME: "codex" });
    expect(payload).toMatchObject({ transcriptPathPresent: false });
    expect(payload).not.toHaveProperty("transcriptPath");
  });
});

describe("#1524 (a): a Codex SessionStart's transcript decides whether it replaces the saved pointer", () => {
  it("explicit null keeps the saved pointer, publishes no identity, and says so", async () => {
    const s = seat();
    const before = s.identityEvents();
    const r = await s.sessionStart({ transcript_path: null });
    expect(r.body).toMatchObject({ tokenPersisted: false, code: "transcript_absent" });
    expect(s.token()).toBe(saved);
    expect(s.identityEvents()).toBe(before);
  });

  it.each([
    ["a path", { transcript_path: "/home/u/.codex/sessions/2026/10/20/rollout-x.jsonl" }],
    ["an empty string (unknown, not null)", { transcript_path: "" }],
    ["a number (malformed, not null)", { transcript_path: 7 }],
    ["an object (malformed, not null)", { transcript_path: { path: "/r.jsonl" } }],
    ["an array (malformed, not null)", { transcript_path: ["/r.jsonl"] }],
    ["no transcript_path key", {}],
  ])("%s still writes and publishes, as today", async (_label, stdin) => {
    const s = seat();
    const before = s.identityEvents();
    const r = await s.sessionStart(stdin);
    expect(r.body).toMatchObject({ ok: true, tokenPersisted: true });
    expect(s.token()).toBe(incoming);
    expect(s.identityEvents()).toBe(before + 1);
  });

  it("an older relay's post (no transcriptPathPresent field at all) still writes", async () => {
    const s = seat();
    const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: incoming, transcript_path: null },
      { OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: s.node.id, OPENRIG_RUNTIME: "codex", OPENRIG_OCCUPANT_GENERATION: s.generation })!;
    delete payload.transcriptPathPresent;
    delete payload.transcriptPath;
    const r = await s.post(payload);
    expect(r.body).toMatchObject({ tokenPersisted: true });
    expect(s.token()).toBe(incoming);
  });

  it("an operator-set pointer still holds against a hook that has a transcript, and the event is still published", async () => {
    const s = seat();
    s.registry.updateResumeToken(s.session.id, "codex_id", saved, "operator");
    const before = s.identityEvents();
    const r = await s.sessionStart({ transcript_path: "/r.jsonl" });
    expect(r.body).toMatchObject({ tokenPersisted: false });
    expect(s.token()).toBe(saved);
    expect(s.identityEvents()).toBe(before + 1);
  });
});

describe("#1524 (a): the occupant generation on a Codex SessionStart", () => {
  it("a known earlier occupant's generation neither writes nor publishes", async () => {
    const s = seat();
    // A relaunch registers a new occupant; the first occupant's generation stays registered for the node.
    const second = s.registry.registerSession(s.node.id, name);
    s.registry.updateStatus(second.id, "running");
    s.registry.updateResumeToken(second.id, "codex_id", saved, "hook");
    const current = s.registry.currentOccupantTenure(s.node.id)?.generationUuid;
    expect(current).toBeTruthy();
    expect(current).not.toBe(s.generation);
    expect(s.registry.isOccupantGenerationRegistered(s.node.id, s.generation)).toBe(true);
    const before = s.identityEvents();
    const r = await s.sessionStart({ transcript_path: "/r.jsonl" }, { OPENRIG_OCCUPANT_GENERATION: s.generation });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ tokenPersisted: false, code: "generation_mismatch" });
    expect((s.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(second.id) as { resume_token: string }).resume_token).toBe(saved);
    expect(s.identityEvents()).toBe(before);
  });

  it.each([
    ["absent", ""],
    ["unregistered for this node", "never-registered-generation"],
  ])("a generation that is %s still writes, as today", async (_label, generation) => {
    const s = seat();
    const r = await s.sessionStart({ transcript_path: "/r.jsonl" }, { OPENRIG_OCCUPANT_GENERATION: generation });
    expect(r.body).toMatchObject({ tokenPersisted: true });
    expect(s.token()).toBe(incoming);
  });

  it("a node with no current tenure still writes, as today", async () => {
    const s = seat();
    s.db.prepare("DELETE FROM occupant_tenures WHERE node_id = ?").run(s.node.id);
    const r = await s.sessionStart({ transcript_path: "/r.jsonl" });
    expect(r.body).toMatchObject({ tokenPersisted: true });
    expect(s.token()).toBe(incoming);
  });

  it("an unreadable generation ledger still writes, as today (the broader Pi/OMP gate stays unselected)", async () => {
    const s = seat();
    s.registry.currentOccupantTenure = () => { throw new Error("ledger unreadable"); };
    const r = await s.sessionStart({ transcript_path: "/r.jsonl" });
    expect(r.body).toMatchObject({ tokenPersisted: true });
    expect(s.token()).toBe(incoming);
  });
});
