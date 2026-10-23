// `rig watchdog update <jobId>` (#1789): change a job's interval, spec or message in place.
// Real jobs, history, queue and engine repositories on a full test DB; the route is the one the CLI calls.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { contextUsageWatchdogSchema } from "../src/db/migrations/074_context_usage_watchdog.js";
import { contextUsageWatchdogGenerationSchema } from "../src/db/migrations/075_context_usage_watchdog_generation.js";
import { contextUsageWatchdogUnitsSchema } from "../src/db/migrations/124_context_usage_watchdog_units.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { isDue } from "../src/domain/watchdog-scheduler.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository, type WatchdogJob } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { watchdogRoutes } from "../src/routes/watchdog.js";
import type { PersistedEvent } from "../src/domain/types.js";

const OWNER = "worker@rig";
const REMINDER_SPEC = [
  "policy: periodic-reminder",
  "# kept: this comment and the context block stay when only the message changes",
  "target:",
  `  session: ${OWNER}`,
  "message: check the build",
  "context:",
  "  label: nightly",
  "",
].join("\n");

describe("watchdog update", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobs: WatchdogJobsRepository;
  let history: WatchdogHistoryLog;
  let queue: QueueRepository;
  let app: Hono;
  let events: PersistedEvent[];

  beforeEach(() => {
    db = createFullTestDb();
    // The shared fixture carries only the core watchdog table; this suite also needs the audit and context-usage ones.
    db.exec(watchdogHistorySchema.sql);
    migrate(db, [contextUsageWatchdogSchema, contextUsageWatchdogGenerationSchema, contextUsageWatchdogUnitsSchema]);
    bus = new EventBus(db);
    events = [];
    bus.subscribe((e) => events.push(e));
    jobs = new WatchdogJobsRepository(db);
    history = new WatchdogHistoryLog(db);
    queue = new QueueRepository(db, bus);
    queue.attachWatchdogJobsRepository(jobs);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("watchdogJobsRepo" as never, jobs);
      c.set("watchdogHistoryLog" as never, history);
      await next();
    });
    app.route("/api/watchdog", watchdogRoutes());
  });
  afterEach(() => db.close());

  function register(over: Partial<Parameters<WatchdogJobsRepository["register"]>[0]> = {}): WatchdogJob {
    return jobs.register({
      policy: "periodic-reminder", specYaml: REMINDER_SPEC, targetSession: OWNER,
      intervalSeconds: 3600, registeredBySession: "ops@kernel", ...over,
    });
  }
  async function update(jobId: string, body: Record<string, unknown>) {
    const res = await app.request(`/api/watchdog/${jobId}/update`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    // A route that doesn't exist answers with plain text, which must fail the assertion on status, not the parse.
    const text = await res.text();
    let parsed: Record<string, any>;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  }
  const agoIso = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  describe("what changes and what stays", () => {
    it("changes only the interval: same id, spec, registration, history and every other field", async () => {
      const job = register();
      jobs.recordEvaluation(job.jobId, agoIso(120), true);
      history.record({ jobId: job.jobId, evaluatedAt: agoIso(120), outcome: "sent", deliveryStatus: "ok" } as never);
      const before = jobs.getByIdOrThrow(job.jobId);
      const historyBefore = history.listForJob(job.jobId, 50);

      const res = await update(job.jobId, { intervalSeconds: 600 });

      expect(res.status).toBe(200);
      const after = jobs.getByIdOrThrow(job.jobId);
      expect(after).toEqual({ ...before, intervalSeconds: 600 });
      expect(res.body.job).toEqual(after);
      expect(jobs.listAll()).toHaveLength(1);
      expect(history.listForJob(job.jobId, 50)).toEqual(historyBefore);
      expect(events.some((e) => e.type === "watchdog.job_updated" && (e as { jobId?: string }).jobId === job.jobId)).toBe(true);
    });

    it("changes only the message: the rest of the spec, comments included, is kept", async () => {
      const job = register();
      const res = await update(job.jobId, { message: "check the build and the deploy" });

      expect(res.status).toBe(200);
      const after = jobs.getByIdOrThrow(job.jobId);
      expect(after.specYaml).toBe(REMINDER_SPEC.replace("message: check the build", "message: check the build and the deploy"));
      expect(after.intervalSeconds).toBe(3600);
    });

    it("replaces the spec with another valid one for the same policy", async () => {
      const job = register();
      const spec = ["policy: periodic-reminder", "target:", `  session: ${OWNER}`, "message: new words", ""].join("\n");
      const res = await update(job.jobId, { specYaml: spec });
      expect(res.status).toBe(200);
      expect(jobs.getByIdOrThrow(job.jobId).specYaml).toBe(spec);
    });

    it("changes the interval and the message together", async () => {
      const job = register();
      const res = await update(job.jobId, { intervalSeconds: 90, message: "both" });
      expect(res.status).toBe(200);
      expect(jobs.getByIdOrThrow(job.jobId)).toMatchObject({ intervalSeconds: 90 });
      expect(jobs.getByIdOrThrow(job.jobId).specYaml).toContain("message: both");
    });

    it("keeps a queue attachment on the same id", async () => {
      const job = register();
      const row = await queue.create({ sourceSession: "orch@rig", destinationSession: OWNER, body: "work", nudge: false });
      queue.update({
        qitemId: row.qitemId, actorSession: OWNER, state: "blocked", blockedOn: "external:ci",
        transitionNote: "continuation: check CI", wakeWatchdogId: job.jobId,
      } as never);
      expect(await update(job.jobId, { intervalSeconds: 120 })).toMatchObject({ status: 200 });
      expect(queue.getParkWakeStatus(row.qitemId)).toMatchObject({ kind: "watchdog", ref: job.jobId, live: true });
    });
  });

  describe("when a new interval takes effect", () => {
    it("is measured from the last recorded evaluation, which the update does not write", async () => {
      const job = register();
      const last = agoIso(30);
      jobs.recordEvaluation(job.jobId, last, false);

      const res = await update(job.jobId, { intervalSeconds: 600 });

      expect(res.body.nextDueAt).toBe(new Date(Date.parse(last) + 600_000).toISOString());
      expect(res.body.dueNow).toBe(false);
      expect(res.body.intervalEffect).toContain(last);
      const after = jobs.getByIdOrThrow(job.jobId);
      expect(after.lastEvaluationAt).toBe(last);
      expect(isDue(after, Date.now())).toBe(false);
    });

    it("never-evaluated reminder: measured from registration, and no evaluation is invented", async () => {
      const job = register();
      expect(job.lastEvaluationAt).toBeNull();

      const res = await update(job.jobId, { intervalSeconds: 600 });

      expect(res.body.nextDueAt).toBe(new Date(Date.parse(job.registeredAt) + 600_000).toISOString());
      expect(jobs.getByIdOrThrow(job.jobId)).toMatchObject({ lastEvaluationAt: null, lastFireAt: null });
    });

    it("an interval already elapsed since the last evaluation is due on the next pass", async () => {
      const job = register();
      jobs.recordEvaluation(job.jobId, agoIso(600), true);
      const fired = jobs.getByIdOrThrow(job.jobId).lastFireAt;

      const res = await update(job.jobId, { intervalSeconds: 60 });

      expect(res.body.dueNow).toBe(true);
      expect(isDue(jobs.getByIdOrThrow(job.jobId), Date.now())).toBe(true);
      expect(jobs.getByIdOrThrow(job.jobId).lastFireAt).toBe(fired);
    });

    it("a pending wake-now marker stays due", async () => {
      const job = register();
      jobs.updateSchedule(job.jobId, job.specYaml, job.intervalSeconds, new Date(0).toISOString());
      expect((await update(job.jobId, { intervalSeconds: 7200 })).status).toBe(200);
      expect(jobs.getByIdOrThrow(job.jobId).intervalSeconds).toBe(7200);
      expect(jobs.getByIdOrThrow(job.jobId).lastEvaluationAt).toBe(new Date(0).toISOString());
      expect(isDue(jobs.getByIdOrThrow(job.jobId), Date.now())).toBe(true);
    });
  });

  describe("a wait attached to the same id", () => {
    it("carries on at the new interval without replaying a message already delivered", async () => {
      const row = await queue.create({ sourceSession: "orch@rig", destinationSession: OWNER, body: "work", nudge: false });
      queue.update({
        qitemId: row.qitemId, actorSession: OWNER, state: "blocked", blockedOn: "external:vendor-window",
        transitionNote: "continuation: resume when the window opens", wakeAfterSeconds: 60, wakeMaxSeconds: 240,
      } as never);
      const jobId = queue.getParkWakeStatus(row.qitemId)!.ref;
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const engine = new WatchdogPolicyEngine({
        jobsRepo: jobs, historyLog: history, eventBus: bus,
        resolveQueueWait: (input) => queue.evaluateWaitReminder(input),
        resolvePreDeliveryTerminalReason: ({ jobId: id }) => queue.resolveWatchdogPreDeliveryTerminalReason(id),
        onWakeAttempt: ({ jobId: id, deliveryStatus }) => queue.recordWatchdogWakeAttempt(id, deliveryStatus),
        deliver: async (request) => { deliveries.push(request); return { status: "ok" }; },
      });

      // First wake is delivered; the wait backs off and records that it told its owner.
      expect((await engine.evaluate(jobs.getByIdOrThrow(jobId))).outcome.action).toBe("send");
      expect(deliveries).toHaveLength(1);
      const delivered = jobs.getByIdOrThrow(jobId);
      expect(delivered.intervalSeconds).toBe(120);

      const res = await update(jobId, { intervalSeconds: 900 });

      expect(res.status).toBe(200);
      const after = jobs.getByIdOrThrow(jobId);
      expect(after.jobId).toBe(jobId);
      expect(after.intervalSeconds).toBe(900);
      expect(after.lastEvaluationAt).toBe(delivered.lastEvaluationAt);
      expect(after.lastFireAt).toBe(delivered.lastFireAt);
      expect(JSON.parse(after.specYaml).context.queue_wait.notice)
        .toEqual(JSON.parse(delivered.specYaml).context.queue_wait.notice);
      expect(queue.getParkWakeStatus(row.qitemId)).toMatchObject({ ref: jobId, live: true });

      // Not due at the old cadence any more; when it is evaluated it does not re-send what was delivered.
      expect(isDue(after, Date.parse(delivered.lastEvaluationAt!) + 300_000)).toBe(false);
      expect(isDue(after, Date.parse(delivered.lastEvaluationAt!) + 900_000)).toBe(true);
      expect((await engine.evaluate(after)).outcome).toMatchObject({ action: "skip", reason: "queue_wait_already_presented" });
      expect(deliveries).toHaveLength(1);
      // Backoff carries on from the new interval: its ceiling moved up to it, so it neither falls back to the
      // wait's old 240s ceiling nor doubles past what the caller asked for.
      expect(jobs.getByIdOrThrow(jobId).intervalSeconds).toBe(900);
    });

    it("an update to the interval the wait already has still retunes its own settings", async () => {
      const row = await queue.create({ sourceSession: "orch@rig", destinationSession: OWNER, body: "work", nudge: false });
      queue.update({
        qitemId: row.qitemId, actorSession: OWNER, state: "blocked", blockedOn: "external:ci",
        transitionNote: "continuation: check CI", wakeAfterSeconds: 60, wakeMaxSeconds: 240,
      } as never);
      const jobId = queue.getParkWakeStatus(row.qitemId)!.ref;
      jobs.updateSchedule(jobId, jobs.getByIdOrThrow(jobId).specYaml, 120, jobs.getByIdOrThrow(jobId).lastEvaluationAt); // backed off

      const res = await update(jobId, { intervalSeconds: 120 });

      expect(res.status).toBe(200);
      expect(res.body.changed).toEqual(["intervalSeconds"]);
      expect(JSON.parse(jobs.getByIdOrThrow(jobId).specYaml).context.queue_wait).toMatchObject({ initialSeconds: 120, maxSeconds: 240 });
    });

    it("refuses a spec or message change: the queue owns that spec", async () => {
      const row = await queue.create({ sourceSession: "orch@rig", destinationSession: OWNER, body: "work", nudge: false });
      queue.update({
        qitemId: row.qitemId, actorSession: OWNER, state: "blocked", blockedOn: "external:ci",
        transitionNote: "continuation: check CI", wakeAfterSeconds: 60, wakeMaxSeconds: 240,
      } as never);
      const jobId = queue.getParkWakeStatus(row.qitemId)!.ref;
      const before = jobs.getByIdOrThrow(jobId);
      for (const body of [{ message: "new" }, { specYaml: "policy: periodic-reminder\nmessage: new\n" }]) {
        const res = await update(jobId, body);
        expect(res).toMatchObject({ status: 409, body: { error: "spec_not_updatable" } });
      }
      expect(jobs.getByIdOrThrow(jobId)).toEqual(before);
    });
  });

  describe("an update that lands while the job's delivery is in flight", () => {
    /** An engine whose first delivery stays open until the test releases it. */
    function heldEngine(deliveries: Array<{ targetSession: string; message: string }>, withQueue: boolean) {
      let release!: () => void;
      let held = true;
      const engine = new WatchdogPolicyEngine({
        jobsRepo: jobs, historyLog: history, eventBus: bus,
        ...(withQueue ? {
          resolveQueueWait: (input: { jobId: string }) => queue.evaluateWaitReminder(input),
          resolvePreDeliveryTerminalReason: ({ jobId }: { jobId: string }) => queue.resolveWatchdogPreDeliveryTerminalReason(jobId),
          onWakeAttempt: ({ jobId, deliveryStatus }: { jobId: string; deliveryStatus: string }) => queue.recordWatchdogWakeAttempt(jobId, deliveryStatus),
        } : {}),
        deliver: async (request) => {
          deliveries.push(request);
          if (held) { held = false; await new Promise<void>((r) => { release = r; }); }
          return { status: "ok" };
        },
      });
      return { engine, release: () => release() };
    }
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it("a wait is not told the same thing twice", async () => {
      const row = await queue.create({ sourceSession: "orch@rig", destinationSession: OWNER, body: "work", nudge: false });
      queue.update({
        qitemId: row.qitemId, actorSession: OWNER, state: "blocked", blockedOn: "external:vendor-window",
        transitionNote: "continuation: resume when the window opens", wakeAfterSeconds: 60, wakeMaxSeconds: 240,
      } as never);
      const jobId = queue.getParkWakeStatus(row.qitemId)!.ref;
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const { engine, release } = heldEngine(deliveries, true);

      const first = engine.evaluate(jobs.getByIdOrThrow(jobId));
      await settle();
      expect(deliveries).toHaveLength(1);
      expect((await update(jobId, { intervalSeconds: 30 })).status).toBe(200);
      release();
      await first;

      const after = jobs.getByIdOrThrow(jobId);
      expect(JSON.parse(after.specYaml).context.queue_wait.notice).toMatchObject({ deliveryStatus: "ok" });
      expect(after.lastFireAt).not.toBeNull();
      expect((await engine.evaluate(after)).outcome).toMatchObject({ action: "skip", reason: "queue_wait_already_presented" });
      expect(deliveries).toHaveLength(1);
    });

    it("a wait is not told the same thing twice after nine updates during one held send", async () => {
      const row = await queue.create({ sourceSession: "orch@rig", destinationSession: OWNER, body: "work", nudge: false });
      queue.update({
        qitemId: row.qitemId, actorSession: OWNER, state: "blocked", blockedOn: "external:vendor-window",
        transitionNote: "continuation: resume when the window opens", wakeAfterSeconds: 60, wakeMaxSeconds: 240,
      } as never);
      const jobId = queue.getParkWakeStatus(row.qitemId)!.ref;
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const { engine, release } = heldEngine(deliveries, true);

      const first = engine.evaluate(jobs.getByIdOrThrow(jobId));
      await settle();
      // More distinct updates than the replaced-schedule record keeps, while the first send is still in flight.
      for (const seconds of [30, 31, 32, 33, 34, 35, 36, 37, 38]) {
        expect((await update(jobId, { intervalSeconds: seconds })).status).toBe(200);
      }
      release();
      await first;

      const after = jobs.getByIdOrThrow(jobId);
      expect(JSON.parse(after.specYaml).context.queue_wait.notice).toMatchObject({ deliveryStatus: "ok" });
      expect(after.lastFireAt).not.toBeNull();
      expect((await engine.evaluate(after)).outcome).toMatchObject({ action: "skip", reason: "queue_wait_already_presented" });
      expect(deliveries).toHaveLength(1);
    });

    it("control: a real re-park after those updates still keeps the held send from counting for the new park", async () => {
      const row = await queue.create({ sourceSession: "orch@rig", destinationSession: OWNER, body: "work", nudge: false });
      const park = (seconds: number) => queue.update({
        qitemId: row.qitemId, actorSession: OWNER, state: "blocked", blockedOn: "external:vendor-window",
        transitionNote: "continuation: resume when the window opens", wakeAfterSeconds: seconds, wakeMaxSeconds: 240,
      } as never);
      park(60);
      const jobId = queue.getParkWakeStatus(row.qitemId)!.ref;
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const { engine, release } = heldEngine(deliveries, true);

      const first = engine.evaluate(jobs.getByIdOrThrow(jobId));
      await settle();
      for (const seconds of [30, 31, 32, 33, 34, 35, 36, 37, 38]) {
        expect((await update(jobId, { intervalSeconds: seconds })).status).toBe(200);
      }
      park(120); // a different park: a real reschedule, not an update in place
      const reparked = jobs.getByIdOrThrow(jobId);
      release();
      await first;

      const after = jobs.getByIdOrThrow(jobId);
      expect(after.lastFireAt).not.toBeNull();
      expect(after.lastEvaluationAt).toBe(reparked.lastEvaluationAt);
    });

    it("a wait is not told the same thing twice when the owner re-parks unchanged after the update", async () => {
      const row = await queue.create({ sourceSession: "orch@rig", destinationSession: OWNER, body: "work", nudge: false });
      const park = (seconds: number) => queue.update({
        qitemId: row.qitemId, actorSession: OWNER, state: "blocked", blockedOn: "external:vendor-window",
        transitionNote: "continuation: resume when the window opens", wakeAfterSeconds: seconds, wakeMaxSeconds: 240,
      } as never);
      park(60);
      const jobId = queue.getParkWakeStatus(row.qitemId)!.ref;
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const { engine, release } = heldEngine(deliveries, true);

      const first = engine.evaluate(jobs.getByIdOrThrow(jobId));
      await settle();
      expect((await update(jobId, { intervalSeconds: 30 })).status).toBe(200);
      const stored = jobs.getByIdOrThrow(jobId);
      park(30); // the same park again: it rewrites the schedule with the values already stored
      expect(jobs.getByIdOrThrow(jobId)).toMatchObject({ specYaml: stored.specYaml, intervalSeconds: 30, lastEvaluationAt: stored.lastEvaluationAt });
      release();
      await first;

      const after = jobs.getByIdOrThrow(jobId);
      expect(JSON.parse(after.specYaml).context.queue_wait.notice).toMatchObject({ deliveryStatus: "ok" });
      expect((await engine.evaluate(after)).outcome).toMatchObject({ action: "skip", reason: "queue_wait_already_presented" });
      expect(deliveries).toHaveLength(1);
    });

    it.each([60, 3600])("a plain reminder (registered at 600s) updated to %is is not due again at once", async (seconds) => {
      const job = register({ intervalSeconds: 600 });
      jobs.recordEvaluation(job.jobId, agoIso(4000), false);
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const { engine, release } = heldEngine(deliveries, false);

      const first = engine.evaluate(jobs.getByIdOrThrow(job.jobId));
      await settle();
      expect((await update(job.jobId, { intervalSeconds: seconds })).status).toBe(200);
      release();
      await first;

      const after = jobs.getByIdOrThrow(job.jobId);
      expect(deliveries).toHaveLength(1);
      expect(after.lastFireAt).not.toBeNull();
      expect(after.lastEvaluationAt).toBe(after.lastFireAt);
      expect(isDue(after, Date.now())).toBe(false);
    });
  });

  describe("refusals leave the job exactly as it was", () => {
    async function refused(jobId: string, body: Record<string, unknown>, status: number, error: string) {
      const before = jobs.listAll();
      const eventsBefore = events.length;
      const res = await update(jobId, body);
      expect(res).toMatchObject({ status, body: { error } });
      expect(jobs.listAll()).toEqual(before);
      expect(events.slice(eventsBefore).filter((e) => e.type === "watchdog.job_updated")).toEqual([]);
    }

    it("an unknown job", async () => {
      expect(await update("01UNKNOWN", { intervalSeconds: 5 })).toMatchObject({ status: 404, body: { error: "job_not_found" } });
    });

    it("a stopped job is not revived", async () => {
      const job = register();
      jobs.stop(job.jobId, "operator_stopped");
      await refused(job.jobId, { intervalSeconds: 5 }, 409, "job_stopped");
      expect(jobs.getByIdOrThrow(job.jobId).state).toBe("stopped");
    });

    it("a finished job is not revived", async () => {
      const job = register();
      jobs.markTerminal(job.jobId, "done");
      await refused(job.jobId, { message: "again" }, 409, "job_terminal");
      expect(jobs.getByIdOrThrow(job.jobId)).toMatchObject({ state: "terminal", terminalReason: "done" });
    });

    it("no field given", async () => {
      await refused(register().jobId, {}, 400, "nothing_to_update");
    });

    it.each([0, -5, 1.5, "60"])("an invalid interval %j", async (value) => {
      await refused(register().jobId, { intervalSeconds: value }, 400, "interval_invalid");
    });

    it.each([
      ["policy", "artifact-pool-ready"],
      ["targetSession", "other@rig"],
      ["registeredBySession", "someone@else"],
      ["targetGenerationUuid", "gen-1"],
      ["scanIntervalSeconds", 5],
    ])("a field that is not updatable: %s", async (field, value) => {
      await refused(register().jobId, { intervalSeconds: 600, [field]: value }, 400, "field_not_updatable");
    });

    it("a job the daemon registered for itself, which it would overwrite or replace", async () => {
      const job = register({ registeredBySession: "daemon@kernel" });
      await refused(job.jobId, { intervalSeconds: 600 }, 409, "policy_not_updatable");
      await refused(job.jobId, { message: "mine" }, 409, "policy_not_updatable");
    });

    it.each(["null", "[]", "\"text\""])("a body that is not an object: %s", async (raw) => {
      const before = jobs.listAll();
      const res = await app.request(`/api/watchdog/${register().jobId}/update`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: raw,
      });
      expect(res.status).toBe(400);
      expect(jobs.listAll()).toHaveLength(before.length + 1);
    });

    it("a job whose cadence is its scan interval", async () => {
      const job = register({ policy: "artifact-pool-ready", scanIntervalSeconds: 30,
        specYaml: "policy: artifact-pool-ready\ntarget: worker@rig\ncontext:\n  pools:\n    - path: /tmp/none\n" });
      await refused(job.jobId, { intervalSeconds: 600 }, 409, "interval_not_effective");
    });

    it("a daemon-owned timing policy", async () => {
      const job = register({ policy: "quiet-release", specYaml: "policy: quiet-release\ntarget: worker@rig\nmessage: x\n" });
      await refused(job.jobId, { intervalSeconds: 600 }, 409, "policy_not_updatable");
    });

    it("a spec invalid for the job's policy", async () => {
      const job = register();
      await refused(job.jobId, { specYaml: `policy: periodic-reminder\ntarget: ${OWNER}\n` }, 400, "spec_invalid");
      await refused(job.jobId, { specYaml: "- not\n- a mapping\n" }, 400, "spec_invalid");
      await refused(job.jobId, { message: "   " }, 400, "spec_invalid");
    });

    it("a spec for a different policy", async () => {
      const job = register();
      await refused(job.jobId, { specYaml: `policy: artifact-pool-ready\ntarget: ${OWNER}\nmessage: x\n` }, 400, "spec_invalid");
    });

    it("a spec that points at another target", async () => {
      const job = register();
      await refused(job.jobId, { specYaml: "policy: periodic-reminder\ntarget: other@rig\nmessage: hi\n" }, 409, "target_not_updatable");
    });

    it("a spec on a context-usage job, whose thresholds live in columns", async () => {
      const job = register({ policy: "context-usage-threshold", thresholdPercent: 70,
        specYaml: `policy: context-usage-threshold\ntarget:\n  session: ${OWNER}\ncontext:\n  threshold_percent: 70\n` });
      await refused(job.jobId, { specYaml: `policy: context-usage-threshold\ntarget:\n  session: ${OWNER}\ncontext:\n  threshold_percent: 10\n` },
        409, "spec_not_updatable");
      expect((await update(job.jobId, { message: "compact now", intervalSeconds: 300 })).status).toBe(200);
      expect(jobs.getByIdOrThrow(job.jobId)).toMatchObject({ thresholdPercent: 70, intervalSeconds: 300 });
    });
  });
});
