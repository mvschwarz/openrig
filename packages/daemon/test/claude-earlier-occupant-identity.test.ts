// #2768: after a handover commits, the seat's earlier Claude occupant (its generation still registered for the node) can
// still emit SessionStart. That hook must not move the seat's resume target off the current occupant's conversation, as
// a Codex seat's earlier occupant already can't (#1524). The shipped relay builds each post from a synthetic Claude
// SessionStart stdin; the real activity route and SQLite registry receive it.
import { createRequire } from "node:module";
import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
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
const current = "33333333-3333-4333-8333-333333333333";
const earlier = "44444444-4444-4444-8444-444444444444";
const name = "dev-impl@rig-a";

/** A seat whose first occupant A handed over to B, committed; B has its own saved conversation. */
function handedOver() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = rigRepo.createRig("rig-a");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/repo" });
  const first = registry.registerSession(node.id, name);
  registry.updateStatus(first.id, "running");
  const generationA = registry.currentOccupantTenure(node.id)?.generationUuid ?? "";
  const generationB = registry.reserveOccupantGeneration()!;
  const successor = registry.registerClaimedSession(node.id, name, "handover", generationB);
  registry.updateStatus(successor.id, "running");
  registry.updateResumeToken(successor.id, "claude_id", current, "hook");
  const app = new Hono();
  app.use("*", async (c, go) => {
    c.set("agentActivityStore" as never, new AgentActivityStore({ db, eventBus }) as never);
    c.set("activityHookToken" as never, "fixture" as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("eventBus" as never, eventBus as never);
    await go();
  });
  app.route("/api/activity", activityRoutes);
  const env: Record<string, string> = { OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: node.id, OPENRIG_RUNTIME: "claude-code" };
  /** One Claude SessionStart naming `sessionId`, carrying `generation` (null: no generation), through the relay and route. */
  const sessionStart = async (generation: string | null, sessionId = earlier) => {
    const envFor = generation === null ? env : { ...env, OPENRIG_OCCUPANT_GENERATION: generation };
    const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: sessionId, source: "startup" }, envFor);
    const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const tokenOf = (id: string) => (db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(id) as { resume_token: string | null }).resume_token;
  const identityEvents = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.session_identity'").get() as { n: number }).n;
  return { registry, node, successor, generationA, generationB, sessionStart, tokenOf, identityEvents };
}

it("the earlier occupant's SessionStart keeps the current occupant's resume target and is refused as a mismatch", async () => {
  const s = handedOver();
  expect(s.registry.isOccupantGenerationRegistered(s.node.id, s.generationA)).toBe(true);
  const events = s.identityEvents();
  const r = await s.sessionStart(s.generationA);
  expect(s.tokenOf(s.successor.id)).toBe(current);
  expect(s.identityEvents()).toBe(events);
  expect(r.status).toBe(409);
  expect(r.body).toMatchObject({ ok: false, code: "generation_mismatch", tokenPersisted: false });
});

it("the current occupant's own SessionStart still moves its resume target", async () => {
  const s = handedOver();
  expect((await s.sessionStart(s.generationB, earlier)).body).toMatchObject({ ok: true, tokenPersisted: true });
  expect(s.tokenOf(s.successor.id)).toBe(earlier);
});

it("a post with no generation keeps today's write", async () => {
  const s = handedOver();
  expect((await s.sessionStart(null)).body).toMatchObject({ ok: true, tokenPersisted: true });
  expect(s.tokenOf(s.successor.id)).toBe(earlier);
});

it("a generation never registered for the seat is still uncommitted, not a mismatch", async () => {
  const s = handedOver();
  const reserved = s.registry.reserveOccupantGeneration()!;
  const r = await s.sessionStart(reserved);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, tokenPersisted: false, code: "generation_uncommitted" });
  expect(s.tokenOf(s.successor.id)).toBe(current);
});
