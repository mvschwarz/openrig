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

  it("names the park an answer belongs to when the ask is parked on its person", async () => {
    const f = fixture(); const id = await f.ask();
    f.repo.update({ qitemId: id, actorSession: ASKER, state: "blocked", blockedOn: PERSON, summary: "Still need your call",
      evidenceRef: "/fixture/decision", transitionNote: "parked on its person" });
    const episode = f.repo.currentHumanRequiredEpisode(id)!.key;
    // As the Slack path records a parked ask's answer: under that park's question.
    const parked = await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: ASKER, body: "Go ahead\n\n---\nIn reply to: x",
      tags: ["human-answer"], inboundReplyTo: id, episodeKey: episode, nudge: false });
    expect((await f.read(id)).answers).toMatchObject([{ qitemId: parked.qitemId, by: PERSON, text: "Go ahead", episode }]);
  });

  it("counts only real answers: not correspondence, another reply after the answer, a reply to an update, or a row to someone else", async () => {
    const f = fixture();
    const legacy = (qitemId: string, replyTo: string, source: string, destination: string, at = new Date().toISOString()) => {
      f.db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,reply_to,tags) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(qitemId, at, at, source, destination, "pending", "routine", `Words in ${qitemId}`, replyTo, "[]");
    };
    // An older Slack reply from before the answer tag: the asked person's first one counts, and a second one doesn't.
    const old = await f.ask();
    legacy("qitem-slack-inbound-old-1", old, PERSON, ASKER);
    legacy("qitem-slack-inbound-old-2", old, PERSON, ASKER);
    // A reply from someone who can't answer the ask, and one sent to someone other than the asker.
    legacy("qitem-slack-inbound-agent", old, "owner@test-rig", ASKER);
    legacy("qitem-slack-inbound-elsewhere", old, PERSON, "owner@test-rig");
    expect((await f.read(old)).answers).toEqual([expect.objectContaining({ qitemId: "qitem-slack-inbound-old-1", episode: null })]);
    // Once a tagged answer exists, a later untagged reply on the ask is correspondence, not a second answer.
    const id = await f.ask();
    const done = await f.act({ verb: "answer", qitemId: id, decision: "Ship it" });
    legacy("qitem-slack-inbound-later", id, PERSON, ASKER);
    expect((await f.read(id)).answers).toEqual([expect.objectContaining({ qitemId: done.body.createdQitemId, text: "Ship it" })]);
    // Replies posted to an update's thread are never its answers.
    const update = (await f.repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "FYI", humanIntent: "update", nudge: false })).qitemId;
    legacy("qitem-slack-inbound-on-update", update, PERSON, ASKER);
    expect((await f.read(update)).answers).toEqual([]);
    // Closed with no answer row (answered in place), then a reply on its thread: correspondence, not its answer.
    const inPlace = await f.ask();
    f.repo.update({ qitemId: inPlace, actorSession: PERSON, state: "done", closureReason: "no-follow-on", transitionNote: "decided in place" });
    legacy("qitem-slack-inbound-after-close", inPlace, PERSON, ASKER, new Date(Date.now() + 60_000).toISOString());
    expect((await f.read(inPlace)).answers).toEqual([]);
    // Reopening the ask, or closing it again later, doesn't make that reply its answer.
    f.repo.update({ qitemId: inPlace, actorSession: ASKER, state: "pending", reopen: true, transitionNote: "reopened to ask again" });
    expect((await f.read(inPlace)).answers).toEqual([]);
    f.repo.update({ qitemId: inPlace, actorSession: PERSON, state: "done", closureReason: "no-follow-on", transitionNote: "decided again" });
    expect((await f.read(inPlace)).answers).toEqual([]);
  });

  it("at the same time as the first tagged answer, an older reply counts only when it was recorded first", async () => {
    const f = fixture();
    const at = new Date(Date.now() - 60_000).toISOString();
    const insert = (qitemId: string, askId: string, tags: string) => f.db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,reply_to,tags) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(qitemId, at, at, PERSON, ASKER, "pending", "routine", `Words in ${qitemId}`, askId, tags);
    const legacyFirst = await f.ask();
    insert("qitem-slack-inbound-tie-first", legacyFirst, "[]");
    insert("qitem-tagged-tie-second", legacyFirst, '["human-answer"]');
    expect((await f.read(legacyFirst)).answers.map((a: { qitemId: string }) => a.qitemId)).toEqual(["qitem-slack-inbound-tie-first", "qitem-tagged-tie-second"]);
    const taggedFirst = await f.ask();
    insert("qitem-tagged-tie-first", taggedFirst, '["human-answer"]');
    insert("qitem-slack-inbound-tie-second", taggedFirst, "[]");
    expect((await f.read(taggedFirst)).answers.map((a: { qitemId: string }) => a.qitemId)).toEqual(["qitem-tagged-tie-first"]);
  });

  it("keeps a real older Slack answer that came before a re-park's tagged answer, and lists both", async () => {
    const f = fixture(); const id = await f.ask();
    const at = new Date(Date.now() - 60_000).toISOString();
    f.db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,reply_to,tags) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("qitem-slack-inbound-before-tag", at, at, PERSON, ASKER, "pending", "routine", "Yes, ship it", id, "[]");
    // That answer closed the ask; later it was deliberately reopened onto its person, and answered again under the tag.
    f.repo.update({ qitemId: id, actorSession: ASKER, state: "done", closureReason: "no-follow-on", transitionNote: "answered in Slack" });
    f.repo.update({ qitemId: id, actorSession: ASKER, state: "blocked", blockedOn: PERSON, reopen: true, summary: "One more call",
      evidenceRef: "/fixture/decision", transitionNote: "reopened for a follow-up decision" });
    const episode = f.repo.currentHumanRequiredEpisode(id)!.key;
    const parked = await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: ASKER, body: "Also tell the team",
      tags: ["human-answer"], inboundReplyTo: id, episodeKey: episode, nudge: false });
    expect((await f.read(id)).answers).toMatchObject([
      { qitemId: "qitem-slack-inbound-before-tag", text: "Yes, ship it", episode: null },
      { qitemId: parked.qitemId, text: "Also tell the team", episode },
    ]);
  });

  it("finds an ask's replies through the reply_to index, not a scan of the queue", async () => {
    const f = fixture(); const id = await f.ask();
    const replyToQueries = new Set<string>();
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => {
      if (/reply_to = \?/.test(sql)) replyToQueries.add(sql);
      return prepare(sql);
    }) as typeof f.db.prepare;
    await f.read(id);
    await f.attention();
    f.db.prepare = prepare;
    // The answer lookup and the decision revision's reply lookups, as the reads actually ran them.
    expect(replyToQueries.size).toBeGreaterThanOrEqual(2);
    for (const sql of replyToQueries) {
      const params = (sql.match(/\?/g) ?? []).map(() => "x");
      const plan = (f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
      expect(plan, sql).toMatch(/SEARCH queue_items USING INDEX idx_queue_items_reply_to/);
    }
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
