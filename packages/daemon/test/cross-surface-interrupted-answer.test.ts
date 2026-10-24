// Test-only: real inbound router, Mission Control HTTP route/contract and migrated SQLite.
// Transport records nudge attempts; it is not a model-consumption or Slack-network proof.
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
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { InboundRouter } from "../src/domain/gateway/slack/inbound.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";

const PERSON = "human-test@external", ASKER = "requester@test-rig";
const registry = { ok: true as const, entities: [{ entityId: "human-test", class: "human" as const, displayName: "Test person", address: PERSON,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "unused", role: "primary" as const, handle: "UTEST" }], prefs: { deliveryClass: "A" as const } }] };
const questions = [{ id: "choice", question: "Proceed?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }];

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
});

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cross-answer-"));
  const dbPath = join(home, "queue.sqlite");
  const db = new Database(dbPath); migrate(db, ALL_MIGRATIONS); const bus = new EventBus(db);
  const acknowledgements: string[] = [];
  const nudges: Array<{ session: string; text: string }> = [];
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    transport: { send: async (session, text) => { nudges.push({ session, text }); return { ok: true, verified: true, sent: true }; } } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const ask = await repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "Synthetic one-question ask", summary: "Proceed?",
    humanIntent: "decision", humanAlert: true, humanQuestions: questions, evidenceRef: "/fixture/decision", nudge: false });
  const router = new InboundRouter({ queue: makeQueuePorts(repo), destination: ASKER, seen: new SeenStore(join(home, "seen.jsonl")),
    deadLetter: new DeadLetterStore(join(home, "dead.jsonl")), resolveSender: () => ({ admitted: true, source: PERSON }),
    resolveRoute: () => ({ destination: ASKER, correlationQitemId: ask.qitemId }),
    acknowledgeAnswer: async ({ text }) => { acknowledgements.push(text); },
    recordHumanAnswer: input => repo.recordHumanAnswer(input), resolveHumanReply: makeHumanReplyResolver(repo, contract) });
  const app = new Hono(); app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never); c.set("missionControlWriteContract" as never, contract as never); await next(); });
  app.route("/api/mission-control", missionControlRoutes());
  const slack = () => router.routeAction({ type: "block_actions", user: { id: "UTEST" }, channel: { id: "CTEST" },
    container: { type: "message", message_ts: "1.1", channel_id: "CTEST" }, message: { ts: "1.1" },
    actions: [{ type: "button", block_id: "or-q:choice", action_id: "or-opt:yes", value: "yes", action_ts: "2.2" }] });
  const steering = async (input: Record<string, string> = { questionId: "choice", optionId: "yes" }) => {
    const response = await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": input.actorSession ?? PERSON },
      body: JSON.stringify({ verb: "answer", qitemId: ask.qitemId, actorSession: PERSON, ...input }) });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = () => {
    const replies = repo.list({ limit: 100 }).filter(item => item.replyTo === ask.qitemId);
    const resolved = repo.listTransitions(ask.qitemId).filter(t => t.ownerNotificationKind === "human-decision-resolved");
    const readback = new Database(dbPath, { readonly: true });
    let committedReplyCount: number;
    try { committedReplyCount = (readback.prepare("SELECT count(*) n FROM queue_items WHERE reply_to = ?").get(ask.qitemId) as { n: number }).n; }
    finally { readback.close(); }
    return { committedReplyCount, askState: repo.getById(ask.qitemId)?.state, answers: repo.getById(ask.qitemId)?.humanAnswers,
      replies: replies.map(item => ({ id: item.qitemId, replyTo: item.replyTo, source: item.sourceSession, destination: item.destinationSession, body: item.body })),
      replyCount: replies.length, resolutionCount: resolved.length, nudgeCount: nudges.filter(n => n.session === ASKER).length };
  };
  closes.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  return { repo, ask, slack, steering, snapshot, acknowledgements,
    typedSlack: (text: string, recoveredThreadReply = false) => router.route({ type: "message", user: "UTEST", channel: "CTEST", thread_ts: "1.1", ts: "3.3", text, recoveredThreadReply }) };
}

