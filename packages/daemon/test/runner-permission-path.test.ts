import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
// A runner seat's answered permission path, through the real activity routes, queue, Mission Control answer route,
// activity store and seat grant. The chosen person's one offered option reaches only that live request; nothing else
// ever reads as an answer. No model, Slack or terminal is involved.
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { StreamStore } from "../src/domain/stream-store.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { describeDefaultReceiver, permissionDeciderFor } from "../src/domain/default-receiver.js";
import { createGuestActivityApp, type AppDeps } from "../src/server.js";

const PERSON = "mike@external", OTHER_PERSON = "dana@external", SEAT = "dev-runner@perm-rig", INSTALL = "install-token", DECIDER = "lead@perm-rig";
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

function fixture(options: { owner?: string | null; guest?: boolean; realGuest?: boolean; people?: string[]; brokenStream?: boolean; decider?: string | null; deciderOf?: (requester: string) => string | null; receiver?: string | null } = {}) {
  const people = options.people ? { ok: true as const, entities: options.people.map(person) } : registry;
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
  const requesters: string[] = [];
  const queueRepo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => people,
    transport: { send: async (session) => { nudges.push(session); return { ok: true, verified: true, sent: true }; } },
    // The receiving agent that decides an answered request; absent, the request closes with the person's answer.
    // The daemon's own order, as startup wires it, over this host's seats and the given agents.operator_session.
    ...(options.receiver !== undefined ? { permissionDecider: (_ask: unknown, requester: string) => {
      requesters.push(requester);
      const decider = permissionDeciderFor(db, requester, () => options.receiver ?? null);
      return decider?.session ? { session: decider.session, describe: describeDefaultReceiver(decider) } : null; } }
      : options.deciderOf ? { permissionDecider: (_ask: unknown, requester: string) => {
      requesters.push(requester); const session = options.deciderOf!(requester); return session ? { session } : null; } }
      : options.decider !== undefined ? { permissionDecider: () => options.decider ? { session: options.decider } : null } : {}) });
  // A handoff stages its wake durably, as the daemon's queue does with its outbox attached.
  if (options.decider !== undefined || options.deciderOf || options.receiver !== undefined) queueRepo.attachOutbox(new OutboxHandler(db));
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog: new MissionControlActionLog(db) });
  const store = new AgentActivityStore({ db, eventBus: bus,
    resolveOccupantGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const stream = new StreamStore(db, bus);
  const streamStore = options.brokenStream ? { emit: () => { throw new Error("the stream can't be written"); } } : stream;
  // The seat's optional answer override; set it directly so each test reads one path. With none, the default person answers.
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
    c.set("streamStore" as never, streamStore as never);
    await next();
  });
  app.route("/api/activity", options.guest ? guestActivityRoutes : activityRoutes);
  app.route("/api/mission-control", missionControlRoutes());
  // The guest listener's own app, as the daemon builds it; a person still answers on the main app.
  const activityApp = options.realGuest
    ? createGuestActivityApp({ rigRepo: rigs, sessionRegistry: sessions, eventBus: bus, agentActivityStore: store, queueRepo, activityHookToken: INSTALL,
      streamStore } as unknown as AppDeps)
    : app;

  const generation = () => sessions.currentOccupantTenure(runner.id)!.generationUuid;
  const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });
  const auth = (token: string) => ({ authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  /** The runner submits its agent's live request. */
  const submit = async (overrides: Record<string, unknown> = {}, token = INSTALL) => json(await activityApp.request("/api/activity/permission-requests", {
    method: "POST", headers: auth(token), body: JSON.stringify({ sessionName: SEAT, nodeId: runner.id, generation: generation(),
      nativeRef: "conversation-1", turnId: "1", requestId: "7", toolCall: { title: "Edit src/app.ts", kind: "edit" }, options: OPTIONS,
      occurredAt: "2026-10-30T05:00:00.000Z", ...overrides }) }));
  const read = async (askId: string, waitSeconds = 0, token = INSTALL) =>
    json(await activityApp.request(`/api/activity/permission-requests/${askId}?waitSeconds=${waitSeconds}`, { headers: auth(token) }));
  const withdraw = async (askId: string, reason: string, token = INSTALL) =>
    json(await activityApp.request(`/api/activity/permission-requests/${askId}/withdraw`, { method: "POST", headers: auth(token), body: JSON.stringify({ reason }) }));
  /** A person answers in Steering: one offered option, or typed words. */
  const answer = async (askId: string, choice: { optionId?: string; decision?: string }, actor = PERSON) =>
    json(await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor },
      body: JSON.stringify({ verb: "answer", qitemId: askId, actorSession: actor, ...(choice.optionId ? { questionId: "permission", optionId: choice.optionId } : {}),
        ...(choice.decision ? { decision: choice.decision } : {}) }) }));
  /** Another Mission Control verb on a row, as a person in Steering: approve, deny, or handoff to someone. */
  const act = async (qitemId: string, verb: string, extra: Record<string, unknown> = {}, actor = PERSON) =>
    json(await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor },
      body: JSON.stringify({ verb, qitemId, actorSession: actor, ...extra }) }));
  /** The receiving agent decides a request its person answered (`rig seat decide-permission`). */
  const decide = async (askId: string, optionId: string, decider = DECIDER, reason = "they said so") =>
    json(await app.request(`/api/activity/permission-requests/${askId}/decide`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": decider }, body: JSON.stringify({ optionId, reason }) }));
  const waitsOnPerson = () => latestHookWaitsOnPerson(store.getLatestForNode({ nodeId: runner.id, sessionName: SEAT }), "synth");
  const rowsToSeat = () => (db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = ?").get(SEAT) as { n: number }).n;
  const grants = new ActivityGrantStore(db);
  /** OpenRig's pull-only records of the permits it decided by default. */
  const permits = () => stream.list({ hintTag: "runner-permission-permit", limit: 100 });
  return { db, bus, runner, other, sessions, queueRepo, contract, nudges, requesters, generation, submit, read, withdraw, answer, act, decide, waitsOnPerson, rowsToSeat, grants,
    permits, relaunch: () => occupy(runner.id, SEAT, "handover") };
}

describe("a runner seat's answered permission path", () => {
  it("with no override, asks the default person through the ordinary ask", async () => {
    const f = fixture({ owner: null, people: ["mike"] });
    const submitted = await f.submit();
    expect(submitted).toMatchObject({ status: 200, body: { ok: true, created: true } });
    expect(f.queueRepo.getById(String(submitted.body.askId))).toMatchObject({ state: "pending", sourceSession: SEAT, destinationSession: PERSON });
    expect(f.waitsOnPerson()).toBe(true);
    expect(await f.answer(String(submitted.body.askId), { optionId: "reject" })).toMatchObject({ status: 200 });
    expect(await f.read(String(submitted.body.askId))).toMatchObject({ body: { state: "answered", optionId: "reject" } });
  });

  it.each([
    ["no person is registered", { owner: null, people: [] }],
    ["several people are registered and none is the default", { owner: null, people: ["mike", "dana"] }],
    ["the seat's chosen person is no longer registered", { owner: "gone@external", people: ["mike"] }],
  ])("permits at once with the agent's offered allow when %s, and asks no one", async (_case, options) => {
    const f = fixture(options);
    expect(await f.submit()).toMatchObject({ status: 200, body: { ok: true, state: "permitted", optionId: "allow" } });
    expect(f.queueRepo.list({ limit: 100 }).filter((row) => row.tags?.includes("runner-permission"))).toHaveLength(0);
    expect(f.waitsOnPerson()).toBe(false);
  });

  it("refuses every request only when the seat's operator opted in to denial", async () => {
    const f = fixture({ owner: "deny", people: ["mike"] });
    expect(await f.submit()).toMatchObject({ status: 409, body: { code: "denied_by_seat" } });
    expect(f.queueRepo.list({ limit: 100 }).filter((row) => row.tags?.includes("runner-permission"))).toHaveLength(0);
  });

  it("asks the seat's override when one is set, rather than the default person", async () => {
    const f = fixture({ owner: OTHER_PERSON, people: ["mike", "dana"] });
    const submitted = await f.submit();
    expect(f.queueRepo.getById(String(submitted.body.askId))).toMatchObject({ destinationSession: OTHER_PERSON });
  });

  it("asks the chosen person with every option the agent offered, allow_always with its native meaning, and the seat reads needs input", async () => {
    const f = fixture();
    const submitted = await f.submit();
    expect(submitted).toMatchObject({ status: 200, body: { ok: true, created: true } });
    const ask = f.queueRepo.getById(String(submitted.body.askId))!;
    expect(ask).toMatchObject({ state: "pending", sourceSession: SEAT, destinationSession: PERSON });
    expect(ask.humanQuestions?.[0]?.options.map((option) => option.id)).toEqual(["allow", "always", "reject"]);
    expect(ask.body).toContain("Edit src/app.ts");
    expect(ask.body).toMatch(/Always allow \(allow_always, always\): the agent's harness remembers this choice/);
    expect(ask.body).toContain("Your answer, a choice or your own words, goes to this host's receiving agent, which decides this one request while the agent waits: it acts on a clear answer at once, and asks you back when your words aren't clear. Where no agent can decide here, your answer is kept and the request waits, and nothing runs: decide directly with rig seat decide-permission, or set up a receiving agent.");
    expect(f.waitsOnPerson()).toBe(true);
    expect(await f.read(String(submitted.body.askId))).toMatchObject({ status: 200, body: { state: "pending" } });
    expect(await f.answer(String(submitted.body.askId), { optionId: "always" })).toMatchObject({ status: 200 });
    expect(await f.read(String(submitted.body.askId))).toMatchObject({ body: { state: "answered", optionId: "always" } });
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
    ["an option id a person's choice can't carry", [{ optionId: "allow:1", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }], "allow:1"],
    ["more options than an ask can show", ["a", "b", "c", "d"].map((id) => ({ optionId: `reject-${id}`, name: id, kind: "reject_once" }))
      .concat([{ optionId: "always", name: "Always", kind: "allow_always" }]), "always"],
  ])("permits with the agent's own allow when %s, and asks no one", async (_case, options, optionId) => {
    const f = fixture();
    expect(await f.submit({ options })).toMatchObject({ status: 200, body: { ok: true, state: "permitted", optionId } });
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

  it("takes any registered person's click, but no one else's", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    expect((await f.answer(askId, { optionId: "allow" }, "stranger@external")).status).not.toBe(200);
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(await f.answer(askId, { optionId: "allow" }, OTHER_PERSON)).toMatchObject({ status: 200 });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "allow" } });
  });

  it.each([
    ["a typed yes", { decision: "Yes." }, "answered", "allow", undefined],
    ["a typed no", { decision: "no" }, "answered", "reject", undefined],
    // Words that are neither are kept: nobody decided on them, so the request waits, never the default permit.
    ["typed words that are neither", { decision: "what does this edit do?" }, "pending", undefined, undefined],
  ])("reads %s from the person as the offered option, and keeps other words waiting", async (_case, choice, state, optionId, said) => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    expect(await f.answer(askId, choice)).toMatchObject({ status: 200 });
    const read = await f.read(askId);
    expect(read).toMatchObject({ body: { state, ...(optionId ? { optionId } : {}) } });
    // The person's own words reach the runner beside the default, never in place of an option.
    expect(read.body.said).toBe(said);
  });

  it("keeps the person's words waiting when the agent offered no allow option, never reading them as a no", async () => {
    const f = fixture();
    const askId = String((await f.submit({ options: [{ optionId: "reject", name: "Reject", kind: "reject_once" },
      { optionId: "never", name: "Never", kind: "reject_always" }] })).body.askId);
    expect(await f.answer(askId, { decision: "use the other file instead" })).toMatchObject({ status: 200 });
    expect((await f.read(askId)).body).toEqual({ ok: true, state: "pending" });
  });

  it("carries a colleague's words, whole, when the ask was routed to them", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb: "route", qitemId: askId, actorSession: PERSON, destinationSession: OTHER_PERSON, reason: "Dana decides", notify: false } as never);
    const colleague = f.queueRepo.list({ limit: 100 }).find((row) => row.destinationSession === OTHER_PERSON && row.handedOffFrom === askId)!;
    const words = `only the tests folder; ${"and nothing else. ".repeat(200)}`;
    expect(await f.answer(colleague.qitemId, { decision: words }, OTHER_PERSON)).toMatchObject({ status: 200 });
    // Nobody decided on the colleague's words: the request waits, and their words are kept whole on their row.
    expect((await f.read(askId, 1)).body).toEqual({ ok: true, state: "pending" });
    expect((f.queueRepo.getById(colleague.qitemId)!.humanAnswers?.permission as { text?: string })?.text).toBe(words.trim());
  });

  it.each([
    ["deny", "answered", "reject"],
    ["drop", "permitted", "allow"],
  ])("reads Mission Control's %s on the ask as the person's no, or as no answer", async (verb, state, optionId) => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb, qitemId: askId, actorSession: PERSON, reason: "from the Feed" } as never);
    expect(await f.read(askId)).toMatchObject({ body: { state, optionId } });
  });

  it.each([
    ["a typed no", { decision: "no" }],
    ["the Feed's deny", null],
  ] as const)("reads %s as the person's refusal, never a grant, when the agent offered no reject option", async (_case, choice) => {
    const f = fixture();
    const askId = String((await f.submit({ options: OPTIONS.slice(0, 2) })).body.askId);
    if (choice) expect(await f.answer(askId, choice)).toMatchObject({ status: 200 });
    else await f.contract.act({ verb: "deny", qitemId: askId, actorSession: PERSON, reason: "from the Feed" } as never);
    expect((await f.read(askId)).body).toEqual({ ok: true, state: "refused", reason: "said_no" });
  });

  it.each(["route", "handoff"])("after a person's %s to a colleague, waits for the colleague, whose answer reaches the agent", async (verb) => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb, qitemId: askId, actorSession: PERSON, destinationSession: OTHER_PERSON, reason: "Dana decides", notify: false } as never);
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    const successor = f.queueRepo.list({ limit: 100 }).find((row) => row.destinationSession === OTHER_PERSON && row.chainOfRecord?.includes(askId));
    expect(successor?.humanQuestions?.[0]?.options.map((option) => option.id)).toEqual(["allow", "always", "reject"]);
    expect(await f.answer(successor!.qitemId, { optionId: "reject" }, OTHER_PERSON)).toMatchObject({ status: 200 });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "reject" } });
  });

  it("follows only the colleague's own row: a later row citing the ask is neither read nor withdrawn", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb: "route", qitemId: askId, actorSession: PERSON, destinationSession: OTHER_PERSON, reason: "Dana decides", notify: false } as never);
    const colleague = f.queueRepo.list({ limit: 100 }).find((row) => row.destinationSession === OTHER_PERSON && row.chainOfRecord?.includes(askId))!;
    const unrelated = await f.queueRepo.create({ sourceSession: PERSON, destinationSession: OTHER_PERSON, body: "a follow-up about that edit",
      chainOfRecord: [askId], nudge: false });
    f.queueRepo.update({ qitemId: unrelated.qitemId, actorSession: OTHER_PERSON, state: "done", closureReason: "no-follow-on", transitionNote: "read it" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(await f.withdraw(askId, "turn_ended")).toMatchObject({ body: { state: "withdrawn" } });
    expect(f.queueRepo.getById(colleague.qitemId)!.state).toBe("canceled");
    expect(f.queueRepo.getById(unrelated.qitemId)!.state).toBe("done");
  });

  it("follows only the handoff's own successor: an earlier row to the same person with the ask's tags and chain is never picked", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    const earlier = await f.queueRepo.create({ sourceSession: PERSON, destinationSession: OTHER_PERSON, body: "a note about that edit",
      tags: f.queueRepo.getById(askId)!.tags ?? [], chainOfRecord: [askId], nudge: false });
    f.queueRepo.update({ qitemId: earlier.qitemId, actorSession: OTHER_PERSON, state: "done", closureReason: "no-follow-on", transitionNote: "read it" });
    f.db.prepare("UPDATE queue_items SET ts_created = '2026-01-01T00:00:00.000Z' WHERE qitem_id = ?").run(earlier.qitemId);
    await f.contract.act({ verb: "route", qitemId: askId, actorSession: PERSON, destinationSession: OTHER_PERSON, reason: "Dana decides", notify: false } as never);
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
  });

  it.each([
    ["handoff", "a click", { optionId: "always" }, "always"],
    ["handoff", "a typed no", { decision: "no" }, "reject"],
    ["handoffAndComplete", "a click", { optionId: "always" }, "always"],
    ["handoffAndComplete", "a typed no", { decision: "no" }, "reject"],
  ] as const)("after a plain queue %s to a person, %s on their row reaches the agent", async (verb, _case, choice, optionId) => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    const { created } = await f.queueRepo[verb]({ qitemId: askId, fromSession: PERSON, toSession: OTHER_PERSON, nudge: false });
    expect(created.humanQuestions?.[0]?.options.map((option) => option.id)).toEqual(["allow", "always", "reject"]);
    expect(await f.answer(created.qitemId, choice, OTHER_PERSON)).toMatchObject({ status: 200 });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId } });
  });

  it.each([
    ["a plain queue handoff", "a click", { optionId: "always" }, "always"],
    ["a plain queue handoff", "a typed no", { decision: "no" }, "reject"],
    ["Mission Control's route", "a click", { optionId: "always" }, "always"],
    ["Mission Control's route", "a typed no", { decision: "no" }, "reject"],
  ] as const)("routed to an agent seat and then by %s to a person, %s from that person reaches the agent", async (how, _case, choice, optionId) => {
    const f = fixture();
    const SEAT_B = "dev-other@perm-rig";
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb: "route", qitemId: askId, actorSession: PERSON, destinationSession: SEAT_B, reason: "the other seat decides", notify: false } as never);
    const seatRow = f.queueRepo.list({ limit: 100 }).find((row) => row.destinationSession === SEAT_B && row.handedOffFrom === askId)!;
    expect(seatRow.humanQuestions ?? null).toBeNull();
    if (how === "a plain queue handoff") await f.queueRepo.handoff({ qitemId: seatRow.qitemId, fromSession: SEAT_B, toSession: OTHER_PERSON, nudge: false });
    else await f.contract.act({ verb: "route", qitemId: seatRow.qitemId, actorSession: PERSON, destinationSession: OTHER_PERSON, reason: "Dana decides", notify: false } as never);
    const personRow = f.queueRepo.list({ limit: 100 }).find((row) => row.destinationSession === OTHER_PERSON && row.handedOffFrom === seatRow.qitemId)!;
    expect(personRow.humanQuestions?.[0]?.options.map((option) => option.id)).toEqual(["allow", "always", "reject"]);
    expect(await f.answer(personRow.qitemId, choice, OTHER_PERSON)).toMatchObject({ status: 200 });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId } });
  });

  it("reads a row set to state denied as the person's no", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    f.db.prepare("UPDATE queue_items SET state = 'denied', closure_reason = 'no-follow-on' WHERE qitem_id = ?").run(askId);
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "reject" } });
  });

  it("reports a replaced occupant's revoked grant as stale, at submit, read and withdraw", async () => {
    const f = fixture();
    const first = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" });
    const askId = String((await f.submit({ nodeId: undefined, generation: undefined }, first.token)).body.askId);
    f.relaunch();
    f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" }); // the new launch's grant revokes the first
    expect(await f.submit({ nodeId: undefined, generation: undefined, requestId: "8" }, first.token)).toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    expect(await f.read(askId, 0, first.token)).toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    expect(await f.withdraw(askId, "turn_ended", first.token)).toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
  });

  it("reports a grant reissued for the same occupant as revoked, since it can still be the live request", async () => {
    const f = fixture();
    const first = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" });
    f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" }); // a lost response, issued again
    expect(await f.submit({ nodeId: undefined, generation: undefined }, first.token)).toMatchObject({ status: 401, body: { code: "activity_grant_revoked" } });
    const askId = String((await f.submit()).body.askId);
    expect(await f.read(askId, 0, first.token)).toMatchObject({ status: 401, body: { code: "activity_grant_revoked" } });
  });

  it("never permits a handoff it can't follow: with no local successor the request stays pending, and withdrawing leaves the row", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    f.db.prepare("UPDATE queue_items SET state = 'handed-off', closure_reason = 'handed_off_to', handed_off_to = 'dana@external@other-host' WHERE qitem_id = ?").run(askId);
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(await f.withdraw(askId, "turn_ended")).toMatchObject({ body: { state: "withdrawn" } });
    expect(f.queueRepo.getById(askId)!.state).toBe("handed-off");
  });

  it("follows a handoff that completes the ask to the colleague's row", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    const { created } = await f.queueRepo.handoffAndComplete({ qitemId: askId, fromSession: PERSON, toSession: OTHER_PERSON, nudge: false });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    await f.contract.act({ verb: "deny", qitemId: created.qitemId, actorSession: OTHER_PERSON, reason: "not this one" } as never);
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "reject" } });
  });

  it("takes the primary user's ordinary answer from the terminal, as on any ask", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb: "answer", qitemId: askId, actorSession: OTHER_PERSON, questionId: "permission", optionId: "allow",
      authority: "primary-user" } as never);
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "allow" } });
    expect(f.rowsToSeat()).toBe(0);
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

  it.each([false, true])("refuses unverified grant reads and writes without changing the live ask, then recovers (guest=%s)", async guest => {
    const f = fixture({ guest });
    f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('b',?,?,'%1')").run(f.runner.id, SEAT);
    const session = f.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(f.runner.id) as { id: string };
    const grant = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "launch", run: {
      runId: "permission-run", sessionId: session.id, binding: { runtime: "synth", runner: 1, pane: "%1", panePid: 101 } } });
    expect(f.grants.activate(grant.grantId)).toBe(true);
    const askId = String((await f.submit({}, grant.token)).body.askId);
    const before = f.queueRepo.getById(askId);
    const events = f.db.prepare("SELECT COUNT(*) AS n FROM events").get();
    const read = vi.spyOn(SeatIdentityStore.prototype, "getForNode").mockImplementation(() => { throw new Error("observation unavailable"); });
    try {
      for (const reply of [await f.read(askId, 0, grant.token), await f.withdraw(askId, "turn_ended", grant.token),
        await f.submit({ requestId: "unverified-new" }, grant.token)]) {
        expect(reply).toMatchObject({ status: 409, body: { code: "activity_grant_unverified", retryable: true } });
      }
      expect(f.queueRepo.getById(askId)).toEqual(before);
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(events);
      expect(f.grants.get(grant.grantId)?.revokedAt).toBeNull();
    } finally { read.mockRestore(); }
    expect(await f.read(askId, 0, grant.token)).toMatchObject({ status: 200, body: { state: "pending" } });
    expect(f.grants.standing(grant.grantId)).toBe("current");
  });

  it("serves the real guest listener's app for a seat grant, and never for the install token", async () => {
    const f = fixture({ realGuest: true });
    const grant = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" });
    const submitted = await f.submit({ nodeId: undefined, generation: undefined }, grant.token);
    expect(submitted).toMatchObject({ status: 200, body: { created: true } });
    const askId = String(submitted.body.askId);
    expect(await f.read(askId, 0, grant.token)).toMatchObject({ status: 200, body: { state: "pending" } });
    expect(await f.submit({ requestId: "9" })).toMatchObject({ status: 401 });
    expect(await f.read(askId)).toMatchObject({ status: 401 });
    expect(await f.answer(askId, { optionId: "allow" })).toMatchObject({ status: 200 });
    expect(await f.read(askId, 0, grant.token)).toMatchObject({ status: 200, body: { state: "answered", optionId: "allow" } });
    expect(await f.withdraw(askId, "turn_ended", grant.token)).toMatchObject({ status: 200, body: { state: "answered" } });
  });

  it("refuses an earlier occupant's unrevoked grant on the current occupant's ask, to read or to withdraw", async () => {
    const f = fixture();
    const earlier = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" });
    f.relaunch(); // no new grant is issued, so the earlier one isn't revoked
    const askId = String((await f.submit()).body.askId);
    expect(await f.read(askId, 0, earlier.token)).toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    expect(await f.withdraw(askId, "turn_cancelled", earlier.token)).toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
    expect(await f.read(askId)).toMatchObject({ status: 200, body: { state: "pending" } });
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending" });
  });

  it("refuses a waiting read whose grant's occupant is replaced during the wait", async () => {
    const f = fixture();
    const grant = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" });
    const askId = String((await f.submit({ nodeId: undefined, generation: undefined }, grant.token)).body.askId);
    const waiting = f.read(askId, 1, grant.token);
    await new Promise((resolve) => setTimeout(resolve, 50));
    f.relaunch();
    expect(await waiting).toMatchObject({ status: 409, body: { code: "activity_grant_stale" } });
  });

  it("reads an earlier occupant's answered ask as stale to the next occupant, never as its option", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    await f.answer(askId, { optionId: "allow" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "allow" } });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "allow" } });
    f.relaunch();
    const later = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" });
    const byGrant = await f.read(askId, 0, later.token);
    expect(byGrant).toMatchObject({ status: 200, body: { state: "stale" } });
    expect(byGrant.body.optionId).toBeUndefined();
    expect(await f.read(askId)).toMatchObject({ status: 200, body: { state: "stale" } });
  });
});

