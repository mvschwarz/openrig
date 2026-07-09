// OPR.0.4.6.WF1 FR-3 (G2): keepalive auto-arm in-txn + disarm + the
// deadline-gated policy behavior.
//
//   - instantiate arms ONE per-instance workflow-keepalive job inside
//     the same transaction that creates the entry packet;
//   - handoff projections keep it armed idempotently (one job per
//     instance — arch-blessed — and heals pre-WF-1 instances);
//   - terminal exits disarm in-txn (no orphaned watchdog noise);
//   - a mid-txn failure rolls the arming back WITH everything else
//     (the arming rides the scribe, it is not a second writer);
//   - the auto-armed (deadline_gated) policy is QUIET while healthy
//     (FR-2 zero-noise AC) and sends the stuck re-nudge with evidence
//     once a frontier packet is overdue — steering a restored agent to
//     re-project. Operator-registered jobs keep POC always-send parity.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import {
  findArmedKeepaliveJob,
  WORKFLOW_KEEPALIVE_AUTO_INTERVAL_SECONDS,
} from "../src/domain/workflow-keepalive-arming.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const SPEC = `workflow:
  id: fr3-arming
  version: 1
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - worker@rig
    next:
      preferred_targets:
        - next@rig
  steps:
    - id: work
      actor_role: worker
      allowed_exits:
        - handoff
        - waiting
        - done
        - failed
    - id: follow
      actor_role: next
      allowed_exits:
        - done
        - failed
