// A host pairing hands over this daemon's bearer token only on an explicit Approve: the person's choice on the
// request's question, or an agent seat's close that names it. A typed reply, "no", "yes" or anything else, is kept
// as the person's words and never approves.
// Test-only: real hosts routes, Mission Control HTTP route and write contract (Steering's and the TUI's answer path),
// the real Slack inbound router (a button and a thread reply) and migrated SQLite. No Slack network, no real token.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { hostsRoutes } from "../src/routes/hosts.js";
import { InboundRouter } from "../src/domain/gateway/slack/inbound.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";

const BEARER = "synthetic-pairing-bearer-fixture";
const PERSON = "pair-person@external", AGENT = "dev-agent@fixture-rig";
const registry = { ok: true as const, entities: [{ entityId: "pair-person", class: "human" as const, displayName: "Pairing person", address: PERSON,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "unused", role: "primary" as const, handle: "UPAIR" }], prefs: { deliveryClass: "A" as const } }] };

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pair-explicit-"));
  const db = new Database(join(home, "queue.sqlite")); migrate(db, ALL_MIGRATIONS); const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never); c.set("missionControlWriteContract" as never, contract as never); await next(); });
  app.route("/api/mission-control", missionControlRoutes());
  app.route("/api/hosts", hostsRoutes({ bearerToken: BEARER, humanRegistry: () => registry }));
  closes.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const issued = await (await app.request("/api/hosts/pair-request", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requester: "requester@far-host" }) })).json() as { pairId: string; code: string; approvalQitemId: string };
  const ask = issued.approvalQitemId;
  const router = new InboundRouter({ queue: makeQueuePorts(repo), destination: "host-pair@kernel", seen: new SeenStore(join(home, "seen.jsonl")),
    deadLetter: new DeadLetterStore(join(home, "dead.jsonl")), resolveSender: () => ({ admitted: true, source: PERSON }),
    resolveRoute: () => ({ destination: "host-pair@kernel", correlationQitemId: ask }),
    acknowledgeAnswer: async () => {}, recordHumanAnswer: input => repo.recordHumanAnswer(input),
    resolveHumanReply: makeHumanReplyResolver(repo, contract) });

  /** The requester's poll: the status, and whether the response carries the token anywhere. */
  const poll = async () => {
    const res = await app.request(`/api/hosts/pair-request/${issued.pairId}`);
    const text = await res.text();
    return { http: res.status, body: res.status === 200 ? JSON.parse(text) as { status: string; token?: string } : null, leaksToken: text.includes(BEARER) };
  };
  /** Steering's question card and the TUI's acts both post Mission Control's answer verb; the TUI's carry the primary user. */
  const answer = async (input: Record<string, unknown>) => {
    const res = await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": PERSON },
      body: JSON.stringify({ verb: "answer", qitemId: ask, actorSession: PERSON, ...input }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const slackButton = (optionId: string) => router.routeAction({ type: "block_actions", user: { id: "UPAIR" }, channel: { id: "CPAIR" },
    container: { type: "message", message_ts: "1.1", channel_id: "CPAIR" }, message: { ts: "1.1" },
    actions: [{ type: "button", block_id: "or-q:pair", action_id: `or-opt:${optionId}`, value: optionId, action_ts: "2.2" }] });
  const slackThreadReply = (text: string) => router.route({ type: "message", user: "UPAIR", channel: "CPAIR", thread_ts: "1.1", ts: "3.3", text });
  return { repo, contract, ask, issued, poll, answer, slackButton, slackThreadReply };
}

describe("host pairing: only an explicit Approve hands over the token (r9)", () => {
  it("the request carries one question, Approve or Deny, and the person is told a typed reply doesn't approve", async () => {
    const f = await fixture();
    const item = f.repo.getById(f.ask)!;
    expect(item.humanQuestions).toEqual([{ id: "pair", question: `Pair requester@far-host (code ${f.issued.code}) with this host?`, options: [
      { id: "approve", label: "Approve: hand this host's bearer token to the requester" }, { id: "deny", label: "Deny" }] }]);
    expect(item.body).toContain(`A typed reply, even "yes", is kept as your words and doesn't approve`);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "pending", code: f.issued.code }, leaksToken: false });
  });

  // Steering's and the TUI's "reply <text>": the person's words close the request and are kept under its question.
  it.each(["no", "yes", "who is this?"])("a typed reply %j (Steering or the TUI) closes the request denied, no token, words kept", async (words) => {
    const f = await fixture();
    expect((await f.answer({ decision: words })).status).toBe(200);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
    expect((await f.poll()).http).toBe(404);
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", closureReason: "no-follow-on",
      humanAnswers: { pair: { kind: "typed-reply", text: words } } });
  });

  it.each(["yes", "no"])("a typed Slack thread reply %j closes the request denied, no token, words kept", async (words) => {
    const f = await fixture();
    await f.slackThreadReply(words);
    expect(await f.poll()).toEqual({ http: 200, body: { status: "denied" }, leaksToken: false });
    expect(f.repo.getById(f.ask)).toMatchObject({ state: "done", humanAnswers: { pair: { kind: "typed-reply", text: words } } });
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
