// Slice 13 (#3270 round 1): the hook bridge's routes through the real router. A waiter's activity grant is bound exactly as
// the activity route binds it, once the body has arrived: a pending, stale or wrong-generation grant, one for another
// seat, and one revoked while its body arrives are all refused, and nothing is claimed. A person's terminal with no seat
// identity can opt a seat in; the change is recorded as unattributed.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { HookBridge, UNATTRIBUTED_ACTOR } from "../src/domain/hook-bridge.js";
import { hookBridgeRoutes } from "../src/routes/hook-bridge.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const SEAT = "dev-impl@team", OTHER = "dev-other@team", INSTALL_TOKEN = "install-token";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("team");
  const seat = rigs.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const other = rigs.addNode(rig.id, "dev.other", { runtime: "claude-code" });
  const sessions = new SessionRegistry(db);
  const occupy = (nodeId: string, name: string, kind?: "handover", reserved?: string) => {
    const session = sessions.registerSession(nodeId, name, kind, reserved);
    sessions.updateStatus(session.id, "running");
  };
  occupy(seat.id, SEAT);
  occupy(other.id, OTHER);
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db),
    resolveOccupantGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name), async () => {});
  const bridge = new HookBridge(db, { lease: (id, fn) => guard.exclusive(id, fn) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, INSTALL_TOKEN as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("tmuxAdapter" as never, { deliveryGuard: guard } as never);
    c.set("hookBridge" as never, bridge as never);
    await next();
  });
  app.route("/api/hook-bridge", hookBridgeRoutes);
  const grants = new ActivityGrantStore(db);
  const generation = (nodeId: string) => sessions.currentOccupantTenure(nodeId)!.generationUuid;
  const issue = (nodeId = seat.id, gen = generation(seat.id)) => grants.issue({ nodeId, generation: gen, issuedBy: "launch" });
  async function post(path: string, token: string | null, body: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.request(`/api/hook-bridge/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }
  /** A post whose body arrives only when released, so a test can act while the route reads it. */
  function heldPost(path: string, token: string, body: unknown) {
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) { started(); await gate; controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 });
    const response = app.request(`/api/hook-bridge/${path}`, { method: "POST", body: stream, duplex: "half",
      headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" } } as RequestInit)
      .then(async (res) => ({ status: res.status, body: await res.json() as Record<string, unknown> }));
    return { reading, release, response };
  }
  return { db, seat, other, sessions, guard, bridge, grants, generation, issue, post, heldPost, replace: (reserved?: string) => occupy(seat.id, SEAT, "handover", reserved) };
}

const armBody = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) => ({ sessionName: SEAT, generation: f.generation(f.seat.id), hookEvent: "Stop", ...extra });

describe("the hook bridge's routes (slice 13, #3270 round 1)", () => {
  it("records an opt-in from a terminal with no seat identity as unattributed, and still needs a reason", async () => {
    const f = fixture();
    expect(await f.post(`seat/${SEAT}`, null, { enabled: true, reason: "wake at turn boundaries" }))
      .toMatchObject({ status: 200, body: { ok: true, preference: { desired: true, actor: UNATTRIBUTED_ACTOR } } });
    expect(await f.post(`seat/${SEAT}`, null, { enabled: true, reason: " " })).toMatchObject({ status: 400, body: { code: "hook_bridge_reason_required" } });
  });

  it("arms a waiter whose grant is current for its own seat and generation", async () => {
    const f = fixture();
    f.bridge.setPreference(f.seat.id, true, "human@team", "on");
    const grant = f.issue();
    expect(await f.post("arm", grant.token, armBody(f))).toMatchObject({ status: 200, body: { ok: true, armId: expect.any(String) } });
  });

  it("refuses a grant naming another generation, a grant for another seat, a stale grant and a pending one", async () => {
    const f = fixture();
    f.bridge.setPreference(f.seat.id, true, "human@team", "on");
    const grant = f.issue();
    expect(await f.post("arm", grant.token, armBody(f, { generation: "11111111-1111-4111-8111-111111111111" })))
      .toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    const others = f.issue(f.other.id, f.generation(f.other.id));
    expect(await f.post("arm", others.token, armBody(f))).toMatchObject({ status: 403, body: { code: "activity_grant_wrong_seat" } });
    f.replace();
    expect(await f.post("arm", grant.token, armBody(f))).toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    const reserved = f.sessions.reserveOccupantGeneration()!;
    const pending = f.issue(f.seat.id, reserved);
    expect(await f.post("arm", pending.token, { sessionName: SEAT, hookEvent: "Stop" })).toMatchObject({ status: 409, body: { code: "activity_grant_pending" } });
  });

  it("refuses a grant revoked while its poll's body arrives, and claims nothing", async () => {
    const f = fixture();
    f.bridge.setPreference(f.seat.id, true, "human@team", "on");
    const grant = f.issue();
    const armed = await f.post("arm", grant.token, armBody(f));
    const target = { nodeId: f.seat.id, session: SEAT, occupant: f.generation(f.seat.id), pane: "%1" };
    f.bridge.deposit(target, SEAT, "From: peer@team\n---\nhello\n---", { actorSession: "peer@team" }, ["m1"]);
    const held = f.heldPost("poll", grant.token, armBody(f, { armId: armed.body.armId }));
    await held.reading;
    f.grants.revoke({ grantId: grant.grantId }, "test");
    held.release();
    expect(await held.response).toMatchObject({ status: 401, body: { code: "activity_grant_revoked" } });
    expect(f.bridge.queued(f.seat.id).map((r) => r.outboxId)).toEqual(["m1"]);
  });
  // #3270 round 2 (optional): a JSON null body is a bad request, never a crash.
  it("answers a waiter route whose body is JSON null as a refusal, not a server error", async () => {
    const f = fixture();
    const res = await f.post("arm", INSTALL_TOKEN, null);
    expect(res.status).toBeLessThan(500);
    expect(res.body).toMatchObject({ ok: false });
  });
  // #3270 round 3, R3-F1: a poll waiting for the seat's lease is checked again once it has it.
  const holdLease = (f: ReturnType<typeof fixture>) => {
    let release!: () => void;
    const held = f.guard.exclusive(f.seat.id, () => new Promise<void>((r) => { release = r; }));
    return { release: async () => { release(); await held; } };
  };
  const queueOne = (f: ReturnType<typeof fixture>, id: string) => f.bridge.deposit({ nodeId: f.seat.id, session: SEAT, occupant: f.generation(f.seat.id), pane: "%1" },
    SEAT, "From: peer@team\n---\nhello\n---", { actorSession: "peer@team" }, [id]);

  it("refuses a poll whose grant was revoked while it waited for the seat's lease, and claims nothing", async () => {
    const f = fixture();
    f.bridge.setPreference(f.seat.id, true, "human@team", "on");
    const grant = f.issue();
    const armed = await f.post("arm", grant.token, armBody(f));
    queueOne(f, "m1");
    const lease = holdLease(f);
    const polling = f.post("poll", grant.token, armBody(f, { armId: armed.body.armId }));
    await new Promise((r) => setTimeout(r, 30));
    f.grants.revoke({ grantId: grant.grantId }, "test");
    await lease.release();
    expect(await polling).toMatchObject({ status: 401, body: { code: "activity_grant_revoked" } });
    expect(f.bridge.queued(f.seat.id).map((r) => r.outboxId)).toEqual(["m1"]);
  });

  it("refuses a poll whose occupant was replaced while it waited for the seat's lease, and claims nothing", async () => {
    const f = fixture();
    f.bridge.setPreference(f.seat.id, true, "human@team", "on");
    const armed = await f.post("arm", INSTALL_TOKEN, armBody(f));
    queueOne(f, "m1");
    const lease = holdLease(f);
    const polling = f.post("poll", INSTALL_TOKEN, armBody(f, { armId: armed.body.armId }));
    await new Promise((r) => setTimeout(r, 30));
    f.replace();
    await lease.release();
    expect(await polling).toMatchObject({ status: 409, body: { code: "hook_bridge_stale_occupant" } });
    expect(f.bridge.queued(f.seat.id).map((r) => r.outboxId)).toEqual(["m1"]);
  });

  it("still delivers once to a poll whose authority didn't change while it waited", async () => {
    const f = fixture();
    f.bridge.setPreference(f.seat.id, true, "human@team", "on");
    const grant = f.issue();
    const armed = await f.post("arm", grant.token, armBody(f));
    queueOne(f, "m1");
    const lease = holdLease(f);
    const polling = f.post("poll", grant.token, armBody(f, { armId: armed.body.armId }));
    await new Promise((r) => setTimeout(r, 30));
    await lease.release();
    const answer = await polling;
    expect(answer).toMatchObject({ status: 200, body: { action: "deliver" } });
    expect((answer.body.messages as Array<{ outboxId: string }>).map((m) => m.outboxId)).toEqual(["m1"]);
  });

  it("answers the opt-in route's JSON null body as a refusal, not a server error (optional)", async () => {
    const f = fixture();
    const res = await f.post(`seat/${SEAT}`, null, null);
    expect(res.status).toBe(400);
  });
});
