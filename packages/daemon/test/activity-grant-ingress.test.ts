// A seat activity grant on the existing hook ingress, through the real route, store, occupant ledger and oracle. The
// grant is resolved first; only then is the seat and generation a post claims accepted. A refused post records nothing,
// so the seat's activity stays unknown. The install-wide token keeps today's behaviour.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes, restoredRunnerHookEvidence } from "../src/routes/activity.js";
import * as activityModule from "../src/routes/activity.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";
import { createFullTestDb } from "./helpers/test-app.js";

const GUEST = "dev-guest@guest-rig", OTHER = "dev-other@guest-rig", INSTALL_TOKEN = "install-token";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** Two runner seats on one rig: the guest, which holds the grant, and another seat. `guest` mounts the guest router, as a
 *  guest-only listener does, instead of the main activity routes; it has no install-wide token. */
function fixture(options: { guest?: boolean } = {}) {
  const clock = { now: Date.parse("2026-10-30T03:00:00.000Z") };
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("guest-rig");
  const guest = rigs.addNode(rig.id, "dev.guest", { runtime: "synth" });
  const other = rigs.addNode(rig.id, "dev.other", { runtime: "synth" });
  const sessions = new SessionRegistry(db);
  const occupy = (nodeId: string, name: string, kind?: "handover", reserved?: string) => {
    const session = sessions.registerSession(nodeId, name, kind, reserved);
    sessions.updateStatus(session.id, "running");
    sessions.recordCommunityHarnessSelection(session.id, "synth", true);
  };
  occupy(guest.id, GUEST);
  occupy(other.id, OTHER);
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(clock.now),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
    now: () => new Date(clock.now), restoreHookEvidence: (seat, seatRuntime) => restoredRunnerHookEvidence(store, seat, seatRuntime) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    if (!options.guest) c.set("activityHookToken" as never, INSTALL_TOKEN as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("seatActivityService" as never, oracle as never);
    await next();
  });
  const guestRoutes = (activityModule as unknown as Record<string, Hono | undefined>).guestActivityRoutes;
  if (options.guest && !guestRoutes) throw new Error("routes/activity.ts exports no guestActivityRoutes");
  app.route("/api/activity", options.guest ? guestRoutes! : activityRoutes);
  const grants = new ActivityGrantStore(db, () => new Date(clock.now));
  const generation = (nodeId: string) => sessions.currentOccupantTenure(nodeId)!.generationUuid;
  const issue = (gen = generation(guest.id)) => grants.issue({ nodeId: guest.id, generation: gen, issuedBy: "driver@test" });
  /** A runner's post; `body` is sent as given, so a test can send malformed JSON. */
  async function post(token: string | null, body: unknown, header: "bearer" | "x-openrig-activity-token" = "bearer") {
    clock.now += 1000;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token !== null) headers[header === "bearer" ? "authorization" : header] = header === "bearer" ? `Bearer ${token}` : token;
    const response = await app.request("/api/activity/hooks", { method: "POST", headers,
      body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  /** A post whose body arrives only when released, so a test can act after the route authenticated it and while it reads
   *  the body. The stream has no buffer, so it's read only when the route asks for the body. */
  function heldPost(token: string, body: unknown) {
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) { started(); await gate; controller.enqueue(bytes); controller.close(); },
    }, { highWaterMark: 0 });
    clock.now += 1000;
    const response = app.request("/api/activity/hooks", { method: "POST", body: stream, duplex: "half",
      headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" } } as RequestInit)
      .then(async (res) => ({ status: res.status, body: await res.json() as Record<string, unknown> }));
    return { reading, release, response };
  }
  /** Any request to the mounted app, for the paths a guest must not reach. */
  async function raw(method: string, path: string, token: string) {
    const response = await app.request(path, { method,
      headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
    return response.status;
  }
  const event = (hookEvent: string, subtype: string, identity: Record<string, unknown> = {}) =>
    ({ runtime: "synth", hookEvent, subtype, occurredAt: new Date(clock.now + 1000).toISOString(), ...identity });
  const recorded = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.activity'").get() as { n: number }).n;
  const activity = (nodeId: string) => oracle.getSeatState(nodeId)?.activity ?? "unknown";
  const replace = (reserved?: string) => occupy(guest.id, GUEST, "handover", reserved);
  return { guest, other, sessions, grants, generation, issue, post, heldPost, raw, event, recorded, activity, replace };
}

describe("a seat activity grant on the hook ingress", () => {
  it("speaks for its own seat: the runner's posts decide the seat's activity, with the seat and generation from the grant", async () => {
    const f = fixture();
    const grant = f.issue();
    expect(await f.post(grant.token, f.event("UserPromptSubmit", "accepted", { sessionName: GUEST }))).toMatchObject({ status: 200 });
    expect(f.activity(f.guest.id)).toBe("working");
    // A guest may leave out the seat and generation; the grant supplies them.
    const idle = await f.post(grant.token, f.event("Stop", "end_turn"), "x-openrig-activity-token");
    expect(idle).toMatchObject({ status: 200, body: { activity: { generation: grant.generation } } });
    expect(f.activity(f.guest.id)).toBe("idle-at-prompt");
    expect(f.recorded()).toBe(2);
  });

  it("keeps the install-wide token's behaviour for every seat", async () => {
    const f = fixture();
    f.issue();
    for (const [nodeId, sessionName] of [[f.guest.id, GUEST], [f.other.id, OTHER]] as const) {
      expect(await f.post(INSTALL_TOKEN, f.event("UserPromptSubmit", "accepted", { sessionName, nodeId, generation: f.generation(nodeId) })))
        .toMatchObject({ status: 200 });
      expect(f.activity(nodeId)).toBe("working");
    }
  });

  const wrongSeat: Array<[string, (f: ReturnType<typeof fixture>) => Record<string, unknown>]> = [
    ["another seat's name", () => ({ sessionName: OTHER })],
    ["another seat's node", (f) => ({ nodeId: f.other.id })],
    ["its own node with another seat's name", (f) => ({ nodeId: f.guest.id, sessionName: OTHER })],
    ["a seat that doesn't exist", () => ({ sessionName: "dev-nobody@guest-rig" })],
  ];
  it.each(wrongSeat)("refuses a post naming %s, and records nothing", async (_case, identity) => {
    const f = fixture();
    const grant = f.issue();
    expect(await f.post(grant.token, f.event("Stop", "end_turn", identity(f))))
      .toMatchObject({ status: 403, body: { code: "activity_grant_wrong_seat" } });
    expect(f.recorded()).toBe(0);
    expect(f.activity(f.other.id)).toBe("unknown");
  });

  it("refuses a post claiming a generation its grant wasn't issued for", async () => {
    const f = fixture();
    const grant = f.issue();
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { generation: "another-generation" })))
      .toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    expect(f.recorded()).toBe(0);
  });

  it("refuses a replaced occupant's grant as stale", async () => {
    const f = fixture();
    const grant = f.issue();
    f.replace();
    expect(await f.post(grant.token, f.event("Stop", "end_turn"))).toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    expect(f.recorded()).toBe(0);
  });

  it("refuses a grant for a launch that hasn't registered its occupant yet, then accepts it once it has", async () => {
    const f = fixture();
    const reserved = f.sessions.reserveOccupantGeneration()!;
    const grant = f.issue(reserved);
    expect(await f.post(grant.token, f.event("UserPromptSubmit", "accepted"))).toMatchObject({ status: 409, body: { code: "activity_grant_pending" } });
    expect(f.recorded()).toBe(0);
    f.replace(reserved);
    expect(await f.post(grant.token, f.event("UserPromptSubmit", "accepted"))).toMatchObject({ status: 200 });
    expect(f.activity(f.guest.id)).toBe("working");
  });

  it("refuses a revoked grant, including one replaced by a reissue", async () => {
    const f = fixture();
    const first = f.issue();
    const second = f.issue();
    expect(await f.post(first.token, f.event("Stop", "end_turn"))).toMatchObject({ status: 401, body: { code: "activity_grant_revoked" } });
    expect(await f.post(second.token, f.event("UserPromptSubmit", "accepted"))).toMatchObject({ status: 200 });
    f.grants.revoke({ nodeId: f.guest.id }, "stopped");
    expect(await f.post(second.token, f.event("Stop", "end_turn"))).toMatchObject({ status: 401, body: { code: "activity_grant_revoked" } });
    expect(f.recorded()).toBe(1);
    expect(f.activity(f.guest.id)).toBe("working");
  });

  it.each(["revoked", "reissued"] as const)("refuses a post whose grant was %s while its body was arriving, and records nothing", async (change) => {
    const f = fixture();
    const grant = f.issue();
    const held = f.heldPost(grant.token, f.event("Stop", "end_turn"));
    await held.reading;
    if (change === "revoked") f.grants.revoke({ nodeId: f.guest.id }, "stopped");
    else f.issue();
    held.release();
    expect(await held.response).toMatchObject({ status: 401, body: { code: "activity_grant_revoked" } });
    expect(f.recorded()).toBe(0);
    expect(f.activity(f.guest.id)).toBe("unknown");
  });

  it.each([
    ["an unknown grant", `oag_${"0".repeat(64)}`],
    ["another token", "not-the-token"],
    ["no token", null],
  ])("refuses %s as unauthorized", async (_case, token) => {
    const f = fixture();
    f.issue();
    expect(await f.post(token, f.event("Stop", "end_turn", { sessionName: GUEST })))
      .toMatchObject({ status: 401, body: { code: "activity_hook_unauthorized" } });
    expect(f.recorded()).toBe(0);
  });

  it.each([["broken JSON", "{"], ["null", "null"], ["a list", "[]"]])("refuses %s from a grant holder", async (_case, raw) => {
    const f = fixture();
    const grant = f.issue();
    expect(await f.post(grant.token, raw)).toMatchObject({ status: 400, body: { code: "invalid_json" } });
    expect(f.recorded()).toBe(0);
  });

  it("leaves a seat unknown, never idle, when every post was refused", async () => {
    const f = fixture();
    const grant = f.issue();
    await f.post(grant.token, f.event("Stop", "end_turn", { sessionName: OTHER }));
    await f.post(grant.token, f.event("Stop", "end_turn", { generation: "another-generation" }));
    f.grants.revoke({ nodeId: f.guest.id }, "stopped");
    await f.post(grant.token, f.event("Stop", "end_turn"));
    expect(f.recorded()).toBe(0);
    expect(f.activity(f.guest.id)).toBe("unknown");
    expect(f.activity(f.other.id)).toBe("unknown");
  });
});

