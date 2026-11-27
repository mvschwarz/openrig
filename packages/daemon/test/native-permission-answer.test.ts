// Slice 15: a person answers a seat's own Claude Code permission prompt from where they are. The prompt's PermissionRequest
// hook submits it on the runner permission route as a native ask; these cells drive that route, the queue, Mission
// Control's answer route and the activity hook ingress as the daemon wires them, and the real hook process against them
// over HTTP. PM's acceptance list: a clear yes and no, a matching / non-matching / unclear condition, a late answer, a
// missing person, a concurrent terminal answer, a restart, two surfaces; and the runner path unchanged beside it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { runWakeLadderTick, PROMPT_ALERT_TAG } from "../src/domain/queue-wake-ladder.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { activityRoutes } from "../src/routes/activity.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { nativeAskHoldsPrompt } from "../src/domain/runner-permissions.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  claudeToolCallFingerprint: (sessionId: string, agentId: string | null, tool: string, input: unknown) => string | null };
const HOOK_SCRIPT = fileURLToPath(new URL("../assets/plugins/openrig-core/hooks/scripts/permission-answer.cjs", import.meta.url));
const hook = require("../assets/plugins/openrig-core/hooks/scripts/permission-answer.cjs") as { WINDOW_SECONDS: number };

const PERSON = "mike@external", OTHER_PERSON = "dana@external", SEAT = "dev-impl@perm-rig", INSTALL = "install-token";
const DECIDER = "lead@perm-rig", ROUTE = "conversation-0123456789ab@kernel", OTHER_ROUTE = "conversation-ba9876543210@kernel";
const CONVERSATION = "claude-session-1";
const COMMAND = { command: "git push origin docs", description: "Push the docs branch" };
const person = (id: string) => ({ entityId: id, class: "human" as const, displayName: id, address: `${id}@external`,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "unused", role: "primary" as const, handle: `U${id.toUpperCase()}` }],
  prefs: { deliveryClass: "A" as const } });
const NATIVE_OPTIONS = [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];
const RUNNER_OPTIONS = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(options: { owner?: string | null; people?: string[]; decider?: string | null; stopping?: Promise<void> } = {}) {
  const people = { ok: true as const, entities: (options.people ?? ["mike"]).map(person) };
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  cleanups.push(() => db.close());
  const bus = new EventBus(db);
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("perm-rig");
  const node = rigs.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const sessions = new SessionRegistry(db);
  const occupy = (kind?: "handover") => {
    const session = sessions.registerSession(node.id, SEAT, kind);
    sessions.updateStatus(session.id, "running");
  };
  occupy();
  const queueRepo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => people,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) },
    ...(options.decider !== undefined ? { permissionDecider: () => options.decider ? { session: options.decider } : null } : {}) });
  if (options.decider !== undefined) queueRepo.attachOutbox(new OutboxHandler(db));
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog: new MissionControlActionLog(db) });
  const store = new AgentActivityStore({ db, eventBus: bus,
    resolveOccupantGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const stream = new StreamStore(db, bus);
  // A person is chosen for the seat unless a case says otherwise (`owner: null`): a native prompt asks the chosen person or
  // the work's return route, never the default person by implication.
  const owner = options.owner === undefined ? PERSON : options.owner;
  if (owner) db.prepare("UPDATE nodes SET permissions_to = ? WHERE id = ?").run(owner, node.id);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, INSTALL as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("eventBus" as never, bus as never);
    c.set("queueRepo" as never, queueRepo as never);
    c.set("rigRepo" as never, rigs as never);
    c.set("missionControlWriteContract" as never, contract as never);
    c.set("streamStore" as never, stream as never);
    if (options.stopping) c.set("daemonStopping" as never, options.stopping as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  app.route("/api/mission-control", missionControlRoutes());

  const generation = () => sessions.currentOccupantTenure(node.id)!.generationUuid;
  const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, unknown> });
  const auth = { authorization: `Bearer ${INSTALL}`, "Content-Type": "application/json" };
  const post = async (path: string, body: unknown, headers: Record<string, string> = auth) =>
    json(await app.request(path, { method: "POST", headers, body: JSON.stringify(body) }));
  let invocations = 0;
  /** The seat's Claude Code PermissionRequest hook submits its prompt, as permission-answer.cjs does. */
  const submit = async (overrides: Record<string, unknown> = {}, action: Record<string, unknown> = {}) => {
    const invocation = `invocation-${++invocations}`;
    const tool = String(action.tool ?? "Bash"), input = action.input ?? COMMAND, agent = (action.agent as string | null | undefined) ?? null;
    return post("/api/activity/permission-requests", { sessionName: SEAT, nodeId: node.id, generation: generation(), runtime: "claude-code",
      nativeHook: "claude-code", nativeRef: CONVERSATION, turnId: invocation, requestId: invocation, holdSeconds: hook.WINDOW_SECONDS,
      action: { tool, input, agent, callFingerprint: relay.claudeToolCallFingerprint(CONVERSATION, agent, tool, input) },
      toolCall: { title: tool, kind: tool }, options: NATIVE_OPTIONS, occurredAt: new Date().toISOString(), ...overrides });
  };
  /** A runner seat's own request, unchanged by this slice. */
  const submitRunner = async (overrides: Record<string, unknown> = {}) => post("/api/activity/permission-requests", { sessionName: SEAT,
    nodeId: node.id, generation: generation(), nativeRef: "conversation-1", turnId: "1", requestId: "7",
    toolCall: { title: "Edit src/app.ts", kind: "edit" }, options: RUNNER_OPTIONS, occurredAt: "2026-10-30T05:00:00.000Z", ...overrides });
  const read = async (askId: string) => json(await app.request(`/api/activity/permission-requests/${askId}?waitSeconds=0`, { headers: auth }));
  const readWaiting = async (askId: string, seconds: number) =>
    json(await app.request(`/api/activity/permission-requests/${askId}?waitSeconds=${seconds}`, { headers: auth }));
  const withdraw = (askId: string, reason: string) => post(`/api/activity/permission-requests/${askId}/withdraw`, { reason });
  const taken = (askId: string, optionId: string) => post(`/api/activity/permission-requests/${askId}/taken`, { optionId });
  /** A person answers in Steering: one offered option, or their words. */
  const answer = (askId: string, choice: { optionId?: string; decision?: string }, actor = PERSON) => post("/api/mission-control/action",
    { verb: "answer", qitemId: askId, actorSession: actor, ...(choice.optionId ? { questionId: "permission", optionId: choice.optionId } : {}),
      ...(choice.decision ? { decision: choice.decision } : {}) }, { "Content-Type": "application/json", "X-OpenRig-Session": actor });
  const act = (qitemId: string, verb: string, actor = PERSON) => post("/api/mission-control/action", { verb, qitemId, actorSession: actor },
    { "Content-Type": "application/json", "X-OpenRig-Session": actor });
  /** `rig seat decide-permission`, from the agent at `decider` (an outside conversation sends no seat header). */
  const decide = (askId: string, optionId: string, decider: string | null, extra: Record<string, unknown> = {}) =>
    post(`/api/activity/permission-requests/${askId}/decide`, { optionId, reason: "", ...extra },
      { "Content-Type": "application/json", ...(decider ? { "X-OpenRig-Session": decider } : {}) });
  /** The seat's activity relay reports a completed Claude tool batch, with its calls' fingerprints. */
  const batch = (calls: Array<{ tool?: string; input?: unknown }>, agent: string | null = null) => post("/api/activity/hooks", {
    runtime: "claude-code", sessionName: SEAT, nodeId: node.id, generation: generation(), hookEvent: "PostToolBatch", hookAgentId: agent,
    occurredAt: new Date().toISOString(),
    toolCallFingerprints: calls.map((call) => relay.claudeToolCallFingerprint(CONVERSATION, agent, call.tool ?? "Bash", call.input ?? COMMAND)) });
  /** Work the person's conversation handed to the seat, with its return route (`rig queue create --return-route auto`):
   *  in progress, or still pending when the seat never claimed it. */
  const routedWork = async (route = ROUTE, state: "in-progress" | "pending" = "in-progress") => {
    const item = await queueRepo.create({ sourceSession: "someone outside a seat", destinationSession: SEAT, body: "Update the docs",
      returnRoute: route, returnRouteBasis: "issued", nudge: false });
    if (state === "in-progress") queueRepo.update({ qitemId: item.qitemId, actorSession: SEAT, state: "in-progress" });
    // Rows made in one millisecond would tie on their creation time; space them so "newest" is the last one made.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return item.qitemId;
  };
  const notes = (qitemId: string) => queueRepo.listTransitions(qitemId).map((t) => t.transitionNote ?? "");
  const asks = () => queueRepo.list({ limit: 100 }).filter((row) => row.tags?.includes("runner-permission"));
  const rowsTo = (destination: string) => (db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = ?").get(destination) as { n: number }).n;
  const permits = () => stream.list({ hintTag: "runner-permission-permit", limit: 100 });
  return { db, app, node, queueRepo, generation, submit, submitRunner, read, readWaiting, withdraw, taken, answer, act, decide, batch, routedWork,
    notes, asks, rowsTo, permits, relaunch: () => occupy("handover") };
}

const askIdOf = (submitted: { body: Record<string, unknown> }) => String(submitted.body.askId);
/** A time as the ask's record writes it: to the second, in UTC. */
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

describe("a clear yes or no from the person", () => {
  it.each([
    ["clicks Allow once", { optionId: "allow" }, "allow"],
    ["replies just yes", { decision: "yes" }, "allow"],
    ["clicks Deny", { optionId: "deny" }, "deny"],
    ["replies just no", { decision: "no" }, "deny"],
  ])("when the person %s, it is their own answer, relayed with no agent in between", async (_case, choice, optionId) => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "pending", sourceSession: SEAT, destinationSession: PERSON });
    expect(await f.answer(askId, choice)).toMatchObject({ status: 200 });
    const read = await f.read(askId);
    expect(read.body).toMatchObject({ state: "answered", optionId, native: { hook: "claude-code", answeredAs: "person", by: PERSON } });
    expect(String((read.body.native as { message: string }).message)).toContain(optionId === "allow" ? "Allowed once by mike@external" : "Denied by mike@external");
    // No receiving agent was asked to decide a clear answer, and the person wasn't asked to confirm it.
    expect(f.rowsTo(DECIDER)).toBe(0);
  });

  it("takes Steering's Approve and Deny as the person's own yes and no", async () => {
    const f = fixture({ decider: DECIDER });
    const approved = askIdOf(await f.submit());
    expect(await f.act(approved, "approve")).toMatchObject({ status: 200 });
    expect((await f.read(approved)).body).toMatchObject({ state: "answered", optionId: "allow", native: { answeredAs: "person" } });
    const denied = askIdOf(await f.submit());
    expect(await f.act(denied, "deny")).toMatchObject({ status: 200 });
    expect((await f.read(denied)).body).toMatchObject({ state: "answered", optionId: "deny", native: { answeredAs: "person" } });
    expect(f.rowsTo(DECIDER)).toBe(0);
  });
});