// R1: a permit OpenRig decides by default, with no one asked or an ask closed without a choice, leaves one pull-only
// record on the stream: the seat, the tool call, why, and the option the agent got. It wakes no one, and the permit
// itself is unchanged.
describe("a default permit's record", () => {
  it("records who was permitted, for what, why and with which option when no one can be asked, and wakes no one", async () => {
    const f = fixture({ owner: null, people: [] });
    expect(await f.submit()).toMatchObject({ status: 200, body: { ok: true, state: "permitted", optionId: "allow" } });
    const records = f.permits();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sourceSession: SEAT, hintDestination: null, interrupt: false });
    expect(records[0]!.body).toContain("Edit src/app.ts (edit)");
    expect(records[0]!.body).toContain("no one can be asked");
    expect(records[0]!.body).toContain("Allow (allow_once, allow)");
    expect(records[0]!.body).toContain("conversation-1, turn 1, request 7");
    expect(f.rowsToSeat()).toBe(0);
    expect(f.nudges).toHaveLength(0);
  });

  it("records a permit made through the guest listener with a seat grant", async () => {
    const f = fixture({ realGuest: true, owner: null, people: [] });
    const grant = f.grants.issue({ nodeId: f.runner.id, generation: f.generation(), issuedBy: "test" });
    expect(await f.submit({ nodeId: undefined, generation: undefined }, grant.token)).toMatchObject({ status: 200, body: { state: "permitted", optionId: "allow" } });
    expect(f.permits()).toHaveLength(1);
  });

  it("records a resubmitted request once", async () => {
    const f = fixture({ owner: null, people: [] });
    await f.submit();
    await f.submit();
    expect(f.permits()).toHaveLength(1);
  });

  it("records options a person can't be shown, and says when the option it gave is remembered by the agent's harness", async () => {
    const f = fixture();
    const options = ["a", "b", "c", "d"].map((id) => ({ optionId: `reject-${id}`, name: id, kind: "reject_once" }))
      .concat([{ optionId: "always", name: "Always", kind: "allow_always" }]);
    expect(await f.submit({ options })).toMatchObject({ body: { state: "permitted", optionId: "always" } });
    const records = f.permits();
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toContain("can't be shown to a person");
    expect(records[0]!.body).toMatch(/Always \(allow_always, always\): the agent's harness remembers this choice/);
  });

  it("records an ask closed without a choice once, however often the runner reads it", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    expect(f.permits()).toHaveLength(0);
    await f.contract.act({ verb: "drop", qitemId: askId, actorSession: PERSON, reason: "from the Feed" } as never);
    expect(await f.read(askId)).toMatchObject({ body: { state: "permitted", optionId: "allow" } });
    expect(await f.read(askId)).toMatchObject({ body: { state: "permitted", optionId: "allow" } });
    const records = f.permits();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ sourceSession: SEAT, hintDestination: null, interrupt: false });
    expect(records[0]!.body).toContain(askId);
    expect(records[0]!.body).toContain(PERSON);
    expect(records[0]!.body).toContain("allow_once");
  });

  it("names who closed the ask, not whoever added a later receipt to the closed row", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb: "drop", qitemId: askId, actorSession: PERSON, reason: "from the Feed" } as never);
    f.queueRepo.transitionLog.append({ qitemId: askId, state: f.queueRepo.getById(askId)!.state, actorSession: "queue@system",
      transitionNote: "a later delivery receipt" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "permitted", optionId: "allow" } });
    const records = f.permits();
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toContain(`${PERSON} closed the ask`);
    expect(records[0]!.body).not.toContain("queue@system");
  });

  it("permits as before when the record's details can't be read", async () => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb: "drop", qitemId: askId, actorSession: PERSON, reason: "from the Feed" } as never);
    f.queueRepo.closingTransition = () => { throw new Error("the transition log can't be read"); };
    expect(await f.read(askId)).toMatchObject({ status: 200, body: { state: "permitted", optionId: "allow" } });
    expect(f.permits()).toHaveLength(0);
  });

  it("records an agent seat's row closed as failed, which permits", async () => {
    const f = fixture();
    const SEAT_B = "dev-other@perm-rig";
    const askId = String((await f.submit()).body.askId);
    await f.contract.act({ verb: "route", qitemId: askId, actorSession: PERSON, destinationSession: SEAT_B, reason: "the other seat decides", notify: false } as never);
    const seatRow = f.queueRepo.list({ limit: 100 }).find((row) => row.destinationSession === SEAT_B && row.handedOffFrom === askId)!;
    f.queueRepo.update({ qitemId: seatRow.qitemId, actorSession: SEAT_B, state: "failed", transitionNote: "couldn't decide" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "permitted", optionId: "allow" } });
    const records = f.permits();
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toContain(seatRow.qitemId);
    expect(records[0]!.body).toContain(SEAT_B);
    expect(records[0]!.body).toContain("failed");
  });

  it.each([
    ["a click", { optionId: "allow" }],
    ["a typed yes", { decision: "yes" }],
    ["a typed no", { decision: "no" }],
  ])("records nothing when the person answered with %s", async (_case, choice) => {
    const f = fixture();
    const askId = String((await f.submit()).body.askId);
    expect(await f.answer(askId, choice)).toMatchObject({ status: 200 });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered" } });
    expect(f.permits()).toHaveLength(0);
  });

  it("permits exactly as before when the record can't be written", async () => {
    const f = fixture({ owner: null, people: [], brokenStream: true });
    expect(await f.submit()).toMatchObject({ status: 200, body: { ok: true, state: "permitted", optionId: "allow" } });
    const asked = fixture({ brokenStream: true });
    const askId = String((await asked.submit()).body.askId);
    await asked.contract.act({ verb: "drop", qitemId: askId, actorSession: PERSON, reason: "from the Feed" } as never);
    expect(await asked.read(askId)).toMatchObject({ status: 200, body: { state: "permitted", optionId: "allow" } });
  });
});

