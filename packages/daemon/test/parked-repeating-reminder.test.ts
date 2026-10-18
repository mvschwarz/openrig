// A row parked on its owner's own active repeating reminder is waiting, not stranded: the reminder keeps waking that
// owner. After the reminder's first fire the wake status reads it spent, so parked diagnosis used to count the row
// unhealthy and an idle owner read parked, drawing an extra parked-owner wake every few minutes. Parked diagnosis now
// counts such a row healthy only while every condition holds; anything it can't establish reads as before.
// Real queue, watchdog and history repositories on a full test DB; the fires are recorded as the engine records them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";

const SEAT = "dev-impl@seat-rig";
const OTHER = "dev-qa@seat-rig";

describe("parked diagnosis for a row its owner's own repeating reminder serves", () => {
  let db: Database.Database;
  let queue: QueueRepository;
  let jobs: WatchdogJobsRepository;
  let history: WatchdogHistoryLog;
  let seatNodeId: string;
  let clock = 0;

  beforeEach(() => {
    db = createFullTestDb();
    db.exec(watchdogHistorySchema.sql); // the full test DB doesn't include the engine's audit table
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig("seat-rig");
    for (const [logicalId, session] of [["dev.impl", SEAT], ["dev.qa", OTHER]] as const) {
      const node = rigRepo.addNode(rig.id, logicalId, { runtime: "codex" });
      sessions.updateStatus(sessions.registerSession(node.id, session).id, "running");
      if (session === SEAT) seatNodeId = node.id;
    }
    const gen = (session: string) => sessions.currentOccupantGenerationForSession(session);
    queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, resolveOccupantGeneration: gen });
    jobs = new WatchdogJobsRepository(db, undefined, gen);
    queue.attachWatchdogJobsRepository(jobs);
    history = new WatchdogHistoryLog(db);
    clock = 0;
  });
  afterEach(() => db.close());

  function reminder(target = SEAT): string {
    return jobs.register({
      policy: "periodic-reminder",
      specYaml: ["policy: periodic-reminder", "target:", `  session: ${JSON.stringify(target)}`, "message: \"check your rows\"", ""].join("\n"),
      targetSession: target, intervalSeconds: 300, registeredBySession: target,
    } as never).jobId;
  }
  async function row(): Promise<string> {
    return (await queue.create({ sourceSession: "orch-lead@seat-rig", destinationSession: SEAT, body: "work" } as never)).qitemId;
  }
  function park(qitemId: string, wake: { watchdogId?: string; afterSeconds?: number; maxSeconds?: number }) {
    queue.update({
      qitemId, actorSession: SEAT, state: "blocked", blockedOn: "external:ci", transitionNote: "continuation: check CI",
      ...(wake.watchdogId ? { wakeWatchdogId: wake.watchdogId } : {}),
      ...(wake.afterSeconds ? { wakeAfterSeconds: wake.afterSeconds } : {}),
      ...(wake.maxSeconds ? { wakeMaxSeconds: wake.maxSeconds } : {}),
    } as never);
  }
  /** One evaluation of the job, as the engine records it: the audit row, then (for a delivery attempt) the row's fire. */
  /** `deliveredTo`: the session the engine delivered to (its spec's target), recorded as history's delivery target;
   *  the owner unless a test says otherwise, `null` for an unrecorded one. */
  function fire(jobId: string, delivery: "ok" | "failed" | "retained" | { skipped: string }, opts: { history?: boolean; deliveredTo?: string | null } = {}) {
    const evaluatedAt = new Date(Date.UTC(2026, 9, 18, 3, 0, clock++)).toISOString();
    if (opts.history !== false) {
      history.record(typeof delivery === "object"
        ? { jobId, evaluatedAt, outcome: "skipped", skipReason: delivery.skipped }
        : { jobId, evaluatedAt, outcome: delivery === "retained" ? "skipped" : "sent", deliveryStatus: delivery,
          deliveryTargetSession: opts.deliveredTo === undefined ? SEAT : opts.deliveredTo,
          ...(delivery === "retained" ? { skipReason: "typing_guard_retained" } : {}) } as never);
    }
    if (typeof delivery !== "object") queue.recordWatchdogWakeAttempt(jobId, delivery);
  }
  const wakeRef = (qitemId: string) => (queue.getParkWakeStatus(qitemId) as { ref: string }).ref;
  function diagnose() {
    const d = diagnoseSeatParked({
      getSeatState: () => ({ activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "test" }) as never,
      listOpenObligations: (destinationSession, limit) => ({
        rows: queue.list({ destinationSession, state: ["pending", "in-progress", "blocked"], limit })
          .map((r) => ({ qitemId: r.qitemId, state: r.state as "pending" | "in-progress" | "blocked", summary: r.summary ?? null })),
        limit,
      }),
      getParkWake: (qitemId) => queue.getParkWakeStatus(qitemId),
      // As startup.ts and the activity route wire it; on a build without the method this reads false.
      servedByOwnReminder: (qitemId) => (queue as unknown as { parkWakeServedByOwnReminder?: (id: string) => boolean })
        .parkWakeServedByOwnReminder?.(qitemId) === true,
    }, { seatNodeId, sessionName: SEAT });
    return { parked: d.parked, healthy: d.obligations.held[0]?.healthy, held: d.obligations.held[0], reason: d.reason };
  }

  describe("now healthy (the changed result)", () => {
    it("S3: the owner re-parks onto the same reminder, which fires again", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok");
      park(q, { watchdogId: job });
      fire(job, "ok");
      expect(diagnose()).toMatchObject({ parked: false, healthy: true, held: { servedByOwnReminder: true },
        reason: "stopped with 1 HELD row(s), all healthy: 0 with a live wake, 1 served by its own repeating reminder — not parked" });
      // The wake status itself is unchanged for every other reader.
      expect(queue.getParkWakeStatus(q)).toMatchObject({ phase: "fired", live: false, unconsumed: true });
    });

    it("the reminder keeps firing with no re-park", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok");
      fire(job, "ok");
      expect(diagnose()).toMatchObject({ parked: false, healthy: true, held: { servedByOwnReminder: true } });
    });
  });

  it("names the served rows apart from the rows with a live wake", async () => {
    const served = await row();
    const job = reminder();
    park(served, { watchdogId: job });
    fire(job, "ok");
    const live = await row();
    park(live, { watchdogId: reminder() });
    expect(diagnose().reason).toBe("stopped with 2 HELD row(s), all healthy: 1 with a live wake, 1 served by its own repeating reminder — not parked");
  });

  describe("unchanged: parked diagnosis reads as before", () => {
    it("before the reminder's first fire, the row is already healthy, with the existing reason", async () => {
      const q = await row();
      park(q, { watchdogId: reminder() });
      const d = diagnose();
      expect(d).toMatchObject({ parked: false, healthy: true, reason: "stopped with 1 HELD row(s), all healthy with a live wake — not parked" });
      expect(d.held).not.toHaveProperty("servedByOwnReminder");
    });

    it.each([
      ["the job was stopped", (job: string) => { jobs.stop(job); }],
      ["the job was deleted", (job: string) => { db.prepare("DELETE FROM watchdog_history WHERE job_id = ?").run(job); db.prepare("DELETE FROM watchdog_jobs WHERE job_id = ?").run(job); }],
      ["the row's destination changed after the park", () => { db.prepare("UPDATE queue_items SET destination_session = ?").run(OTHER); }],
      ["the latest delivery failed after an earlier success", (job: string) => { fire(job, "failed"); }],
      ["the latest evaluation was refused after an earlier success", (job: string) => { fire(job, { skipped: "target_generation_mismatch" }); }],
      // Root's conservative side: a benign skip (a busy target) is also not proof the reminder reached the owner.
      ["the latest evaluation was a benign skip after an earlier success", (job: string) => { fire(job, { skipped: "target_busy" }); }],
    ])("stranded when %s", async (_label, after) => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok");
      after(job);
      const d = diagnose();
      // On a changed destination the row leaves this seat's obligations; otherwise it stays unhealthy.
      if (d.held) expect(d).toMatchObject({ parked: true, healthy: false });
      else expect(d.parked).toBe(false);
    });

    it("stranded when the reminder's target changed to another seat after the park (a park on another seat's job is refused)", async () => {
      const q = await row();
      expect(() => park(q, { watchdogId: reminder(OTHER) })).toThrow(/targets dev-qa@seat-rig, not parked owner/);
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok");
      db.prepare("UPDATE watchdog_jobs SET target_session = ? WHERE job_id = ?").run(OTHER, job);
      expect(diagnose()).toMatchObject({ parked: true, healthy: false });
    });

    it("stranded when the attached active job isn't a periodic reminder", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok");
      // Any other policy (here an idle gate) doesn't repeat on its own cadence; only a periodic reminder is exempt.
      db.prepare("UPDATE watchdog_jobs SET policy = 'idle-gate-qitem' WHERE job_id = ?").run(job);
      expect(diagnose()).toMatchObject({ parked: true, healthy: false });
    });

    it("stranded when the row left blocked and was blocked again with no wake of its own (the earlier park's reminder doesn't serve it)", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok");
      queue.update({ qitemId: q, actorSession: SEAT, state: "in-progress", transitionNote: "resumed" } as never);
      queue.update({ qitemId: q, actorSession: SEAT, state: "blocked", blockedOn: "external:vendor", transitionNote: "waiting on the vendor" } as never);
      fire(job, "ok");
      const d = diagnose();
      expect(d).toMatchObject({ parked: true, healthy: false });
      expect(d.held).not.toHaveProperty("servedByOwnReminder");
    });

    it("stranded when the reminder delivered to another seat than the row's owner (its spec names another target)", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok", { deliveredTo: OTHER });
      expect(diagnose()).toMatchObject({ parked: true, healthy: false });
    });

    it("stranded when the latest delivery's target isn't recorded", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok", { deliveredTo: null });
      expect(diagnose()).toMatchObject({ parked: true, healthy: false });
    });

    it("stranded when the delivery evidence is missing (a fire with no audit row)", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok", { history: false });
      expect(diagnose()).toMatchObject({ parked: true, healthy: false });
    });

    it("stranded when a one-shot park timer has fired", async () => {
      const q = await row();
      park(q, { afterSeconds: 600 });
      fire(wakeRef(q), "ok");
      expect(diagnose()).toMatchObject({ parked: true, healthy: false });
    });

    it("healthy when the first attempt since the park was retained by the typing guard, as before", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "retained");
      const d = diagnose();
      expect(d).toMatchObject({ parked: false, healthy: true });
      expect(d.held).not.toHaveProperty("servedByOwnReminder");
    });

    it("stranded when the latest attempt was retained after an earlier success, as before", async () => {
      const q = await row();
      const job = reminder();
      park(q, { watchdogId: job });
      fire(job, "ok");
      fire(job, "retained");
      expect(diagnose()).toMatchObject({ parked: true, healthy: false });
    });

    it("healthy for a repeating queue-wait timer, through its own recovery owner, as before", async () => {
      const q = await row();
      park(q, { afterSeconds: 600, maxSeconds: 3600 });
      fire(wakeRef(q), "ok");
      const d = diagnose();
      expect(d).toMatchObject({ parked: false, healthy: true, held: { wake: { recoveryOwner: "queue-stuck-sweep" } } });
      expect(d.held).not.toHaveProperty("servedByOwnReminder");
    });

    it("stranded when a blocked row has no wake at all", async () => {
      const q = await row();
      db.prepare("UPDATE queue_items SET state = 'blocked' WHERE qitem_id = ?").run(q);
      expect(diagnose()).toMatchObject({ parked: true, healthy: false, held: { wake: null } });
    });
  });
});