describe("completed human answer interrupted before ask close", () => {
  it.each(["slack", "steering"] as const)("%s first, then the other surface: one durable reply and one owner nudge", async first => {
    const f = await fixture();
    // This is the shared close seam called only AFTER the real first surface wrote its reply row.
    // The one-shot throw leaves the durable reply and complete answers, with the ask still pending.
    let interruptedAt: ReturnType<typeof f.snapshot> | null = null;
    const original = f.repo.resolveDirectHumanReply.bind(f.repo);
    vi.spyOn(f.repo, "resolveDirectHumanReply").mockImplementationOnce(input => {
      interruptedAt = f.snapshot(); throw new Error("fixture interruption after durable reply, before ask close");
    }).mockImplementation(original);
    await (first === "slack" ? f.slack() : f.steering());
    const afterFirst = f.snapshot();
    const secondResult = first === "slack" ? await f.steering() : await f.slack();
    if (first === "slack") expect(secondResult).toMatchObject({ status: 200, body: { answer: { message: expect.stringContaining("Already answered") } } });
    else expect(f.acknowledgements.at(-1)).toContain("Already answered");
    const afterSecond = f.snapshot();
    expect(interruptedAt).toMatchObject({ committedReplyCount: 1, askState: "pending", replyCount: 1, resolutionCount: 0, nudgeCount: 1 });
    expect(afterFirst).toMatchObject({ askState: "pending", replyCount: 1, resolutionCount: 0, nudgeCount: 1 });
    expect(afterSecond).toMatchObject({ committedReplyCount: 1, askState: "done", replyCount: 1, resolutionCount: 1, nudgeCount: 1 });
  });

  it("without interruption, an answer closes once and the other surface creates no second reply", async () => {
    const f = await fixture(); await f.slack(); await f.steering(); const result = f.snapshot();
    expect(result).toMatchObject({ askState: "done", replyCount: 1, resolutionCount: 1, nudgeCount: 1 });
  });

  it.each(["qitem-slack-answers-old", "qitem-human-answer-old", "qitem-slack-inbound-old"])("reuses %s with its original attribution and words", async qitemId => {
    const f = await fixture();
    const body = "Yes, but preserve this\n\n---\nquoted divider\n\n---\nSource: original surface";
    await f.repo.create({ qitemId, sourceSession: PERSON, destinationSession: ASKER, inboundReplyTo: f.ask.qitemId,
      body, tags: qitemId.includes("inbound") ? ["inbound"] : ["human-answer"] });
    const result = await f.steering({ decision: "Different words must not replace the committed answer" });
    expect(result).toMatchObject({ status: 200, body: { createdQitemId: qitemId, answer: { message: expect.stringContaining(qitemId) } } });
    expect(f.repo.getById(qitemId)?.body).toBe(body);
    expect(f.repo.getById(f.ask.qitemId)).toMatchObject({ state: "done", humanAnswers: {
      choice: { kind: "typed-reply", text: "Yes, but preserve this\n\n---\nquoted divider" } } });
    expect(f.snapshot()).toMatchObject({ committedReplyCount: 1, resolutionCount: 1, nudgeCount: 1 });
    expect((await f.steering({ decision: "retry" })).body).toMatchObject({ createdQitemId: qitemId });
    expect(f.snapshot().nudgeCount).toBe(1);
  });

  it.each(["slack", "steering", "button-after-typed"] as const)("keeps the first typed answer when %s returns before an interrupted close", async first => {
    const f = await fixture();
    vi.spyOn(f.repo, "resolveDirectHumanReply").mockReturnValueOnce(false);
    if (first === "slack") await f.typedSlack("Original words");
    else await f.steering({ decision: "Original words" });
    if (first === "slack") await f.steering({ decision: "Later words" });
    else if (first === "steering") await f.typedSlack("Later words");
    else await f.slack(); // A later button must not replace the earlier typed answer.
    expect(f.snapshot()).toMatchObject({ committedReplyCount: 1, replyCount: 1, resolutionCount: 1, nudgeCount: 1,
      answers: { choice: { kind: "typed-reply", text: "Original words" } } });
  });

  it("a wrong person cannot reuse the answer, and a recovered late message remains separate", async () => {
    const f = await fixture(); await f.steering();
    const wrong = await f.steering({ actorSession: "someone-else@external", decision: "retry" });
    expect(wrong).toMatchObject({ status: 400, body: { error: "answer_not_recorded" } });
    const late = await f.typedSlack("Recovered late context", true);
    expect(late).toMatchObject({ disposition: "accepted" });
    const replies = f.repo.list({ limit: 100 }).filter(row => row.replyTo === f.ask.qitemId);
    expect(replies).toHaveLength(2);
    expect(replies.find(row => row.body.startsWith("Recovered late context"))?.tags).not.toContain("human-answer");
    expect(f.snapshot().resolutionCount).toBe(1);
  });

  it("simultaneous surface attempts return the same answer and close once", async () => {
    const f = await fixture();
    const [steering, slack] = await Promise.all([f.steering(), f.slack()]);
    expect(steering.status).toBe(200);
    expect(slack.status).toBe("accepted");
    expect(f.snapshot()).toMatchObject({ committedReplyCount: 1, replyCount: 1, resolutionCount: 1, nudgeCount: 1 });
  });

  it("does not mistake a legacy recovered late message for the person's answer", async () => {
    const f = await fixture();
    await f.repo.create({ qitemId: "qitem-slack-inbound-recovered", sourceSession: PERSON, destinationSession: ASKER,
      inboundReplyTo: f.ask.qitemId, summary: "[Recovered after gap] Founder via Slack: earlier context",
      body: "Earlier context, not an answer", tags: ["inbound"], nudge: false });
    expect(f.repo.getHumanAnswer(f.ask.qitemId, PERSON)).toBeNull();
    expect(await f.steering()).toMatchObject({ status: 200, body: { answer: { outcome: "answered" } } });
    expect(f.snapshot()).toMatchObject({ committedReplyCount: 2, resolutionCount: 1, nudgeCount: 1 });
  });

});
