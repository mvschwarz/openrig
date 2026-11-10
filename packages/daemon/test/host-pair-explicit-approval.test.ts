// A host pairing hands over this daemon's bearer token only on an explicit decision. Where the kernel operator runs, the
// person's answer, a click or their words, goes to it and it decides (`rig host approve|deny`); where none runs, the
// person's Approve or Deny choice decides, or an agent seat's close that names Approve. Typed words never deny, and
// never approve by themselves.
// Test-only: real hosts routes, Mission Control HTTP route and write contract (Steering's and the TUI's answer path),
// the real Slack inbound router (a button and a thread reply) and migrated SQLite. No Slack network, no real token.
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { hostsRoutes } from "../src/routes/hosts.js";
import { InboundRouter } from "../src/domain/gateway/slack/inbound.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";

const BEARER = "synthetic-pairing-bearer-fixture";
const PERSON = "pair-person@external", AGENT = "dev-agent@fixture-rig", OPERATOR = "operator-agent@kernel";
const registry = { ok: true as const, entities: [{ entityId: "pair-person", class: "human" as const, displayName: "Pairing person", address: PERSON,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "unused", role: "primary" as const, handle: "UPAIR" }], prefs: { deliveryClass: "A" as const } }] };

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

/** The production destination check. `kernel: false` is a daemon started without a kernel rig (--no-kernel), where no
 *  row can be addressed to `…@kernel`; the agent's rig is registered either way. `operator` is the kernel operator's
 *  session state when the request is made (none: no session row). */
