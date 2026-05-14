import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";
import { loadStarterWorkflowSpecs } from "../src/domain/workflow/starter-spec-loader.js";
import { getWorkflowReview } from "../src/domain/spec-library-workflow-scanner.js";

const BUILTIN_WORKFLOW_DIR = resolve(import.meta.dirname, "../src/builtins/workflow-specs");
const CONVEYOR_SPEC = join(BUILTIN_WORKFLOW_DIR, "conveyor.yaml");
const BASIC_LOOP_SPEC = join(BUILTIN_WORKFLOW_DIR, "basic-loop.yaml");

describe("0.3.0 conveyor starter workflow specs", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let runtime: WorkflowRuntime;

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
    eventBus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-conveyor', 'conveyor')`).run();
    const queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo });
  });

  afterEach(() => db.close());

  it("ships exactly the generic public starter workflow specs", () => {
    const result = loadStarterWorkflowSpecs({
      cache: runtime.specCache,
      builtinDir: BUILTIN_WORKFLOW_DIR,
    });

    expect(result.errors).toEqual([]);
    // Keep this list in sync with
    // packages/daemon/src/builtins/workflow-specs/*.yaml.
    expect(result.loaded.map((s) => s.name).sort()).toEqual([
      "basic-loop",
      "conveyor",
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("conveyor and basic-loop validate as generic conveyor-targeted specs", () => {
    const validator = new WorkflowValidator();

    for (const specPath of [CONVEYOR_SPEC, BASIC_LOOP_SPEC]) {
      const raw = readFileSync(specPath, "utf-8");
      expect(raw).not.toMatch(/\brsi\b/i);
      expect(raw).not.toContain("openrig-velocity");

      const spec = parseWorkflowSpec(raw, specPath);
      expect(spec.target?.rig).toBe("conveyor");
      expect(spec.coordination_terminal_turn_rule).toBe("hot_potato");
      expect(spec.steps.map((step) => step.id)).toEqual(["intake", "plan", "build", "review", "close"]);

      const validation = validator.validate(spec);
      expect(validation.ok).toBe(true);
      expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
      expect(validation.summary.entryRole).toBe("intake");
    }
  });

  it("conveyor can run multiple active instances on the same rig", async () => {
    const first = await runtime.instantiate({
      specPath: CONVEYOR_SPEC,
      rootObjective: "packet A",
      createdBySession: "intake-lead@conveyor",
    });
    const second = await runtime.instantiate({
      specPath: CONVEYOR_SPEC,
      rootObjective: "packet B",
      createdBySession: "intake-lead@conveyor",
    });

    expect(first.instance.instanceId).not.toBe(second.instance.instanceId);
    expect(first.instance.currentStepId).toBe("intake");
    expect(second.instance.currentStepId).toBe("intake");

    const projected = await runtime.project({
      instanceId: first.instance.instanceId,
      currentPacketId: first.entryQitemId,
      exit: "handoff",
      actorSession: "intake-lead@conveyor",
      resultNote: "packet A clarified",
    });

    expect(projected.nextStepId).toBe("plan");
    expect(projected.nextOwnerSession).toBe("plan-planner@conveyor");

    const stillActive = runtime.instanceStore.getById(second.instance.instanceId);
    expect(stillActive?.status).toBe("active");
    expect(stillActive?.currentFrontier).toEqual([second.entryQitemId]);
    expect(stillActive?.currentStepId).toBe("intake");
  });

  it("basic-loop can move one packet end-to-end through close", async () => {
    const created = await runtime.instantiate({
      specPath: BASIC_LOOP_SPEC,
      rootObjective: "walk one packet",
      createdBySession: "intake-lead@conveyor",
    });

    let packetId = created.entryQitemId;
    let projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "intake-lead@conveyor",
    });
    expect(projected.nextStepId).toBe("plan");
    packetId = projected.nextQitemId!;

    projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "plan-planner@conveyor",
    });
    expect(projected.nextStepId).toBe("build");
    packetId = projected.nextQitemId!;

    projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "build-builder@conveyor",
    });
    expect(projected.nextStepId).toBe("review");
    packetId = projected.nextQitemId!;

    projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "review-reviewer@conveyor",
    });
    expect(projected.nextStepId).toBe("close");
    expect(projected.nextOwnerSession).toBe("intake-lead@conveyor");
    packetId = projected.nextQitemId!;

    await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "done",
      actorSession: "intake-lead@conveyor",
      resultNote: "walkthrough complete",
    });

    const done = runtime.instanceStore.getById(created.instance.instanceId);
    expect(done?.status).toBe("completed");
    expect(done?.currentFrontier).toEqual([]);
    expect(done?.currentStepId).toBeNull();
  });

  it("workflow review graph shows pass-to-close and review-to-build feedback paths", () => {
    runtime.specCache.readThrough(CONVEYOR_SPEC);
    const review = getWorkflowReview({
      db,
      workflowBuiltinSpecsDir: BUILTIN_WORKFLOW_DIR,
      name: "conveyor",
      version: "1",
    });

    expect(review?.isBuiltIn).toBe(true);
    expect(review?.topology.nodes.map((node) => node.stepId)).toEqual([
      "intake",
      "plan",
      "build",
      "review",
      "close",
    ]);
    expect(review?.topology.edges).toEqual(
      expect.arrayContaining([
        { fromStepId: "review", toStepId: "close", routingType: "direct" },
        { fromStepId: "review", toStepId: "build", routingType: "direct" },
      ]),
    );
  });
});