describe("words and conditions go to the receiving agent, which judges the exact action", () => {
  it("keeps an ask-back and a further handoff holding until the current chain closes", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { decision: "yes, for that request" });
    const first = f.db.prepare("SELECT qitem_id FROM queue_items WHERE handed_off_from = ?").get(askId) as { qitem_id: string };
    const { created: second } = await f.queueRepo.handoff({ qitemId: first.qitem_id, fromSession: DECIDER,
      toSession: "other@perm-rig", nudge: false });
    f.db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = ?").run(second.qitemId);
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    // The same forwarding form that the native resolver supports on older queue records.
    f.db.prepare("UPDATE queue_items SET state = 'done', closure_reason = 'handed_off_to' WHERE qitem_id = ?").run(first.qitem_id);
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    f.queueRepo.update({ qitemId: second.qitemId, actorSession: "other@perm-rig", state: "done", closureReason: "no-follow-on" });
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
  });

  it("uses the newest addressed successor, including equal-time ties, instead of an older open branch", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    const old = await f.queueRepo.create({ sourceSession: PERSON, destinationSession: DECIDER, body: "old branch", nudge: false });
    f.db.prepare("UPDATE queue_items SET handed_off_from = ?, state = 'blocked' WHERE qitem_id = ?").run(askId, old.qitemId);
    await f.answer(askId, { decision: "yes, for that request" });
    f.db.prepare("UPDATE queue_items SET ts_created = ? WHERE handed_off_from = ?").run("2026-01-01T00:00:00.000Z", askId);
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    await f.decide(askId, "allow", DECIDER);
    expect(f.queueRepo.getById(old.qitemId)?.state).toBe("blocked");
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
  });

  it("keeps an unrepresented handoff holding, still bounded by the original answer window", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { decision: "yes, for that request" });
    f.db.prepare("UPDATE queue_items SET state = 'handed-off', handed_off_to = ? WHERE handed_off_from = ?")
      .run("receiver@elsewhere@other-host", askId);
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    const by = f.queueRepo.getById(askId)!.tags!.find(tag => tag.startsWith("permission-answer-by:"))!;
    const deadline = Date.parse(by.slice("permission-answer-by:".length));
    expect(nativeAskHoldsPrompt(f.db, SEAT, deadline)).toBe(true);
    expect(nativeAskHoldsPrompt(f.db, SEAT, deadline + 1)).toBe(false);
    expect(nativeAskHoldsPrompt(f.db, SEAT, Number.NaN)).toBe(false);
  });

  it("lets a later bare prompt alert reach the existing orchestrator after the word answer is decided", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { decision: "yes, for that request" });
    let now = new Date();
    let episode = "native-ask", prompt = now.toISOString();
    const attemptWake = vi.fn(async (_qitemId: string, _destination: string, _occurrence?: string) => "delivered-ack-pending");
    const tick = () => runWakeLadderTick({ db: f.db, queueRepo: f.queueRepo, now, attemptWake,
      resolveOrchestrator: () => DECIDER, readPromptState: (destination) => destination === SEAT ? "blocked" : "clear", log: () => {},
      readPermissionPrompts: () => [{ destination: SEAT, episode, state: "blocked",
        prompt, observedAt: now.toISOString(), evidenceRef: "fixture prompt" }] });
    const alerts = () => f.queueRepo.list({ limit: 100 }).filter(row => row.tags?.includes(PROMPT_ALERT_TAG));
    await tick();
    expect(alerts()).toHaveLength(0);
    await f.decide(askId, "allow", DECIDER);
    episode = "later-prompt";
    prompt = new Date(now.getTime() + 5 * 60_000).toISOString();
    now = new Date(now.getTime() + 10 * 60_000);
    await tick();
    expect(alerts()).toEqual([expect.objectContaining({ destinationSession: DECIDER, state: "pending" })]);
    expect(attemptWake).toHaveBeenCalledWith(expect.any(String), DECIDER, expect.any(String));
    expect(attemptWake.mock.calls.some(call => call[1] === SEAT)).toBe(false); // wake the owner, never type into the native prompt
  });

  it("does not let newer decided handoffs hide an older ask that still takes an answer", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    const by = new Date(Date.now() + 3600_000).toISOString();
    const tags = JSON.stringify(["runner-permission", "permission-native-hook:claude-code", `permission-answer-by:${by}`]);
    const put = f.db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session,
      state, body, tags, handed_off_to, handed_off_from) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`);
    f.db.transaction(() => { for (let n = 0; n < 25; n++) {
      const id = `qitem-closed-native-${n}`, at = new Date(Date.now() + n + 1000).toISOString();
      put.run(id, at, at, SEAT, PERSON, "handed-off", tags, DECIDER, null);
      put.run(`${id}-decider`, at, at, PERSON, DECIDER, "done", null, null, id);
    } })();
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    await f.answer(askId, { optionId: "allow" });
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
  });

  it("keeps the longest answer window inclusive at its boundary and excludes expired history", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit({ holdSeconds: 86400 }));
    const by = f.queueRepo.getById(askId)!.tags!.find(tag => tag.startsWith("permission-answer-by:"))!;
    const deadline = Date.parse(by.slice("permission-answer-by:".length));
    expect(nativeAskHoldsPrompt(f.db, SEAT, deadline)).toBe(true);
    expect(nativeAskHoldsPrompt(f.db, SEAT, deadline + 1)).toBe(false);
    expect(nativeAskHoldsPrompt(f.db, SEAT, Number.NaN)).toBe(false);
    expect(nativeAskHoldsPrompt(f.db, SEAT, Number.POSITIVE_INFINITY)).toBe(false);
    // This is a valid old ask: both creation and its one-day answer window are in the past.
    const old = new Date(deadline - 3 * 86400_000).toISOString();
    f.db.prepare("UPDATE queue_items SET ts_created = ?, tags = ? WHERE qitem_id = ?")
      .run(old, JSON.stringify(["runner-permission", "permission-native-hook:claude-code", "permission-answer-by:" + new Date(deadline - 2 * 86400_000).toISOString()]), askId);
    expect(nativeAskHoldsPrompt(f.db, SEAT, deadline)).toBe(false);
  });

  it("keeps holding an ask passed on with handoff-and-complete until its colleague's row closes, here or on another host", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    const { created } = await f.queueRepo.handoffAndComplete({ qitemId: askId, fromSession: PERSON, toSession: "other@perm-rig", nudge: false });
    expect(f.queueRepo.getById(askId)).toMatchObject({ state: "done", closureReason: "handed_off_to" });
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    f.queueRepo.update({ qitemId: created.qitemId, actorSession: "other@perm-rig", state: "done", closureReason: "no-follow-on" });
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
    // The cross-host form closes the source done too, with no successor on this host: it holds until answer-by.
    const remote = askIdOf(await f.submit({ requestId: "req-remote" }));
    f.db.prepare("UPDATE queue_items SET state = 'done', closure_reason = 'handed_off_to', handed_off_to = ? WHERE qitem_id = ?")
      .run("receiver@elsewhere", remote);
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    const by = f.queueRepo.getById(remote)!.tags!.find(tag => tag.startsWith("permission-answer-by:"))!;
    expect(nativeAskHoldsPrompt(f.db, SEAT, Date.parse(by.slice("permission-answer-by:".length)) + 1)).toBe(false);
  });

  it("releases the prompt-alert hold after a word answer is decided on its handoff", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    await f.answer(askId, { decision: "yes, for that request" });
    expect(f.queueRepo.getById(askId)?.state).toBe("handed-off");
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    await f.decide(askId, "allow", DECIDER, { reason: "the action meets the answer" });
    expect(f.queueRepo.getById(askId)?.state).toBe("handed-off");
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
  });

  it("allows the action when it meets the person's condition, as the agent's judgment", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    // The person's receipt says what the record keeps: their words as theirs, and the decision as the agent's judgment.
    expect(await f.answer(askId, { decision: "yes, as long as it's the docs branch" })).toMatchObject({ status: 200, body: { answer: {
      message: `Your words on ${askId} went to ${DECIDER}, the receiving agent, which judges whether this exact action meets them. Its decision`
        + ` is recorded as its judgment, not your own answer, with your words as you gave them. ${SEAT}'s prompt waits until then, and is also open in the seat's terminal.` } } });
    expect(f.rowsTo(DECIDER)).toBe(1);
    // The receiving agent is told to judge the condition itself, and to ask back only when it can't tell: a condition it
    // can judge isn't a reason for a second round with the person.
    const told = f.queueRepo.list({ limit: 100 }).find((row) => row.destinationSession === DECIDER)!.body;
    expect(told).toContain("A condition is theirs to set and yours to judge: when this exact action plainly meets it, allow it; when it plainly doesn't, take the reject option with their words in your reason.");
    expect(told).toContain("If you can't tell what they meant, or whether this exact action meets their condition, ask them back");
    expect(told).not.toContain("unclear or conditional");
    expect((await f.read(askId)).body).toMatchObject({ state: "pending" });
    const decided = await f.decide(askId, "allow", DECIDER, { reason: "it pushes the docs branch, which is their condition" });
    expect(decided.body).toMatchObject({ state: "answered", optionId: "allow", native: { answeredAs: "agent", by: DECIDER,
      said: "yes, as long as it's the docs branch" } });
    expect(String((decided.body.native as { message: string }).message)).toMatch(/^Allowed once: lead@perm-rig, deciding on the person's answer, judged that this exact action meets it/);
  });

  it("denies the action with the person's words when it doesn't meet them, as the agent's judgment and not the person's no", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { decision: "only to a branch, never main" });
    await f.decide(askId, "deny", DECIDER, { reason: "it pushes to main" });
    const read = await f.read(askId);
    expect(read.body).toMatchObject({ state: "answered", optionId: "deny", native: { answeredAs: "agent", by: DECIDER } });
    const message = String((read.body.native as { message: string }).message);
    expect(message).toContain("judged that this exact action doesn't meet it (it pushes to main)");
    expect(message).toContain("not the person's own no");
    expect(message).toContain('The person said: "only to a branch, never main"');
  });

  it("decides nothing on unclear words: the ask waits, then ends with its window, and a decision after that is too late", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { decision: "hmm, what does it push?" });
    expect((await f.read(askId)).body).toMatchObject({ state: "pending" });
    // The receiving agent's task says to ask back on words that aren't clear.
    const task = f.queueRepo.list({ limit: 100 }).find((row) => row.destinationSession === DECIDER)!;
    expect(task.body).toMatch(/ask/i);
    expect((await f.withdraw(askId, "answer_window_ended")).body).toMatchObject({ state: "withdrawn" });
    expect((await f.read(askId)).body).toMatchObject({ state: "withdrawn", native: { why: "answer_window_ended" } });
    const late = await f.decide(askId, "allow", DECIDER);
    expect(late.body).toMatchObject({ state: "withdrawn", native: { unchanged: true } });
    expect(f.notes(askId).some((note) => note.startsWith("runner-permission-decided"))).toBe(false);
  });
});

describe("no one to ask: nothing is decided, and the native prompt carries on", () => {
  it.each([
    ["no person is registered", { people: [] as string[] }],
    ["several people are registered and none is the default", { owner: null, people: ["mike", "dana"] }],
    ["the default person is registered, but no one is chosen for the seat and its work has no return route", { owner: null, people: ["mike"] }],
    ["the seat's chosen person is no longer registered", { owner: "gone@external", people: [] as string[] }],
    ["the chosen person is unavailable while a different default person is registered", { owner: "gone@external", people: ["mike"] }],
  ])("asks no one and permits nothing when %s", async (_case, options) => {
    const f = fixture(options);
    const submitted = await f.submit();
    expect(submitted).toMatchObject({ status: 200, body: { ok: true, state: "not_asked" } });
    expect(String(submitted.body.reason)).toMatch(/Nothing was decided: Claude Code's own prompt stays open in the seat's terminal\.$/);
    expect(f.asks()).toHaveLength(0);
    expect(f.permits()).toHaveLength(0);
  });

  it("doesn't ask the default person by implication, so the seat's prompt escalation isn't held back", async () => {
    const f = fixture({ owner: null, people: ["mike"] });
    const submitted = await f.submit();
    expect(submitted).toMatchObject({ status: 200, body: { ok: true, state: "not_asked" } });
    expect(String(submitted.body.reason)).toContain("No one is chosen for this seat (rig seat set-permissions-to) and its work carries no return route on this host, so no one is asked by implication; the prompt goes through the seat's usual escalation instead");
    expect(f.asks()).toHaveLength(0);
    expect(f.rowsTo(PERSON)).toBe(0);
    // No open native ask, so the wake ladder's prompt alert and routed relay aren't held.
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
    // A runner's own request still goes to the default person, as before.
    const runner = await f.submitRunner();
    expect(runner).toMatchObject({ status: 200 });
    expect(f.queueRepo.getById(askIdOf(runner))).toMatchObject({ destinationSession: PERSON });
  });

  it("refuses nothing on a seat whose operator opted in to refusing runner requests: the native prompt stays", async () => {
    const f = fixture({ owner: "deny" });
    expect(await f.submit()).toMatchObject({ status: 200, body: { state: "not_asked" } });
  });

  it("leaves the runner path as it was: no one to ask still permits a runner's request, and --deny still refuses it", async () => {
    expect(await fixture({ people: [] }).submitRunner()).toMatchObject({ status: 200, body: { state: "permitted", optionId: "allow" } });
    expect(await fixture({ owner: "deny" }).submitRunner()).toMatchObject({ status: 409, body: { code: "denied_by_seat" } });
  });
});

describe("the person's own conversation, through the return route of the work the seat is running", () => {
  it("owns the ask, which shows the exact action and how to relay the answer", async () => {
    const f = fixture({ people: [] });
    const work = await f.routedWork();
    const submitted = await f.submit();
    expect(submitted.body).toMatchObject({ askedOf: ROUTE });
    const ask = f.queueRepo.getById(askIdOf(submitted))!;
    expect(ask).toMatchObject({ destinationSession: ROUTE, state: "pending" });
    expect(ask.tags).toContain("permission-asked:return-route");
    expect(ask.body).toContain(`your conversation handed ${SEAT} the work it's running (${work})`);
    expect(ask.body).toContain("git push origin docs");
    expect(ask.body).toContain(`rig seat decide-permission ${ask.qitemId} --option allow --relay --person-said`);
    expect(ask.body).toContain("Never decide without their answer");
  });

  // Root's F1: the conversation's agent relays its person's yes or no, which OpenRig didn't get from them. The answer takes
  // effect as before; the record says who relayed it and that it's unconfirmed, never the person's own answer.
  it("records a relayed yes or no as relayed by the conversation's agent, unconfirmed, and the hook's deny carries the words it reports", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const allowed = askIdOf(await f.submit());
    expect((await f.decide(allowed, "allow", null, { relay: true, personSaid: "yes" })).body).toMatchObject({ state: "answered",
      optionId: "allow", native: { answeredAs: "relayed", by: "someone outside a seat", reported: "yes" } });
    const denied = askIdOf(await f.submit());
    const read = (await f.decide(denied, "deny", ROUTE, { relay: true, personSaid: "no, use the test script" })).body;
    expect(read).toMatchObject({ state: "answered", optionId: "deny", native: { answeredAs: "relayed", by: ROUTE, reported: "no, use the test script" } });
    expect(read.native).not.toHaveProperty("said");
    expect((read.native as { message: string }).message).toBe(`Denied: ${ROUTE} relayed this as the person's answer (unconfirmed: OpenRig didn't get this answer from them). ${ROUTE} reports they said: "no, use the test script"`);
    expect(f.notes(denied).at(-1)).toBe(`runner-permission-decided as relayed by ${ROUTE}, unconfirmed (OpenRig didn't get this answer from the person): deny; the decider reported they said "no, use the test script"`);
  });

  // claude8: the seat still held two review results it never claimed, on the first conversation's route, when a second
  // address handed it the fix it was running. With two routes the ask went to the default person, none was registered,
  // and the prompt reached no one.
  it("asks the conversation whose work the seat is running when its open work carries several routes", async () => {
    const f = fixture({ people: [] });
    await f.routedWork(ROUTE, "pending");
    await f.routedWork(ROUTE, "pending");
    const running = await f.routedWork(OTHER_ROUTE);
    const submitted = await f.submit();
    expect(submitted.body).toMatchObject({ ok: true, askedOf: OTHER_ROUTE });
    const ask = f.queueRepo.getById(askIdOf(submitted))!;
    expect(ask.tags).toContain("permission-asked:return-route");
    expect(ask.body).toContain(`your conversation handed ${SEAT} the work it's running (${running}), and this address is that work's return route; `
      + "it holds open work from 2 conversations, and this one's is in progress");
  });

  it("takes the work in progress over newer work it hasn't started, else the newest open work", async () => {
    const started = fixture({ owner: null });
    await started.routedWork(ROUTE);
    await started.routedWork(OTHER_ROUTE, "pending");
    expect((await started.submit()).body).toMatchObject({ askedOf: ROUTE });
    const waiting = fixture({ owner: null });
    await waiting.routedWork(ROUTE, "pending");
    const newest = await waiting.routedWork(OTHER_ROUTE, "pending");
    const submitted = await waiting.submit();
    expect(submitted.body).toMatchObject({ askedOf: OTHER_ROUTE });
    expect(waiting.queueRepo.getById(askIdOf(submitted))!.body).toContain(`your conversation handed ${SEAT} its newest open work (${newest}), `
      + "and this address is that work's return route; it holds open work from 2 conversations, and none is in progress");
  });

  it("asks no one when the work the seat is running names a conversation on another host and no one is chosen, and a chosen person comes first", async () => {
    const remote = fixture({ owner: null });
    await remote.routedWork(ROUTE, "pending");
    await remote.routedWork("conversation-0123456789ab@kernel@host-b");
    expect((await remote.submit()).body).toMatchObject({ state: "not_asked" });
    expect(remote.asks()).toHaveLength(0);
    const chosen = fixture({ owner: OTHER_PERSON, people: ["mike", "dana"] });
    await chosen.routedWork(ROUTE);
    await chosen.routedWork(OTHER_ROUTE);
    expect((await chosen.submit()).body).toMatchObject({ askedOf: OTHER_PERSON });
  });

  it("never reads a queue close as an approval: a native ask closed without an answer is unanswered", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    f.queueRepo.update({ qitemId: askId, actorSession: ROUTE, state: "done", closureReason: "no-follow-on", resolution: "yes" });
    expect((await f.read(askId)).body).toMatchObject({ state: "unanswered", native: { hook: "claude-code" } });
    expect(f.permits()).toHaveLength(0);
  });

  it("refuses --relay on a runner's request, which records the deciding agent", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submitRunner());
    expect(await f.decide(askId, "allow", DECIDER, { relay: true })).toMatchObject({ status: 400, body: { code: "relay_unsupported" } });
  });
});