describe("an answered request goes to the receiving agent, which decides while the runner waits", () => {
  it("a person's click is kept and handed to the agent; the runner reads pending until the agent decides, then that option", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    expect(await f.answer(askId, { optionId: "allow" })).toMatchObject({ status: 200 });
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "handed-off", handedOffTo: DECIDER, humanAnswers: { permission: "allow" } });
    const handed = f.queueRepo.list({ limit: 100 }).find((row) => row.handedOffFrom === askId)!;
    expect(handed).toMatchObject({ destinationSession: DECIDER, state: "pending" });
    expect(handed.body).toContain(`${PERSON} answered ${SEAT}'s permission request ${askId}: they chose "Allow" (option allow).`);
    expect(handed.body).toContain(`Decide with: rig seat decide-permission ${askId} --option <id>`);
    // The receiver reads who to ask back (the person who answered), and that closing without a decision permits nothing.
    expect(handed.body).toContain(`ask them back with an ask to ${PERSON} that names request ${askId}`);
    expect(handed.body).toContain("Closing this item without deciding permits nothing: the person's answer stays kept and the runner keeps waiting");
    expect(handed.body).not.toContain("is how OpenRig records any answer typed at this machine's terminal");
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(await f.decide(askId, "allow")).toMatchObject({ status: 200, body: { ok: true, state: "answered", optionId: "allow" } });
    expect(await f.read(askId)).toMatchObject({ body: { state: "answered", optionId: "allow" } });
    const note = f.queueRepo.listTransitions(handed.qitemId).at(-1)?.transitionNote ?? "";
    expect(note).toContain(`runner-permission-decided by ${DECIDER}, an agent, not the person: allow, because they said so`);
    // Deciding again changes nothing: the request isn't pending any more.
    expect(await f.decide(askId, "reject")).toMatchObject({ status: 200, body: { state: "answered", optionId: "allow" } });
    expect(f.permits()).toHaveLength(0);
  });

  it("an answer typed at the terminal reaches the agent with what it means, who's who, and the asked person to ask back", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    const asked = f.queueRepo.getById(askId)!.destinationSession;
    await f.contract.act({ verb: "answer", qitemId: askId, actorSession: "human@host", authority: "primary-user",
      questionId: "permission", optionId: "allow" } as never);
    const handed = f.queueRepo.list({ limit: 100 }).find((row) => row.handedOffFrom === askId)!;
    expect(handed).toMatchObject({ destinationSession: DECIDER, state: "pending" });
    // Provenance stays truthful: the answerer is human@host, never a registered person.
    expect(handed.body).toContain(`human@host answered ${SEAT}'s permission request ${askId}: they chose "Allow" (option allow).`);
    expect(handed.body).toContain(`- **Who's who:** ${SEAT} is the agent asking to run the tool; ${asked} is the person it asked; human@host answered.`);
    expect(handed.body).toContain("human@host is how OpenRig records any answer typed at this machine's terminal or TUI");
    expect(handed.body).toContain(`ask them back with an ask to ${asked} that names request ${askId}`);
    expect(handed.body).toContain("A row to human@host names no person: it asks no one, waits on Steering and in the Feed, and OpenRig reports it as undeliverable, so don't ask them back there.");
    expect(handed.body).toContain("Closing this item without deciding permits nothing");
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(f.permits()).toHaveLength(0);
  });

  it("a person's words, even a plain yes, go to the agent with the question and options, never permitted by default first", async () => {
    for (const words of ["yes", "only if it's the test file"]) {
      const f = fixture({ decider: DECIDER });
      const askId = String((await f.submit()).body.askId);
      expect(await f.answer(askId, { decision: words })).toMatchObject({ status: 200 });
      expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
      const handed = f.queueRepo.list({ limit: 100 }).find((row) => row.handedOffFrom === askId)!;
      expect(handed.body).toContain(`they wrote "${words}"`);
      expect(handed.body).toContain("- Reject (reject)");
      expect(await f.decide(askId, "reject", DECIDER, "they set a condition")).toMatchObject({ body: { state: "answered", optionId: "reject" } });
      const note = f.queueRepo.listTransitions(handed.qitemId).at(-1)?.transitionNote ?? "";
      expect(note).toContain(`the person wrote "${words}"`);
      expect(f.permits()).toHaveLength(0);
    }
  });

  it("an option the agent didn't offer is refused and nothing is decided; a withdrawn request decides nothing", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    await f.answer(askId, { optionId: "always" });
    expect(await f.decide(askId, "sure")).toMatchObject({ status: 400, body: { code: "invalid_option" } });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(await f.withdraw(askId, "turn_ended")).toMatchObject({ body: { state: "withdrawn" } });
    expect(await f.decide(askId, "allow")).toMatchObject({ status: 200, body: { state: "withdrawn" } });
    expect(f.queueRepo.list({ limit: 100 }).find((row) => row.handedOffFrom === askId)?.humanAnswers?.permission).toBeUndefined();
  });

  it("an agent that closes the handed row without deciding leaves the person's answer waiting: never a permit, and a direct decision settles it", async () => {
    for (const choice of [{ decision: "no" }, { optionId: "reject" }] as const) {
      const f = fixture({ decider: DECIDER });
      const askId = String((await f.submit()).body.askId);
      await f.answer(askId, choice);
      const handed = f.queueRepo.list({ limit: 100 }).find((row) => row.handedOffFrom === askId)!;
      // The agent's usual close, not decide-permission.
      await f.queueRepo.update({ qitemId: handed.qitemId, actorSession: DECIDER, state: "done", closureReason: "no-follow-on" });
      expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
      expect(f.permits()).toHaveLength(0);
      expect(await f.decide(askId, "reject", PERSON, "decided directly")).toMatchObject({ body: { state: "answered", optionId: "reject" } });
    }
  });

  it("with no agent that can decide, any answer is kept and the request waits; the person is told once; the direct decision decides", async () => {
    for (const choice of [{ decision: "yes" }, { optionId: "allow" }, { decision: "only the test file" }] as const) {
      const f = fixture({ decider: null });
      const askId = String((await f.submit()).body.askId);
      expect(await f.answer(askId, choice)).toMatchObject({ status: 200 });
      expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending" });
      expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
      await new Promise((resolve) => setImmediate(resolve));
      const told = f.queueRepo.list({ limit: 100 }).filter((row) => row.destinationSession === PERSON && row.humanIntent === "update");
      expect(told).toHaveLength(1);
      expect(told[0]!.body).toContain(`The tool hasn't run, and nothing was permitted or refused.`);
      expect(told[0]!.body).toContain(`rig seat decide-permission ${askId} --option <id>`);
      expect(f.permits()).toHaveLength(0);
      expect(await f.decide(askId, "reject", PERSON, "decided directly")).toMatchObject({ body: { state: "answered", optionId: "reject" } });
    }
  });
});

