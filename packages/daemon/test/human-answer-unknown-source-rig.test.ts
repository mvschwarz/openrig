// A person answers an ask whose source names a rig this daemon doesn't know (`rig queue create --source` accepts any
// source). There's no queue here for the answer to go back to, but the person's answer still counts once: the ask closes
// with it, its history says the return couldn't go and why, and nothing asks the person again.
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";

const PERSON = "human-test@external";
const FAR = "asker@far-rig";
const NEAR = "asker@near-rig";
const registry = { ok: true as const, entities: [{ entityId: "human-test", class: "human" as const, displayName: "Test person", address: PERSON,
  connectorBindings: [], prefs: { deliveryClass: "A" as const } }] };

const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

function fixture() {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  let farKnown = false;
  // This daemon knows near-rig and the person, not far-rig.
  const repo = new QueueRepository(db, bus, { validateRig: (session) => farKnown || !session.endsWith("@far-rig"), loadHumanRegistry: () => registry,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never);
    c.set("missionControlWriteContract" as never, contract as never);
    await next();
  });
  app.route("/api/mission-control", missionControlRoutes());
  closes.push(() => db.close());
  const ask = async (source: string, questions?: Array<{ id: string; question: string; options: Array<{ id: string; label: string }> }>) =>
    (await repo.create({ sourceSession: source, destinationSession: PERSON, body: "Ship it?", summary: "Ship it?", humanIntent: "decision",
      ...(questions ? { humanQuestions: questions } : {}), nudge: false })).qitemId;
  // The person at the terminal, as the TUI and Steering send it.
  const answer = async (body: Record<string, string>) => {
    const response = await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "answer", actorSession: PERSON, authority: "primary-user", ...body }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const rowsTo = (destination: string) => (db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = ?").get(destination) as { n: number }).n;
  return { db, repo, ask, answer, rowsTo, learnFar: () => { farKnown = true; } };
}