// Root's F1 (2026-11-26): the record keeps apart an answer OpenRig received from the person, an agent's report of the
// person's words (--relay, --person-said), and an agent's own decision on them. Nothing is refused for it: the transport
// session is attribution, not proof of a person, so no caller, header or missing header makes a report the person's own.
describe("who decided what: the person's own answer, a relay and an agent's judgment stay apart", () => {
  const UNCONFIRMED = "relayed this as the person's answer (unconfirmed: OpenRig didn't get this answer from them)";

  it.each([
    ["the ask's own addressee, the conversation", ROUTE, "allow"],
    ["a call with no seat header", null, "allow"],
    ["a caller whose header names the registered person", PERSON, "allow"],
    ["the seat whose prompt it is (a deny: no seat approves its own call here)", SEAT, "deny"],
  ])("reads a relay from %s as relayed and unconfirmed, never the person's own answer", async (_case, caller, optionId) => {
    const f = fixture({ owner: null, people: ["mike"] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    const by = caller ?? "someone outside a seat";
    const read = (await f.decide(askId, optionId, caller, { relay: true, personSaid: optionId === "allow" ? "yes" : "no" })).body;
    // The answer takes effect as it did: only the record changed.
    expect(read).toMatchObject({ state: "answered", optionId, native: { answeredAs: "relayed", by, reported: optionId === "allow" ? "yes" : "no" } });
    const message = String((read.native as { message: string }).message);
    expect(message).toBe(`${optionId === "allow" ? "Allowed once" : "Denied"}: ${by} ${UNCONFIRMED}. ${by} reports they said: "${optionId === "allow" ? "yes" : "no"}"`);
    expect(message).not.toContain("the person's own answer");
    expect(f.notes(askId).at(-1)).toMatch(new RegExp(`^runner-permission-decided as relayed by ${by.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, unconfirmed `));
    expect(JSON.stringify((await f.read(askId)).body)).not.toContain('"answeredAs":"person"');
  });

  it("says so when a relay carries none of the person's words", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    const read = (await f.decide(askId, "allow", ROUTE, { relay: true })).body;
    expect(read).toMatchObject({ state: "answered", optionId: "allow", native: { answeredAs: "relayed", by: ROUTE } });
    expect(read.native).not.toHaveProperty("said");
    expect(read.native).not.toHaveProperty("reported");
    expect((read.native as { message: string }).message).toBe(`Allowed once: ${ROUTE} ${UNCONFIRMED}, with none of their words.`);
  });

  it("keeps an agent's judgment on the words it reports as its judgment, with the words as its report", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    const read = (await f.decide(askId, "deny", ROUTE, { reason: "it pushes to main", personSaid: "only on a branch" })).body;
    expect(read).toMatchObject({ state: "answered", optionId: "deny", native: { answeredAs: "agent", by: ROUTE, reported: "only on a branch" } });
    expect(read.native).not.toHaveProperty("said");
    expect((read.native as { message: string }).message).toBe(`Not allowed: ${ROUTE}, deciding on the person's answer, judged that this exact action`
      + ` doesn't meet it (it pushes to main). That's its judgment, not the person's own no. ${ROUTE} reports they said: "only on a branch"`);
    expect(f.notes(askId).at(-1)).toBe(`runner-permission-decided by ${ROUTE}, an agent, not the person: deny, because "it pushes to main";`
      + ` the decider reported they said "only on a branch"`);
  });

  it("keeps a recorded answer the person's own: a later relay of the opposite answer changes nothing", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { optionId: "allow" });
    for (const caller of [DECIDER, null, PERSON]) {
      expect((await f.decide(askId, "deny", caller, { relay: true, personSaid: "no" })).body).toMatchObject({ state: "answered", optionId: "allow",
        native: { unchanged: true, answeredAs: "person", by: PERSON, message: `Allowed once by ${PERSON} in OpenRig: their own answer.` } });
    }
    expect(f.notes(askId).some((note) => note.startsWith("runner-permission-decided"))).toBe(false);
  });

  it("keeps the person's recorded words theirs when the receiving agent relays other words, and records both", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { decision: "only to a branch, never main" });
    const read = (await f.decide(askId, "allow", DECIDER, { relay: true, personSaid: "yes" })).body;
    expect(read).toMatchObject({ state: "answered", optionId: "allow",
      native: { answeredAs: "relayed", by: DECIDER, said: "only to a branch, never main", reported: "yes" } });
    expect((read.native as { message: string }).message).toBe(`Allowed once: ${DECIDER} ${UNCONFIRMED}.`
      + ` The person said: "only to a branch, never main" ${DECIDER} reports they said: "yes"`);
    // The person's own words stay on the ask they answered, apart from the decision recorded on the agent's row.
    expect(f.queueRepo.getById(askId)!.humanAnswers).toMatchObject({ permission: { kind: "typed-reply", text: "only to a branch, never main" } });
  });

  it("keeps a kept answer's words the person's own through a direct decision on the same row", async () => {
    const f = fixture({ decider: null });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { decision: "fine, but \"docs\" only; nothing else" });
    expect((await f.read(askId)).body).toMatchObject({ state: "pending" });
    const read = (await f.decide(askId, "allow", DECIDER, { reason: "it pushes the docs branch", personSaid: "fine, but \"docs\" only; nothing else" })).body;
    // The decision fills the row's answer slot with its option (the shared contract); the record keeps the words as theirs.
    expect(f.queueRepo.getById(askId)!.humanAnswers).toMatchObject({ permission: "allow" });
    expect(read).toMatchObject({ state: "answered", optionId: "allow", native: { answeredAs: "agent", by: DECIDER, said: "fine, but \"docs\" only; nothing else" } });
    expect(read.native).not.toHaveProperty("reported");
  });

  it("doesn't read an ask someone closed as denied as the person's own answer", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    f.queueRepo.update({ qitemId: askId, actorSession: ROUTE, state: "done", closureReason: "denied", resolution: "not now" });
    const read = (await f.read(askId)).body;
    expect(read).toMatchObject({ state: "answered", optionId: "deny", native: { by: ROUTE, message: `Denied: ${ROUTE} closed this ask as denied in OpenRig: "not now"` } });
    expect(read.native).not.toHaveProperty("answeredAs");
    expect(read.native).not.toHaveProperty("said");
  });

  it("records a runner decider's --person-said as its report, beside the words the person gave", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submitRunner());
    await f.answer(askId, { decision: "yes, but only the test file" });
    expect((await f.decide(askId, "allow", DECIDER, { reason: "it edits the test file", personSaid: "yes" })).body).toMatchObject({ state: "answered" });
    const decided = f.queueRepo.list({ limit: 100 }).flatMap((row) => f.notes(row.qitemId)).find((note) => note.startsWith("runner-permission-decided"))!;
    expect(decided).toBe(`runner-permission-decided by ${DECIDER}, an agent, not the person: allow, because it edits the test file;`
      + ` the person wrote "yes, but only the test file"; the decider reported they said "yes"`);
  });
});

