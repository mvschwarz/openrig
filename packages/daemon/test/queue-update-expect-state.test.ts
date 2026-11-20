// `rig queue update --expect-state <state>`: an optional compare-and-set a caller adds to its own write. The row's
// state is checked inside the update's transaction; on a mismatch nothing is written or triggered (no state, note,
// transition, event, wake or outbox entry), the repository raises qitem_state_changed with the current state, and the
// route answers 409. Callers that omit the option keep today's behaviour, including the race this option exists for.
// Real QueueRepository with its watchdog jobs and outbox, on the canonical schema; the route through queueRoutes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError, type QueueUpdateInput } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { queueRoutes } from "../src/routes/queue.js";

const DESTINATION = "dev-x@rig";
const CLOSER = "orch@rig";

describe("queue update with an expected state", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let app: Hono;
  let notified: unknown[];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    repo.attachWatchdogJobsRepository(new WatchdogJobsRepository(db));
    repo.attachOutbox(new OutboxHandler(db));
    app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); await next(); });
    app.route("/api/queue", queueRoutes());
    notified = [];
    bus.subscribe((event) => { notified.push(event); });
  });
  afterEach(() => db.close());

  /** The stored row, through the repository's public read; a missing row fails the test. */
  const row = (qitemId: string) => { const item = repo.getById(qitemId); if (!item) throw new Error(`row ${qitemId} not found`); return item; };
  const create = async () => (await repo.create({ sourceSession: CLOSER, destinationSession: DESTINATION, body: "work", nudge: false })).qitemId;
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  /** Everything an update can write or trigger for a row: the row itself, its transitions, events, wakes, jobs and outbox entries. */
  const footprint = (qitemId: string) => ({
    row: row(qitemId),
    transitions: count("SELECT count(*) n FROM queue_transitions WHERE qitem_id = ?", qitemId),
    events: count("SELECT count(*) n FROM events"),
    wakes: count("SELECT count(*) n FROM queue_transition_wakes"),
    watchdogJobs: count("SELECT count(*) n FROM watchdog_jobs"),
    outbox: count("SELECT count(*) n FROM outbox_entries"),
  });
  const refusal = (fn: () => unknown): QueueRepositoryError => {
    try { fn(); } catch (err) { if (err instanceof QueueRepositoryError) return err; throw err; }
    throw new Error("expected the update to be refused");
  };
  const post = (qitemId: string, body: Record<string, unknown>, session = CLOSER) => app.request(`/api/queue/${qitemId}/update`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": session }, body: JSON.stringify(body),
  });
  const close: Partial<QueueUpdateInput> = { state: "done", closureReason: "no-follow-on", transitionNote: "closing: handled elsewhere" };

  describe("in the queue repository", () => {
    it("the closer reads pending, the destination claims, and the conditional close writes nothing and leaves the claim in place", async () => {
      const id = await create();
      const read = row(id).state;
      expect(read).toBe("pending");
      repo.claim({ qitemId: id, destinationSession: DESTINATION });
      const before = footprint(id);
      notified.length = 0;

      const err = refusal(() => repo.update({ qitemId: id, actorSession: CLOSER, expectState: read, ...close }));

      expect(err.code).toBe("qitem_state_changed");
      expect(err.meta).toEqual({ expectedState: "pending", currentState: "in-progress" });
      expect(err.message).toContain("nothing was written");
      expect(footprint(id)).toEqual(before);
      expect(before.row).toMatchObject({ state: "in-progress", closureReason: null });
      expect(notified).toEqual([]);
    });

    it("without the option, the same sequence closes over the claim, as today", async () => {
      const id = await create();
      repo.claim({ qitemId: id, destinationSession: DESTINATION });
      repo.update({ qitemId: id, actorSession: CLOSER, ...close });
      expect(row(id)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    });

    it.each([
      ["pending", false],
      ["in-progress", true],
    ] as const)("a matching condition (%s) applies the update as usual", async (expectState, claimFirst) => {
      const id = await create();
      if (claimFirst) repo.claim({ qitemId: id, destinationSession: DESTINATION });
      const transitions = footprint(id).transitions;
      notified.length = 0;
      const item = repo.update({ qitemId: id, actorSession: CLOSER, expectState, ...close });
      expect(item).toMatchObject({ state: "done", closureReason: "no-follow-on" });
      expect(footprint(id).transitions).toBe(transitions + 1);
      // The control for the refusals' empty `notified`: an applied update does notify subscribers.
      expect(notified.length).toBeGreaterThan(0);
    });

    it("a matching condition on a note-only update appends the note and keeps the state", async () => {
      const id = await create();
      repo.claim({ qitemId: id, destinationSession: DESTINATION });
      const transitions = footprint(id).transitions;
      expect(repo.update({ qitemId: id, actorSession: CLOSER, expectState: "in-progress", transitionNote: "still yours" }).state).toBe("in-progress");
      expect(footprint(id).transitions).toBe(transitions + 1);
    });

    it.each([
      ["a note", { transitionNote: "progress note" }],
      ["a summary", { summary: "A new subject" }],
      ["a park with a timer wake", { state: "blocked", blockedOn: "external:ci", wakeAfterSeconds: 600, transitionNote: "continuation: check CI" }],
      ["a cancel", { state: "canceled", transitionNote: "not needed" }],
    ] as const)("on a mismatch, %s is not written and nothing is triggered", async (_label, change) => {
      const id = await create();
      repo.claim({ qitemId: id, destinationSession: DESTINATION });
      const before = footprint(id);
      notified.length = 0;

      const err = refusal(() => repo.update({ qitemId: id, actorSession: CLOSER, expectState: "pending", ...change } as QueueUpdateInput));

      expect(err.code).toBe("qitem_state_changed");
      expect(footprint(id)).toEqual(before);
      expect(notified).toEqual([]);
    });

    it("the same timer park with a matching condition does arm its wake", async () => {
      const id = await create();
      repo.claim({ qitemId: id, destinationSession: DESTINATION });
      const before = footprint(id);
      repo.update({ qitemId: id, actorSession: CLOSER, expectState: "in-progress", state: "blocked", blockedOn: "external:ci", wakeAfterSeconds: 600, transitionNote: "continuation: check CI" });
      expect(row(id).state).toBe("blocked");
      expect(footprint(id).wakes).toBeGreaterThan(before.wakes);
    });

    it("a closed row is checked like any other: expecting pending on a done row writes nothing", async () => {
      const id = await create();
      repo.update({ qitemId: id, actorSession: DESTINATION, ...close });
      const before = footprint(id);
      const err = refusal(() => repo.update({ qitemId: id, actorSession: CLOSER, expectState: "pending", transitionNote: "late note" }));
      expect(err.meta).toEqual({ expectedState: "pending", currentState: "done" });
      expect(footprint(id)).toEqual(before);
    });

    it("an expected state that is not a queue state is refused as invalid_state and writes nothing", async () => {
      const id = await create();
      const before = footprint(id);
      const err = refusal(() => repo.update({ qitemId: id, actorSession: CLOSER, expectState: "pendng" as never, ...close }));
      expect(err.code).toBe("invalid_state");
      expect(err.message).toContain("expectState=pendng");
      expect(footprint(id)).toEqual(before);
    });

    it("a null expected state is the same as no option", async () => {
      const id = await create();
      repo.claim({ qitemId: id, destinationSession: DESTINATION });
      repo.update({ qitemId: id, actorSession: CLOSER, expectState: null, ...close });
      expect(row(id).state).toBe("done");
    });
  });

  describe("through the update route", () => {
    it("the conditional close after a claim answers 409 qitem_state_changed with the current state and writes nothing", async () => {
      const id = await create();
      const read = (await (await app.request(`/api/queue/${id}`)).json() as { state: string }).state;
      expect(read).toBe("pending");
      repo.claim({ qitemId: id, destinationSession: DESTINATION });
      const before = footprint(id);
      notified.length = 0;

      const res = await post(id, { expectState: read, state: "done", closureReason: "no-follow-on", transitionNote: "closing: handled elsewhere" });

      expect(res.status).toBe(409);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ error: "qitem_state_changed", expectedState: "pending", currentState: "in-progress" });
      expect(body.message).toEqual(expect.stringContaining("nothing was written"));
      expect(footprint(id)).toEqual(before);
      expect(notified).toEqual([]);
    });

    it("a matching condition applies the close (200)", async () => {
      const id = await create();
      const res = await post(id, { expectState: "pending", state: "done", closureReason: "no-follow-on" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    });

    it("without the option, the close after a claim applies as today (200)", async () => {
      const id = await create();
      repo.claim({ qitemId: id, destinationSession: DESTINATION });
      const res = await post(id, { state: "done", closureReason: "no-follow-on" });
      expect(res.status).toBe(200);
      expect(row(id).state).toBe("done");
    });

    it("an expected state that is not a queue state answers 400 invalid_state", async () => {
      const id = await create();
      const res = await post(id, { expectState: "PENDING", state: "done", closureReason: "no-follow-on" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_state" });
      expect(row(id).state).toBe("pending");
    });
  });
});
