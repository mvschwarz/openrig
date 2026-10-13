import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { occupantMutationRefusal, requireSenderIdentity, resolveActorWithDeferral } from "../src/routes/require-sender-identity.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("seat runtime switch route", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => db.close());

  it("validates a target runtime before attempting a handover", async () => {
    const { app } = createTestApp(db);
    const response = await app.request("/api/seat/set-runtime/operator-agent%40kernel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "pi", reason: "move the operator" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "invalid_runtime" });
  });

  it("does not interpret a string dry-run as a mutation", async () => {
    const { app } = createTestApp(db);
    const response = await app.request("/api/seat/set-runtime/operator-agent%40kernel", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime: "claude-code", reason: "preview", dryRun: "true" }) });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_runtime_settings" });
  });

  it.each([{ body: null }, { body: [] }, { body: "invalid" }, { body: 1 }, { body: true }])("rejects a non-object JSON body: $body", async ({ body }) => {
    const { app } = createTestApp(db);
    const response = await app.request("/api/seat/set-runtime/operator-agent%40kernel", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "invalid_runtime_settings" });
  });

  function seed(runtime = "codex") {
    const repo = new RigRepository(db), registry = new SessionRegistry(db);
    const rig = repo.createRig("fixture"), node = repo.addNode(rig.id, "dev.owner", { runtime });
    const name = "dev-owner@fixture";
    const session = registry.registerSession(node.id, name); registry.updateStatus(session.id, "running");
    const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
    const headers = (gen: string) => ({ "Content-Type": "application/json", "X-OpenRig-Session": name, "X-OpenRig-Occupant-Generation": gen });
    return { registry, node, name, session, generation, headers };
  }

  it("denies pending/retired CLI mutations while allowing current mutations and status reads", async () => {
    const f = seed();
    const { app } = createTestApp(db);
    const pending = f.registry.reserveOccupantGeneration()!;
    const mutate = (generation: string) => app.request(`/api/seat/set-model/${f.name}`, { method: "POST", headers: f.headers(generation),
      body: JSON.stringify({ model: "selected-model", reason: "fixture" }) });
    expect(await (await mutate(pending)).json()).toMatchObject({ code: "occupant_not_current" });
    f.registry.updateStatus(f.session.id, "superseded");
    f.registry.registerClaimedSession(f.node.id, f.name, "handover", pending);
    expect(await (await mutate(f.generation)).json()).toMatchObject({ code: "occupant_not_current" });
    expect((await mutate(pending)).status).toBe(200);
    expect(db.prepare("SELECT model FROM nodes WHERE id=?").get(f.node.id)).toEqual({ model: "selected-model" });
    expect((await app.request(`/api/seat/status/${f.name}`, { headers: f.headers(f.generation) })).status).toBe(200);
  });

  it("uses the live binding when a newer archived session has the same name", async () => {
    const f = seed(), repo = new RigRepository(db);
    const archived = repo.createRig("archived"), node = repo.addNode(archived.id, "historical", { runtime: "codex" });
    f.registry.registerClaimedSession(node.id, f.name);
    f.registry.updateBinding(node.id, { tmuxSession: f.name, tmuxPane: "%99" });
    db.prepare("UPDATE rigs SET archived_at=datetime('now') WHERE id=?").run(archived.id);
    const { app } = createTestApp(db);
    const response = await app.request(`/api/seat/set-model/${f.name}`, { method: "POST", headers: f.headers(f.generation),
      body: JSON.stringify({ model: "current-model", reason: "fixture" }) });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT model FROM nodes WHERE id=?").get(f.node.id)).toEqual({ model: "current-model" });
  });

  it.each([requireSenderIdentity, resolveActorWithDeferral])("%s rechecks an in-flight actor after body parsing", async helper => {
    const f = seed();
    const app = new Hono();
    let release!: () => void, entered!: () => void;
    const parsed = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    app.use("*", async (c, next) => {
      c.set("sessionRegistry" as never, f.registry as never);
      const refusal = occupantMutationRefusal(c); if (refusal) return refusal;
      await next();
    });
    app.post("/", async c => {
      await c.req.json(); entered(); await parsed;
      const actor = helper(c); return actor.ok ? c.json({ ok: true }) : actor.response;
    });
    const response = app.request("/", { method: "POST", headers: f.headers(f.generation), body: "{}" });
    await started;
    f.registry.updateStatus(f.session.id, "superseded"); f.registry.registerClaimedSession(f.node.id, f.name, "handover");
    release();
    expect((await response).status).toBe(409);
  });

  it.each(["codex", "claude-code"])("prevents another provider's hook from replacing the current %s native token", async runtime => {
    const f = seed(runtime);
    f.registry.updateResumeToken(f.session.id, runtime === "codex" ? "codex_id" : "claude_id", "incumbent-id", "scrape");
    const { app } = createTestApp(db, { activityHookToken: "fixture-token" });
    const response = await app.request("/api/activity/hooks", { method: "POST", headers: { "Content-Type": "application/json", "x-openrig-activity-token": "fixture-token" },
      body: JSON.stringify({ eventFamily: "session_identity", sessionName: f.name, runtime: runtime === "codex" ? "claude-code" : "codex", sessionId: "other-native-id" }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "runtime_mismatch", tokenPersisted: false });
    expect(db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.session.id)).toEqual({ resume_token: "incumbent-id" });
  });

  it("retains a staged generation's new native identity separately from the incumbent", async () => {
    const f = seed(); const reserved = f.registry.reserveOccupantGeneration()!;
    db.prepare(`INSERT INTO seat_runtime_switches (id,node_id,canonical_session,staging_session,predecessor_pane,
      predecessor_generation,successor_generation,from_runtime,to_runtime) VALUES ('switch',?,?,'staging','%1',?,?,'codex','claude-code')`)
      .run(f.node.id, f.name, f.generation, reserved);
    const { app } = createTestApp(db, { activityHookToken: "fixture-token" });
    const response = await app.request("/api/activity/hooks", { method: "POST", headers: { "Content-Type": "application/json", "x-openrig-activity-token": "fixture-token" },
      body: JSON.stringify({ eventFamily: "session_identity", sessionName: f.name, runtime: "claude-code", generation: reserved, sessionId: "target-native-id" }) });
    expect(await response.json()).toMatchObject({ ok: true, tokenPersisted: true, staged: true });
    expect(db.prepare("SELECT successor_resume_token FROM seat_runtime_switches").get()).toEqual({ successor_resume_token: "target-native-id" });
    expect(db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.session.id)).toEqual({ resume_token: null });
  });

  it.each(["codex", "claude-code"])("rejects a retired %s hook even after switching back to that provider", async runtime => {
    const f = seed(runtime);
    f.registry.updateStatus(f.session.id, "superseded");
    const successor = f.registry.registerClaimedSession(f.node.id, f.name, "handover");
    f.registry.updateResumeToken(successor.id, runtime === "codex" ? "codex_id" : "claude_id", "current-native-id", "scrape");
    const { app } = createTestApp(db, { activityHookToken: "fixture-token" });
    const response = await app.request("/api/activity/hooks", { method: "POST", headers: { "Content-Type": "application/json", "x-openrig-activity-token": "fixture-token" },
      body: JSON.stringify({ eventFamily: "session_identity", sessionName: f.name, runtime, generation: f.generation, sessionId: "retired-native-id" }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "generation_mismatch", tokenPersisted: false });
    expect(db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(successor.id)).toEqual({ resume_token: "current-native-id" });
  });
});