async function fixture({ kernel = true, operator, ownershipUnreadable = false }: { kernel?: boolean; operator?: "running" | "exited"; ownershipUnreadable?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pair-explicit-"));
  const db = new Database(join(home, "queue.sqlite")); migrate(db, ALL_MIGRATIONS); const bus = new EventBus(db);
  if (operator) {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-kernel", "kernel");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("node-operator", "rig-kernel", "operator.agent");
    db.prepare("INSERT INTO sessions (node_id, session_name, status) VALUES (?, ?, ?)").run("node-operator", OPERATOR, operator);
  }
  const rigs = kernel ? ["kernel", "fixture-rig"] : ["fixture-rig"];
  const validateRig = makeTopologyDestinationCheck({ findRigsByName: (name) => rigs.filter((rig) => rig === name),
    loadHumanRegistry: () => registry, sharedChannels: () => [] });
  const repo = new QueueRepository(db, bus, { validateRig, loadHumanRegistry: () => registry,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never); c.set("missionControlWriteContract" as never, contract as never); await next(); });
  app.route("/api/mission-control", missionControlRoutes());
  app.route("/api/hosts", hostsRoutes({ bearerToken: BEARER, humanRegistry: () => registry }));
  closes.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  // The ownership read fails while the request is made (the sessions lookup throws).
  const real = db.prepare.bind(db);
  const unreadable = ownershipUnreadable ? vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    if (sql.includes("FROM sessions WHERE session_name = ? LIMIT 1")) throw new Error("sessions unreadable");
    return real(sql);
  }) as typeof db.prepare) : null;
  const issued = await (await app.request("/api/hosts/pair-request", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requester: "requester@far-host" }) })).json() as { pairId: string; code: string; approvalQitemId: string };
  unreadable?.mockRestore();
  const ask = issued.approvalQitemId;
  const router = new InboundRouter({ queue: makeQueuePorts(repo), destination: "host-pair@kernel", seen: new SeenStore(join(home, "seen.jsonl")),
    deadLetter: new DeadLetterStore(join(home, "dead.jsonl")), resolveSender: () => ({ admitted: true, source: PERSON }),
    // The thread map's seat for a posted ask is the ask's source (slack-subsystem's threadMap.open).
    resolveRoute: () => ({ destination: repo.getById(ask)!.sourceSession, correlationQitemId: ask }),
    acknowledgeAnswer: async () => {}, recordHumanAnswer: input => repo.recordHumanAnswer(input),
    resolveHumanReply: makeHumanReplyResolver(repo, contract) });

  /** The requester's poll: the status, and whether the response carries the token anywhere. */
  const poll = async () => {
    const res = await app.request(`/api/hosts/pair-request/${issued.pairId}`);
    const text = await res.text();
    return { http: res.status, body: res.status === 200 ? JSON.parse(text) as { status: string; token?: string } : null, leaksToken: text.includes(BEARER) };
  };
  /** Steering's question card and the TUI's acts both post Mission Control's answer verb. The TUI's carry the primary
   *  user's authority and no seat header (attention-model.ts answerRequest); the route honours it only then. */
  const answer = async (input: Record<string, unknown>, qitemId = ask) => {
    const tui = input.authority === "primary-user";
    const res = await app.request("/api/mission-control/action", { method: "POST",
      headers: { "Content-Type": "application/json", ...(tui ? {} : { "X-OpenRig-Session": PERSON }) },
      body: JSON.stringify({ verb: "answer", qitemId, actorSession: PERSON, ...input }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  /** `rig host approve|deny <request>`: from a seat (its header), or from a plain terminal (no seat). */
  const decide = async (request: string, decision: string, seat?: string) => {
    const res = await app.request("/api/hosts/pair-decision", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${BEARER}`, ...(seat ? { "X-OpenRig-Session": seat } : {}) },
      body: JSON.stringify({ request, decision }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  /** Rows to the person other than the request: a re-ask, or the result's update. */
  const toPerson = () => repo.list({ limit: 1000 }).filter((item) => item.destinationSession === PERSON && item.qitemId !== ask);
  const slackButton = (optionId: string) => router.routeAction({ type: "block_actions", user: { id: "UPAIR" }, channel: { id: "CPAIR" },
    container: { type: "message", message_ts: "1.1", channel_id: "CPAIR" }, message: { ts: "1.1" },
    actions: [{ type: "button", block_id: "or-q:pair", action_id: `or-opt:${optionId}`, value: optionId, action_ts: "2.2" }] });
  const slackThreadReply = (text: string) => router.route({ type: "message", user: "UPAIR", channel: "CPAIR", thread_ts: "1.1", ts: "3.3", text });
  /** Rows created in reply to the request: an answer to it is kept on the request itself, so there are none. */
  const replyRows = () => repo.list({ limit: 1000 }).filter((item) => item.replyTo === ask || item.destinationSession === "host-pair@kernel");
  return { repo, contract, ask, issued, poll, answer, decide, toPerson, slackButton, slackThreadReply, replyRows };
}

describe("host pairing with no kernel operator running: Approve and Deny decide, typed words are asked again", () => {
  it("the request carries one question, Approve or Deny, and tells the person typed words are kept and asked again", async () => {
    const f = await fixture();
    const item = f.repo.getById(f.ask)!;
    expect(item.sourceSession).toBe("host-pair@kernel");
    expect(item.humanQuestions).toEqual([{ id: "pair", question: `Pair requester@far-host (code ${f.issued.code}) with this host?`, options: [
      { id: "approve", label: "Approve: hand this host's bearer token to the requester" }, { id: "deny", label: "Deny" }] }]);
    expect(item.body).toContain(`Answer with Approve or Deny. Typed words are kept but don't decide it, and you're asked again: no agent reads answers on this host (it has no ${OPERATOR}).`);
    expect(item.body).toContain(`rig host approve ${f.issued.code}, or rig host deny ${f.issued.code}`);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
  });

  // Steering's and the TUI's "reply <text>": the person's words close the request and are kept under its question.
  // Nothing on this host reads them, so they never deny: the person is asked again, and their choice there decides.
  it.each(["no", "yes", "who is this?"])("a typed reply %j (Steering or the TUI) never denies: words kept, the person is asked again, and Approve there pairs", async (words) => {
    const f = await fixture();
    expect((await f.answer({ decision: words })).status).toBe(200);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", closureReason: "no-follow-on",
      humanAnswers: { pair: { kind: "typed-reply", text: words } } });
    const [again, ...more] = f.toPerson();
    expect(more).toEqual([]);
    expect(again).toMatchObject({ state: "pending", sourceSession: "host-pair@kernel", humanQuestions: f.repo.getById(f.ask)!.humanQuestions });
    expect(again!.body).toContain(`You wrote "${words}" in reply to this request. Your words are kept, and they didn't deny anything`);
    // Polling again asks nothing more.
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    expect(f.toPerson()).toHaveLength(1);
    expect((await f.answer({ questionId: "pair", optionId: "approve" }, again!.qitemId)).status).toBe(200);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
    expect((await f.poll()).http).toBe(404);
  });

  it.each(["yes", "no"])("a typed Slack thread reply %j never denies: words kept, the person is asked again", async (words) => {
    const f = await fixture();
    await f.slackThreadReply(words);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", humanAnswers: { pair: { kind: "typed-reply", text: words } } });
    expect(f.toPerson()).toEqual([expect.objectContaining({ state: "pending", sourceSession: "host-pair@kernel" })]);
  });

  it("a plain terminal on this host decides with rig host approve, recorded as a direct human action, and the person is told", async () => {
    const f = await fixture();
    await f.answer({ decision: "yes please" });
    await f.poll();
    const again = f.toPerson()[0]!;
    expect(await f.decide(f.issued.code, "approve")).toEqual({ status: 200,
      body: { ok: true, decision: "approve", code: f.issued.code, requester: "requester@far-host", by: "human@host" } });
    // The open re-ask is closed with the result, and one update tells the person.
    expect(f.repo.getById(again.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on", resolution: "pairing approved by human@host" });
    expect(f.toPerson().filter((item) => item.humanIntent === "update")).toEqual([expect.objectContaining({
      body: `Pairing request ${f.issued.code} from requester@far-host: approved by human@host. This host's token is handed over when the requesting machine next checks, if it's still waiting.` })]);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
  });

  it.each([
    ["Steering's question card", { questionId: "pair", optionId: "approve" }],
    ["the TUI's Approve act (primary user)", { questionId: "pair", optionId: "approve", authority: "primary-user" }],
  ] as const)("%s: Approve hands the token over once, then the pairing dies", async (_label, input) => {
    const f = await fixture();
    expect((await f.answer(input)).status).toBe(200);
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", humanAnswers: { pair: "approve" } });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
    expect((await f.poll()).http).toBe(404);
  });

  it("Slack's Approve button hands the token over once", async () => {
    const f = await fixture();
    await f.slackButton("approve");
    expect(f.repo.getById(f.ask)?.humanAnswers).toEqual({ pair: "approve" });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
    expect((await f.poll()).http).toBe(404);
  });

  it.each([
    ["Steering's Deny choice", (f: Awaited<ReturnType<typeof fixture>>) => f.answer({ questionId: "pair", optionId: "deny" })],
    ["Slack's Deny button", (f: Awaited<ReturnType<typeof fixture>>) => f.slackButton("deny")],
  ] as const)("%s denies, with no token", async (_label, act) => {
    const f = await fixture();
    await act(f);
    expect(f.repo.getById(f.ask)?.humanAnswers).toEqual({ pair: "deny" });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
  });

  // An answer is kept on the request, like a runner's permission request's: no reply row goes to host-pair@kernel, so it
  // works the same on a daemon without a kernel rig, and nothing is left for a seat that doesn't exist.
  it.each([true, false])("kernel rig registered: %s. An Approve choice (Steering, the TUI, Slack) closes the request in place and approves once", async (kernel) => {
    for (const [actor, act] of [
      [PERSON, (f: Awaited<ReturnType<typeof fixture>>) => f.answer({ questionId: "pair", optionId: "approve" })],
      // The terminal names no responder: the TUI's act is recorded unattributed.
      ["human@host", (f: Awaited<ReturnType<typeof fixture>>) => f.answer({ questionId: "pair", optionId: "approve", authority: "primary-user" })],
      [PERSON, (f: Awaited<ReturnType<typeof fixture>>) => f.slackButton("approve")],
    ] as const) {
      const f = await fixture({ kernel });
      const result = await act(f);
      // Steering and the TUI answer over HTTP; Slack's router returns its own disposition.
      if (typeof (result as { status?: unknown }).status === "number") expect((result as { status: number }).status).toBe(200);
      expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", closureReason: "no-follow-on", humanAnswers: { pair: "approve" } });
      expect(f.repo.closingTransition(f.ask, "done")?.actorSession).toBe(actor);
      expect(f.replyRows()).toEqual([]);
      expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
      expect((await f.poll()).http).toBe(404);
    }
  });

  it.each([true, false])("kernel rig registered: %s. A Deny choice (Steering, Slack) closes the request in place and denies once", async (kernel) => {
    for (const act of [
      (f: Awaited<ReturnType<typeof fixture>>) => f.answer({ questionId: "pair", optionId: "deny" }),
      (f: Awaited<ReturnType<typeof fixture>>) => f.slackButton("deny"),
    ]) {
      const f = await fixture({ kernel });
      const result = await act(f);
      if (typeof (result as { status?: unknown }).status === "number") expect((result as { status: number }).status).toBe(200);
      expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", humanAnswers: { pair: "deny" } });
      expect(f.repo.closingTransition(f.ask, "done")?.actorSession).toBe(PERSON);
      expect(f.replyRows()).toEqual([]);
      expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
      expect((await f.poll()).http).toBe(404);
    }
  });

  it.each([true, false])("kernel rig registered: %s. A typed reply (Steering, Slack) closes the request in place, words kept, never denied", async (kernel) => {
    for (const act of [
      (f: Awaited<ReturnType<typeof fixture>>) => f.answer({ decision: "yes" }),
      (f: Awaited<ReturnType<typeof fixture>>) => f.slackThreadReply("yes"),
    ]) {
      const f = await fixture({ kernel });
      const result = await act(f);
      // Steering and the TUI answer over HTTP; Slack's router returns its own disposition.
      if (typeof (result as { status?: unknown }).status === "number") expect((result as { status: number }).status).toBe(200);
      expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", humanAnswers: { pair: { kind: "typed-reply", text: "yes" } } });
      expect(f.repo.closingTransition(f.ask, "done")?.actorSession).toBe(PERSON);
      expect(f.replyRows()).toEqual([]);
      expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    }
  });

  it("a click that decides is told to the person as the outcome, apart from their click", async () => {
    const f = await fixture();
    await f.slackButton("approve");
    expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
    expect(f.toPerson()).toEqual([expect.objectContaining({ humanIntent: "update", summary: `Pairing ${f.issued.code} from requester@far-host: approved`,
      body: `Pairing request ${f.issued.code} from requester@far-host: approved by ${PERSON}. This host's token was handed to the requesting machine.` })]);
  });

  it("an agent seat approves only by naming the choice: rig queue update --state done --closure-reason no-follow-on --resolution approve", async () => {
    const f = await fixture();
    await f.repo.update({ qitemId: f.ask, actorSession: AGENT, state: "done", closureReason: "no-follow-on", resolution: "approve" });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
  });

  it.each([
    ["an agent seat's close without --resolution approve", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.repo.update({ qitemId: f.ask, actorSession: AGENT, state: "done", closureReason: "no-follow-on" }); }],
    ["an agent seat's close naming another outcome", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.repo.update({ qitemId: f.ask, actorSession: AGENT, state: "done", closureReason: "no-follow-on", resolution: "approved, I think" }); }],
    ["a bare Approve verb, which records no choice", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.contract.act({ verb: "approve", qitemId: f.ask, actorSession: PERSON }); }],
  ] as const)("%s denies, with no token", async (_label, act) => {
    const f = await fixture();
    await act(f);
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
  });

  it("an explicit Deny wins over a later agent close that names Approve", async () => {
    const f = await fixture();
    // A recorded Deny whose return hasn't closed the request yet (its close failed), then an agent's approving close.
    f.repo.recordHumanAnswer({ qitemId: f.ask, actorSession: PERSON, questionId: "pair", optionId: "deny" });
    expect(f.repo.getById(f.ask)?.state).toBe("pending");
    await f.repo.update({ qitemId: f.ask, actorSession: AGENT, state: "done", closureReason: "no-follow-on", resolution: "approve" });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
  });

  it("a recorded Approve whose return didn't close the request still approves once; a later Steering Deny before the poll denies", async () => {
    const approvedOpen = await fixture();
    approvedOpen.repo.recordHumanAnswer({ qitemId: approvedOpen.ask, actorSession: PERSON, questionId: "pair", optionId: "approve" });
    expect(approvedOpen.repo.getById(approvedOpen.ask)?.state).toBe("pending");
    expect(await approvedOpen.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });

    const deniedAfter = await fixture();
    deniedAfter.repo.recordHumanAnswer({ qitemId: deniedAfter.ask, actorSession: PERSON, questionId: "pair", optionId: "approve" });
    await deniedAfter.contract.act({ verb: "deny", qitemId: deniedAfter.ask, actorSession: PERSON });
    expect(await deniedAfter.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
  });
});

describe("host pairing with the kernel operator running: the person's answer goes to it, and it decides", () => {
  it("the operator asks, and the request tells it to act on a clear answer with rig host approve|deny", async () => {
    const f = await fixture({ operator: "running" });
    const item = f.repo.getById(f.ask)!;
    expect(item).toMatchObject({ sourceSession: OPERATOR, destinationSession: PERSON, tier: "human-gate" });
    expect(item.body).toContain(`Answer with Approve or Deny, or in your own words. ${OPERATOR} reads your answer and acts on it`);
    expect(item.body).toContain(`For ${OPERATOR}: when the person's answer to this request comes back, act on it. A clear yes or an Approve click: rig host approve ${f.issued.code}. A clear no or a Deny click: rig host deny ${f.issued.code}.`);
  });

  it.each(["yes", "no", "yes, but which machine?"])("a typed %j (Steering) reaches the operator as a reply with the person's words, and decides nothing by itself", async (words) => {
    const f = await fixture({ operator: "running" });
    expect((await f.answer({ decision: words })).status).toBe(200);
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", closureReason: "no-follow-on", humanAnswers: { pair: { kind: "typed-reply", text: words } } });
    const replies = f.repo.list({ limit: 1000 }).filter((row) => row.replyTo === f.ask);
    expect(replies).toEqual([expect.objectContaining({ sourceSession: PERSON, destinationSession: OPERATOR, state: "pending" })]);
    expect(replies[0]!.body).toContain(words);
    expect(replies[0]!.body).toContain(`In reply to: ${f.ask}`);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    // Nobody is asked again: the operator reads the words. The person is told once that their answer was received.
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    expect(f.toPerson()).toEqual([expect.objectContaining({ sourceSession: OPERATOR, humanIntent: "update",
      summary: `Pairing ${f.issued.code} from requester@far-host: answer received`,
      body: `Received "${words}" on pairing request ${f.issued.code} from requester@far-host. ${OPERATOR} reads it and acts on it. You'll see the result here, or a question if your answer isn't clear.` })]);
  });

  it("a stopped kernel operator still owns the request: the person sees it isn't running, the answer is kept, and nothing is granted or denied", async () => {
    const f = await fixture({ operator: "exited" });
    const item = f.repo.getById(f.ask)!;
    expect(item.sourceSession).toBe(OPERATOR);
    expect(item.body).toContain(`${OPERATOR} isn't running right now, so your answer waits until it starts; nothing is granted or denied meanwhile. To decide sooner, in a terminal on this host with its operator bearer token: rig host approve ${f.issued.code}, or rig host deny ${f.issued.code} (OPENRIG_AUTH_BEARER_TOKEN set, or --bearer <token>).`);
    await f.slackButton("approve");
    expect(f.repo.list({ limit: 1000 }).filter((row) => row.replyTo === f.ask)).toEqual([expect.objectContaining({ destinationSession: OPERATOR, state: "pending" })]);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    const [receipt, ...more] = f.toPerson();
    expect(more).toEqual([]);
    expect(receipt!.body).toContain(`Received your Approve choice on pairing request ${f.issued.code} from requester@far-host. ${OPERATOR} isn't running, so it may not have read it yet. Nothing is granted or denied until it acts, or the request expires at `);
    expect(receipt!.body).toContain(`To decide now, in a terminal on this host with its operator bearer token: rig host approve ${f.issued.code}, or rig host deny ${f.issued.code} (OPENRIG_AUTH_BEARER_TOKEN set, or --bearer <token>).`);
    // The person's terminal route works without a seat.
    expect((await f.decide(f.issued.code, "approve")).body).toMatchObject({ ok: true, by: "human@host" });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
  });

  it("a typed Slack thread reply reaches the operator too, and decides nothing by itself", async () => {
    const f = await fixture({ operator: "running" });
    await f.slackThreadReply("go ahead");
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", humanAnswers: { pair: { kind: "typed-reply", text: "go ahead" } } });
    expect(f.repo.list({ limit: 1000 }).filter((row) => row.replyTo === f.ask)).toEqual([expect.objectContaining({ destinationSession: OPERATOR })]);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
  });

  it.each(["approve", "deny"])("a %s click reaches the operator as context: no token until it decides", async (optionId) => {
    const f = await fixture({ operator: "running" });
    expect((await f.answer({ questionId: "pair", optionId })).status).toBe(200);
    expect(f.repo.list({ limit: 1000 }).filter((row) => row.replyTo === f.ask)).toEqual([expect.objectContaining({ destinationSession: OPERATOR })]);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
  });

  it("the operator approves by code: the token is handed over once, and the person is told who approved", async () => {
    const f = await fixture({ operator: "running" });
    await f.answer({ decision: "yes" });
    expect(await f.decide(f.issued.code, "approve", OPERATOR)).toMatchObject({ status: 200, body: { ok: true, decision: "approve", by: OPERATOR } });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
    expect((await f.poll()).http).toBe(404);
    expect(f.toPerson()).toEqual([expect.objectContaining({ sourceSession: OPERATOR, humanIntent: "update",
      summary: `Pairing ${f.issued.code} from requester@far-host: approved` })]);
  });

  it("the operator denies by the request's row: nothing is handed over", async () => {
    const f = await fixture({ operator: "running" });
    await f.answer({ decision: "no thanks" });
    expect(await f.decide(f.ask, "deny", OPERATOR)).toMatchObject({ status: 200, body: { ok: true, decision: "deny", by: OPERATOR } });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
    expect(f.toPerson()[0]!.body).toBe(`Pairing request ${f.issued.code} from requester@far-host: denied by ${OPERATOR}. Nothing was handed over.`);
  });

  it("a decision is made once: a second one, an unknown request or a malformed call changes nothing", async () => {
    const f = await fixture({ operator: "running" });
    expect((await f.decide(f.issued.code, "deny", OPERATOR)).status).toBe(200);
    expect(await f.decide(f.issued.code, "approve", AGENT)).toMatchObject({ status: 409, body: { error: "pair_request_decided", decision: "deny", by: OPERATOR } });
    expect(await f.decide("000000", "approve", OPERATOR)).toMatchObject({ status: 404, body: { error: "pair_request_unknown" } });
    expect(await f.decide(f.issued.code, "yes", OPERATOR)).toMatchObject({ status: 400, body: { error: "pair_decision_invalid" } });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
  });

  it("after expiry a decision is refused, the request reads expired, and an answer the operator didn't pick up is named", async () => {
    const f = await fixture({ operator: "running" });
    await f.answer({ decision: "yes" });
    const later = Date.now() + 11 * 60_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(await f.decide(f.issued.code, "approve", OPERATOR)).toMatchObject({ status: 409, body: { error: "pair_request_expired" } });
      expect(await f.poll()).toEqual({ http: 200, body: { status: "expired" }, leaksToken: false });
    } finally { now.mockRestore(); }
    expect(f.toPerson()).toEqual([expect.objectContaining({ humanIntent: "update",
      body: `Pairing request ${f.issued.code} from requester@far-host: expired before it was decided: ${OPERATOR} didn't pick up your answer. Nothing was handed over; the requester can run rig host pair again.` })]);
  });
});

