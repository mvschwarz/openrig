import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { eraseQueue } from "../src/domain/queue-erasure.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { queueRoutes } from "../src/routes/queue.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";

const person = "reader@external", asker = "author@rig", relaySeat = "reviewer@rig";
const registry = { ok: true as const, entities: [{ entityId: "reader", class: "human" as const, displayName: "Reader", address: person,
  connectorBindings: [], prefs: { deliveryClass: "A" as const } }] };
const questions = ["first", "second"].map(id => ({ id, question: id,
  options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }));
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); vi.useRealTimers(); });

async function fixture(structured = false, extraQuestion = false, sharedChannel?: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-03T04:05:06Z"));
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  closes.push(() => db.close());
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    sharedChannels: () => sharedChannel ? [{ address: sharedChannel }] : [] });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, repo as never);
    c.set("eventBus" as never, bus as never);
    c.set("missionControlWriteContract" as never, contract as never);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  app.route("/api/mission-control", missionControlRoutes());
  const ask = await repo.create({ sourceSession: asker, destinationSession: person, summary: "Synthetic ask", body: "What do you think?",
    evidenceRef: "/fixture/evidence", humanIntent: "decision", ...(structured ? {
      humanQuestions: extraQuestion ? [...questions, { ...questions[0], id: "third", question: "third" }] : questions,
    } : {}), nudge: false });
  const post = (path: string, actor: string, body: object) => app.request(path, { method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor }, body: JSON.stringify(body) });
  const relay = (fields: object = {}) => post(`/api/queue/${ask.qitemId}/relayed-answer`, relaySeat,
    { attributedTo: person, channel: "voice call", text: "  Not this week.\n", ...fields });
  const correct = (fields: object) => post("/api/mission-control/action", person, { actorSession: person, verb: "answer", qitemId: ask.qitemId, ...fields });
  return { db, bus, repo, contract, ask, relay, correct, post, history: () => repo.answersForAsk(ask.qitemId) };
}

it("returns an ordinary relay from a different seat with the verbatim words and honest provenance", async () => {
  const f = await fixture();
  expect((await f.post(`/api/queue/${f.ask.qitemId}/update`, relaySeat, { state: "done", closureReason: "relayed-answer" })).status).toBe(400);
  const permission = await f.repo.create({ sourceSession: asker, destinationSession: person, summary: "Permission", body: "May I proceed?",
    evidenceRef: "/fixture/evidence", humanIntent: "decision", tags: ["runner-permission"], nudge: false });
  expect((await f.post(`/api/queue/${permission.qitemId}/relayed-answer`, relaySeat,
    { attributedTo: person, channel: "voice call", text: "Yes" })).status).toBe(409);
  expect(f.repo.getById(permission.qitemId)?.state).toBe("pending");
  expect((await f.relay()).status).toBe(200);
  expect(f.repo.getById(f.ask.qitemId)).toMatchObject({ state: "done", closureReason: "relayed-answer", delegatedDecision: null });
  expect(f.history()).toEqual([expect.objectContaining({ kind: "relayed-answer", by: person, text: "  Not this week.\n",
    recordedBy: relaySeat, channel: "voice call", at: "2026-02-03T04:05:06.000Z", questionId: null })]);
  const [answer] = f.history();
  expect(answer).not.toHaveProperty("answeredAt");
  expect(f.repo.getById(answer?.qitemId ?? "")).toMatchObject({ sourceSession: relaySeat, destinationSession: asker, replyTo: f.ask.qitemId });
});

it("keeps other questions open and commits one return across failures and repeated submissions", async () => {
  const f = await fixture(true);
  const picked = { questionId: "second", optionId: "no", answeredAt: "2026-02-03T02:00:00Z" };
  expect((await f.relay({ ...picked, questionId: "unknown" })).status).toBe(409);
  expect((await f.relay(picked)).status).toBe(200);
  expect((await f.relay(picked)).status).toBe(200);
  expect((await f.relay({ ...picked, text: "Different words." })).status).toBe(409);
  expect(f.repo.getById(f.ask.qitemId)).toMatchObject({ state: "pending" });
  expect(f.history()).toEqual([expect.objectContaining({ questionId: "second", optionId: "no", answeredAt: picked.answeredAt, qitemId: null })]);
  const first = { questionId: "first", optionId: "yes", text: "Yes." };
  f.db.exec(`CREATE TRIGGER reject_relay_return BEFORE INSERT ON queue_items WHEN NEW.qitem_id LIKE 'qitem-human-answer-%'
    BEGIN SELECT RAISE(ABORT, 'injected return failure'); END`);
  expect((await f.relay(first)).status).toBe(500);
  expect(f.history()).toHaveLength(1);
  f.db.exec("DROP TRIGGER reject_relay_return");
  expect((await f.relay(first)).status).toBe(200);
  expect((await f.relay(first)).status).toBe(200);
  expect(f.history()).toHaveLength(2);
  expect(new Set(f.history().map(answer => answer.qitemId)).size).toBe(1);
  expect(f.repo.getById(f.ask.qitemId)?.closureReason).toBe("relayed-answer");
});

