import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
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

async function fixture(structured = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-03T04:05:06Z"));
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  closes.push(() => db.close());
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry });
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
    evidenceRef: "/fixture/evidence", humanIntent: "decision", ...(structured ? { humanQuestions: questions } : {}), nudge: false });
  const post = (path: string, actor: string, body: object) => app.request(path, { method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": actor }, body: JSON.stringify(body) });
  const relay = (fields: object = {}) => post(`/api/queue/${ask.qitemId}/relayed-answer`, relaySeat,
    { attributedTo: person, channel: "voice call", text: "  Not this week.\n", ...fields });
  const correct = (fields: object) => post("/api/mission-control/action", person, { actorSession: person, verb: "answer", qitemId: ask.qitemId, ...fields });
  return { db, repo, ask, relay, correct, post, history: () => repo.answersForAsk(ask.qitemId) };
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