describe("host pairing: one decision per request, and no reply is denied on a technicality", () => {
  it("a Deny click the requester hasn't polled yet stands: rig host approve is refused, and the poll denies", async () => {
    const f = await fixture();
    await f.slackButton("deny");
    expect(await f.decide(f.issued.code, "approve")).toMatchObject({ status: 409, body: { error: "pair_request_decided", decision: "deny", by: PERSON } });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
  });

  it("an operator's refusing close the requester hasn't polled yet stands: rig host approve is refused", async () => {
    const f = await fixture({ operator: "running" });
    await f.repo.update({ qitemId: f.ask, actorSession: OPERATOR, state: "denied" });
    expect(await f.decide(f.issued.code, "approve", AGENT)).toMatchObject({ status: 409, body: { error: "pair_request_decided", decision: "deny", by: OPERATOR } });
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
  });

  it("an attachment-only Slack reply on an owner host reaches the operator and is never denied: the person gets a receipt", async () => {
    const f = await fixture({ operator: "running" });
    await f.slackThreadReply("");
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(f.repo.getById(f.ask)?.humanAnswers?.pair).toBeUndefined();
    expect(f.repo.list({ limit: 1000 }).filter((row) => row.replyTo === f.ask)).toEqual([expect.objectContaining({ destinationSession: OPERATOR })]);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    expect(f.toPerson()).toEqual([expect.objectContaining({ body: expect.stringContaining(`Received your reply on pairing request ${f.issued.code}`) })]);
  });

  it("an attachment-only Slack reply on an agent-free host is never denied: the person is asked again", async () => {
    const f = await fixture();
    await f.slackThreadReply("");
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    expect(f.toPerson()).toEqual([expect.objectContaining({ state: "pending", sourceSession: "host-pair@kernel",
      body: expect.stringContaining("Your reply to this request had no words to keep here, and it didn't deny anything") })]);
  });

  // The queue keeps no words for the literal text "[file reply]" (the text a Slack file reply carries), so these closes
  // carry no answer: they're still the person's reply, and never a denial.
  it.each([
    ["Steering", (f: Awaited<ReturnType<typeof fixture>>) => f.answer({ decision: "[file reply]" })],
    ["Slack", (f: Awaited<ReturnType<typeof fixture>>) => f.slackThreadReply("[file reply]")],
  ] as const)("the literal text [file reply] typed in %s is never denied: asked again with no operator, a receipt with one", async (_label, act) => {
    const free = await fixture();
    await act(free);
    expect(free.repo.getById(free.ask)?.humanAnswers?.pair).toBeUndefined();
    expect(await free.poll()).toEqual({ http: 200, body: { status: "pending", code: free.issued.code }, leaksToken: false });
    expect(free.toPerson()).toEqual([expect.objectContaining({ state: "pending", body: expect.stringContaining("Your reply to this request had no words to keep here") })]);

    const owned = await fixture({ operator: "running" });
    await act(owned);
    expect(await owned.poll()).toEqual({ http: 200, body: { status: "pending", code: owned.issued.code }, leaksToken: false });
    expect(owned.toPerson()).toEqual([expect.objectContaining({ body: expect.stringContaining(`Received your reply on pairing request ${owned.issued.code}`) })]);
  });

  it("when OpenRig can't read whether the operator runs, the receipt says so instead of saying it reads the answer", async () => {
    const f = await fixture({ operator: "running" });
    await f.answer({ decision: "yes" });
    const real = f.repo.db.prepare.bind(f.repo.db);
    const prepare = vi.spyOn(f.repo.db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("status = 'running'")) throw new Error("sessions unreadable");
      return real(sql);
    }) as typeof f.repo.db.prepare);
    try {
      expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
    } finally { prepare.mockRestore(); }
    const [receipt] = f.toPerson();
    expect(receipt!.body).toContain(`OpenRig couldn't tell whether ${OPERATOR} is running, so it may not have read it yet.`);
    expect(receipt!.body).toContain(`rig host approve ${f.issued.code}`);
    expect(receipt!.body).not.toContain("reads it and acts on it");
  });
});