describe("an answered request goes to the receiving agent: the pair's round-0 controls", () => {
  const handedFrom = (f: ReturnType<typeof fixture>, id: string) => f.queueRepo.list({ limit: 100 }).find((row) => row.handedOffFrom === id);

  it("Steering's Approve or Deny on the request is the person's yes or no: it goes to the agent, or, with none, to the request as before", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    // The result says what became of the answer (the TUI prints it), never that the request closed.
    expect(await f.act(askId, "approve")).toMatchObject({ status: 200,
      body: { answer: { message: `Your answer on ${askId} went to ${DECIDER}, the receiving agent, which decides. The runner waits until then; nothing has run. A note to you says the agent's recorded state.` } } });
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "handed-off", handedOffTo: DECIDER });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(handedFrom(f, askId)!.body).toContain(`they wrote "yes"`);
    // With no agent that can decide, the Approve or Deny is kept as context too: the request waits for a direct decision.
    for (const verb of ["approve", "deny"] as const) {
      const g = fixture({ decider: null });
      const id = String((await g.submit()).body.askId);
      expect(await g.act(id, verb, { reason: `${verb}: only the test file` })).toMatchObject({ status: 200, body: { verb,
        answer: { message: expect.stringContaining(`Your answer is kept on ${id}, and the request is still waiting: the tool hasn't run`) } } });
      expect(await g.read(id)).toMatchObject({ body: { state: "pending" } });
      // The audit keeps what the person did: their verb, and their reason.
      expect(g.db.prepare("SELECT action_verb, reason FROM mission_control_actions WHERE qitem_id = ?").all(id))
        .toEqual([{ action_verb: verb, reason: `${verb}: only the test file` }]);
    }
  });

  it("the decider is chosen against the runner that asked, even after a person handed the request to another person", async () => {
    // The runner seat itself is the receiving agent: it can't decide its own blocked turn, so nobody else here can either.
    const f = fixture({ deciderOf: (requester) => requester === SEAT ? null : SEAT });
    const askId = String((await f.submit()).body.askId);
    expect(await f.act(askId, "handoff", { destinationSession: OTHER_PERSON })).toMatchObject({ status: 200 });
    const toDana = handedFrom(f, askId)!;
    expect(await f.answer(toDana.qitemId, { optionId: "reject" }, OTHER_PERSON)).toMatchObject({ status: 200 });
    expect(f.requesters).toEqual([SEAT]);
    expect(f.queueRepo.list({ limit: 100 }).some((row) => row.destinationSession === SEAT && row.handedOffFrom)).toBe(false);
    // Nobody else here can decide: the answer is kept, the request waits, and a direct decision settles it.
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(await f.decide(askId, "reject", OTHER_PERSON)).toMatchObject({ body: { state: "answered", optionId: "reject" } });
  });

  it("a handoff to the agent that fails leaves the request open, never a default permit", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    const spy = vi.spyOn(f.queueRepo as unknown as { handoffNow: () => unknown }, "handoffNow").mockImplementation(() => { throw new Error("staging failed"); });
    try {
      expect(await f.answer(askId, { decision: "only the test file" })).toMatchObject({ status: 200 });
      // Steering's Approve fails the same way, and is kept too.
      const other = String((await f.submit({ requestId: "8" })).body.askId);
      expect(await f.act(other, "approve")).toMatchObject({ status: 200 });
      expect((f.queueRepo.getById(other)!.humanAnswers?.permission as { text?: string })?.text).toBe("yes");
    } finally { spy.mockRestore(); }
    // The words are committed on the request, which stays open; the person is told it couldn't be passed on.
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending" });
    expect((f.queueRepo.getById(askId)!.humanAnswers?.permission as { text?: string })?.text).toBe("only the test file");
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.queueRepo.list({ limit: 100 }).filter((row) => row.destinationSession === PERSON && row.humanIntent === "update")
      .some((row) => row.body.includes(`it couldn't be passed to ${DECIDER}, the receiving agent, just now (answer again to retry)`))).toBe(true);
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(f.permits()).toHaveLength(0);
    // Answering again once it works passes the kept words on.
    expect(await f.answer(askId, { decision: "only the test file" })).toMatchObject({ status: 200 });
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "handed-off", handedOffTo: DECIDER });
    expect(handedFrom(f, askId)!.body).toContain(`they wrote "only the test file"`);
  });

  it("a person's no on a row handed to them is kept when the agent it went to closes without deciding (two handoffs)", async () => {
    const f = fixture({ decider: "lead-two@perm-rig" });
    const askId = String((await f.submit()).body.askId);
    await f.act(askId, "handoff", { destinationSession: OTHER_PERSON });
    const toDana = handedFrom(f, askId)!;
    await f.answer(toDana.qitemId, { decision: "no" }, OTHER_PERSON);
    const toAgent = handedFrom(f, toDana.qitemId)!;
    expect(toAgent.destinationSession).toBe("lead-two@perm-rig");
    await f.queueRepo.update({ qitemId: toAgent.qitemId, actorSession: "lead-two@perm-rig", state: "done", closureReason: "no-follow-on" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(f.permits()).toHaveLength(0);
    expect(await f.decide(askId, "reject", OTHER_PERSON)).toMatchObject({ body: { state: "answered", optionId: "reject" } });
  });

  it("the agent gets the person's whole words, with where they're recorded, however long", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    const words = `${"go ahead with the edit, it is the release fix we discussed this morning; ".repeat(9)}but only if it touches the test file`;
    expect(words.length).toBeGreaterThan(500);
    await f.answer(askId, { decision: words });
    const handed = handedFrom(f, askId)!;
    expect(handed.body).toContain(`they wrote "${words}"`);
    expect(handed.body).toContain(`rig queue show ${askId} --full`);
  });
});