describe("a person's answer to an ask whose source names an unknown rig", () => {
  it.each([PERSON, "human@host"])("keeps the committed answer when the source rig becomes known before %s retries", async (actorSession) => {
    const f = fixture();
    const qitemId = await f.ask(FAR);
    vi.spyOn(f.repo, "resolveDirectHumanReply").mockReturnValueOnce(false);
    await f.answer({ qitemId, decision: "First answer" });
    expect(f.repo.keptAnswer(qitemId)?.words).toBe("First answer");
    f.learnFar();
    const retry = await f.answer({ qitemId, actorSession, decision: "Replacement answer" });
    expect(f.rowsTo(FAR)).toBe(0);
    expect(f.repo.getById(qitemId)?.resolution).toContain("First answer");
    expect(JSON.stringify(retry.body)).toContain("wasn't recorded");
  });

  it("keeps a typed answer when the same person retries an interrupted close with a choice", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR, [{ id: "q1", question: "Ship it?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]);
    vi.spyOn(f.repo, "resolveDirectHumanReply").mockReturnValueOnce(false);
    await f.answer({ qitemId, decision: "First typed answer" });
    expect(f.repo.keptAnswer(qitemId)?.words).toBe("First typed answer");
    const retry = await f.answer({ qitemId, questionId: "q1", optionId: "no" });
    expect(f.repo.getById(qitemId)?.resolution).toContain("First typed answer");
    expect(f.repo.getById(qitemId)?.humanAnswers?.q1).toMatchObject({ kind: "typed-reply", text: "First typed answer" });
    expect(JSON.stringify(retry.body)).toContain("wasn't recorded");
  });

  it("doesn't let a direct same-person click replace a kept typed answer", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR, [{ id: "q1", question: "Ship it?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]);
    await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: FAR, body: "First typed answer", inboundReplyTo: qitemId });
    expect(f.repo.recordHumanAnswer({ qitemId, actorSession: PERSON, questionId: "q1", optionId: "no" }))
      .toMatchObject({ status: "not-applicable", reason: "answered", answeredBy: PERSON });
    expect(f.repo.getById(qitemId)).toMatchObject({ state: "done", resolution: "First typed answer" });
    expect(f.repo.getById(qitemId)?.humanAnswers?.q1).toMatchObject({ kind: "typed-reply", text: "First typed answer" });
  });

  // review-r2's reproductions (X-F1, X-F2 on 4d521168), with the kept answer read where it's now written.
  it("keeps the first typed answer when closing the ask is interrupted, and a retry with other words closes with it", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR);
    vi.spyOn(f.repo, "resolveDirectHumanReply").mockReturnValueOnce(false);
    const first = await f.answer({ qitemId, decision: "Yes, ship it" });
    expect(first.status).not.toBe(200);
    expect(JSON.stringify(first.body)).toContain(`Your answer is kept on ${qitemId}, but it didn't close`);
    // Saying it's kept is true: the words are on the ask before the close.
    expect(f.repo.listTransitions(qitemId).some((t) => (t.transitionNote ?? "").endsWith("\nYes, ship it"))).toBe(true);
    const retry = await f.answer({ qitemId, decision: "No, hold it" });
    expect(retry.status).toBe(200);
    expect(f.repo.getById(qitemId)?.resolution).toContain("Yes, ship it");
    expect(f.repo.getById(qitemId)?.resolution).not.toContain("No, hold it");
    expect((retry.body.answer as { message?: string }).message).toMatch(/^Your earlier answer is kept on .*, so this one wasn't recorded\./);
  });

  it("doesn't tell a second, different answer sent at the same time that it's kept", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR);
    const [first, second] = await Promise.all([
      f.answer({ qitemId, decision: "Yes, ship it" }),
      f.answer({ qitemId, decision: "No, hold it" }),
    ]);
    expect(first.status).toBe(200);
    expect(f.repo.getById(qitemId)?.resolution).toContain("Yes, ship it");
    expect(second.status === 200 && String((second.body.answer as { message?: string })?.message).startsWith("Your answer is kept")).toBe(false);
    expect(String((second.body.answer as { message?: string })?.message)).toMatch(/^Your earlier answer is kept/);
  });

  it("closes as the first person's answer when another person answers after it was kept", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR);
    await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: FAR, body: "Yes, ship it", inboundReplyTo: qitemId });
    await f.repo.createHumanAnswer({ sourceSession: "human@host", destinationSession: FAR, body: "No, hold it", inboundReplyTo: qitemId });
    expect(f.repo.listTransitions(qitemId).filter((t) => (t.transitionNote ?? "").includes("references an unknown rig")).map((t) => t.transitionNote))
      .toEqual([expect.stringMatching(new RegExp(`\\nanswered by: ${PERSON}\\nYes, ship it$`))]);
    // The second person's close settles the ask as the first's, and says theirs didn't settle it.
    expect(f.repo.resolveDirectHumanReply({ qitemId, actorSession: "human@host", decision: "No, hold it", primaryUser: true })).toBe(false);
    const closed = f.repo.getById(qitemId);
    expect(closed).toMatchObject({ state: "done", resolution: "Yes, ship it" });
    expect(f.repo.listTransitions(qitemId).at(-1)?.actorSession).toBe(PERSON);
  });

  it("closes with the kept words at Slack's seam even when the close carries other words", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR);
    await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: FAR, body: "Yes from Slack", inboundReplyTo: qitemId });
    expect(f.repo.resolveDirectHumanReply({ qitemId, actorSession: PERSON, decision: "Something else", typedReply: true })).toBe(true);
    expect(f.repo.getById(qitemId)).toMatchObject({ state: "done", resolution: "Yes from Slack" });
  });

  it("doesn't record another person's choice once an answer is kept on the ask", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR, [{ id: "q1", question: "Ship it?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]);
    await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: FAR, body: "Yes, ship it", inboundReplyTo: qitemId });
    expect(f.repo.recordHumanAnswer({ qitemId, actorSession: "human@host", questionId: "q1", optionId: "no", primaryUser: true }))
      .toMatchObject({ status: "not-applicable", reason: "answered", answeredBy: PERSON });
    // The first person's typed words sit under q1 (placed when their answer arrived); the second person's choice isn't recorded.
    expect(f.repo.getById(qitemId)?.humanAnswers?.q1).toMatchObject({ kind: "typed-reply", text: "Yes, ship it" });
  });

  it("closes the ask with their words, says on the ask why it couldn't go back, and doesn't ask them again", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR);

    const answered = await f.answer({ qitemId, decision: "Yes, ship it" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(f.repo.getById(qitemId)).toMatchObject({ state: "done", resolution: expect.stringContaining("Yes, ship it") });
    expect(f.rowsTo(FAR)).toBe(0);
    const notes = f.repo.listTransitions(qitemId).map((t) => t.transitionNote ?? "");
    expect(notes.filter((note) => note.includes(`${FAR} references an unknown rig`))).toHaveLength(1);
    expect(String((answered.body.answer as { message?: string } | undefined)?.message ?? "")).toMatch(new RegExp(`kept on ${qitemId}.*${FAR}`));

    // Answered once: a second answer is refused as already settled, and nothing else is recorded or sent.
    const again = await f.answer({ qitemId, decision: "Yes, ship it" });
    expect(again.status).not.toBe(200);
    expect(f.repo.getById(qitemId)?.resolution).toContain("Yes, ship it");
    expect(f.rowsTo(FAR)).toBe(0);
  });

  it("closes an ask with questions on the person's choice, keeping it on the ask", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR, [{ id: "ship", question: "Ship it?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }]);

    const answered = await f.answer({ qitemId, questionId: "ship", optionId: "yes" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(f.repo.getById(qitemId)).toMatchObject({ state: "done", humanAnswers: { ship: "yes" } });
    expect(f.rowsTo(FAR)).toBe(0);
  });

  it("keeps the answer on the ask at the seam Slack's reply uses too, then closes it once", async () => {
    const f = fixture();
    const qitemId = await f.ask(FAR);
    // Slack's typed reply: the answer row first (createHumanAnswer), then the ask's close (resolveDirectHumanReply).
    const created = await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: FAR, body: "Yes from Slack", inboundReplyTo: qitemId });
    expect(created.qitemId).toBe(qitemId);
    expect(f.rowsTo(FAR)).toBe(0);
    await f.repo.resolveDirectHumanReply({ qitemId, actorSession: PERSON, decision: "Yes from Slack", typedReply: true });
    expect(f.repo.getById(qitemId)).toMatchObject({ state: "done", resolution: expect.stringContaining("Yes from Slack") });
    // A retry of the same reply finds nothing new to record.
    await f.repo.createHumanAnswer({ sourceSession: PERSON, destinationSession: FAR, body: "Yes from Slack", inboundReplyTo: qitemId });
    expect(f.repo.listTransitions(qitemId).filter((t) => (t.transitionNote ?? "").includes("references an unknown rig"))).toHaveLength(1);
  });

  it("still returns the answer as its own row to a source this daemon knows", async () => {
    const f = fixture();
    const qitemId = await f.ask(NEAR);

    const answered = await f.answer({ qitemId, decision: "Yes" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(f.repo.getById(qitemId)?.state).toBe("done");
    expect(f.rowsTo(NEAR)).toBe(1);
    expect(f.repo.listTransitions(qitemId).some((t) => (t.transitionNote ?? "").includes("references an unknown rig"))).toBe(false);
  });
});