describe("host pairing: exact expiry, and an agent-free request says why nobody reads answers", () => {
  it("the outcome update can't hold the token: a hanging update doesn't delay the approved response", async () => {
    const f = await fixture();
    await f.slackButton("approve");
    const create = f.repo.create.bind(f.repo);
    const hang = vi.spyOn(f.repo, "create").mockImplementation(((input: Parameters<typeof f.repo.create>[0]) =>
      input.humanIntent === "update" ? new Promise(() => {}) : create(input)) as typeof f.repo.create);
    try {
      expect(await f.poll()).toEqual({ http: 200, body: { status: "approved", token: BEARER }, leaksToken: true });
    } finally { hang.mockRestore(); }
  });

  it("a decision the requester never collected expires, and the person is told it was decided but not collected", async () => {
    const f = await fixture({ operator: "running" });
    expect((await f.decide(f.issued.code, "approve", OPERATOR)).status).toBe(200);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    try {
      expect(await f.poll()).toEqual({ http: 200, body: { status: "expired" }, leaksToken: false });
    } finally { now.mockRestore(); }
    expect(f.toPerson().map((row) => row.body)).toContain(`Pairing request ${f.issued.code} from requester@far-host: expired after it was approved by ${OPERATOR}, before the requesting machine collected the result. Nothing was handed over; the requester can run rig host pair again.`);
  });

  it("an operator the queue can't send answers to doesn't own the request, and the request says so", async () => {
    const f = await fixture({ kernel: false, operator: "running" });
    const item = f.repo.getById(f.ask)!;
    expect(item.sourceSession).toBe("host-pair@kernel");
    expect(item.body).toContain(`Answer with Approve or Deny. Typed words are kept but don't decide it, and you're asked again: ${OPERATOR} can't receive answers on this host.`);
  });

  it("when OpenRig can't read who owns the request, it's agent-free and says it couldn't tell", async () => {
    const f = await fixture({ operator: "running", ownershipUnreadable: true });
    const item = f.repo.getById(f.ask)!;
    expect(item.sourceSession).toBe("host-pair@kernel");
    expect(item.body).toContain("Answer with Approve or Deny. Typed words are kept but don't decide it, and you're asked again: OpenRig couldn't tell whether an agent reads answers on this host.");
    await f.answer({ decision: "yes" });
    await f.poll();
    expect(f.toPerson()[0]!.body).toContain("and they didn't deny anything: OpenRig couldn't tell whether an agent reads answers on this host, so please decide");
  });
});

describe("host pairing: expiry when the requester stopped waiting", () => {
  it("the request's ask closes as expired at its deadline, so a late Approve click there isn't accepted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const f = await fixture();
      const later = Date.now() + 11 * 60_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(later);
      try {
        vi.advanceTimersByTime(11 * 60_000);
        await vi.waitFor(() => expect(f.repo.getById(f.ask)?.state).toBe("canceled"));
        expect(f.repo.closingTransition(f.ask, "canceled")?.transitionNote).toBe(`pairing request ${f.issued.code} expired undecided`);
        const late = await f.answer({ questionId: "pair", optionId: "approve" });
        expect(late.status).not.toBe(200);
        expect(f.repo.getById(f.ask)).toMatchObject({ state: "canceled" });
        expect(f.repo.getById(f.ask)?.humanAnswers?.pair).toBeUndefined();
        expect(await f.poll()).toEqual({ http: 200, body: { status: "expired" }, leaksToken: false });
      } finally { now.mockRestore(); }
    } finally { vi.useRealTimers(); }
  });
});
