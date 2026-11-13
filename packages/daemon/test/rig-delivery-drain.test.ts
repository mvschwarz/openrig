import { describe, it, expect, vi } from "vitest";
import { createTestApp } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigRepository } from "../src/domain/rig-repository.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { nextDueAt } from "../src/domain/watchdog-due.js";
import { WAKE_INTENT_PREFIX, OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { RigDeliveryDrainStore } from "../src/domain/rig-delivery-drain.js";

function createDrainTestDb() { const db = createDb(); migrate(db, ALL_MIGRATIONS); return db; }
const jsonPost = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });


describe("per-rig delivery drain control", () => {
  it("exposes the explicit per-rig control without claiming native-start deferral", async () => {
    const db = createDrainTestDb();
    try {
      const { app, rigRepo } = createTestApp(db);
      const rig = rigRepo.createRig("drain-one");
      const response = await app.request(`/api/rigs/${rig.id}/delivery-drain`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ active: false, nativeStartsDeferred: false });
    } finally { db.close(); }
  });
  it("keeps BEGIN idempotent and releases only once on explicit END", async () => {
    const db = createDrainTestDb();
    try {
      const queue = new QueueRepository(db, new EventBus(db));
      queue.attachOutbox(new OutboxHandler(db));
      const release = vi.spyOn(queue, "drainPendingWakeIntents").mockResolvedValue({ delivered: 0, failed: 0, indeterminate: 0, retained: 0 });
      const jobs = new WatchdogJobsRepository(db);
      const { app, rigRepo } = createTestApp(db, { appDeps: { queueRepo: queue, watchdogJobsRepo: jobs } });
      const rig = rigRepo.createRig("drain-one");
      const path = `/api/rigs/${rig.id}/delivery-drain`;
      const input = { drainId: "maintenance-1", owner: "owner@drain-one", reviewAt: new Date(Date.now() + 60_000).toISOString() };
      const firstResponse = await app.request(path, jsonPost(input));
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      const second = await (await app.request(path, jsonPost(input))).json();
      expect(second.drain).toEqual(first.drain);
      expect(first).toMatchObject({ active: true, nativeStartsDeferred: false, retainedWorkCount: 0 });
      expect(jobs.listActive().map(j => j.jobId)).toEqual([first.drain.reviewJobId]);
      const renewed = await (await app.request(path, jsonPost({ ...input, reviewAt: new Date(Date.now() + 120_000).toISOString() }))).json();
      expect(renewed.drain.startedAt).toBe(first.drain.startedAt);
      expect(renewed.drain.reviewJobId).not.toBe(first.drain.reviewJobId);
      expect(jobs.getByIdOrThrow(first.drain.reviewJobId).state).toBe("stopped");
      expect(jobs.listActive().map(j => j.jobId)).toEqual([renewed.drain.reviewJobId]);
      const ended = await (await app.request(path + "/end", jsonPost({ drainId: input.drainId }))).json();
      expect(ended).toMatchObject({ active: false, ended: true, releaseScheduled: true });
      const duplicate = await (await app.request(path + "/end", jsonPost({ drainId: input.drainId }))).json();
      expect(duplicate).toMatchObject({ active: false, ended: false, releaseScheduled: false });
      expect(release).toHaveBeenCalledTimes(1);
      expect(jobs.getByIdOrThrow(first.drain.reviewJobId).state).toBe("stopped");
    } finally { db.close(); }
  });

  it("a completed BEGIN or old END cannot reactivate or end a later window", () => {
    const db = createDrainTestDb();
    try {
      const { rigRepo } = createTestApp(db);
      const rig = rigRepo.createRig("drain-one");
      const jobs = new WatchdogJobsRepository(db);
      const store = new RigDeliveryDrainStore(db);
      const input = { drainId: "first", owner: "owner@drain-one", reviewAt: new Date(Date.now() + 60_000).toISOString() };
      store.begin(rig.id, input, jobs);
      store.end(rig.id, "first", jobs);
      const second = store.begin(rig.id, { ...input, drainId: "second" }, jobs);
      expect(store.end(rig.id, "first", jobs).fresh).toBe(false);
      expect(store.get(rig.id)).toEqual(second);
      store.end(rig.id, "second", jobs);
      expect(store.begin(rig.id, input, jobs).endedAt).not.toBeNull();
      expect(jobs.listActive()).toEqual([]);
    } finally { db.close(); }
  });
  it("retains due and new notices across DB reopen, keeps unrelated delivery moving, and never replays a completed notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-drain-"));
    const file = join(dir, "fixture.sqlite");
    let db = createDb(file);
    migrate(db, ALL_MIGRATIONS);
    const sends: string[] = [];
    const transport = { send: async (_session: string, text: string) => { sends.push(text); return { ok: true, verified: true }; } };
    try {
      let queue = new QueueRepository(db, new EventBus(db));
      let outbox = new OutboxHandler(db);
      queue.attachOutbox(outbox);
      const rigs = new RigRepository(db);
      const one = rigs.createRig("held-one");
      rigs.createRig("other-two");
      let jobs = new WatchdogJobsRepository(db);
      let store = queue.deliveryDrains;
      const due = await queue.create({ sourceSession: "owner@other-two", destinationSession: "worker@held-one", body: "due before drain" });
      const dueId = WAKE_INTENT_PREFIX + due.qitemId;
      expect(outbox.getById(dueId)?.deliveryState).toBe("pending");
      store.begin(one.id, { drainId: "window", owner: "owner@held-one", reviewAt: new Date(Date.now() + 60_000).toISOString() }, jobs);
      queue.attachTransport(transport);
      await queue.drainPendingWakeIntents();
      const fresh = await queue.create({ sourceSession: "owner@other-two", destinationSession: "worker@held-one", body: "new during drain" });
      const freshId = WAKE_INTENT_PREFIX + fresh.qitemId;
      const other = await queue.create({ sourceSession: "owner@other-two", destinationSession: "worker@other-two", body: "unrelated continues" });
      await vi.waitFor(() => {
        expect(sends).toHaveLength(1);
        expect(outbox.getById(WAKE_INTENT_PREFIX + other.qitemId)?.deliveryState).toBe("delivered");
        expect(queue.getById(other.qitemId)?.lastNudgeAttempt).not.toBeNull();
      });
      expect(outbox.getById(dueId)?.deliveryState).toBe("pending");
      expect(outbox.getById(freshId)?.deliveryState).toBe("pending");
      expect(queue.getById(due.qitemId)?.lastNudgeAttempt).toBeNull();
      expect(queue.getById(fresh.qitemId)?.lastNudgeAttempt).toBeNull();
      expect(store.status(one.id, jobs).retained.pendingWakeIntents).toBe(2);
      await new Promise(resolve => setImmediate(resolve));
      db.close();
      db = createDb(file);
      migrate(db, ALL_MIGRATIONS);
      queue = new QueueRepository(db, new EventBus(db), { transport });
      outbox = new OutboxHandler(db);
      queue.attachOutbox(outbox);
      jobs = new WatchdogJobsRepository(db);
      store = queue.deliveryDrains;
      await queue.drainPendingWakeIntents();
      expect(sends).toHaveLength(1);
      expect(store.get(one.id)?.drainId).toBe("window");
      const { app } = createTestApp(db, { appDeps: { queueRepo: queue, watchdogJobsRepo: jobs } });
      const path = `/api/rigs/${one.id}/delivery-drain/end`;
      expect((await (await app.request(path, jsonPost({ drainId: "window" }))).json()).ended).toBe(true);
      await vi.waitFor(() => expect(sends).toHaveLength(3));
      expect(outbox.getById(dueId)?.deliveryState).toBe("delivered");
      expect(outbox.getById(freshId)?.deliveryState).toBe("delivered");
      expect((await (await app.request(path, jsonPost({ drainId: "window" }))).json()).ended).toBe(false);
      await queue.drainPendingWakeIntents();
      expect(sends).toHaveLength(3);
      expect(sends.filter(x => x.includes(due.qitemId))).toHaveLength(1);
      expect(sends.filter(x => x.includes(fresh.qitemId))).toHaveLength(1);
    } finally { await new Promise(resolve => setImmediate(resolve)); db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("END adds no retries of failed or uncertain input and reconciles completed sources", async () => {
    const db = createDrainTestDb();
    try {
      const sends: string[] = [];
      const queue = new QueueRepository(db, new EventBus(db), { transport: { send: async (_s, text) => { sends.push(text); return { ok: true, verified: true }; } } });
      const outbox = new OutboxHandler(db);
      queue.attachOutbox(outbox);
      const jobs = new WatchdogJobsRepository(db);
      const { app, rigRepo } = createTestApp(db, { appDeps: { queueRepo: queue, watchdogJobsRepo: jobs } });
      const rig = rigRepo.createRig("held-one");
      queue.deliveryDrains.begin(rig.id, { drainId: "window", owner: "owner@held-one", reviewAt: new Date(Date.now() + 60_000).toISOString() }, jobs);
      for (const state of ["failed", "indeterminate", "delivered"] as const) {
        const item = await queue.create({ sourceSession: "owner@held-one", destinationSession: "worker@held-one", body: state });
        const id = WAKE_INTENT_PREFIX + item.qitemId;
        expect(outbox.claimForDelivery(id)).toBe(true);
        outbox.finalizeDelivery(id, state);
      }
      const completed = await queue.create({ sourceSession: "owner@held-one", destinationSession: "worker@held-one", body: "already completed" });
      // Fixture records the positive completed-work fact; delivery must consult the current row before sending.
      db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id=?").run(completed.qitemId);
      await queue.drainPendingWakeIntents();
      expect(outbox.getById(WAKE_INTENT_PREFIX + completed.qitemId)?.deliveryState).toBe("failed");
      await app.request(`/api/rigs/${rig.id}/delivery-drain/end`, jsonPost({ drainId: "window" }));
      await new Promise(resolve => setImmediate(resolve));
      expect(sends).toEqual([]);
    } finally { db.close(); }
  });

  it("leaves watchdog evaluation and accounting untouched, but permits unrelated work and the owner's deadline prompt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
    const db = createDrainTestDb();
    try {
      const bus = new EventBus(db);
      const rigs = new RigRepository(db);
      const one = rigs.createRig("held-one");
      rigs.createRig("other-two");
      const jobs = new WatchdogJobsRepository(db);
      const history = new WatchdogHistoryLog(db);
      const store = new RigDeliveryDrainStore(db);
      const drain = store.begin(one.id, { drainId: "window", owner: "owner@held-one", reviewAt: "2026-11-14T00:00:30Z" }, jobs);
      const makeJob = (session: string) => jobs.register({ policy: "periodic-reminder", targetSession: session, registeredBySession: "owner@held-one", intervalSeconds: 1, specYaml: JSON.stringify({ target: { session }, message: "work" }) });
      const held = makeJob("worker@held-one");
      const unrelated = makeJob("worker@other-two");
      const deliver = vi.fn<DeliveryFn>(async () => ({ status: "ok" as const }));
      const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: bus, deliver,
        deliveryDeferred: (jobId, session) => store.holds(session, jobId) });
      const before = jobs.getByIdOrThrow(held.jobId);
      expect((await engine.evaluate(held)).outcome).toMatchObject({ action: "skip", reason: "rig_delivery_drain" });
      expect(jobs.getByIdOrThrow(held.jobId)).toEqual(before);
      expect(history.countForJob(held.jobId)).toBe(0);
      expect(deliver).not.toHaveBeenCalled();
      await engine.evaluate(unrelated);
      expect(deliver).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-11-14T00:00:31Z"));
      const review = jobs.getByIdOrThrow(drain.reviewJobId);
      expect(nextDueAt(review)).toBeLessThanOrEqual(Date.now());
      await engine.evaluate(review);
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(store.get(one.id)?.endedAt).toBeNull();
      expect(store.status(one.id, jobs).retained.dueWatchdogJobs).toBe(1);
      expect(store.status(one.id, jobs).nativeStartsDeferred).toBe(false);
      store.end(one.id, "window", jobs);
      await engine.evaluate(held);
      expect(deliver).toHaveBeenCalledTimes(3);
    } finally { db.close(); vi.useRealTimers(); }
  });

  it("a drain beginning while a policy awaits leaves the job due without delivering or accounting", async () => {
    const db = createDrainTestDb();
    try {
      const rigs = new RigRepository(db);
      const rig = rigs.createRig("held-one");
      const jobs = new WatchdogJobsRepository(db);
      const history = new WatchdogHistoryLog(db);
      const store = new RigDeliveryDrainStore(db);
      const job = jobs.register({ policy: "periodic-reminder", targetSession: "worker@held-one", registeredBySession: "owner@held-one", intervalSeconds: 1, specYaml: JSON.stringify({ target: { session: "worker@held-one" }, message: "work" }) });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const deliver = vi.fn<DeliveryFn>(async () => ({ status: "ok" as const }));
      const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(db), deliver,
        deliveryDeferred: (id, session) => store.holds(session, id),
        additionalPolicies: [{ name: "periodic-reminder", evaluate: async () => { await gate; return { action: "send" as const, target: { session: "worker@held-one" }, message: "work" }; } }] });
      const before = jobs.getByIdOrThrow(job.jobId);
      const evaluation = engine.evaluate(job);
      store.begin(rig.id, { drainId: "window", owner: "owner@held-one", reviewAt: new Date(Date.now() + 60_000).toISOString() }, jobs);
      release();
      expect((await evaluation).outcome).toMatchObject({ action: "skip", reason: "rig_delivery_drain" });
      expect(deliver).not.toHaveBeenCalled();
      expect(jobs.getByIdOrThrow(job.jobId)).toEqual(before);
      expect(history.countForJob(job.jobId)).toBe(0);
    } finally { db.close(); }
  });

  it("defers a collected reminder digest before accounting, then sends its same due occurrences after END", async () => {
    const db = createDrainTestDb();
    try {
      const rigs = new RigRepository(db);
      const rig = rigs.createRig("held-one");
      const jobs = new WatchdogJobsRepository(db);
      const history = new WatchdogHistoryLog(db);
      const store = new RigDeliveryDrainStore(db);
      const input = { policy: "periodic-reminder", targetSession: "worker@held-one", registeredBySession: "owner@held-one", intervalSeconds: 1, specYaml: JSON.stringify({ target: { session: "worker@held-one" }, message: "work" }) };
      const a = jobs.register(input), b = jobs.register(input);
      const before = [jobs.getByIdOrThrow(a.jobId), jobs.getByIdOrThrow(b.jobId)];
      const deliver = vi.fn<DeliveryFn>(async () => ({ status: "ok" as const }));
      const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(db), deliver,
        deliveryDeferred: (id, session) => store.holds(session, id), resolveDigestEntry: ({ jobId }) => ({ qitemId: jobId, summary: "owed" }) });
      const pass = { held: [] };
      await engine.evaluate(a, undefined, pass);
      await engine.evaluate(b, undefined, pass);
      expect(pass.held).toHaveLength(2);
      store.begin(rig.id, { drainId: "window", owner: "owner@held-one", reviewAt: new Date(Date.now() + 60_000).toISOString() }, jobs);
      await engine.deliverHeldReminders(pass);
      expect(deliver).not.toHaveBeenCalled();
      expect([jobs.getByIdOrThrow(a.jobId), jobs.getByIdOrThrow(b.jobId)]).toEqual(before);
      expect(history.countForJob(a.jobId) + history.countForJob(b.jobId)).toBe(0);
      store.end(rig.id, "window", jobs);
      const next = { held: [] };
      await engine.evaluate(a, undefined, next);
      await engine.evaluate(b, undefined, next);
      await engine.deliverHeldReminders(next);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(deliver.mock.calls[0]![1]?.members?.map(x => x.jobId).sort()).toEqual([a.jobId, b.jobId].sort());
    } finally { db.close(); }
  });

  it("keeps the owner's recorded review usable when its seat is in another drained rig", () => {
    const db = createDrainTestDb();
    try {
      const rigs = new RigRepository(db);
      const a = rigs.createRig("first"), b = rigs.createRig("second");
      const jobs = new WatchdogJobsRepository(db);
      const store = new RigDeliveryDrainStore(db);
      const input = { drainId: "window", owner: "owner@second", reviewAt: new Date(Date.now() + 60_000).toISOString() };
      const first = store.begin(a.id, input, jobs);
      store.begin(b.id, input, jobs);
      expect(store.holds("owner@second")).toBe(true);
      expect(store.holds("owner@second", first.reviewJobId)).toBe(false);
    } finally { db.close(); }
  });

});
