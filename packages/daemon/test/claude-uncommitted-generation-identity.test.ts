// #2341: a handover starts its successor Claude on a reserved occupant generation, which the seat registers only when
// the handover commits. Until then (and for good, if the handover fails) that Claude's SessionStart must not move the
// seat's resume target off the occupant it still has. The shipped relay builds each post from a synthetic Claude
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
const saved = "11111111-1111-4111-8111-111111111111";
const incoming = "22222222-2222-4222-8222-222222222222";
const name = "dev-impl@rig-a";

function seat() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = rigRepo.createRig("rig-a");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/repo" });
  const session = registry.registerSession(node.id, name);
  registry.updateStatus(session.id, "running");
  const generation = registry.currentOccupantTenure(node.id)?.generationUuid ?? "";
  registry.updateResumeToken(session.id, "claude_id", saved, "hook");
  const app = new Hono();
  app.use("*", async (c, go) => {
    c.set("agentActivityStore" as never, new AgentActivityStore({ db, eventBus }) as never);
    c.set("activityHookToken" as never, "fixture" as never);
    c.set("sessionRegistry" as never, registry as never);
    c.set("eventBus" as never, eventBus as never);
    await go();
  });
  app.route("/api/activity", activityRoutes);
  const env: Record<string, string> = { OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: node.id, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation };
  /** One Claude SessionStart, as a fresh launch reports it, through the shipped relay and the real route. */
  const sessionStart = async (generationOverride?: string | null) => {
    const envFor = { ...env };
    if (generationOverride === null) delete envFor.OPENRIG_OCCUPANT_GENERATION;
    else if (generationOverride !== undefined) envFor.OPENRIG_OCCUPANT_GENERATION = generationOverride;
    const payload = relay.buildSessionIdentityPayload({ hook_event_name: "SessionStart", session_id: incoming, source: "startup" }, envFor);
    const res = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const tokenOf = (id: string) => (db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(id) as { resume_token: string | null }).resume_token;
  const identityEvents = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.session_identity'").get() as { n: number }).n;
  return { registry, node, session, sessionStart, tokenOf, identityEvents };
}

it("an uncommitted successor's SessionStart keeps the seat's resume target and says why", async () => {
  const s = seat();
  const reserved = s.registry.reserveOccupantGeneration()!;
  const events = s.identityEvents();
  const r = await s.sessionStart(reserved);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, tokenPersisted: false, code: "generation_uncommitted" });
  expect(s.tokenOf(s.session.id)).toBe(saved);
  expect(s.identityEvents()).toBe(events);
});

it("the seat's registered current generation still moves its resume target", async () => {
  const s = seat();
  expect((await s.sessionStart()).body).toMatchObject({ ok: true, tokenPersisted: true });
  expect(s.tokenOf(s.session.id)).toBe(incoming);
});

it("once the handover commits that generation, the same SessionStart moves the new session's resume target", async () => {
  const s = seat();
  const reserved = s.registry.reserveOccupantGeneration()!;
  await s.sessionStart(reserved);
  const successor = s.registry.registerClaimedSession(s.node.id, name, "handover", reserved);
  expect((await s.sessionStart(reserved)).body).toMatchObject({ ok: true, tokenPersisted: true });
  expect(s.tokenOf(successor.id)).toBe(incoming);
  expect(s.tokenOf(s.session.id)).toBe(saved);
});

it("a post that carries no generation keeps today's write", async () => {
  const s = seat();
  expect((await s.sessionStart(null)).body).toMatchObject({ ok: true, tokenPersisted: true });
  expect(s.tokenOf(s.session.id)).toBe(incoming);
});
