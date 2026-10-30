// A runner seat's answered permission path, through the real activity routes, queue, Mission Control answer route,
// activity store and seat grant. The chosen person's one offered option reaches only that live request; nothing else
// ever reads as an answer. No model, Slack or terminal is involved.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { AgentActivityStore, latestHookWaitsOnPerson } from "../src/domain/agent-activity-store.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { activityRoutes, guestActivityRoutes } from "../src/routes/activity.js";
import { ActivityGrantStore } from "../src/domain/activity-grants.js";

const PERSON = "mike@external", OTHER_PERSON = "dana@external", SEAT = "dev-runner@perm-rig", INSTALL = "install-token";
const person = (id: string) => ({ entityId: id, class: "human" as const, displayName: id, address: `${id}@external`,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "unused", role: "primary" as const, handle: `U${id.toUpperCase()}` }],
  prefs: { deliveryClass: "A" as const } });
const registry = { ok: true as const, entities: [person("mike"), person("dana")] };
const OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(options: { owner?: string | null; guest?: boolean } = {}) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  cleanups.push(() => db.close());
  const bus = new EventBus(db);
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("perm-rig");
  const runner = rigs.addNode(rig.id, "dev.runner", { runtime: "synth" });
  const other = rigs.addNode(rig.id, "dev.other", { runtime: "synth" });
  const sessions = new SessionRegistry(db);
  const occupy = (nodeId: string, name: string, kind?: "handover") => {
    const session = sessions.registerSession(nodeId, name, kind);
    sessions.updateStatus(session.id, "running");
    sessions.recordCommunityHarnessSelection(session.id, "synth", true);
  };
  occupy(runner.id, SEAT);
  occupy(other.id, "dev-other@perm-rig");
  const nudges: string[] = [];
  const queueRepo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    transport: { send: async (session) => { nudges.push(session); return { ok: true, verified: true, sent: true }; } } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog: new MissionControlActionLog(db) });
  const store = new AgentActivityStore({ db, eventBus: bus,
    resolveOccupantGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  // The answer owner is a new seat setting; set it directly so each test reads one path.
  const owner = options.owner === undefined ? PERSON : options.owner;
  if (owner) {
    try { db.prepare("UPDATE nodes SET permissions_to = ? WHERE id = ?").run(owner, runner.id); } catch { /* no column: no owner */ }
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    if (!options.guest) c.set("activityHookToken" as never, INSTALL as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("eventBus" as never, bus as never);
    c.set("queueRepo" as never, queueRepo as never);
    c.set("rigRepo" as never, rigs as never);
    c.set("missionControlWriteContract" as never, contract as never);
    await next();
  });
  app.route("/api/activity", options.guest ? guestActivityRoutes : activityRoutes);
  app.route("/api/mission-control", missionControlRoutes());

  const generation = () => sessions.currentOccupantTenure(runner.id)!.generationUuid;
  const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });
  const auth = (token: string) => ({ authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  /** The runner submits its agent's live request. */
  const submit = async (overrides: Record<string, unknown> = {}, token = INSTALL) => json(await app.request("/api/activity/permission-requests", {
    method: "POST", headers: auth(token), body: JSON.stringify({ sessionName: SEAT, nodeId: runner.id, generation: generation(),
      nativeRef: "conversation-1", turnId: "1", requestId: "7", toolCall: { title: "Edit src/app.ts", kind: "edit" }, options: OPTIONS,
      occurredAt: "2026-10-30T05:00:00.000Z", ...overrides }) }));
  const read = async (askId: string, waitSeconds = 0, token = INSTALL) =>
    json(await app.request(`/api/activity/permission-requests/${askId}?waitSeconds=${waitSeconds}`, { headers: auth(token) }));
  const withdraw = async (askId: string, reason: string, token = INSTALL) =>
    json(await app.request(`/api/activity/permission-requests/${askId}/withdraw`, { method: "POST", headers: auth(token), body: JSON.stringify({ reason }) }));
  /** A person answers in Steering: one offered option, or typed words. */
  const answer = async (askId: string, choice: { optionId?: string; decision?: string }, actor = PERSON) =>
    json(await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor },
      body: JSON.stringify({ verb: "answer", qitemId: askId, actorSession: actor, ...(choice.optionId ? { questionId: "permission", optionId: choice.optionId } : {}),
        ...(choice.decision ? { decision: choice.decision } : {}) }) }));
  const waitsOnPerson = () => latestHookWaitsOnPerson(store.getLatestForNode({ nodeId: runner.id, sessionName: SEAT }), "synth");
  const rowsToSeat = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = ?").get(SEAT) as { n: number }).n;
  const grants = new ActivityGrantStore(db);
  return { db, runner, other, sessions, queueRepo, contract, nudges, generation, submit, read, withdraw, answer, waitsOnPerson, rowsToSeat, grants,
    relaunch: () => occupy(runner.id, SEAT, "handover") };
}