describe("a late, concurrent or stale answer stays what it is", () => {
  it("takes a terminal Yes from the exact call's completion: the ask is already answered there, and a later answer is too late", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    // Another call, or the same call from a subagent, doesn't settle it.
    await f.batch([{ input: { command: "ls" } }]);
    await f.batch([{}], "subagent-1");
    expect((await f.read(askId)).body).toMatchObject({ state: "pending" });
    await f.batch([{ input: { command: "ls" } }, {}]);
    const settled = (await f.read(askId)).body;
    expect(settled).toMatchObject({ state: "withdrawn", native: { why: "answered_in_terminal" } });
    // The batch says the call resolved, not that it ran (a terminal No resolves it too).
    expect(settled.native).not.toHaveProperty("toolCompleted");
    expect(f.notes(askId).at(-1)).toContain("reported a tool call with exactly this input resolved in the same conversation, without an answer from here");
    const late = await f.answer(askId, { optionId: "deny" });
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.body)).toContain("Too late: the prompt ended in the seat's terminal: it was answered or cancelled there");
    expect((await f.decide(askId, "deny", DECIDER)).body).toMatchObject({ state: "withdrawn", native: { unchanged: true, why: "answered_in_terminal" } });
  });

  it("takes a terminal No or Esc from the hook's own withdrawal, which a runner's request doesn't accept", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    expect((await f.withdraw(askId, "answered_in_terminal")).body).toMatchObject({ state: "withdrawn" });
    expect((await f.read(askId)).body).toMatchObject({ state: "withdrawn", native: { why: "answered_in_terminal" } });
    const runnerAsk = askIdOf(await f.submitRunner());
    expect(await f.withdraw(runnerAsk, "answered_in_terminal")).toMatchObject({ status: 400, body: { code: "invalid_permission_request" } });
  });

  it("ends an ask its hook never withdrew once its window has passed", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    const ask = f.queueRepo.getById(askId)!;
    const past = ask.tags!.map((tag) => tag.startsWith("permission-answer-by:") ? `permission-answer-by:${new Date(Date.now() - 120_000).toISOString()}` : tag);
    f.db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify(past), askId);
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
    const late = await f.answer(askId, { optionId: "allow" });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect((await f.read(askId)).body).toMatchObject({ state: "withdrawn", native: { why: "answer_window_ended" } });
  });

  it("reads a restarted seat's earlier ask as stale, and decides nothing on it", async () => {
    const f = fixture();
    const before = f.generation();
    const askId = askIdOf(await f.submit());
    f.relaunch();
    expect((await f.read(askId)).body).toMatchObject({ state: "stale" });
    expect((await f.decide(askId, "allow", DECIDER)).body).toMatchObject({ state: "stale", native: { unchanged: true } });
    // The old occupant's hook can't open a new one.
    expect(await f.submit({ generation: before })).toMatchObject({ status: 409, body: { code: "stale_generation" } });
  });

  it("lets the first answer win when two surfaces answer, and tells the second one it was already answered", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { optionId: "allow" });
    const second = await f.decide(askId, "deny", DECIDER);
    expect(second.body).toMatchObject({ state: "answered", optionId: "allow", native: { unchanged: true, by: PERSON } });
    expect(f.notes(askId).some((note) => note.startsWith("runner-permission-decided"))).toBe(false);
    const other = askIdOf(await f.submit());
    await f.decide(other, "deny", DECIDER, { relay: true });
    const click = await f.answer(other, { optionId: "allow" });
    expect(click.status).toBe(409);
    expect((await f.read(other)).body).toMatchObject({ state: "answered", optionId: "deny" });
  });
});

