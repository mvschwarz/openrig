import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";

const SPEC = `workflow:
  id: pd-three-step
  version: 1
  objective: 3-step transactional-scribe test
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
    finalizer:
      preferred_targets:
        - finalizer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
    - id: review
      actor_role: reviewer
      allowed_exits:
        - handoff
    - id: finalize
      actor_role: finalizer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
`;

describe("WorkflowProjector + WorkflowRuntime (PL-004 Phase D; transactional-scribe LOAD-BEARING)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
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
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
    ]);
    bus = new EventBus(db);
    // Seed a rig + node so QueueRepository.validateRig accepts the targets.
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    tmp = mkdtempSync(join(tmpdir(), "wf-proj-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("instantiate creates an instance + entry qitem in same transaction; emits workflow.instantiated + queue.created", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await runtime.instantiate({
      specPath,
      rootObjective: "test run",
      createdBySession: "ops@rig",
    });
    expect(result.instance.status).toBe("active");
    expect(result.instance.currentFrontier).toEqual([result.entryQitemId]);
    expect(events.some((e) => e.type === "workflow.instantiated")).toBe(true);
    expect(events.some((e) => e.type === "queue.created")).toBe(true);
    // Entry qitem actually exists with the expected destination.
    const entryItem = queueRepo.getById(result.entryQitemId);
    expect(entryItem?.destinationSession).toBe("producer@rig");
    expect(entryItem?.state).toBe("pending");
  });

  // R1 fix (guard blocker 1): project handoff persists Phase A queue
  // closure metadata (closure_reason, closure_target, handed_off_to) +
  // appends queue_transitions row + emits queue.updated event.
  it("project(handoff) persists Phase A queue closure metadata + transition row + queue.updated event", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
      resultNote: "produced",
    });
    // Phase A queue closure contract preserved.
    const closedItem = queueRepo.getById(inst.entryQitemId);
    expect(closedItem?.state).toBe("handed-off");
    expect(closedItem?.closureReason).toBe("handed_off_to");
    expect(closedItem?.closureTarget).toBe("reviewer@rig");
    expect(closedItem?.handedOffTo).toBe("reviewer@rig");
    // queue_transitions row appended.
    const transitions = db
      .prepare(`SELECT * FROM queue_transitions WHERE qitem_id = ? ORDER BY ts DESC`)
      .all(inst.entryQitemId) as Array<{ state: string; closure_reason: string | null; closure_target: string | null }>;
    expect(transitions.find((t) => t.state === "handed-off")).toBeDefined();
    expect(transitions.find((t) => t.state === "handed-off")?.closure_reason).toBe("handed_off_to");
    // queue.updated event emitted.
    expect(events.find((e) => e.type === "queue.updated")).toBeDefined();
    // Workflow events too.
    expect(events.find((e) => e.type === "workflow.step_closed")).toBeDefined();
    expect(events.find((e) => e.type === "workflow.next_qitem_projected")).toBeDefined();
    expect(projected.nextStepId).toBe("review");
  });

  it("project(done) without exposed closure overrides defaults closure_reason to no-follow-on", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "done",
      actorSession: "producer@rig",
    });
    const closedItem = queueRepo.getById(inst.entryQitemId);
    expect(closedItem?.state).toBe("done");
    expect(closedItem?.closureReason).toBe("no-follow-on");
    expect(events.find((e) => e.type === "queue.updated")).toBeDefined();
  });

  it("project(waiting) uses Phase A blocked state + closure_reason=blocked_on + blocked_on column", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "producer@rig",
      blockedOn: "external-gate-x",
    });
    const closedItem = queueRepo.getById(inst.entryQitemId);
    expect(closedItem?.state).toBe("blocked");
    expect(closedItem?.closureReason).toBe("blocked_on");
    expect(closedItem?.closureTarget).toBe("external-gate-x");
    expect(closedItem?.blockedOn).toBe("external-gate-x");
  });

  it("project(handoff) closes current packet AND creates next-step packet IN ONE TRANSACTION; emits step_closed + next_qitem_projected", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
      resultNote: "produced",
    });
    expect(projected.closurePriorPacketId).toBe(inst.entryQitemId);
    expect(projected.nextStepId).toBe("review");
    expect(projected.nextOwnerSession).toBe("reviewer@rig");
    expect(projected.nextQitemId).not.toBeNull();
    // Prior packet closed.
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe("handed-off");
    // Next packet exists.
    expect(queueRepo.getById(projected.nextQitemId!)?.state).toBe("pending");
    // Both events emitted.
    expect(events.filter((e) => e.type === "workflow.step_closed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "workflow.next_qitem_projected")).toHaveLength(1);
  });

  it("transactional-scribe ROLLBACK: if next-qitem creation fails, prior packet remains in-progress + no trail row + no orphan qitem", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    // Force projection failure by invalidating destination via validateRig flip.
    const failingRepo = new QueueRepository(db, bus, {
      validateRig: () => false,
    });
    const failingRuntime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: failingRepo });
    const trailCountBefore = failingRuntime.trailLog.countForInstance(inst.instance.instanceId);
    const queueCountBefore = db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number };

    let threw = false;
    try {
      await failingRuntime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Prior packet still pending (rollback).
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe("pending");
    // No trail row written.
    expect(failingRuntime.trailLog.countForInstance(inst.instance.instanceId)).toBe(trailCountBefore);
    // No orphan qitem created.
    const queueCountAfter = db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number };
    expect(queueCountAfter.n).toBe(queueCountBefore.n);
    // Instance frontier unchanged.
    const instAfter = failingRuntime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(instAfter.currentFrontier).toEqual([inst.entryQitemId]);
    expect(instAfter.status).toBe("active");
  });

  it("project(done) on terminal step → status=completed + frontier=[]", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    // Walk through all 3 steps.
    let projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "handoff",
      actorSession: "reviewer@rig",
    });
    projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "done",
      actorSession: "finalizer@rig",
      resultNote: "shipped",
    });
    expect(projected.instance.status).toBe("completed");
    expect(projected.instance.currentFrontier).toEqual([]);
    expect(projected.instance.completedAt).not.toBeNull();
    expect(projected.nextQitemId).toBeNull();
    // Step trail has 3 entries.
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    expect(trail).toHaveLength(3);
  });

  it("project rejects packet not on frontier → 409 packet_not_on_frontier", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    try {
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: "qitem-not-in-frontier",
        exit: "done",
        actorSession: "x@r",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowProjectorError);
      expect((err as WorkflowProjectorError).code).toBe("packet_not_on_frontier");
    }
  });

  it("project rejects on completed instance → 409 instance_not_active", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    let projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "done",
      actorSession: "producer@rig",
    });
    expect(projected.instance.status).toBe("completed");
    try {
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "done",
        actorSession: "producer@rig",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowProjectorError);
      expect((err as WorkflowProjectorError).code).toBe("instance_not_active");
    }
  });

  // R1 fix (guard blocker 2b): project(waiting) PRESERVES the closed
  // packet on currentFrontier so workflow-keepalive can still resolve
  // the owner. The blocker bug was: removing the closed packet left
  // single-packet waiting workflows with no owner to wake.
  it("project(waiting) sets status=waiting AND preserves the closed packet on currentFrontier (workflow-keepalive resolvability)", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    expect(inst.instance.currentFrontier).toEqual([inst.entryQitemId]);
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "producer@rig",
      blockedOn: "external-gate",
    });
    expect(projected.instance.status).toBe("waiting");
    expect(projected.nextQitemId).toBeNull();
    // Phase A queue closure shape on the blocked packet.
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe("blocked");
    // FRONTIER PRESERVED — workflow-keepalive can still wake the owner.
    expect(projected.instance.currentFrontier).toEqual([inst.entryQitemId]);
    // Re-fetch to confirm the persisted instance row reflects the same.
    const reread = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(reread.currentFrontier).toEqual([inst.entryQitemId]);
  });

  // R1 fix (guard blocker 2a): exit=failed sets workflow status=failed
  // (not completed) AND emits workflow.failed (not workflow.completed).
  it("project(failed) sets workflow status=failed AND emits workflow.failed (NOT completed)", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "producer@rig",
      resultNote: "could not produce artifact",
    });
    expect(projected.instance.status).toBe("failed");
    expect(events.find((e) => e.type === "workflow.failed")).toBeDefined();
    expect(events.find((e) => e.type === "workflow.completed")).toBeUndefined();
    // Phase A queue closure: state=done with closure_reason=denied.
    const closedItem = queueRepo.getById(inst.entryQitemId);
    expect(closedItem?.state).toBe("done");
    expect(closedItem?.closureReason).toBe("denied");
    // Persisted failed event carries the reason.
    const failedEvent = events.find((e) => e.type === "workflow.failed") as
      | { type: "workflow.failed"; reason: string }
      | undefined;
    expect(failedEvent?.reason).toBe("could not produce artifact");
  });
});
