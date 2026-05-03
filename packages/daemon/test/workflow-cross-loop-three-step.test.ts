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

/**
 * PRD § Acceptance Criteria load-bearing case (Phase D):
 *   "A workflow instance with three steps, instantiated and run by
 *    three different rigs, completes with a continuous step trail and
 *    no orphaned packets."
 *
 * This test simulates the three different rigs by using three
 * different actor sessions on canonical rig names; the daemon
 * doesn't gate this test on rig topology being live.
 */

const SPEC = `workflow:
  id: cross-loop-three-step
  version: 1
  objective: PRD acceptance criteria load-bearing
  entry:
    role: discovery
  roles:
    discovery:
      preferred_targets:
        - discovery@rig-discovery
    productlab:
      preferred_targets:
        - productlab@rig-productlab
    delivery:
      preferred_targets:
        - delivery@rig-delivery
  steps:
    - id: discover
      actor_role: discovery
      allowed_exits:
        - handoff
    - id: shape
      actor_role: productlab
      allowed_exits:
        - handoff
    - id: deliver
      actor_role: delivery
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
`;

describe("workflow cross-loop three-step (PL-004 Phase D PRD acceptance)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-3step-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("three steps × three actors → completed with continuous trail + zero orphans", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));

    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "ship feature X",
      createdBySession: "orchestrator@rig-orch",
    });
    expect(inst.instance.status).toBe("active");

    // Step 1 (discovery): close + project
    let projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "discovery@rig-discovery",
      resultNote: "discovered intent",
    });
    expect(projected.nextStepId).toBe("shape");
    expect(projected.nextOwnerSession).toBe("productlab@rig-productlab");
    const step2QitemId = projected.nextQitemId!;

    // Step 2 (productlab)
    projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: step2QitemId,
      exit: "handoff",
      actorSession: "productlab@rig-productlab",
      resultNote: "shaped slice",
    });
    expect(projected.nextStepId).toBe("deliver");
    expect(projected.nextOwnerSession).toBe("delivery@rig-delivery");
    const step3QitemId = projected.nextQitemId!;

    // Step 3 (delivery; terminal)
    projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: step3QitemId,
      exit: "done",
      actorSession: "delivery@rig-delivery",
      resultNote: "shipped",
    });
    expect(projected.instance.status).toBe("completed");
    expect(projected.instance.currentFrontier).toEqual([]);
    expect(projected.nextQitemId).toBeNull();

    // Continuous step trail.
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    expect(trail).toHaveLength(3);
    expect(trail.map((t) => t.stepId).sort()).toEqual(["deliver", "discover", "shape"]);

    // Zero orphan packets: every queue item is either done or handed-off
    // (the prior steps) or done (the terminal). No pending items left.
    const pending = db
      .prepare(`SELECT COUNT(*) AS n FROM queue_items WHERE state = 'pending'`)
      .get() as { n: number };
    expect(pending.n).toBe(0);

    // Event timeline includes the full lifecycle.
    expect(events.filter((e) => e.type === "workflow.instantiated")).toHaveLength(1);
    expect(events.filter((e) => e.type === "workflow.step_closed")).toHaveLength(3);
    expect(events.filter((e) => e.type === "workflow.next_qitem_projected")).toHaveLength(2);
    expect(events.filter((e) => e.type === "workflow.completed")).toHaveLength(1);
  });
});