// claude10 (21:55Z and 22:22Z): the person answered a prompt still open on the seat's screen after the hook's five-minute
// window, and OpenRig refused it as too late. The hook now takes an answer for as long as the prompt is open (a day at most):
// an answer to that same prompt is carried, and one to a prompt that ended or changed is still too late.
describe("an answer that comes after five minutes, while the same prompt is still open", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-11-25T21:49:40.000Z")); });
  afterEach(() => { vi.useRealTimers(); });
  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  /** claude10's second late answer came 7 min 44 s after its ask (22:14:47 to 22:22:31Z): past the old window and its grace. */
  const LATE = 7 * 60_000 + 44_000;

  it("carries the person's relayed yes, recorded as relayed and unconfirmed, and the hook takes it", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    later(LATE);
    expect((await f.read(askId)).body).toMatchObject({ state: "pending" });
    const decided = await f.decide(askId, "allow", ROUTE, { relay: true, personSaid: "Option 1, yes" });
    expect(decided.body).toMatchObject({ state: "answered", optionId: "allow", native: { answeredAs: "relayed", by: ROUTE, reported: "Option 1, yes",
      hookLastRead: isoSeconds(Date.now()) } });
    // Its hook is reading the ask, so the reply reads as it always has.
    expect(decided.body.native).not.toHaveProperty("notReached");
    expect((await f.taken(askId, "allow")).body).toMatchObject({ state: "answered", native: { taken: true } });
  });

  // Orch-advisor's must-fix: a hook killed outright (an OOM kill, say) while its Claude Code lives on leaves its ask open for
  // the rest of its day. An answer to it is recorded, but nothing takes it to the prompt, so the reply says so plainly.
  it("says an answer to an ask its hook stopped reading hasn't reached the prompt, records it all the same, and refuses nothing", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    later(10_000);
    expect((await f.read(askId)).body).toMatchObject({ state: "pending" }); // the hook's last read before it was killed
    const lastRead = isoSeconds(Date.now());
    later(LATE);
    const decided = (await f.decide(askId, "allow", ROUTE, { relay: true, personSaid: "yes" })).body;
    expect(decided).toMatchObject({ ok: true, state: "answered", optionId: "allow", native: { answeredAs: "relayed", by: ROUTE, reported: "yes", hookLastRead: lastRead } });
    expect((decided.native as { notReached: string }).notReached).toBe(`It hasn't reached ${SEAT}'s prompt: the seat's permission hook hasn't`
      + ` read this ask since ${lastRead}, so nothing has taken the answer there (the hook may have been stopped). Check the seat`
      + ` (rig capture ${SEAT}): if its prompt is still open, an answer in its terminal reaches it.`);
    expect(f.notes(askId).filter((note) => note.startsWith("runner-permission-decided"))).toHaveLength(1);
    // A second answer is told the first one counts, and still that it hasn't reached the prompt.
    expect((await f.decide(askId, "deny", ROUTE, { relay: true, personSaid: "no" })).body).toMatchObject({ state: "answered", optionId: "allow",
      native: { unchanged: true, notReached: expect.stringContaining(`It hasn't reached ${SEAT}'s prompt`) } });
    // A hook that does read it again (one that had stalled, say) takes it as usual, and then nothing says it hasn't.
    expect((await f.taken(askId, "allow")).body).toMatchObject({ state: "answered", native: { taken: true } });
    expect((await f.read(askId)).body.native).not.toHaveProperty("notReached");
  });

  it("tells a person who answers in Steering that their answer hasn't reached the prompt when its hook isn't reading", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    later(LATE);
    const answered = await f.answer(askId, { optionId: "allow" });
    expect(answered).toMatchObject({ status: 200, body: { answer: { message: `Your answer on ${askId} is recorded as yours. It hasn't reached`
      + ` ${SEAT}'s prompt: the seat's permission hook hasn't read this ask since ${isoSeconds(Date.now() - LATE)}, so nothing has taken`
      + ` the answer there (the hook may have been stopped). Check the seat (rig capture ${SEAT}): if its prompt is still open, an answer in its terminal reaches it.` } } });
    expect((await f.read(askId)).body).toMatchObject({ state: "answered", optionId: "allow", native: { answeredAs: "person" } });
    // While its hook reads, the receipt is as it was.
    const reading = askIdOf(await f.submit());
    expect(((await f.answer(reading, { optionId: "deny" })).body.answer as { message: string }).message)
      .toBe(`Your answer on ${reading} is recorded as yours, and goes to ${SEAT}'s own prompt as soon as its permission hook reads it. The prompt is also open in the seat's terminal, and the first answer counts; the request's record says when the hook took yours.`);
  });

  it("keeps a late no a no, with the person's words for the seat's agent", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    later(LATE);
    const read = (await f.decide(askId, "deny", ROUTE, { relay: true, personSaid: "No, remove the trailer" })).body;
    expect(read).toMatchObject({ state: "answered", optionId: "deny", native: { answeredAs: "relayed" } });
    expect((read.native as { message: string }).message).toBe(`Denied: ${ROUTE} relayed this as the person's answer (unconfirmed: OpenRig didn't get this answer from them). ${ROUTE} reports they said: "No, remove the trailer"`);
  });

  it("tells a second late answer that the first one counts, and writes nothing", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    later(LATE);
    await f.decide(askId, "deny", ROUTE, { relay: true, personSaid: "no" });
    later(60_000);
    expect((await f.decide(askId, "allow", ROUTE, { relay: true, personSaid: "yes" })).body)
      .toMatchObject({ state: "answered", optionId: "deny", native: { unchanged: true } });
    expect(f.notes(askId).filter((note) => note.startsWith("runner-permission-decided"))).toHaveLength(1);
  });

  it("is still too late for a prompt that ended in the terminal: a No or Esc there, or a Yes whose call resolved", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const refused = askIdOf(await f.submit());
    await f.withdraw(refused, "answered_in_terminal");
    later(LATE);
    expect((await f.decide(refused, "allow", ROUTE, { relay: true, personSaid: "yes" })).body)
      .toMatchObject({ state: "withdrawn", native: { unchanged: true, why: "answered_in_terminal" } });
    const allowed = askIdOf(await f.submit());
    await f.batch([{}]);
    later(LATE);
    expect((await f.decide(allowed, "deny", ROUTE, { relay: true, personSaid: "no" })).body)
      .toMatchObject({ state: "withdrawn", native: { unchanged: true, why: "answered_in_terminal" } });
    expect([...f.notes(refused), ...f.notes(allowed)].some((note) => note.startsWith("runner-permission-decided"))).toBe(false);
  });

  it("never gives a changed prompt the old answer: the new prompt is its own ask, still waiting", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const first = askIdOf(await f.submit());
    await f.batch([{}]); // the first prompt was answered in the terminal, and the seat moved on
    later(1000);
    const next = askIdOf(await f.submit({}, { input: { command: "git push --force origin main", description: "Force-push main" } }));
    later(LATE);
    expect((await f.decide(first, "allow", ROUTE, { relay: true, personSaid: "yes" })).body).toMatchObject({ state: "withdrawn", native: { unchanged: true } });
    expect((await f.read(next)).body).toMatchObject({ state: "pending" });
    expect(f.notes(next).some((note) => note.startsWith("runner-permission-decided"))).toBe(false);
  });

  it("answers in the window exactly as before", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    later(60_000);
    expect((await f.decide(askId, "allow", ROUTE, { relay: true, personSaid: "yes" })).body).toMatchObject({ state: "answered", optionId: "allow",
      native: { answeredAs: "relayed", by: ROUTE } });
  });

  // OpenRig's relay task for a seat's prompt tells the conversation to type the answer into the seat itself, so it waits for
  // as long as the conversation's ask takes an answer.
  it("holds the seat's prompt alert while the ask still takes an answer, past five minutes, and lets it go once the prompt ends", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const askId = askIdOf(await f.submit());
    later(LATE);
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    expect((await f.read(askId)).body).toMatchObject({ state: "pending" });
    expect(f.queueRepo.getById(askId)!.body).toContain("(24 hours)");
    await f.withdraw(askId, "answered_in_terminal");
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
  });

  it("still ends an ask its hook never withdrew once its own window has passed", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    later(hook.WINDOW_SECONDS * 1000 + 120_000);
    expect((await f.read(askId)).body).toMatchObject({ state: "withdrawn", native: { why: "answer_window_ended" } });
  });
});