it("returns an exact-question direct correction without replacing the relay or reopening the ask", async () => {
  const f = await fixture(true);
  for (const question of questions) expect((await f.relay({ questionId: question.id, optionId: "no" })).status).toBe(200);
  const original = f.history();
  const change = { questionId: "second", optionId: "yes" };
  expect((await f.correct(change)).status).toBe(200);
  expect((await f.correct(change)).status).toBe(200);
  expect(f.history().slice(0, 2)).toEqual(original);
  expect(f.history().slice(2)).toEqual([expect.objectContaining({ kind: "direct-correction", by: person, questionId: "second", optionId: "yes" })]);
  expect(f.repo.getById(f.ask.qitemId)).toMatchObject({ state: "done", closureReason: "relayed-answer", humanAnswers: { second: "yes" } });
  const correction = f.history().at(-1);
  expect(f.repo.getById(correction?.qitemId ?? "")).toMatchObject({ sourceSession: person, destinationSession: asker, replyTo: f.ask.qitemId });
});

it("includes an attributed direct word-for-word answer in the mixed history", async () => {
  const f = await fixture(true);
  expect((await f.relay({ questionId: "first" })).status).toBe(200);
  vi.setSystemTime(new Date("2026-02-03T04:05:07Z"));
  expect((await f.correct({ questionId: "second", decision: "  My own words.\n" })).status).toBe(200);
  expect(f.history()).toEqual([
    expect.objectContaining({ kind: "relayed-answer", recordedBy: relaySeat }),
    expect.objectContaining({ kind: "direct-answer", questionId: "second", by: person, text: "  My own words.\n", at: "2026-02-03T04:05:07.000Z" }),
  ]);
});

it("returns an unplaced app reply verbatim without settling an ambiguous question", async () => {
  const f = await fixture(true, true);
  expect((await f.relay({ questionId: "first" })).status).toBe(200);
  const text = "  I need more time.\n";
  expect((await f.correct({ decision: text })).status).toBe(200);
  expect((await f.correct({ decision: text })).status).toBe(200);
  expect(f.repo.getById(f.ask.qitemId)).toMatchObject({ state: "pending", humanAnswers: null });
  const replies = f.history().filter(answer => "kind" in answer && answer.kind === "unplaced-reply");
  expect(replies).toEqual([expect.objectContaining({ text, by: person, questionId: null })]);
  expect(f.repo.getById(replies[0]?.qitemId ?? "")).toMatchObject({ replyTo: f.ask.qitemId, destinationSession: asker,
    body: expect.stringContaining(text) });
  const body = f.repo.getById(replies[0]?.qitemId ?? "")?.body;
  for (const question of ["first: first", "second: second", "third: third"]) expect(body).toContain(question);
});

it("keeps the actual person's earlier click in the history when the first relay is written", async () => {
  const f = await fixture(true);
  const by = "another-reader@external";
  f.repo.recordHumanAnswer({ qitemId: f.ask.qitemId, actorSession: by, primaryUser: true, questionId: "first", optionId: "yes" });
  vi.setSystemTime(new Date("2026-02-03T04:05:07Z"));
  expect((await f.relay({ questionId: "second" })).status).toBe(200);
  expect(f.history()).toEqual([
    expect.objectContaining({ kind: "direct-answer", questionId: "first", optionId: "yes", text: "Yes", by, at: "2026-02-03T04:05:06.000Z" }),
    expect.objectContaining({ kind: "relayed-answer", questionId: "second", recordedBy: relaySeat }),
  ]);
});

it("replays the final direct answer without accepting a different closed submission", async () => {
  const f = await fixture(true);
  expect((await f.relay({ questionId: "first" })).status).toBe(200);
  const input = { qitemId: f.ask.qitemId, actorSession: person, direct: { questionId: "second", optionId: "yes" } };
  const first = f.repo.writeRelayedAnswer(input);
  expect(f.repo.writeRelayedAnswer(input)).toEqual(first);
  expect(() => f.repo.writeRelayedAnswer({ ...input, direct: { ...input.direct, optionId: "no" } })).toThrow();
  expect(f.history()).toHaveLength(2);
});