describe("the guest router: only the hook post, and only for a grant", () => {
  it("takes a grant's post for its own seat", async () => {
    const f = fixture({ guest: true });
    const grant = f.issue();
    expect(await f.post(grant.token, f.event("UserPromptSubmit", "accepted"))).toMatchObject({ status: 200 });
    expect(f.activity(f.guest.id)).toBe("working");
  });

  it("refuses the install-wide token", async () => {
    const f = fixture({ guest: true });
    f.issue();
    expect(await f.post(INSTALL_TOKEN, f.event("Stop", "end_turn", { sessionName: GUEST, nodeId: f.guest.id, generation: f.generation(f.guest.id) })))
      .toMatchObject({ status: 401, body: { code: "activity_hook_unauthorized" } });
    expect(f.recorded()).toBe(0);
  });

  it.each([
    ["GET", "/api/activity/hooks"], ["GET", "/api/activity/events"], ["GET", "/api/activity/parked?rig=guest-rig"],
    ["POST", "/api/activity/pi-usage"], ["POST", "/api/activity/pi-usage-charges"], ["PUT", "/api/activity/hooks"],
    ["POST", "/api/config"], ["POST", "/api/queue"],
  ])("serves nothing at %s %s", async (method, path) => {
    const f = fixture({ guest: true });
    const grant = f.issue();
    expect(await f.raw(method, path, grant.token)).toBe(404);
    expect(f.recorded()).toBe(0);
  });

  it("still refuses another seat, another generation and a revoked grant, and records nothing", async () => {
    const f = fixture({ guest: true });
    const grant = f.issue();
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { sessionName: OTHER })))
      .toMatchObject({ status: 403, body: { code: "activity_grant_wrong_seat" } });
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { generation: "another-generation" })))
      .toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    f.grants.revoke({ nodeId: f.guest.id }, "stopped");
    expect(await f.post(grant.token, f.event("Stop", "end_turn"))).toMatchObject({ status: 401, body: { code: "activity_grant_revoked" } });
    expect(f.recorded()).toBe(0);
    expect(f.activity(f.guest.id)).toBe("unknown");
  });
});
