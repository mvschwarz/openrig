// team-operations.v1, needs-me.read: what needs the person, each request's revision and what it's about, and the answers
// returned to it, read by their links rather than by searching answer text. Real SQLite (all migrations), the real queue,
// the Mission Control answer path, the queue's single-row read and the attention read. Nothing native.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import { queueRoutes } from "../src/routes/queue.js";
import { attentionRoutes } from "../src/routes/attention.js";
import type { AttentionRead } from "../src/attention-surface.js";
import { teamOperationsCapabilities } from "../src/domain/team-operations.js";

const PERSON = "human-test@external", ASKER = "requester@test-rig";
const registry = { ok: true as const, entities: [{ entityId: "human-test", class: "human" as const, displayName: "human-test",
  address: PERSON, connectorBindings: [], prefs: { deliveryClass: "A" as const } }] };
const QUESTIONS = [
  { id: "q1", question: "Ship it?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  { id: "q2", question: "Tell the team?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
];

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

function fixture() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never);
    c.set("missionControlWriteContract" as never, contract as never);
    c.set("settingsStore" as never, { resolveOne: () => ({ value: "/nonexistent-needs-me-fixture" }) } as never);
    await next();
  });
  app.route("/api/mission-control", missionControlRoutes());
  app.route("/api/queue", queueRoutes());
  app.route("/api/attention", attentionRoutes());
  closes.push(() => db.close());
  const ask = async () => (await repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "Synthetic two-question ask",
    summary: "Ship?", humanIntent: "decision", humanQuestions: QUESTIONS, nudge: false })).qitemId;
  const read = async (id: string) => (await app.request(`/api/queue/${id}`)).json() as Promise<Record<string, any>>;
  const attention = async () => (await app.request("/api/attention")).json() as Promise<AttentionRead>;
  const act = async (body: Record<string, unknown>) => {
    const response = await app.request("/api/mission-control/action", { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": PERSON }, body: JSON.stringify({ actorSession: PERSON, ...body }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { db, bus, repo, ask, read, attention, act };
}

describe("needs-me.read: answers on the ask, by link", () => {
  it("an ask lists no answer until its set is returned, then the one answer row, with who, when and the words", async () => {
    const f = fixture(); const id = await f.ask();
    expect((await f.read(id)).answers).toEqual([]);
    expect(await f.act({ verb: "answer", qitemId: id, questionId: "q1", optionId: "yes" })).toMatchObject({ status: 200 });
    // A partial answer is recorded on the ask (humanAnswers); nothing has been returned to the asker yet.
    expect(await f.read(id)).toMatchObject({ humanAnswers: { q1: "yes" }, answers: [] });
    const done = await f.act({ verb: "answer", qitemId: id, questionId: "q2", optionId: "no" });
    expect(done).toMatchObject({ status: 200 });
    const { answers } = await f.read(id);
    expect(answers).toEqual([{ qitemId: done.body.createdQitemId, by: PERSON, at: expect.any(String),
      text: "Ship it?: Yes\nTell the team?: No", episode: null, recordedIdentity: expect.anything() }]);
    // The other direction is the answer row's own link.
    expect(await f.read(answers[0].qitemId)).toMatchObject({ replyTo: id, answers: [] });
  });

  it("an answer in the person's words reads back as those words, without the footer", async () => {
    const f = fixture(); const id = await f.ask();
    expect(await f.act({ verb: "answer", qitemId: id, decision: "Hold until Friday" })).toMatchObject({ status: 200 });
    expect((await f.read(id)).answers).toMatchObject([{ by: PERSON, text: "Hold until Friday" }]);
  });

  it("names the park an answer belongs to, keeps an older Slack reply, and leaves out an update posted to the thread", async () => {
    const f = fixture();
    const row = await f.repo.create({ sourceSession: ASKER, destinationSession: "owner@test-rig", body: "Work waiting on a person", nudge: false });
    f.repo.claim({ qitemId: row.qitemId, destinationSession: "owner@test-rig" });
    f.repo.update({ qitemId: row.qitemId, actorSession: "owner@test-rig", state: "blocked", blockedOn: PERSON });
    const episode = f.repo.currentHumanRequiredEpisode(row.qitemId);
    expect(episode).not.toBeNull();
    const parked = await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: "owner@test-rig",
      body: "Go ahead\n\n---\nIn reply to: x", inboundReplyTo: row.qitemId, episodeKey: episode!.key, nudge: false });
    const at = new Date().toISOString();
    f.db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,reply_to,tags) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("qitem-slack-inbound-legacy", at, at, PERSON, "owner@test-rig", "pending", "routine", "Older reply", row.qitemId, "[]");
    await f.repo.create({ sourceSession: "owner@test-rig", destinationSession: PERSON, body: "FYI, still going", humanIntent: "update",
      replyTo: row.qitemId, nudge: false });
    expect((await f.read(row.qitemId)).answers).toMatchObject([
      { qitemId: parked.qitemId, text: "Go ahead", episode: episode!.key },
      { qitemId: "qitem-slack-inbound-legacy", text: "Older reply", episode: null },
    ]);
  });
});

describe("needs-me.read: the attention snapshot", () => {
  it("gives each request its revision and what it's about, and a watermark read before the snapshot", async () => {
    const f = fixture(); const id = await f.ask();
    const waiting = await f.repo.create({ sourceSession: ASKER, destinationSession: "owner@test-rig", body: "Waits on the ask", nudge: false });
    f.repo.claim({ qitemId: waiting.qitemId, destinationSession: "owner@test-rig" });
    f.repo.update({ qitemId: waiting.qitemId, actorSession: "owner@test-rig", state: "blocked", blockedOn: id });
    const park = await f.repo.create({ sourceSession: ASKER, destinationSession: "owner@test-rig", body: "Parked on the person", nudge: false });
    f.repo.claim({ qitemId: park.qitemId, destinationSession: "owner@test-rig" });
    f.repo.update({ qitemId: park.qitemId, actorSession: "owner@test-rig", state: "blocked", blockedOn: PERSON });
    const before = f.bus.maxSeq();
    const snapshot = await f.attention();
    expect(snapshot.watermark).toBe(before);
    const item = (qitemId: string) => snapshot.items.find((i) => i.id === `queue:${qitemId}`);
    expect(item(id)).toMatchObject({ revision: (await f.read(id)).decisionRevision, about: [waiting.qitemId] });
    expect(item(park.qitemId)).toMatchObject({ revision: (await f.read(park.qitemId)).decisionRevision, about: [park.qitemId] });
  });
});

describe("team-operations.v1 capabilities", () => {
  it("names the contract, needs-me's capabilities and the build label separately", () => {
    expect(teamOperationsCapabilities({ semver: "9.9.9", commit: "abc", dirty: false, builtAt: null })).toEqual({
      contract: "team-operations.v1",
      capabilities: { "needs-me.read": "supported", "needs-me.answer": "not-supported", "needs-me.follow": "not-supported" },
      build: { semver: "9.9.9", commit: "abc" },
    });
    expect(teamOperationsCapabilities().build).toEqual({ semver: null, commit: null });
  });
});