it("no longer returns the journal or answer history after scrubbing the ask", async () => {
  const f = await fixture();
  expect((await f.relay()).status).toBe(200);
  expect((await f.correct({ decision: "  My correction.\n" })).status).toBe(200);
  expect(f.history()).toHaveLength(2);
  const report = await eraseQueue(f.db, { scope: { kind: "ids", entries: [{ qitemId: f.ask.qitemId, action: "scrub" }] },
    apply: true, nowIso: "2026-02-04T04:05:06.000Z" });
  expect(report.qitems).toMatchObject([{ qitemId: f.ask.qitemId, action: "scrub" }]);
  expect(f.repo.getById(f.ask.qitemId)).not.toHaveProperty("relayedAnswers");
  expect(f.history()).toEqual([]);
});

it.each(["checkpoint", "audit"])("rolls back a relayed app answer when %s fails", async phase => {
  const f = await fixture(true, true);
  expect((await f.relay({ questionId: "first" })).status).toBe(200);
  const before = f.repo.getById(f.ask.qitemId);
  const seq = f.bus.maxSeq();
  f.db.exec("CREATE TABLE fixture_receipt (id TEXT)");
  if (phase === "audit") f.db.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON mission_control_actions
    BEGIN SELECT RAISE(ABORT, 'audit failed'); END`);
  const result = () => f.contract.act({ verb: "answer", qitemId: f.ask.qitemId, actorSession: person, questionId: "second", optionId: "yes",
    appSubmission: { verify: () => {}, checkpoint: () => {
      f.db.prepare("INSERT INTO fixture_receipt VALUES (?)").run(f.ask.qitemId);
      if (phase === "checkpoint") throw new Error("checkpoint failed");
    }, finalize: () => ({ fixture: true }) } });
  await expect(result()).rejects.toThrow(`${phase} failed`);
  expect(f.repo.getById(f.ask.qitemId)).toEqual(before);
  expect(f.bus.maxSeq()).toBe(seq);
  expect(f.db.prepare("SELECT * FROM fixture_receipt").all()).toEqual([]);
  if (phase === "audit") f.db.exec("DROP TRIGGER reject_audit");
  else return;
  await expect(result()).resolves.toMatchObject({ answer: { outcome: "recorded", unanswered: ["third"] } });
});

it("refuses a relay attributed to the shared channel the ask names, but not a person on it", async () => {
  const channel = "front-desk@external";
  const f = await fixture(false, false, channel);
  const ask = await f.repo.create({ sourceSession: asker, destinationSession: channel, summary: "Channel ask", body: "Who is on tonight?",
    evidenceRef: "/fixture/evidence", humanIntent: "decision", nudge: false });
  const answer = (attributedTo: string) => f.post(`/api/queue/${ask.qitemId}/relayed-answer`, relaySeat,
    { attributedTo, channel: "slack", text: "Tonight." });
  expect(ask.destinationSession).toBe(channel);
  expect((await answer(channel)).status).toBe(409);
  expect(f.repo.getById(ask.qitemId)).toMatchObject({ state: "pending" });
  expect(f.repo.getById(ask.qitemId)?.relayedAnswers).toBeUndefined();
  // Who answered, not where: a person's answer through the same channel stays valid, attributed to them.
  expect((await answer(person)).status).toBe(200);
  expect(f.repo.getById(ask.qitemId)).toMatchObject({ state: "done", closureReason: "relayed-answer" });
  expect(f.repo.answersForAsk(ask.qitemId)).toEqual([
    expect.objectContaining({ kind: "relayed-answer", by: person, channel: "slack" })]);
});

it.each([
  ["the human-gate tier", { tier: "human-gate" }],
  ["a gate:human tag", { tags: ["gate:human"] }],
])(
"takes a relayed answer on an ordinary ask waiting on a person gate (%s)", async (_gate, fields) => {
  const f = await fixture();
  const gated = await f.repo.create({ sourceSession: asker, destinationSession: person, summary: "Approval", body: "Approve the plan?",
    evidenceRef: "/fixture/evidence", humanIntent: "decision", nudge: false, ...fields });
  expect((await f.post(`/api/queue/${gated.qitemId}/relayed-answer`, relaySeat,
    { attributedTo: person, channel: "voice call", text: "Approved in chat." })).status).toBe(200);
  expect(f.repo.getById(gated.qitemId)).toMatchObject({ state: "done", closureReason: "relayed-answer" });
  expect(f.repo.getById(gated.qitemId)?.humanAnswers).toBeNull();
});