describe("an answered request: the round-1 controls with the daemon's own decider order", () => {
  const handedFrom = (f: ReturnType<typeof fixture>, id: string) => f.queueRepo.list({ limit: 100 }).find((row) => row.handedOffFrom === id);
  const updatesTo = (f: ReturnType<typeof fixture>, person: string) => f.queueRepo.list({ limit: 100 }).filter((row) => row.destinationSession === person && row.humanIntent === "update");

  it("a forwarded request is never decided by the runner that asked, when that runner is the receiving agent: the answer is kept", async () => {
    const f = fixture({ receiver: SEAT });
    const askId = String((await f.submit()).body.askId);
    await f.act(askId, "handoff", { destinationSession: OTHER_PERSON });
    const toDana = handedFrom(f, askId)!;
    expect(await f.answer(toDana.qitemId, { decision: "yes" }, OTHER_PERSON)).toMatchObject({ status: 200 });
    expect(f.requesters).toEqual([SEAT]);
    expect(handedFrom(f, toDana.qitemId)).toBeUndefined();
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(updatesTo(f, OTHER_PERSON)[0]!.body).toContain(`or the only one is ${SEAT} itself`);
  });

  it("a chosen receiving agent this host doesn't have can't decide: the answer is kept, and the person is told", async () => {
    const f = fixture({ receiver: "ghost@perm-rig" });
    const askId = String((await f.submit()).body.askId);
    await f.answer(askId, { optionId: "allow" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(updatesTo(f, PERSON)).toHaveLength(1);
  });

  it("when the answer goes to an agent, the person is told once who decides and its recorded state", async () => {
    const f = fixture({ receiver: "dev-other@perm-rig" });
    const askId = String((await f.submit()).body.askId);
    await f.answer(askId, { decision: "only the test file" });
    expect(handedFrom(f, askId)).toMatchObject({ destinationSession: "dev-other@perm-rig" });
    await new Promise((resolve) => setImmediate(resolve));
    const told = updatesTo(f, PERSON);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain(`went to dev-other@perm-rig, which decides it while ${SEAT} waits. Nothing runs until it decides.`);
    expect(told[0]!.body).toContain("Receiving agent: dev-other@perm-rig, chosen in agents.operator_session; its session is recorded as running.");
    expect(told[0]!.body).toContain(`rig seat decide-permission ${askId} --option <id>`);
  });

  it("a Reject click on a row handed to a colleague is kept when the agent it went to closes without deciding (two handoffs)", async () => {
    const f = fixture({ decider: "lead-two@perm-rig" });
    const askId = String((await f.submit()).body.askId);
    await f.act(askId, "handoff", { destinationSession: OTHER_PERSON });
    const toDana = handedFrom(f, askId)!;
    await f.answer(toDana.qitemId, { optionId: "reject" }, OTHER_PERSON);
    const toAgent = handedFrom(f, toDana.qitemId)!;
    await f.queueRepo.update({ qitemId: toAgent.qitemId, actorSession: "lead-two@perm-rig", state: "done", closureReason: "no-follow-on" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(f.permits()).toHaveLength(0);
  });

  it("qualified words the agent closed without deciding stay waiting; a direct decision still settles them", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    await f.answer(askId, { decision: "only the test file" });
    const toAgent = handedFrom(f, askId)!;
    await f.queueRepo.update({ qitemId: toAgent.qitemId, actorSession: DECIDER, state: "done", closureReason: "no-follow-on" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(f.permits()).toHaveLength(0);
    expect(await f.decide(askId, "allow", PERSON, "the test file only")).toMatchObject({ body: { state: "answered", optionId: "allow" } });
  });
});

describe("a kept answer counts only through an explicit decision (Root's source finding at c0a5d7b1)", () => {
  it("with no agent that can decide, a kept click or plain yes followed by an ordinary close still waits: no direct action, no permit", async () => {
    for (const choice of [{ optionId: "allow" }, { decision: "yes" }, { optionId: "reject" }] as const) {
      const f = fixture({ decider: null });
      const askId = String((await f.submit()).body.askId);
      await f.answer(askId, choice);
      // An ordinary close by the person or an agent: not a decision.
      await f.queueRepo.update({ qitemId: askId, actorSession: PERSON, state: "done", closureReason: "no-follow-on" });
      expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
      expect(f.permits()).toHaveLength(0);
      // The explicit decision still settles it, recorded on the closed row.
      expect(await f.decide(askId, "allow", PERSON, "decided directly")).toMatchObject({ body: { state: "answered", optionId: "allow" } });
    }
  });

  it("a request closed with no answer at all keeps the default permit", async () => {
    const f = fixture({ decider: null });
    const askId = String((await f.submit()).body.askId);
    await f.queueRepo.update({ qitemId: askId, actorSession: PERSON, state: "done", closureReason: "no-follow-on" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "permitted", optionId: "allow" } });
  });
});

describe("an answered request: review-r2's round-1 questions", () => {
  it("a direct decision settles a request whose row closed as failed, and records the person's whole words", async () => {
    const f = fixture({ decider: null });
    const askId = String((await f.submit()).body.askId);
    const words = `${"careful with this one, it touches the release branch config and the CI cache. ".repeat(8)}only the test file`;
    await f.answer(askId, { decision: words });
    await f.queueRepo.update({ qitemId: askId, actorSession: PERSON, state: "failed" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(await f.decide(askId, "allow", PERSON, "only the test file")).toMatchObject({ body: { state: "answered", optionId: "allow" } });
    const note = f.queueRepo.listTransitions(askId).at(-1)?.transitionNote ?? "";
    expect(note).toContain(`the person wrote "${words.trim()}"`);
  });

  it("a withdrawal after the row closed without a decision ends it: it reads withdrawn, and a later decision writes nothing", async () => {
    const f = fixture({ decider: null });
    const askId = String((await f.submit()).body.askId);
    await f.answer(askId, { optionId: "allow" });
    await f.queueRepo.update({ qitemId: askId, actorSession: PERSON, state: "done", closureReason: "no-follow-on" });
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(await f.withdraw(askId, "turn_ended")).toMatchObject({ status: 200, body: { state: "withdrawn" } });
    expect(await f.read(askId)).toMatchObject({ body: { state: "withdrawn" } });
    expect(await f.decide(askId, "allow")).toMatchObject({ body: { state: "withdrawn" } });
    expect(f.queueRepo.listTransitions(askId).some((t) => t.transitionNote?.startsWith("runner-permission-decided"))).toBe(false);
  });

  it("a failed handoff's kept words survive a later ordinary close: the request waits, never a default permit", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    const spy = vi.spyOn(f.queueRepo as unknown as { handoffNow: () => unknown }, "handoffNow").mockImplementation(() => { throw new Error("staging failed"); });
    try { await f.answer(askId, { decision: "only the test file" }); } finally { spy.mockRestore(); }
    await f.queueRepo.update({ qitemId: askId, actorSession: PERSON, state: "done", closureReason: "no-follow-on" });
    expect((f.queueRepo.getById(askId)!.humanAnswers?.permission as { text?: string })?.text).toBe("only the test file");
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(f.permits()).toHaveLength(0);
  });

  it("a decision the row can't take says so: nothing is decided, and the request still waits", async () => {
    const f = fixture({ decider: null });
    const askId = String((await f.submit()).body.askId);
    await f.answer(askId, { decision: "only the test file" });
    const spy = vi.spyOn(f.queueRepo, "recordPermissionDecision").mockReturnValue(false);
    try {
      expect(await f.decide(askId, "allow")).toMatchObject({ status: 409, body: { ok: false, code: "not_recorded",
        error: expect.stringContaining("Nothing was decided. Read the request again.") } });
    } finally { spy.mockRestore(); }
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
  });
});

describe("an answered request: #2934's follow-ups", () => {
  it("a decision on a row closed without one persists queue.updated, so a waiting runner and Steering hear it", async () => {
    const f = fixture({ decider: null });
    const askId = String((await f.submit()).body.askId);
    await f.answer(askId, { decision: "only the test file" });
    await f.queueRepo.update({ qitemId: askId, actorSession: PERSON, state: "done", closureReason: "no-follow-on" });
    const updates = () => (f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'queue.updated' AND json_extract(payload, '$.qitemId') = ?").get(askId) as { n: number }).n;
    const before = updates();
    expect(await f.decide(askId, "allow")).toMatchObject({ body: { state: "answered", optionId: "allow" } });
    expect(updates()).toBe(before + 1);
  });

  it("a handoff that fails after persisting its events still keeps the person's words (the envelope drops the rolled-back tokens)", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    // The real handoff persists its two events, then fails at its last check: its savepoint rolls them back.
    const spy = vi.spyOn(f.queueRepo as unknown as { assertTerminalClosureHasIntent: () => void }, "assertTerminalClosureHasIntent")
      .mockImplementationOnce(() => { throw new Error("closure check failed"); });
    try {
      expect(await f.answer(askId, { decision: "only the test file" })).toMatchObject({ status: 200 });
    } finally { spy.mockRestore(); }
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending" });
    expect((f.queueRepo.getById(askId)!.humanAnswers?.permission as { text?: string })?.text).toBe("only the test file");
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(f.permits()).toHaveLength(0);
  });

  it("a handoff that throws after its own write was released rolls back whole, so the kept answer is the only outcome", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    // The handoff's own transaction has released its savepoint; the throw comes after it, inside the caller's transaction.
    const spy = vi.spyOn(f.queueRepo as unknown as { deliverWakeIntentAfterCommit: () => void }, "deliverWakeIntentAfterCommit")
      .mockImplementationOnce(() => { throw new Error("failed after the handoff was written"); });
    try {
      expect(await f.answer(askId, { decision: "only the test file" })).toMatchObject({ status: 200 });
    } finally { spy.mockRestore(); }
    // Nothing of the handoff remains: the request wasn't handed on, and no row went to the receiving agent.
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE handed_off_from = ?").get(askId)).toEqual({ n: 0 });
    expect((f.queueRepo.getById(askId)!.humanAnswers?.permission as { text?: string })?.text).toBe("only the test file");
    expect(await f.read(askId)).toMatchObject({ body: { state: "pending" } });
    expect(f.permits()).toHaveLength(0);
  });
});

// The Slack fallback answers a direct runner ask with resolveDirectHumanReply itself (slack-subsystem.ts:179): no notify
// envelope and no transaction is open around it.
describe("a direct answer with no notify envelope (the Slack fallback)", () => {
  const watch = (f: ReturnType<typeof fixture>) => {
    const seen: Array<{ type: string; qitemId: string; to?: string; inTransaction: boolean }> = [];
    const stop = f.bus.subscribe((event) => {
      if (event.type === "queue.handed_off") seen.push({ type: event.type, qitemId: event.qitemId, to: event.toSession, inTransaction: f.db.inTransaction });
      if (event.type === "queue.created") seen.push({ type: event.type, qitemId: event.qitemId, to: event.destinationSession, inTransaction: f.db.inTransaction });
    });
    return { seen, stop };
  };

  it("a handoff that throws after its own write delivers nothing to subscribers, and the answer is kept", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    const { seen, stop } = watch(f);
    const spy = vi.spyOn(f.queueRepo as unknown as { deliverWakeIntentAfterCommit: () => void }, "deliverWakeIntentAfterCommit")
      .mockImplementationOnce(() => { throw new Error("failed after the handoff was written"); });
    try {
      f.queueRepo.resolveDirectHumanReply({ qitemId: askId, actorSession: PERSON, decision: "only the test file" });
    } finally { spy.mockRestore(); stop(); }
    expect(seen.filter((e) => (e.type === "queue.handed_off" && e.qitemId === askId) || (e.type === "queue.created" && e.to === DECIDER))).toEqual([]);
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE handed_off_from = ?").get(askId)).toEqual({ n: 0 });
    expect((f.queueRepo.getById(askId)!.humanAnswers?.permission as { text?: string })?.text).toBe("only the test file");
    expect(f.permits()).toHaveLength(0);
  });

  it("a handoff that succeeds reaches subscribers once, after it commits", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    const { seen, stop } = watch(f);
    try {
      expect(f.queueRepo.resolveDirectHumanReply({ qitemId: askId, actorSession: PERSON, decision: "only the test file" })).toBe(true);
    } finally { stop(); }
    const successor = f.db.prepare("SELECT qitem_id FROM queue_items WHERE handed_off_from = ?").get(askId) as { qitem_id: string };
    expect(seen.filter((e) => e.qitemId === askId || e.qitemId === successor.qitem_id)).toEqual([
      { type: "queue.handed_off", qitemId: askId, to: DECIDER, inTransaction: false },
      { type: "queue.created", qitemId: successor.qitem_id, to: DECIDER, inTransaction: false },
    ]);
  });
});

// A person answering from the TUI answers as the host's human seat, and a person-addressed row to a human seat must
// carry an evidence ref (convention C3). Without one, both notes to the person were refused and never written.
describe("the person's note about a runner answer is written under the queue's own conventions", () => {
  const HUMAN_SEAT = "human@host";
  const answerAsHost = (f: ReturnType<typeof fixture>, askId: string, choice: { optionId?: string; decision?: string }) =>
    f.contract.act({ verb: "answer", qitemId: askId, actorSession: HUMAN_SEAT, authority: "primary-user",
      ...(choice.optionId ? { questionId: "permission", optionId: choice.optionId } : {}), ...(choice.decision ? { decision: choice.decision } : {}) } as never);
  const notesTo = (f: ReturnType<typeof fixture>) => f.queueRepo.list({ limit: 100 })
    .filter((row) => row.destinationSession === HUMAN_SEAT && row.humanIntent === "update");

  it("with no agent that can decide, the kept-answer note is written once, linked to the request, with the direct route", async () => {
    const f = fixture({ decider: null });
    const askId = String((await f.submit()).body.askId);
    await answerAsHost(f, askId, { optionId: "allow" });
    await vi.waitFor(() => expect(notesTo(f)).toHaveLength(1));
    const [note] = notesTo(f);
    expect(note).toMatchObject({ qitemId: `qitem-runner-permission-kept-${askId.replace(/^qitem-runner-permission-/, "")}`,
      evidenceRef: `rig queue show ${askId}`, sourceSession: SEAT });
    expect(note!.body).toContain("The tool hasn't run, and nothing was permitted or refused.");
    expect(note!.body).toContain(`rig seat decide-permission ${askId} --option <id>`);
    // The answer itself is kept on the request, and the request still waits.
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending", humanAnswers: { permission: "allow" } });
    // Answering again keeps the new answer and writes no second note.
    await answerAsHost(f, askId, { decision: "only the test file" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notesTo(f)).toHaveLength(1);
    expect(f.permits()).toHaveLength(0);
  });

  it("when the answer goes to an agent, the who-decides note is written once, linked to the request, with the agent's state", async () => {
    const f = fixture({ receiver: "dev-other@perm-rig" });
    const askId = String((await f.submit()).body.askId);
    await answerAsHost(f, askId, { decision: "only the test file" });
    await vi.waitFor(() => expect(notesTo(f)).toHaveLength(1));
    const [note] = notesTo(f);
    expect(note).toMatchObject({ evidenceRef: `rig queue show ${askId}`, sourceSession: SEAT });
    expect(note!.body).toContain(`went to dev-other@perm-rig, which decides it while ${SEAT} waits. Nothing runs until it decides.`);
    expect(note!.body).toContain("Receiving agent: dev-other@perm-rig, chosen in agents.operator_session; its session is recorded as running.");
    expect(note!.body).toContain(`rig seat decide-permission ${askId} --option <id>`);
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "handed-off", handedOffTo: "dev-other@perm-rig" });
  });

  it("a runner already waiting when the answer is handed to the agent reads the agent's decision at once, not at its read's end", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = String((await f.submit()).body.askId);
    const started = Date.now();
    const waiting = f.read(askId, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await f.answer(askId, { optionId: "allow" })).toMatchObject({ status: 200 });
    expect(await f.decide(askId, "allow")).toMatchObject({ status: 200, body: { state: "answered" } });
    expect(await waiting).toMatchObject({ body: { state: "answered", optionId: "allow" } });
    expect(Date.now() - started).toBeLessThan(2500);
  });
});
