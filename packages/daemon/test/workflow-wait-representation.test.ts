import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { parseWatchdogSpec } from "../src/domain/watchdog-policy-engine.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";

const AUTHORED_WAIT_SPEC = readFileSync(
  new URL("./fixtures/workflow-authored-wait.yaml", import.meta.url),
  "utf8",
);

const commandFor = (instanceId: string, packetId: string) =>
  `rig workflow project --instance ${instanceId} --current-packet ${packetId} --exit <handoff|waiting|done|failed>`;

describe("workflow authored waiting re-presentation", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    watchdogRepo = new WatchdogJobsRepository(db);
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo, watchdogJobsRepo: watchdogRepo });
    tmp = mkdtempSync(join(tmpdir(), "workflow-authored-wait-"));
    specPath = join(tmp, "workflow.yaml");
    writeFileSync(specPath, AUTHORED_WAIT_SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("re-presents the same waiting occurrence once, absorbs replay, and leaves unconfigured waiting unchanged", async () => {
    const created = await runtime.instantiate({
      specPath,
      rootObjective: "prove the authored context rail",
      createdBySession: "ops@rig",
    });
    const entryCommand = commandFor(created.instance.instanceId, created.entryQitemId);
    const entryBody = queueRepo.getByIdOrThrow(created.entryQitemId).body;
    expect(entryBody).toContain(`Continuation: ${entryCommand}`);
    expect(entryBody).toContain("shortcut, not the whole story");

    await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: created.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      blockedOn: "external:receipt-review",
      resultNote: "agent is still interpreting evidence",
      closureEvidence: { receipt: { outcome: "published" } },
    });

    const wake = queueRepo.getParkWakeStatus(created.entryQitemId);
    expect(wake).toMatchObject({ kind: "timer", live: true });
    const timer = watchdogRepo.getById(wake!.ref)!;
    const timerMessage = parseWatchdogSpec(timer.specYaml).message!;
    expect(timer.intervalSeconds).toBe(60);
    expect(timerMessage).toContain(created.entryQitemId);
    expect(timerMessage).toContain(entryCommand);
    expect(timerMessage).toContain("shortcut, not the whole story");
    queueRepo.recordWatchdogWakeAttempt(timer.jobId, "verified");
    expect(watchdogRepo.getById(timer.jobId)).toMatchObject({
      state: "terminal",
      terminalReason: "park_timer_fired_once",
    });
    expect(queueRepo.recordWatchdogWakeAttempt(timer.jobId, "verified")).toBeUndefined();

    const qitemsBeforeReplay = (db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n;
    const jobsBeforeReplay = (db.prepare(`SELECT COUNT(*) AS n FROM watchdog_jobs`).get() as { n: number }).n;
    const reconstructedBus = new EventBus(db);
    const reconstructedQueue = new QueueRepository(db, reconstructedBus, { validateRig: () => true });
    reconstructedQueue.attachOutbox(new OutboxHandler(db));
    const reconstructed = new WorkflowRuntime({
      db,
      eventBus: reconstructedBus,
      queueRepo: reconstructedQueue,
      watchdogJobsRepo: watchdogRepo,
    });
    const replay = await reconstructed.project({
      instanceId: created.instance.instanceId,
      currentPacketId: created.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      blockedOn: "external:receipt-review",
      resultNote: "agent is still interpreting evidence",
      closureEvidence: { receipt: { outcome: "published" } },
    });
    expect(replay.absorbedReplay).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n).toBe(qitemsBeforeReplay);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM watchdog_jobs`).get() as { n: number }).n).toBe(jobsBeforeReplay);

    const handoff = await reconstructed.project({
      instanceId: created.instance.instanceId,
      currentPacketId: created.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    const nextCommand = commandFor(created.instance.instanceId, handoff.nextQitemId!);
    const nextBody = queueRepo.getByIdOrThrow(handoff.nextQitemId!).body;
    expect(nextBody).toContain(`Continuation: ${nextCommand}`);
    expect(nextBody).toContain("shortcut, not the whole story");

    await reconstructed.project({
      instanceId: created.instance.instanceId,
      currentPacketId: handoff.nextQitemId!,
      exit: "waiting",
      actorSession: "next@rig",
      blockedOn: "external:ordinary-wait",
    });
    expect(queueRepo.getByIdOrThrow(handoff.nextQitemId!).state).toBe("blocked");
    expect(queueRepo.getParkWakeStatus(handoff.nextQitemId!)).toBeNull();
  });

  it("refreshes the exact continuation command when a frontier packet is rerouted or redriven", async () => {
    const created = await runtime.instantiate({
      specPath,
      rootObjective: "prove replacement packets",
      createdBySession: "ops@rig",
    });
    const routed = await runtime.route({
      instanceId: created.instance.instanceId,
      toSession: "worker-2@rig",
      actorSession: "ops@rig",
      reason: "owner changed",
    });
    const routedBody = queueRepo.getByIdOrThrow(routed.newPacketId).body;
    expect(routedBody).toContain(
      `Continuation: ${commandFor(created.instance.instanceId, routed.newPacketId)}`,
    );
    expect(routedBody).not.toContain(`--current-packet ${created.entryQitemId} `);

    await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: routed.newPacketId,
      exit: "failed",
      actorSession: "worker-2@rig",
      resultNote: "bounded failure",
    });
    const resumed = await runtime.resume({
      instanceId: created.instance.instanceId,
      actorSession: "ops@rig",
      decision: "retry the authored step",
    });
    const resumedBody = queueRepo.getByIdOrThrow(resumed.newPacketId).body;
    expect(resumedBody).toContain(
      `Continuation: ${commandFor(created.instance.instanceId, resumed.newPacketId)}`,
    );
    expect(resumedBody).toContain("shortcut, not the whole story");
  });

  it("rejects a non-positive authored waiting deadline", () => {
    const invalidPath = join(tmp, "invalid.yaml");
    writeFileSync(invalidPath, AUTHORED_WAIT_SPEC.replace("re_present_after_seconds: 60", "re_present_after_seconds: 0"));
    expect(() => runtime.validate(invalidPath)).toThrowError(
      expect.objectContaining({ code: "spec_field_invalid" }),
    );
  });
});
