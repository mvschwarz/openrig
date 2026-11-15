// Route-level: the real Mission Control route and write contract, the real /api/events stream and a migrated SQLite.
// A click on an ask with questions, from Steering or from Slack, is one queue.answer_recorded event that says how much
// of the set is answered; a typed reply, which settles the ask, is not one.
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
import { eventsRoute } from "../src/routes/events.js";

const PERSON = "human-test@external", ASKER = "requester@test-rig";
const registry = { ok: true as const, entities: [{ entityId: "human-test", class: "human" as const, displayName: "Test person", address: PERSON,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "unused", role: "primary" as const, handle: "UTEST" }],
  prefs: { deliveryClass: "A" as const } }] };
const questions = [
  { id: "ship", question: "Ship it?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
  { id: "when", question: "When?", options: [{ id: "today", label: "Today" }, { id: "monday", label: "Monday" }] },
];

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
  vi.restoreAllMocks();
});

async function fixture() {
  const db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry,
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never);
    c.set("missionControlWriteContract" as never, contract as never);
    await next();
  });
  app.route("/api/mission-control", missionControlRoutes());
  app.route("/api/events", eventsRoute);
  closes.push(() => db.close());
  const ask = async () => (await repo.create({ sourceSession: ASKER, destinationSession: PERSON, body: "Two questions", summary: "Ship and when",
    humanIntent: "decision", humanQuestions: questions, evidenceRef: "/fixture/decision", nudge: false })).qitemId;
  // The person at the terminal, as the TUI sends it: no seat header, the primary user's authority.
  const steering = async (body: Record<string, string>) => {
    const response = await app.request("/api/mission-control/action", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "answer", actorSession: PERSON, authority: "primary-user", ...body }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  // What an app following /api/events from its watermark reads: the stored events after it.
  const eventsAfter = async (watermark: number) => {
    const response = await app.request("/api/events", { headers: { "Last-Event-ID": String(watermark) } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))]);
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>);
  };
  const recorded = async (watermark: number) => (await eventsAfter(watermark)).filter((event) => event.type === "queue.answer_recorded");
  return { bus, repo, ask, steering, recorded, eventsAfter };
}

describe("queue.answer_recorded: a person's click on an ask with questions", () => {
  it("one event per click that changes the answers, partial until the set is complete, from Steering and from Slack", async () => {
    const f = await fixture();
    const qitemId = await f.ask();

    let watermark = f.bus.maxSeq();
    const partial = await f.steering({ qitemId, questionId: "ship", optionId: "yes" });
    expect(partial.status).toBe(200);
    expect(f.repo.getById(qitemId)).toMatchObject({ state: "pending", humanAnswers: { ship: "yes" } });
    const [first, ...noMore] = await f.recorded(watermark);
    expect(noMore).toEqual([]);
    // Partial: it says so, and counts the set. Ids and counts only: the person's choice stays on the row.
    // The person at the terminal OpenRig can't name is recorded as such, as on the answer itself.
    expect(first).toMatchObject({ type: "queue.answer_recorded", qitemId, actorSession: "human@host", questionId: "ship",
      answered: 1, questions: 2, complete: false, summary: "Ship and when" });
    expect(JSON.stringify(first)).not.toMatch(/"yes"|Yes|optionId/);

    // The same click again changes nothing, so there's nothing to hear.
    watermark = f.bus.maxSeq();
    expect(f.repo.recordHumanAnswer({ qitemId, actorSession: PERSON, questionId: "ship", optionId: "yes" })).toMatchObject({ status: "recorded", complete: false });
    expect(await f.recorded(watermark)).toEqual([]);

    // A Slack-style click (the inbound router's call) completes the set.
    watermark = f.bus.maxSeq();
    expect(f.repo.recordHumanAnswer({ qitemId, actorSession: PERSON, questionId: "when", optionId: "monday" }))
      .toMatchObject({ status: "recorded", complete: true });
    expect(await f.recorded(watermark)).toEqual([expect.objectContaining({ qitemId, questionId: "when", answered: 2, questions: 2, complete: true })]);
  });

  it("a typed reply settles the ask through its own transitions and records no click event (the control)", async () => {
    const f = await fixture();
    const qitemId = await f.ask();

    const watermark = f.bus.maxSeq();
    const typed = await f.steering({ qitemId, decision: "Ship it on Monday" });
    expect(typed.status).toBe(200);
    expect(f.repo.getById(qitemId)?.state).toBe("done");
    const events = await f.eventsAfter(watermark);
    expect(events.some((event) => event.type === "queue.updated" && event.qitemId === qitemId)).toBe(true);
    expect(events.filter((event) => event.type === "queue.answer_recorded")).toEqual([]);
  });

  it("fails open: a click whose event can't be recorded is still on the ask, and its answer goes back", async () => {
    const f = await fixture();
    const qitemId = await f.ask();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emit = f.bus.emit.bind(f.bus);
    vi.spyOn(f.bus, "emit").mockImplementation((event) => {
      if (event.type === "queue.answer_recorded") throw new Error("events table unavailable");
      return emit(event);
    });

    const partial = await f.steering({ qitemId, questionId: "ship", optionId: "no" });
    expect(partial.status).toBe(200);
    const complete = await f.steering({ qitemId, questionId: "when", optionId: "today" });
    expect(complete.status).toBe(200);
    expect(f.repo.getById(qitemId)).toMatchObject({ state: "done", humanAnswers: { ship: "no", when: "today" } });
    expect(f.repo.list({ limit: 50 }).filter((item) => item.replyTo === qitemId)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${qitemId}'s recorded answer has no event`), expect.any(Error));
  });
});