describe("a runner seat's answered permission path", () => {
  it("with no one chosen, reads route_unsupported and asks no one", async () => {
    const f = fixture({ owner: null });
    expect(await f.submit()).toMatchObject({ status: 409, body: { code: "route_unsupported" } });
    expect(f.queueRepo.list({ limit: 100 }).filter((row) => row.destinationSession === PERSON)).toHaveLength(0);
  });

  it("asks the chosen person with the agent's offered options, allow_always hidden, and the seat reads needs input", async () => {
    const f = fixture();
    const submitted = await f.submit();
    expect(submitted).toMatchObject({ status: 200, body: { ok: true, created: true } });
    const ask = f.queueRepo.getById(String(submitted.body.askId))!;
    expect(ask).toMatchObject({ state: "pending", sourceSession: SEAT, destinationSession: PERSON });
    expect(ask.humanQuestions?.[0]?.options.map((option) => option.id)).toEqual(["allow", "reject"]);
    expect(ask.body).toContain("Edit src/app.ts");
    expect(f.waitsOnPerson()).toBe(true);
    expect(await f.read(String(submitted.body.askId))).toMatchObject({ status: 200, body: { state: "pending" } });
  });

  it("returns the same ask for the same request, and refuses its request id in another turn", async () => {
    const f = fixture();
    const first = await f.submit();
    expect(await f.submit()).toMatchObject({ status: 200, body: { askId: first.body.askId, created: false } });
    expect(await f.submit({ turnId: "2" })).toMatchObject({ status: 409, body: { code: "duplicate_request" } });
  });

  it("takes the agent's JSON-RPC id and the prompt number as numbers too, the same request as their strings", async () => {
    const f = fixture();
    const first = await f.submit({ requestId: 7, turnId: 1 });
    expect(first).toMatchObject({ status: 200, body: { ok: true, created: true } });
    expect(await f.submit()).toMatchObject({ status: 200, body: { askId: first.body.askId, created: false } });
  });

  it.each([
    ["an option id a person's choice can't carry", [{ optionId: "allow:1", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }]],
    ["only one option left once allow_always is hidden", [{ optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }]],
  ])("refuses %s, and asks no one", async (_case, options) => {
    const f = fixture();
    expect(await f.submit({ options })).toMatchObject({ status: 422, body: { code: "options_unsupported" } });
    expect(f.queueRepo.list({ limit: 100 }).filter((row) => row.destinationSession === PERSON)).toHaveLength(0);
  });

  it("refuses a request from an earlier occupant", async () => {
    const f = fixture();
    expect(await f.submit({ generation: "an-earlier-generation" })).toMatchObject({ status: 409, body: { code: "stale_generation" } });
  });

  it("gives the chosen person's option to that request once, with no reply row or wake for the runner's terminal", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    expect(await f.answer(askId, { optionId: "allow" })).toMatchObject({ status: 200 });
    expect(await f.read(askId)).toMatchObject({ status: 200, body: { state: "answered", optionId: "allow" } });
    expect(f.rowsToSeat()).toBe(0);
    expect(f.nudges.filter((session) => session === SEAT)).toHaveLength(0);
    await f.answer(askId, { optionId: "reject" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "allow" } });
  });

  it("wakes a waiting read when the answer arrives", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    const started = Date.now();
    const waiting = f.read(askId, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await f.answer(askId, { optionId: "reject" });
    expect(await waiting).toMatchObject({ status: 200, body: { state: "answered", optionId: "reject" } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("never takes another person's click, the primary user's or typed words as the answer", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    expect((await f.answer(askId, { optionId: "allow" }, OTHER_PERSON)).status).not.toBe(200);
    await expect(f.contract.act({ verb: "answer", qitemId: askId, actorSession: OTHER_PERSON, questionId: "permission", optionId: "allow",
      authority: "primary-user" } as never)).rejects.toThrow();
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    await f.answer(askId, { decision: "yes go ahead" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "refused", reason: "typed_reply" } });
  });

  it("withdraws on turn end, and a later answer isn't sent", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    expect(await f.withdraw(askId, "sometime")).toMatchObject({ status: 400 });
    expect(await f.withdraw(askId, "turn_ended")).toMatchObject({ status: 200, body: { state: "withdrawn" } });
    expect((await f.answer(askId, { optionId: "allow" })).status).not.toBe(200);
    expect(await f.read(askId)).toMatchObject({ body: { state: "withdrawn" } });
  });

  it("makes an earlier occupant's request stale after a relaunch, whoever looks first", async () => {
    const f = fixture();
    const read = String((await f.submit()).body.askId);
    const answered = String((await f.submit({ requestId: "8" })).body.askId);
    f.relaunch();
    expect(await f.read(read)).toMatchObject({ body: { state: "stale" } });
    expect((await f.answer(answered, { optionId: "allow" })).status).not.toBe(200);
    expect(f.queueRepo.getById(answered)).toMatchObject({ state: "canceled" });
    expect(await f.read(answered)).toMatchObject({ body: { state: "stale" } });
  });

  it("leaves an unanswered request pending, never granted", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    expect(await f.read(askId, 1)).toMatchObject({ body: { state: "pending" } });
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending" });
  });

  it("serves a seat grant on the main and guest routers, for its own seat only", async () => {
    for (const guest of [false, true]) {
      const f = fixture({ guest });
      const grant = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" });
      const submitted = await f.submit({ nodeId: undefined, generation: undefined }, grant.token);
      expect(submitted).toMatchObject({ status: 200, body: { created: true } });
      const askId = String(submitted.body.askId);
      expect(await f.read(askId, 0, grant.token)).toMatchObject({ body: { state: "pending" } });
      const otherGrant = f.grants.issue({ nodeId: f.other.id, generation: f.sessions.currentOccupantTenure(f.other.id)!.generationUuid, issuedBy: "test" });
      expect(await f.read(askId, 0, otherGrant.token)).toMatchObject({ status: 404 });
      expect(await f.submit({ requestId: "9" }, otherGrant.token)).toMatchObject({ status: 403, body: { code: "activity_grant_wrong_seat" } });
      if (guest) expect(await f.submit({ requestId: "10" })).toMatchObject({ status: 401 });
    }
  });
});