describe("truthful outcome states", () => {
  it("records that the hook took the answer apart from the answer itself, and the tool's completion apart from both", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    expect((await f.taken(askId, "allow")).body).toMatchObject({ state: "pending" });
    expect(f.notes(askId).some((note) => note.startsWith("runner-permission-taken-by-hook"))).toBe(false);
    await f.answer(askId, { optionId: "allow" });
    expect((await f.read(askId)).body).toMatchObject({ state: "answered", native: { answeredAs: "person" } });
    expect((await f.read(askId)).body.native).not.toHaveProperty("taken");
    expect((await f.taken(askId, "allow")).body).toMatchObject({ state: "answered", native: { taken: true } });
    await f.taken(askId, "allow");
    const takenNotes = f.notes(askId).filter((note) => note.startsWith("runner-permission-taken-by-hook"));
    expect(takenNotes).toHaveLength(1);
    expect(takenNotes[0]).toContain("Whether Claude Code applied it isn't seen by OpenRig");
    expect((await f.read(askId)).body.native).not.toHaveProperty("toolCompleted");
    await f.batch([{}]);
    expect((await f.read(askId)).body).toMatchObject({ state: "answered", native: { taken: true, toolCompleted: true } });
    expect(f.notes(askId).filter((note) => note.startsWith("runner-permission-tool-completed"))).toHaveLength(1);
  });

  it("records no completion for a denied call: Claude's batch names it, but it didn't run", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { optionId: "deny" });
    await f.taken(askId, "deny");
    await f.batch([{}]);
    const read = (await f.read(askId)).body;
    expect(read).toMatchObject({ state: "answered", optionId: "deny", native: { taken: true } });
    expect(read.native).not.toHaveProperty("toolCompleted");
    expect(f.notes(askId).some((note) => note.startsWith("runner-permission-tool-completed"))).toBe(false);
  });

  it("shows the exact action with credential-looking text redacted before it's stored, and says so", async () => {
    const f = fixture();
    const secret = "sk-ABCDEFGHIJ0123456789abcdef";
    const askId = askIdOf(await f.submit({}, { input: { command: `curl -H "Authorization: Bearer ${secret}" https://example.test` } }));
    const row = JSON.stringify(f.db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(askId));
    expect(row).not.toContain(secret);
    const ask = f.queueRepo.getById(askId)!;
    expect(ask.body).toContain("[REDACTED]");
    expect(ask.body).toContain("with text that looks like a credential shown as [REDACTED]");
    expect(ask.body).toContain("OpenRig changes nothing in the request");
  });

  it("holds the seat's prompt alert only while a native ask takes an answer", async () => {
    const f = fixture();
    const askId = askIdOf(await f.submit());
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true);
    await f.withdraw(askId, "answer_window_ended");
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
    await f.submitRunner();
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
  });
});

