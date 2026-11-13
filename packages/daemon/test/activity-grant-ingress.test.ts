import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { piUsageEntriesSchema } from "../src/db/migrations/107_pi_usage_entries.js";
import { piUsageChargesSchema } from "../src/db/migrations/108_pi_usage_charges.js";
// A seat activity grant on the existing hook ingress, through the real route, store, occupant ledger and oracle. The
// grant is resolved first; only then is the seat and generation a post claims accepted. A refused post records nothing,
// so the seat's activity stays unknown. The install-wide token keeps today's behaviour.
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus, now: () => new Date(clock.now),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
    now: () => new Date(clock.now), restoreHookEvidence: (seat, seatRuntime) => restoredRunnerHookEvidence(store, seat, seatRuntime) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    if (!options.guest) c.set("activityHookToken" as never, INSTALL_TOKEN as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("eventBus" as never, eventBus as never);
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
  return { clock, store, eventBus, db, app, guest, other, sessions, grants, generation, issue, post, heldPost, raw, event, recorded, activity, replace };
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

  it("requires bound authority for a claimed run even when install and generation are known", async () => {
    const f = fixture();
    const legacy = f.issue();
    for (const token of [INSTALL_TOKEN, legacy.token]) {
      expect(await f.post(token, f.event("Stop", "end_turn", { sessionName: GUEST, runId: "claimed-run" })))
        .toMatchObject({ status: 403, body: { code: "run_grant_required" } });
    }
    expect(f.recorded()).toBe(0);
  });

  it("checks activation, run ID and the concrete binding before accepting run activity", async () => {
    const f = fixture();
    const row = f.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(f.guest.id) as { id: string };
    f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('b',?,?,'%1')").run(f.guest.id, GUEST);
    const grant = f.grants.issue({ nodeId: f.guest.id, generation: f.generation(f.guest.id), issuedBy: "launch", run: {
      runId: "actual-attempt", sessionId: row.id, binding: { runtime: "synth", runner: 1, pane: "%1", panePid: 101 } } });
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { runId: grant.runId }))).toMatchObject({ status: 409, body: { code: "activity_grant_pending" } });
    expect(f.grants.activate(grant.grantId)).toBe(true);
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { runId: "forged" }))).toMatchObject({ status: 409 });
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { runId: grant.runId }))).toMatchObject({ status: 200 });
    f.db.prepare("UPDATE bindings SET tmux_pane = '%2' WHERE node_id = ?").run(f.guest.id);
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { runId: grant.runId }))).toMatchObject({ status: 409 });
    expect(f.recorded()).toBe(1);
  });

  it("refuses unverified run activity without recording or revoking, then recovers", async () => {
    const f = fixture();
    const row = f.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(f.guest.id) as { id: string };
    f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('b',?,?,'%1')").run(f.guest.id, GUEST);
    const grant = f.grants.issue({ nodeId: f.guest.id, generation: f.generation(f.guest.id), issuedBy: "launch", run: {
      runId: "temporarily-unverified", sessionId: row.id, binding: { runtime: "synth", runner: 1, pane: "%1", panePid: 101 } } });
    expect(f.grants.activate(grant.grantId)).toBe(true);
    const read = vi.spyOn(SeatIdentityStore.prototype, "getForNode").mockImplementation(() => { throw new Error("observation unavailable"); });
    try {
      expect(await f.post(grant.token, f.event("Stop", "end_turn", { runId: grant.runId })))
        .toMatchObject({ status: 409, body: { code: "activity_grant_unverified", retryable: true } });
      expect(f.recorded()).toBe(0);
      expect(f.grants.get(grant.grantId)?.revokedAt).toBeNull();
    } finally { read.mockRestore(); }
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { runId: grant.runId }))).toMatchObject({ status: 200 });
    expect(f.recorded()).toBe(1);
    f.db.prepare("UPDATE bindings SET tmux_pane = '%2' WHERE node_id = ?").run(f.guest.id);
    expect(await f.post(grant.token, f.event("Stop", "end_turn", { runId: grant.runId })))
      .toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    expect(f.recorded()).toBe(1);
  });

  it("allows a retained Pi run to reannounce identity after explicit same-process adoption", async () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET runtime = 'pi' WHERE id = ?").run(f.guest.id);
    f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('b',?,?,'%1')").run(f.guest.id, GUEST);
    const row = f.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(f.guest.id) as { id: string };
    const grant = f.grants.issue({ nodeId: f.guest.id, generation: f.generation(f.guest.id), issuedBy: "launch", run: {
      runId: "retained-pi", sessionId: row.id, binding: { runtime: "pi", runner: 0, pane: "%1", panePid: 101 } } });
    f.grants.activate(grant.grantId);
    new SeatIdentityStore(f.db).upsert({ nodeId: f.guest.id, verdict: "unconfirmed", evidenceSource: "pane_process", reason: null,
      sessionName: GUEST, observedAt: new Date().toISOString(), evidence: { registeredPane: "%1", observedPid: 101,
        observedPanePid: 101, observedCommand: "node", matchedLayer: null } });
    f.sessions.registerClaimedSession(f.guest.id, GUEST, "adopt");
    expect(await f.post(grant.token, { runtime: "pi", eventFamily: "session_identity", hookEvent: "SessionStart",
      sessionName: GUEST, sessionId: "native-id", sessionFile: "/tmp/retained.jsonl", generation: grant.generation, runId: grant.runId }))
      .toMatchObject({ status: 200, body: { tokenPersisted: true } });
  });

  it.each(["claude-code", undefined])("refuses another or absent runtime identity on a Pi grant without changing the saved resume pointer: %s", async runtime => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET runtime = 'pi' WHERE id = ?").run(f.guest.id);
    f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('b',?,?,'%1')").run(f.guest.id, GUEST);
    const row = f.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(f.guest.id) as { id: string };
    f.sessions.updateResumeToken(row.id, "pi_session_file", "/tmp/original-pi.jsonl", "hook");
    const grant = f.grants.issue({ nodeId: f.guest.id, generation: f.generation(f.guest.id), issuedBy: "launch", run: {
      runId: "pi-attempt", sessionId: row.id, binding: { runtime: "pi", runner: 0, pane: "%1", panePid: 101 } } });
    f.grants.activate(grant.grantId);
    const response = await f.post(grant.token, { runtime, eventFamily: "session_identity", hookEvent: "SessionStart",
      sessionId: "12345678-1234-1234-1234-123456789abc", generation: grant.generation, runId: grant.runId });
    expect(response).toMatchObject({ status: 403, body: { code: "activity_grant_runtime_mismatch" } });
    expect(f.db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(row.id))
      .toEqual({ resume_type: "pi_session_file", resume_token: "/tmp/original-pi.jsonl" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.session_identity'").get()).toEqual({ n: 0 });
    expect(await f.post(grant.token, { runtime: "pi", eventFamily: "session_identity", hookEvent: "SessionStart",
      sessionId: "native-id", sessionFile: "/tmp/current-pi.jsonl", generation: grant.generation, runId: grant.runId }))
      .toMatchObject({ status: 200, body: { tokenPersisted: true } });
    expect(f.db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(row.id))
      .toEqual({ resume_type: "pi_session_file", resume_token: "/tmp/current-pi.jsonl" });
    // Ordinary posts may omit runtime; a bound credential still supplies seat and generation.
    expect(await f.post(grant.token, { eventFamily: "turn_end", hookEvent: "Stop", runId: grant.runId })).toMatchObject({ status: 200 });
    expect(await f.post(grant.token, { runtime: "claude-code", eventFamily: "turn_end", hookEvent: "Stop", runId: grant.runId }))
      .toMatchObject({ status: 403, body: { code: "activity_grant_runtime_mismatch" } });
    // The install token still follows the existing identity path; it is not narrowed into a run-bound credential.
    expect(await f.post(INSTALL_TOKEN, { runtime: "claude-code", eventFamily: "session_identity", hookEvent: "SessionStart",
      sessionName: GUEST, sessionId: "12345678-1234-1234-1234-123456789abc", generation: grant.generation }))
      .toMatchObject({ status: 200, body: { tokenPersisted: true } });
  });

  it("accepts bound Pi usage while preserving legacy install-token usage", async () => {
    const f = fixture();
    f.db.exec(piUsageEntriesSchema.sql!);
    f.db.exec(piUsageChargesSchema.sql!);
    f.db.prepare("UPDATE nodes SET runtime = 'pi' WHERE id = ?").run(f.guest.id);
    f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('b',?,?,'%1')").run(f.guest.id, GUEST);
    const row = f.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(f.guest.id) as { id: string };
    const grant = f.grants.issue({ nodeId: f.guest.id, generation: f.generation(f.guest.id), issuedBy: "launch", run: {
      runId: "pi-attempt", sessionId: row.id, binding: { runtime: "pi", runner: 0, pane: "%1", panePid: 101 } } });
    const post = (token: string, path: string, extra = {}) => f.app.request(`/api/activity/${path}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionName: GUEST, piSessionId: "pi-native-id", facts: [], charges: [], ...extra }) });
    for (const path of ["pi-usage", "pi-usage-charges"]) expect((await post(grant.token, path)).status).toBe(409);
    f.grants.activate(grant.grantId);
    for (const path of ["pi-usage", "pi-usage-charges"]) {
      expect((await post(grant.token, path)).status).toBe(200);
      expect((await post(INSTALL_TOKEN, path)).status).toBe(200);
      expect((await post(grant.token, path, { nodeId: f.other.id })).status).toBe(403);
    }
    f.grants.revoke({ grantId: grant.grantId }, "stopped");
    expect((await post(grant.token, "pi-usage")).status).toBe(401);
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

describe("credential-bound observation-only reports", () => {
  function runner() {
    const f = fixture();
    f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('observed',?,?,'%1')").run(f.guest.id, GUEST);
    f.db.prepare("UPDATE occupant_tenures SET boot_at = ? WHERE node_id = ?").run(new Date(f.clock.now - 1000).toISOString(), f.guest.id);
    const row = f.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(f.guest.id) as { id: string };
    const grant = f.grants.issue({ nodeId: f.guest.id, generation: f.generation(f.guest.id), issuedBy: "Core launch", run: { runId: "actual-observation-run",
      sessionId: row.id, binding: { runtime: "synth", runner: 1, pane: "%1", panePid: 101 } } });
    expect(f.grants.activate(grant.grantId)).toBe(true);
    const report = (sequence: number, observations: unknown) => ({ runId: grant.runId, sequence,
      occurredAt: new Date(f.clock.now + 1000).toISOString(), observations });
    const reports = () => f.db.prepare("SELECT payload FROM events WHERE type = 'agent.runner_observation'").all() as Array<{ payload: string }>;
    return { ...f, grant, row, report, reports };
  }

  it.each(["binding", "report read"])("keeps an unreadable %s unknown without claiming replacement or consuming a receipt", async kind => {
    const f = runner();
    const body = f.report(1, { model: { id: "reported-model" }, context: { usedTokens: 10, windowTokens: 100 } });
    const accepted = await f.post(f.grant.token, body);
    expect(accepted.status).toBe(200);
    const prepare = f.db.prepare.bind(f.db);
    const fault = kind === "binding"
      ? vi.spyOn(SeatIdentityStore.prototype, "getForNode").mockImplementation(() => { throw new Error("binding unavailable"); })
      : vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
        if (sql.includes("SELECT payload FROM events")) throw new Error("report read unavailable");
        return prepare(sql);
      }) as typeof f.db.prepare);
    try {
      for (const component of ["model", "context"] as const) {
        expect(f.store.getRunnerObservation(f.guest.id, component, { freshnessMs: 600_000 }))
          .toEqual({ report: null, reason: "binding_unverified" });
      }
      if (kind === "binding") {
        expect(await f.post(f.grant.token, body))
          .toMatchObject({ status: 409, body: { code: "activity_grant_unverified", retryable: true } });
      }
      expect(f.grants.get(f.grant.grantId)?.revokedAt).toBeNull();
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent.runner_observation'").get()).toEqual({ n: 1 });
    } finally { fault.mockRestore(); }
    expect(f.store.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 }))
      .toMatchObject({ report: { sequence: 1, observations: { model: { id: "reported-model" } } }, reason: null });
    expect(await f.post(f.grant.token, body)).toEqual(accepted);
    expect(f.reports()).toHaveLength(1);
  });

  it.each(["unverified", "failed read"])("returns retryable domain uncertainty for an %s standing after route admission", async kind => {
    const f = runner(), body = f.report(1, { model: { id: "model" }, context: { inputTokens: 11 } });
    const record = f.store.recordRunnerObservation.bind(f.store);
    const fault = vi.spyOn(f.store, "recordRunnerObservation").mockImplementation((grant, input) => {
      const prepare = f.db.prepare.bind(f.db);
      const read = kind === "unverified"
        ? vi.spyOn(SeatIdentityStore.prototype, "getForNode").mockImplementation(() => { throw new Error("binding read unavailable"); })
        : vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
          if (sql === "PRAGMA table_info(activity_grants)") throw new Error("standing read unavailable");
          return prepare(sql);
        }) as typeof f.db.prepare);
      try { return record(grant, input); } finally { read.mockRestore(); }
    });
    try {
      expect(await f.post(f.grant.token, body)).toMatchObject({ status: 409, body: { code: "runner_observation_unverified", retryable: true } });
      expect(f.reports()).toHaveLength(0);
      expect(f.grants.get(f.grant.grantId)?.revokedAt).toBeNull();
    } finally { fault.mockRestore(); }
    const accepted = await f.post(f.grant.token, body);
    expect(accepted.status).toBe(200);
    expect(await f.post(f.grant.token, body)).toEqual(accepted);
    expect(f.reports()).toHaveLength(1);
  });

  it.each(["pending", "stale", "revoked"])("distinguishes a %s run when recording an observation", kind => {
    const f = runner(), body = f.report(1, { model: { id: "model" } });
    if (kind === "pending") f.db.prepare("UPDATE activity_grants SET activated_at=NULL WHERE grant_id=?").run(f.grant.grantId);
    if (kind === "stale") f.db.prepare("UPDATE bindings SET tmux_pane='%2' WHERE node_id=?").run(f.guest.id);
    if (kind === "revoked") f.grants.revoke({ grantId: f.grant.grantId }, "positive stop");
    expect(f.store.recordRunnerObservation(f.grant, body)).toMatchObject(kind === "pending"
      ? { ok: false, code: "runner_observation_unverified", retryable: true }
      : { ok: false, code: "runner_observation_unavailable" });
    expect(f.reports()).toHaveLength(0);
    expect(f.grants.get(f.grant.grantId)?.revokedAt !== null).toBe(kind === "revoked");
  });

  it("retains one authenticated report with a stable receipt and no fabricated activity or identity", async () => {
    const f = runner();
    const body = f.report(1, { model: { id: "provider/model" }, context: { usedTokens: 10 } });
    const accepted = await f.post(f.grant.token, body);
    expect(accepted).toMatchObject({ status: 200, body: { ok: true, observation: { runId: f.grant.runId, family: "observation", sequence: 1 } } });
    expect(await f.post(f.grant.token, body)).toEqual(accepted);
    expect(f.reports()).toHaveLength(1);
    const payload = JSON.parse(f.reports()[0]!.payload);
    expect(payload).toMatchObject({ type: "agent.runner_observation", nodeId: f.guest.id, sessionRowId: f.row.id,
      generation: f.grant.generation, runId: f.grant.runId, grantId: f.grant.grantId, observations: body.observations });
    expect(JSON.stringify(payload)).not.toContain(f.grant.token);
    expect(f.recorded()).toBe(0);
    expect(f.activity(f.guest.id)).toBe("unknown");
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(f.row.id)).toEqual({ resume_token: null });
  });

  it("conflicts on sequence reuse, while a lower sequence may retain an omitted component", async () => {
    const f = runner();
    expect((await f.post(f.grant.token, f.report(3, { model: { id: "new-model" } }))).status).toBe(200);
    expect(await f.post(f.grant.token, f.report(3, { model: { id: "conflicting" } }))).toMatchObject({ status: 409, body: { code: "runner_observation_conflict" } });
    expect((await f.post(f.grant.token, f.report(2, { context: { usedTokens: 5, windowTokens: 100 } }))).status).toBe(200);
    expect(f.store.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 })).toMatchObject({ report: { sequence: 3, observations: { model: { id: "new-model" } } } });
    expect(f.store.getRunnerObservation(f.guest.id, "context", { freshnessMs: 600_000 })).toMatchObject({ report: { sequence: 2 } });
    expect(f.reports()).toHaveLength(2);
  });

  it.each([
    { context: { usedTokens: -1 } }, { context: { windowTokens: 0 } }, { context: { usedPercentage: 101 } },
    { context: { usedTokens: 5, windowTokens: 10, usedPercentage: 70 } },
    { context: { usedTokens: 5, windowTokens: 10, usedPercentage: 50.001 } }, { model: { id: "" } },
    { session: { nativeRef: "with spaces" } }, { model: { id: "model", source: "verified" } },
    { context: {} }, {}, [], null,
  ])("refuses an invalid whole observation object without effects: %j", async observations => {
    const f = runner();
    expect(await f.post(f.grant.token, f.report(1, observations))).toMatchObject({ status: 400, body: { code: "invalid_runner_observation" } });
    expect(f.reports()).toHaveLength(0); expect(f.recorded()).toBe(0);
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.row.id)).toEqual({ resume_token: null });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent.session_identity'").get()).toEqual({ n: 0 });
  });

  it.each(["\u202E", "\u200D", "\u200C", "\u2066"])("retains format characters in observations without losing valid counts: %j", async format => {
    const f = runner();
    const observations = { model: { id: `model${format}spelling` }, session: { nativeRef: `session${format}reference` }, context: { inputTokens: 11 } };
    const body = f.report(1, observations), first = await f.post(f.grant.token, body);
    expect(first.status).toBe(200);
    expect(await f.post(f.grant.token, body)).toEqual(first);
    expect(JSON.parse(f.reports()[0]!.payload).observations).toEqual(observations);
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.row.id)).toEqual({ resume_token: observations.session.nativeRef });
    expect(f.store.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 }).report?.observations.model?.id).toBe(observations.model.id);
  });

  it("accepts format characters in Pi session paths without losing valid counts", async () => {
    const f = runner();
    f.db.prepare("UPDATE nodes SET runtime='pi' WHERE id=?").run(f.guest.id);
    f.sessions.recordCommunityHarnessSelection(f.row.id, "pi", "pi-rpc");
    const grant = f.grants.issue({ nodeId: f.guest.id, generation: f.grant.generation, issuedBy: "Core launch",
      run: { runId: "pi-observation", sessionId: f.row.id, binding: { ...f.grant.binding!, runtime: "pi", runner: 2 } } });
    expect(f.grants.activate(grant.grantId)).toBe(true);
    const observations = { session: { nativeRef: "/tmp/pi-\u200Djoiner.jsonl" }, context: { inputTokens: 11 } };
    const body = { ...f.report(1, observations), runId: grant.runId }, first = await f.post(grant.token, body);
    expect(first.status).toBe(200);
    expect(await f.post(grant.token, body)).toEqual(first);
    expect(JSON.parse(f.reports()[0]!.payload).observations).toEqual(observations);
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.row.id)).toEqual({ resume_token: observations.session.nativeRef });
  });

  it("requires actual bound authority, run ID, sequence and time; preserves legacy hook behavior", async () => {
    const f = runner();
    const valid = f.report(1, { model: { id: "model" } });
    expect((await f.post(INSTALL_TOKEN, valid)).status).toBe(403);
    for (const patch of [{ runId: undefined }, { runId: "other" }, { sequence: 0 }, { sequence: 1.5 }, { occurredAt: "yesterday" }, { occurredAt: "2026-02-30T00:00:00Z" }]) {
      expect((await f.post(f.grant.token, { ...valid, ...patch })).status).toBeGreaterThanOrEqual(400);
    }
    expect(f.reports()).toHaveLength(0);
    expect((await f.post(f.grant.token, f.event("Stop", "end_turn", { sequence: 100 }))).status).toBe(200);
    expect((await f.post(f.grant.token, valid)).status).toBe(200); // activity order is a separate family
  });

  it("stamps the bound node's concrete row despite a newer foreign historical spelling", async () => {
    const f = runner();
    f.db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES ('zz-foreign-history',?,?,'superseded')").run(f.other.id, GUEST);
    expect((await f.post(f.grant.token, f.report(1, { model: { id: "model" } }))).status).toBe(200);
    expect(JSON.parse(f.reports()[0]!.payload)).toMatchObject({ nodeId: f.guest.id, sessionRowId: f.row.id });
  });

  it("rejects mixed activity/identity envelopes without partial side effects", async () => {
    const f = runner();
    for (const extra of [{ hookEvent: "Stop" }, { runtime: "synth", eventFamily: "session_identity", sessionId: "reported" }]) {
      expect((await f.post(f.grant.token, { ...f.report(1, { model: { id: "model" } }), ...extra })).status).toBe(400);
    }
    expect(f.reports()).toHaveLength(0); expect(f.recorded()).toBe(0);
  });

  it("publishes only after the receipt commits and emits nothing for retries or rejected inserts", async () => {
    const f = runner(); const notifications: boolean[] = [];
    f.app.onError((error, c) => {
      if (error.message !== "fixture rejects report") throw error;
      return c.json({ ok: false, code: "fixture_insert_rejected" }, 500);
    });
    f.eventBus.subscribe(event => { if (event.type === "agent.runner_observation") notifications.push(f.db.inTransaction); });
    const body = f.report(1, { model: { id: "model" } });
    f.db.exec("CREATE TEMP TRIGGER reject_observation BEFORE INSERT ON events WHEN NEW.type='agent.runner_observation' BEGIN SELECT RAISE(ABORT,'fixture rejects report'); END;");
    expect((await f.post(f.grant.token, body)).status).toBe(500);
    expect(f.reports()).toHaveLength(0); expect(notifications).toEqual([]);
    f.db.exec("DROP TRIGGER reject_observation");
    expect((await f.post(f.grant.token, body)).status).toBe(200);
    expect((await f.post(f.grant.token, body)).status).toBe(200);
    expect(notifications).toEqual([false]);
  });

  it("keeps the original run/generation and its facts through explicit same-process adoption", async () => {
    const f = runner();
    await f.post(f.grant.token, f.report(1, { model: { id: "retained" } }));
    new SeatIdentityStore(f.db).upsert({ nodeId: f.guest.id, verdict: "unconfirmed", evidenceSource: "pane_process", reason: null,
      sessionName: GUEST, observedAt: new Date(f.clock.now).toISOString(), evidence: { registeredPane: "%1", observedPid: 101,
        observedPanePid: 101, observedCommand: "node", matchedLayer: null } });
    const adopted = f.sessions.registerClaimedSession(f.guest.id, GUEST, "adopt");
    expect(adopted.id).not.toBe(f.row.id);
    expect(f.grants.get(f.grant.grantId)?.sessionId).toBe(f.row.id);
    expect(f.store.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 })).toMatchObject({ report: { sequence: 1, generation: f.grant.generation } });
    expect((await f.post(f.grant.token, f.report(2, { model: { id: "after-adoption" } }))).status).toBe(200);
    expect(JSON.parse(f.reports()[1]!.payload)).toMatchObject({ sessionRowId: adopted.id, generation: f.grant.generation, runId: f.grant.runId });
  });

  it("retains a conflicting native reference only as history, without changing Core identity", async () => {
    const f = runner();
    f.db.prepare("UPDATE sessions SET resume_type='community:synth', resume_token='original-ref' WHERE id=?").run(f.row.id);
    expect((await f.post(f.grant.token, f.report(1, { session: { nativeRef: "different-ref" }, model: { id: "model" } }))).status).toBe(200);
    expect(f.store.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 })).toMatchObject({ report: null, reason: "session_mismatch" });
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.row.id)).toEqual({ resume_token: "original-ref" });
  });

  it.each(["model", "context"] as const)("checks both original and latest session references for %s currency", async component => {
    for (const [original, latest, current] of [["core-A", "runner-B", false], ["core-A", "core-A", true], ["runner-B", "core-A", false]] as const) {
      const f = runner();
      f.db.prepare("UPDATE sessions SET resume_type='community:synth', resume_token='core-A' WHERE id=?").run(f.row.id);
      expect((await f.post(f.grant.token, f.report(1, { session: { nativeRef: original }, model: { id: "model-A" }, context: { usedTokens: 10 } }))).status).toBe(200);
      expect((await f.post(f.grant.token, f.report(2, { session: { nativeRef: latest } }))).status).toBe(200);
      const read = f.store.getRunnerObservation(f.guest.id, component, { freshnessMs: 600_000 });
      expect(read).toMatchObject(current ? { report: { sequence: 1 }, reason: null } : { report: null, reason: "session_mismatch" });
      expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.row.id)).toEqual({ resume_token: "core-A" });
    }
  });

  it("projects runner context through existing single and batch reads without trusting a cache", async () => {
    const f = runner();
    const context = new ContextUsageStore(f.db, { stateDir: "/unused", runnerObservations: f.store });
    expect((await f.post(f.grant.token, f.report(1, { context: { usedTokens: 25, windowTokens: 100, inputTokens: 1000, outputTokens: 50 } }))).status).toBe(200);
    const usage = context.getForNode(f.guest.id, GUEST);
    expect(usage).toMatchObject({ availability: "known", reason: null, source: "runner_reported", usedPercentage: 25,
      remainingPercentage: 75, contextWindowSize: 100, totalInputTokens: 1000, totalOutputTokens: 50, fresh: true, transcriptPath: null });
    expect(context.getForNodes([{ nodeId: f.guest.id, currentSessionName: GUEST }]).get(f.guest.id)).toEqual(usage);
    context.persist(f.guest.id, usage);
    const replacement = f.grants.issue({ nodeId: f.guest.id, generation: f.grant.generation, issuedBy: "relaunch",
      run: { runId: "new-run", sessionId: f.row.id, binding: f.grant.binding! } });
    expect(f.grants.activate(replacement.grantId)).toBe(true);
    expect(context.getForNode(f.guest.id, GUEST)).toMatchObject({ availability: "unknown", reason: "no_data", usedPercentage: null });
    expect(context.getForNodes([{ nodeId: f.guest.id, currentSessionName: GUEST }]).get(f.guest.id)?.availability).toBe("unknown");
  });

  it.each([
    { raw: { usedTokens: 10 }, reason: "window_capacity_unknown" },
    { raw: { inputTokens: 1000, outputTokens: 100 }, reason: "window_capacity_unknown" },
    { raw: { windowTokens: 100 }, reason: "no_data" },
    { raw: { inputTokens: 1000, outputTokens: 100, windowTokens: 100 }, reason: "no_data" },
  ])("retains raw context with unknown occupancy: $raw", async ({ raw, reason }) => {
    const f = runner(); const context = new ContextUsageStore(f.db, { stateDir: "/unused", runnerObservations: f.store });
    expect((await f.post(f.grant.token, f.report(1, { context: raw }))).status).toBe(200);
    expect(context.getForNode(f.guest.id, GUEST)).toMatchObject({ availability: "unknown", reason, source: "runner_reported",
      usedPercentage: null, remainingPercentage: null, totalInputTokens: "inputTokens" in raw ? raw.inputTokens : null });
  });

  it("keeps explicit percentages runner-reported and expires omitted context independently", async () => {
    const f = runner(); const context = new ContextUsageStore(f.db, { stateDir: "/unused", runnerObservations: f.store });
    expect((await f.post(f.grant.token, f.report(1, { context: { usedPercentage: 80 } }))).status).toBe(200);
    expect(context.getForNode(f.guest.id, GUEST)).toMatchObject({ availability: "known", source: "runner_reported", usedPercentage: 80, contextWindowSize: null });
    f.clock.now += 600_000;
    expect((await f.post(f.grant.token, f.report(2, { model: { id: "new-model" } }))).status).toBe(200);
    expect(context.getForNode(f.guest.id, GUEST)).toMatchObject({ availability: "unknown", reason: "stale", usedPercentage: null });
  });

  it("persists a current native reference as launcher origin without verification or duplicate identity effects", async () => {
    const f = runner();
    const body = f.report(1, { session: { nativeRef: "provider:会話/abc?x=1" } });
    const accepted = await f.post(f.grant.token, body);
    expect(accepted.status).toBe(200);
    expect(f.db.prepare("SELECT resume_type,resume_token,resume_provenance,resume_last_verified,resume_last_probe_status FROM sessions WHERE id=?").get(f.row.id))
      .toEqual({ resume_type: "community:synth", resume_token: "provider:会話/abc?x=1", resume_provenance: "launcher", resume_last_verified: null, resume_last_probe_status: null });
    const identities = () => f.db.prepare("SELECT payload FROM events WHERE type='agent.session_identity'").all();
    expect(identities()).toHaveLength(1);
    expect(JSON.parse((identities()[0] as { payload: string }).payload)).toMatchObject({ provenance: "launcher", sessionId: "provider:会話/abc?x=1" });
    expect(await f.post(f.grant.token, body)).toEqual(accepted);
    expect(identities()).toHaveLength(1);
    expect(new SeatIdentityStore(f.db).getForNode(f.guest.id)?.verdict).not.toBe("verified");
    expect((await f.post(f.grant.token, f.report(2, { session: { nativeRef: "conflicting" } }))).status).toBe(200);
    expect((f.db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.row.id) as { resume_token: string }).resume_token).toBe("provider:会話/abc?x=1");
    expect(identities()).toHaveLength(1);
  });

  it.each(["scrape", "adoption"] as const)("lets Core %s evidence supersede a runner-reported reference", async provenance => {
    const f = runner();
    expect((await f.post(f.grant.token, f.report(1, { session: { nativeRef: "runner-claim" } }))).status).toBe(200);
    expect(f.sessions.updateResumeToken(f.row.id, "community:synth", "core-evidence", provenance)).toBe(true);
    expect(f.db.prepare("SELECT resume_token,resume_provenance FROM sessions WHERE id=?").get(f.row.id))
      .toEqual({ resume_token: "core-evidence", resume_provenance: provenance });
  });

  it("rolls back the report and native reference together if the identity event cannot commit", async () => {
    const f = runner(); const published: string[] = [];
    f.eventBus.subscribe(event => { published.push(event.type); });
    f.app.onError((error, c) => {
      if (error.message !== "fixture rejects identity") throw error;
      return c.json({ ok: false }, 500);
    });
    f.db.exec("CREATE TEMP TRIGGER reject_identity BEFORE INSERT ON events WHEN NEW.type='agent.session_identity' BEGIN SELECT RAISE(ABORT,'fixture rejects identity'); END;");
    expect((await f.post(f.grant.token, f.report(1, { session: { nativeRef: "uncommitted" } }))).status).toBe(500);
    expect(f.reports()).toHaveLength(0);
    expect(f.db.prepare("SELECT resume_token FROM sessions WHERE id=?").get(f.row.id)).toEqual({ resume_token: null });
    expect(published).toEqual([]);
  });

  it.each(["future", "stale", "lower-sequence"])("does not persist an unusable %s session claim", async kind => {
    const f = runner();
    if (kind === "lower-sequence") {
      expect((await f.post(f.grant.token, { ...f.report(2, { session: { nativeRef: "future-session" } }), occurredAt: new Date(f.clock.now + 60_000).toISOString() })).status).toBe(200);
    }
    const occurredAt = new Date(f.clock.now + (kind === "future" ? 60_000 : kind === "stale" ? -600_000 : 1000)).toISOString();
    expect((await f.post(f.grant.token, { ...f.report(1, { session: { nativeRef: "unusable" } }), occurredAt })).status).toBe(200);
    expect(f.db.prepare("SELECT resume_token,resume_last_verified FROM sessions WHERE id=?").get(f.row.id)).toEqual({ resume_token: null, resume_last_verified: null });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='agent.session_identity'").get()).toEqual({ n: 0 });
  });

  it("preserves independent verification on an already known matching reference", async () => {
    const f = runner();
    f.db.prepare("UPDATE sessions SET resume_type='community:synth',resume_token='known',resume_provenance='operator',resume_last_verified='2026-10-30 02:59:00',resume_last_probe_status='resumable' WHERE id=?").run(f.row.id);
    expect((await f.post(f.grant.token, f.report(1, { session: { nativeRef: "known" } }))).status).toBe(200);
    expect(f.db.prepare("SELECT resume_provenance,resume_last_verified,resume_last_probe_status FROM sessions WHERE id=?").get(f.row.id))
      .toEqual({ resume_provenance: "operator", resume_last_verified: "2026-10-30 02:59:00", resume_last_probe_status: "resumable" });
  });

  it("projects retained context after same-process adoption and reconstruction, then refuses revoked history", async () => {
    const f = runner();
    expect((await f.post(f.grant.token, f.report(1, { context: { usedTokens: 30, windowTokens: 100 } }))).status).toBe(200);
    new SeatIdentityStore(f.db).upsert({ nodeId: f.guest.id, verdict: "unconfirmed", evidenceSource: "pane_process", reason: "process_identity_unconfirmed",
      evidence: { registeredPane: "%1", observedPid: 101, observedPanePid: 101, observedCommand: "node", matchedLayer: null }, sessionName: GUEST, observedAt: new Date(f.clock.now).toISOString() });
    f.sessions.registerClaimedSession(f.guest.id, GUEST, "adopt");
    const reconstructed = new AgentActivityStore({ db: f.db, eventBus: f.eventBus, now: () => new Date(f.clock.now) });
    const context = new ContextUsageStore(f.db, { stateDir: "/unused", runnerObservations: reconstructed });
    expect(context.getForNode(f.guest.id, GUEST)).toMatchObject({ source: "runner_reported", usedPercentage: 30, fresh: true });
    f.grants.revoke({ grantId: f.grant.grantId }, "stopped");
    expect(context.getForNode(f.guest.id, GUEST)).toMatchObject({ availability: "unknown", usedPercentage: null });
  });

  it.each(["revoked", "replaced"])("refuses a body that arrives after its run was %s", async change => {
    const f = runner(); const held = f.heldPost(f.grant.token, f.report(1, { model: { id: "delayed" } }));
    await held.reading;
    if (change === "revoked") f.grants.revoke({ grantId: f.grant.grantId }, "stopped");
    else {
      const next = f.grants.issue({ nodeId: f.guest.id, generation: f.grant.generation, issuedBy: "Core relaunch",
        run: { runId: "replacement", sessionId: f.row.id, binding: f.grant.binding! } });
      f.grants.activate(next.grantId);
    }
    held.release(); expect((await held.response).status).toBe(401);
    expect(f.reports()).toHaveLength(0); expect(f.recorded()).toBe(0);
  });

  it("uses launch-recorded Pi-RPC session-file grammar rather than the community reference grammar", async () => {
    const f = runner();
    f.db.prepare("UPDATE sessions SET agent_runner=2 WHERE id=?").run(f.row.id);
    const piRpc = f.grants.issue({ nodeId: f.guest.id, generation: f.grant.generation, issuedBy: "Core Pi-RPC launch", run: {
      runId: "pi-rpc-run", sessionId: f.row.id, binding: { ...f.grant.binding!, runner: 2 } } });
    expect(f.grants.activate(piRpc.grantId)).toBe(true);
    expect((await f.post(piRpc.token, { ...f.report(1, { session: { nativeRef: "provider:conversation-id" } }), runId: piRpc.runId })).status).toBe(400);
    expect((await f.post(piRpc.token, { ...f.report(1, { session: { nativeRef: "/state/dev@rig/history.jsonl" } }), runId: piRpc.runId })).status).toBe(200);
  });

  it("retains pre-issuance and pre-boot samples as unusable rather than current facts", async () => {
    const f = runner(); const body = f.report(1, { model: { id: "old" } });
    body.occurredAt = new Date(Date.parse(f.grant.issuedAt) - 1000).toISOString();
    expect((await f.post(f.grant.token, body)).status).toBe(200);
    expect(f.store.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 })).toMatchObject({ report: null, reason: "sample_time_invalid" });
    const next = f.report(2, { model: { id: "newer" } });
    await f.post(f.grant.token, next);
    f.db.prepare("UPDATE occupant_tenures SET boot_at=? WHERE node_id=?").run(new Date(f.clock.now + 1000).toISOString(), f.guest.id);
    expect(f.store.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 })).toMatchObject({ report: null, reason: "sample_time_invalid" });
  });

  it("normalizes object key order for identical retries and rejects numeric overflow", async () => {
    const f = runner(); const body = f.report(1, { context: { outputTokens: 2, inputTokens: 1 }, model: { id: "model" } });
    const first = await f.post(f.grant.token, body);
    expect(await f.post(f.grant.token, { ...body, observations: { model: { id: "model" }, context: { inputTokens: 1, outputTokens: 2 } } })).toEqual(first);
    const overflow = JSON.stringify(f.report(2, { context: { usedTokens: 1 } })).replace('"usedTokens":1', '"usedTokens":1e999');
    expect((await f.post(f.grant.token, overflow)).status).toBe(400);
    expect(f.reports()).toHaveLength(1);
  });

  it("keeps component ages separate and never falls back past an invalid latest sample", async () => {
    const f = runner();
    await f.post(f.grant.token, f.report(1, { model: { id: "older" }, context: { inputTokens: 8 } }));
    f.clock.now += 600_001;
    await f.post(f.grant.token, f.report(2, { model: { id: "current" } }));
    expect(f.store.getRunnerObservation(f.guest.id, "context", { freshnessMs: 600_000 })).toMatchObject({ report: null, reason: "stale" });
    const future = f.report(3, { model: { id: "future" } }); future.occurredAt = new Date(f.clock.now + 60_000).toISOString();
    expect((await f.post(f.grant.token, future)).status).toBe(200);
    expect(f.store.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 })).toMatchObject({ report: null, reason: "sample_time_invalid" });
  });

  it("retains same-run facts across rotation/reconstruction and refuses prior-run facts after relaunch", async () => {
    const f = runner();
    const body = f.report(1, { session: { nativeRef: "provider:会話/abc?x=1" }, model: { id: "model" } });
    await f.post(f.grant.token, body);
    const rotate = (runId: string) => f.grants.issue({ nodeId: f.guest.id, generation: f.grant.generation, issuedBy: "Core rotation",
      run: { runId, sessionId: f.row.id, binding: { panePid: f.grant.binding!.panePid, pane: f.grant.binding!.pane,
        runner: f.grant.binding!.runner, runtime: f.grant.binding!.runtime } } });
    f.clock.now += 1000;
    const rotated = rotate(f.grant.runId!); f.grants.activate(rotated.grantId);
    const reconstructed = new AgentActivityStore({ db: f.db, eventBus: new EventBus(f.db), now: () => new Date(f.clock.now) });
    expect(reconstructed.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 })).toMatchObject({ report: { runId: f.grant.runId } });
    const next = rotate("new-actual-run"); f.grants.activate(next.grantId);
    expect(reconstructed.getRunnerObservation(f.guest.id, "model", { freshnessMs: 600_000 })).toMatchObject({ report: null, reason: "no_data" });
  });
});