`;

describe("FR-3: keepalive auto-arm in-txn + disarm", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      watchdogJobsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    watchdogRepo = new WatchdogJobsRepository(db);
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
    });
    tmp = mkdtempSync(join(tmpdir(), "wf-arming-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("instantiate arms exactly ONE per-instance deadline-gated keepalive job (in the same txn as the entry packet)", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "arming walk",
      createdBySession: "ops@rig",
    });
    const job = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId);
    expect(job).not.toBeNull();
    expect(job!.policy).toBe("workflow-keepalive");
    expect(job!.state).toBe("active");
    expect(job!.targetSession).toBe("worker@rig");
    expect(job!.intervalSeconds).toBe(WORKFLOW_KEEPALIVE_AUTO_INTERVAL_SECONDS);
    expect(job!.specYaml).toContain(`workflow_instance_id: ${inst.instance.instanceId}`);
    expect(job!.specYaml).toContain("deadline_gated: true");
    expect(watchdogRepo.listActive()).toHaveLength(1);
  });

  it("handoff keeps ONE job per instance (idempotent ensure); terminal done disarms it in-txn", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "one job walk",
      createdBySession: "ops@rig",
    });
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    // Still exactly one active job for the instance.
    expect(
      watchdogRepo
        .listActive()
        .filter((j) => j.specYaml.includes(inst.instance.instanceId)),
    ).toHaveLength(1);

    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "done",
      actorSession: "next@rig",
    });
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).toBeNull();
    const all = watchdogRepo
      .listAll()
      .filter((j) => j.specYaml.includes(inst.instance.instanceId));
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe("terminal");
    expect(all[0]!.terminalReason).toBe("workflow_completed");
  });

  it("failed exit disarms with workflow_failed; a handoff onto a pre-WF-1 instance (no job) heals by arming", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "heal walk",
      createdBySession: "ops@rig",
    });
    // Simulate a pre-WF-1 instance: kill the auto-armed job out-of-band.
    const armed = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)!;
    watchdogRepo.markTerminal(armed.jobId, "simulated_pre_wf1_state");
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).toBeNull();

    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    // Healed: a fresh active job exists again.
    const healed = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId);
    expect(healed).not.toBeNull();
    expect(healed!.targetSession).toBe("next@rig");

    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "failed",
      actorSession: "next@rig",
    });
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).toBeNull();
    const terminalJob = watchdogRepo
      .listAll()
      .find((j) => j.jobId === healed!.jobId)!;
    expect(terminalJob.terminalReason).toBe("workflow_failed");
  });

  it("waiting keeps the job armed (the keepalive wakes the parked owner)", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "waiting walk",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      blockedOn: "external-gate-x",
    });
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).not.toBeNull();
  });

  it("BR-2/atomicity: a mid-txn failure rolls the arming back WITH the rest — arming rides the scribe, it is not a second writer", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "rollback walk",
      createdBySession: "ops@rig",
    });
    // Make this look like a pre-WF-1 instance so the handoff would arm.
    const armed = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)!;
    watchdogRepo.markTerminal(armed.jobId, "simulated_pre_wf1_state");

    vi.spyOn(runtime.trailLog, "record").mockImplementation(() => {
      throw new Error("injected-mid-txn-failure");
    });
    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "worker@rig",
      }),
    ).rejects.toThrow("injected-mid-txn-failure");

    // The heal-arm rolled back with everything else.
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).toBeNull();
  });
});

describe("FR-3/FR-2: the deadline-gated keepalive policy behavior", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      watchdogJobsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    watchdogRepo = new WatchdogJobsRepository(db);
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
    });
    tmp = mkdtempSync(join(tmpdir(), "wf-gated-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function jobFor(instanceId: string, deadlineGated: boolean): PolicyJob {
    return {
      jobId: "job-test",
      policy: "workflow-keepalive",
      target: { session: "fallback@rig" },
      intervalSeconds: 900,
      activeWakeIntervalSeconds: null,
      scanIntervalSeconds: null,
      context: {
        workflow_instance_id: instanceId,
        ...(deadlineGated ? { deadline_gated: true } : {}),
      },
      lastEvaluationAt: null,
      lastFireAt: null,
      registeredBySession: "ops@rig",
      registeredAt: new Date().toISOString(),
    };
  }

  it("deadline-gated + healthy → QUIET skip (workflow_healthy_deadline_gated) — zero noise on the happy path", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "quiet walk",
      createdBySession: "ops@rig",
    });
    const policy = makeWorkflowKeepalivePolicy({ db });
    const evaluation = await policy.evaluate(jobFor(inst.instance.instanceId, true));
    expect(evaluation.action).toBe("skip");
    expect(evaluation.reason).toBe("workflow_healthy_deadline_gated");
  });

  it("deadline-gated + overdue-unclaimed → SEND to the packet owner with stuck evidence + re-project steering", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "stuck walk",
      createdBySession: "ops@rig",
    });
    // Age the entry packet past the never-claimed threshold.
    const past = new Date(
      Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60) * 1000,
    ).toISOString();
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(
      past,
      inst.entryQitemId,
    );

    const policy = makeWorkflowKeepalivePolicy({ db });
    const evaluation = await policy.evaluate(jobFor(inst.instance.instanceId, true));
    expect(evaluation.action).toBe("send");
    if (evaluation.action !== "send") throw new Error("unreachable");
    expect(evaluation.target.session).toBe("worker@rig");
    expect(evaluation.message).toContain("Workflow STUCK (overdue-unclaimed)");
    expect(evaluation.message).toContain(inst.entryQitemId);
    expect(evaluation.message).toContain("rig workflow project");
    const deadlineNotes = (evaluation.notes as Record<string, unknown>)
      .deadline as Record<string, unknown>;
    expect(deadlineNotes.state).toBe("overdue-unclaimed");
    expect(deadlineNotes.packetId).toBe(inst.entryQitemId);
  });

  it("NON-gated (operator-registered) + healthy → shipped always-send POC parity unchanged", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "parity walk",
      createdBySession: "ops@rig",
    });
    const policy = makeWorkflowKeepalivePolicy({ db });
    const evaluation = await policy.evaluate(jobFor(inst.instance.instanceId, false));
    expect(evaluation.action).toBe("send");
    if (evaluation.action !== "send") throw new Error("unreachable");
    expect(evaluation.message).toContain("Workflow keepalive:");
    expect(evaluation.message).not.toContain("Workflow STUCK");
  });
});