describe("the real hook process against the real routes", () => {
  async function served(f: ReturnType<typeof fixture>) {
    let server: ReturnType<typeof serve> | undefined;
    const port = await new Promise<number>((ready) => { server = serve({ fetch: f.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => ready(info.port)); });
    cleanups.push(() => new Promise<void>((done) => server!.close(() => done())));
    return port;
  }
  /** Run permission-answer.cjs as Claude Code does, with the seat's environment; resolves with its stdout and exit code. */
  function runHook(f: ReturnType<typeof fixture>, port: number, input: Record<string, unknown>, onStart?: (child: ReturnType<typeof spawn>) => void) {
    const child = spawn(process.execPath, [HOOK_SCRIPT], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: INSTALL, OPENRIG_SESSION_NAME: SEAT, OPENRIG_NODE_ID: f.node.id,
      OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: f.generation() }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: CONVERSATION, tool_name: "Bash", tool_input: COMMAND,
      permission_mode: "default", ...input }));
    onStart?.(child);
    return new Promise<{ stdout: string; code: number | null }>((done) => child.on("exit", (code) => done({ stdout, code })));
  }
  const openAsk = async (f: ReturnType<typeof fixture>) => {
    for (let i = 0; i < 200; i++) {
      const open = f.asks().find((row) => row.state === "pending");
      if (open) return open.qitemId;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no ask opened");
  };

  it("returns the person's Allow once to Claude Code, after recording that the hook took it", async () => {
    const f = fixture();
    const port = await served(f);
    const run = runHook(f, port, {});
    const askId = await openAsk(f);
    await f.answer(askId, { optionId: "allow" });
    const { stdout, code } = await run;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect((await f.read(askId)).body).toMatchObject({ native: { taken: true } });
  });

  it("returns a Deny with the person's words as Claude Code's message", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const port = await served(f);
    const run = runHook(f, port, {});
    const askId = await openAsk(f);
    const decided = await f.decide(askId, "deny", ROUTE, { relay: true, personSaid: "no, run the test script first" });
    const { stdout } = await run;
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny",
      message: `Denied: ${ROUTE} relayed this as the person's answer (unconfirmed: OpenRig didn't get this answer from them). ${ROUTE} reports they said: "no, run the test script first"` } } });
    // Decided while the hook reads: the reply reads as it always has.
    expect(decided.body).toMatchObject({ state: "answered", optionId: "deny" });
    expect(decided.body.native).not.toHaveProperty("notReached");
  });

  it("returns a conditional judgment through the real hook without calling it the person's own yes", async () => {
    const f = fixture({ decider: DECIDER });
    const port = await served(f);
    const run = runHook(f, port, {});
    const askId = await openAsk(f);
    await f.answer(askId, { decision: "yes, as long as it is the docs branch" });
    const decided = await f.decide(askId, "allow", DECIDER, { reason: "this exact action uses the docs branch" });
    expect(decided.body).toMatchObject({ state: "answered", optionId: "allow", native: { answeredAs: "agent", by: DECIDER } });
    const { stdout, code } = await run;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect((await f.read(askId)).body).toMatchObject({ native: { taken: true, answeredAs: "agent", said: "yes, as long as it is the docs branch" } });
  });

  it("says an answer hasn't reached the prompt when the hook was killed outright while its Claude Code lives on", async () => {
    const f = fixture({ people: [] });
    await f.routedWork();
    const port = await served(f);
    let child: ReturnType<typeof spawn> | undefined;
    const run = runHook(f, port, {}, (started) => { child = started; });
    const askId = await openAsk(f);
    // An OOM kill, say: no signal handler runs, so nothing withdraws the ask, and this process (its Claude Code) lives on.
    child!.kill("SIGKILL");
    expect((await run).stdout).toBe("");
    // Two minutes on, with no read from the hook since it was killed.
    vi.useFakeTimers({ toFake: ["Date"] });
    cleanups.push(() => { vi.useRealTimers(); });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const decided = (await f.decide(askId, "allow", ROUTE, { relay: true, personSaid: "yes" })).body;
    expect(decided).toMatchObject({ state: "answered", optionId: "allow", native: { answeredAs: "relayed",
      notReached: expect.stringContaining(`It hasn't reached ${SEAT}'s prompt: the seat's permission hook hasn't read this ask since`) } });
    expect(decided.native).not.toHaveProperty("taken");
  });

  it("exits with no decision when no one can be asked, leaving Claude Code's own prompt", async () => {
    const f = fixture({ people: [] });
    const port = await served(f);
    const { stdout, code } = await runHook(f, port, {});
    expect({ stdout, code }).toEqual({ stdout: "", code: 0 });
    expect(f.asks()).toHaveLength(0);
  });

  it("withdraws its ask as answered in the terminal when Claude Code ends it (a terminal No or Esc), with no decision", async () => {
    const f = fixture();
    const port = await served(f);
    let child: ReturnType<typeof spawn> | undefined;
    const run = runHook(f, port, {}, (started) => { child = started; });
    const askId = await openAsk(f);
    child!.kill("SIGTERM");
    const { stdout, code } = await run;
    expect({ stdout, code }).toEqual({ stdout: "", code: 0 });
    expect((await f.read(askId)).body).toMatchObject({ state: "withdrawn", native: { why: "answered_in_terminal" } });
  });

  it("withdraws its ask when the Claude Code that started it is gone without ending it", async () => {
    const f = fixture();
    const port = await served(f);
    // A stand-in for Claude Code: it starts the hook, says its pid, and is then killed outright, leaving the hook on its own.
    const parent = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(HOOK_SCRIPT)}],
      { stdio: ["pipe", "ignore", "ignore"] }); process.stdout.write(c.pid + "\\n"); process.stdin.pipe(c.stdin);`], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: INSTALL,
        OPENRIG_SESSION_NAME: SEAT, OPENRIG_NODE_ID: f.node.id, OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: f.generation() },
      stdio: ["pipe", "pipe", "ignore"] });
    const hookPid = await new Promise<number>((done) => parent.stdout.once("data", (chunk) => done(Number(String(chunk).trim()))));
    cleanups.push(() => { try { process.kill(hookPid, "SIGKILL"); } catch { /* already gone */ } });
    parent.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: CONVERSATION, tool_name: "Bash", tool_input: COMMAND,
      permission_mode: "default" }));
    const askId = await openAsk(f);
    parent.kill("SIGKILL");
    let read = (await f.read(askId)).body;
    for (let i = 0; i < 100 && read.state === "pending"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      read = (await f.read(askId)).body;
    }
    expect(read).toMatchObject({ state: "withdrawn", native: { why: "answered_in_terminal" } });
  });

  it("exits with no decision when its daemon can't be reached", async () => {
    const f = fixture();
    const started = Date.now();
    const { stdout, code } = await runHook(f, 9, {});
    expect({ stdout, code }).toEqual({ stdout: "", code: 0 });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("the daemon stopping while the hook waits", () => {
  it("answers the waiting read at once with what it has, so the read doesn't hold the daemon's shutdown", async () => {
    let stop!: () => void;
    const f = fixture({ decider: DECIDER, stopping: new Promise<void>((resolve) => { stop = resolve; }) });
    const askId = askIdOf(await f.submit());
    const started = Date.now();
    const waiting = f.readWaiting(askId, 20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();
    expect((await waiting).body).toMatchObject({ state: "pending" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

// dev60-review's R1: every Claude seat's tool batch settles its native asks (up to 64 reads, one per call it names), and the
// wake ladder asks on its ticks whether one holds the seat's prompt alert. Each read walked every row the seat ever sent
// (3.17 s cold for Build's largest sender). Migration 199's partial index lists the native asks alone, by seat and age;
// these cells read the plan of the statement the code itself prepares, as #3965's census cell does.
describe("the reads on every tool batch and wake-ladder tick cover only the seat's native asks", () => {
  const INDEX = "idx_queue_items_native_permission";
  /** The statements prepared while `run` runs that `pick` selects. */
  async function preparedDuring(f: ReturnType<typeof fixture>, pick: (sql: string) => boolean, run: () => unknown): Promise<string[]> {
    const prepare = f.db.prepare.bind(f.db);
    const seen: string[] = [];
    const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => { if (pick(sql)) seen.push(sql); return prepare(sql); });
    try { await run(); } finally { spy.mockRestore(); }
    return seen;
  }
  const plan = (f: ReturnType<typeof fixture>, sql: string, ...args: unknown[]) =>
    (f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
  /** A long-lived seat: many rows it sent, none of them a native ask. */
  const history = (f: ReturnType<typeof fixture>) => {
    const insert = f.db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, tags)
      VALUES (?, ?, ?, ?, 'lead@perm-rig', 'done', 'x', '["runner-permission"]')`);
    f.db.transaction(() => { for (let i = 0; i < 500; i++) insert.run(`qitem-sent-${i}`, new Date().toISOString(), new Date().toISOString(), SEAT); })();
  };

  it("settles a tool batch through the partial index, with no scan and no sort", async () => {
    const f = fixture();
    history(f);
    const askId = askIdOf(await f.submit());
    const [sql] = await preparedDuring(f, (text) => text.includes("source_session = ? AND ts_created >= ?"), () => f.batch([{ input: { command: "ls" } }]));
    expect(sql).toBeDefined();
    const read = plan(f, sql!, SEAT, new Date(0).toISOString(), '%"permission-call:0123456789abcdef"%');
    expect(read).toContain(`SEARCH queue_items USING INDEX ${INDEX} (source_session=? AND ts_created>?)`);
    expect(read).not.toMatch(/SCAN queue_items|TEMP B-TREE/);
    // What it settles is unchanged: the batch named another call, so the ask still waits; its own call settles it.
    expect((await f.read(askId)).body).toMatchObject({ state: "pending" });
    await f.batch([{}]);
    expect((await f.read(askId)).body).toMatchObject({ state: "withdrawn", native: { why: "answered_in_terminal" } });
  });

  it("asks whether a native ask holds the seat's prompt alert through the partial index, with no scan and no sort", async () => {
    const f = fixture();
    history(f);
    expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(false);
    await f.submit();
    const [sql] = await preparedDuring(f, (text) => text.includes("state IN ('pending','in-progress','blocked','handed-off')"),
      () => expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true));
    expect(sql).toBeDefined();
    // Bounded by the longest answer window: an ask created before it can't still be taking an answer, so a seat's older
    // native history (handed-off asks stay handed-off) is never read on a tick.
    const read = plan(f, sql!, SEAT, new Date(0).toISOString());
    expect(read).toContain(`SEARCH queue_items USING INDEX ${INDEX} (source_session=? AND ts_created>?)`);
    expect(read).not.toMatch(/SCAN queue_items|TEMP B-TREE/);
  });
});


describe("native prompt-hold handoff lookup plan", () => {
  it("uses the existing successor index while following the current handoff", async () => {
    const f = fixture({ decider: DECIDER });
    const askId = askIdOf(await f.submit());
    await f.answer(askId, { decision: "yes, for that request" });
    const prepare = f.db.prepare.bind(f.db);
    let sql = "";
    const spy = vi.spyOn(f.db, "prepare").mockImplementation((text: string) => {
      if (text.startsWith("WITH RECURSIVE chain")) sql = text;
      return prepare(text);
    });
    try { expect(nativeAskHoldsPrompt(f.db, SEAT)).toBe(true); } finally { spy.mockRestore(); }
    expect(sql).not.toBe("");
    const details = (f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(JSON.stringify([askId])) as Array<{ detail: string }>).map(r => r.detail).join(" | ");
    expect(details).toContain("idx_queue_items_handed_off_from");
    expect(details).not.toMatch(/SCAN queue_items|SCAN next\b/);
  });
});

describe("successive prompts for the same tool input", () => {
  it.each(["allow", "deny"])("does not withdraw a later identical prompt when an earlier %s call resolves", async (optionId) => {
    const f = fixture();
    const first = askIdOf(await f.submit());
    await f.answer(first, { optionId });
    await f.taken(first, optionId);
    const second = askIdOf(await f.submit());
    expect(second).not.toBe(first);
    expect((await f.read(second)).body.state).toBe("pending");
    await f.batch([{}]);
    expect((await f.read(second)).body.state).toBe("pending");
    const earlier = (await f.read(first)).body;
    expect(earlier).toMatchObject({ state: "answered", native: { taken: true } });
    if (optionId === "allow") expect(earlier.native).toHaveProperty("toolCompleted", true);
    else expect(earlier.native).not.toHaveProperty("toolCompleted");
    // A later batch for the second call must not keep matching the first decision forever.
    await f.batch([{}]);
    expect((await f.read(second)).body.state).toBe("withdrawn");
  });
});
