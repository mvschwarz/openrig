// OPR.0.4.6.WF1 FR-8 (G6) + FR-9 (G8).
//
// FR-8: `continue` label-vs-wire honesty — after the relabel, the CLI
// description, the route comment, and the behavior all AGREE on
// read-only inspector semantics, and `project` remains the sole
// advance write path (BR-2). The test exercises BOTH: the described
// behavior (source text carries no advance language) and the actual
// behavior (two continue calls mutate nothing).
//
// FR-9: every declared-but-unenforced spec key produces the fail-open
// `declared_not_enforced_v1` advisory (warning; ok stays true) —
// zero keys in the silent third state.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";

const SPEC = `workflow:
  id: fr8-honesty
  version: 1
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
    - id: follow
      actor_role: next
      allowed_exits:
        - done
`;

describe("FR-8: continue is an honest read-only inspector — label AND wire agree", () => {
  let db: Database.Database;
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
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-honesty-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("wire: two continue calls return identical state and mutate NOTHING (version, trail, frontier, queue all untouched)", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "honesty walk",
      createdBySession: "ops@rig",
    });
    const before = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    const qitemCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }
    ).n;

    const first = runtime.continue(inst.instance.instanceId);
    const second = runtime.continue(inst.instance.instanceId);
    expect(second.instance).toEqual(first.instance);
    expect(second.trail).toEqual(first.trail);

    const after = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(after.version).toBe(before.version);
    expect(after.currentFrontier).toEqual(before.currentFrontier);
    expect(after.status).toBe(before.status);
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n,
    ).toBe(qitemCountBefore);
  });

  it("label: the CLI command description + route comment carry inspector language and NO mechanical-advance claim", () => {
    const cliSource = readFileSync(
      join(__dirname, "..", "..", "cli", "src", "commands", "workflow.ts"),
      "utf-8",
    );
    // The old lie is gone...
    expect(cliSource).not.toContain("Mechanically advance an instance");
    expect(cliSource).not.toContain("Advanced instance ${instanceId}");
    // ...and the honest label + the project() pointer are present.
    expect(cliSource).toContain(
      "Inspect an instance's current frontier + step trail (read-only",
    );
    expect(cliSource).toContain("rig workflow project");

    const routeSource = readFileSync(
      join(__dirname, "..", "src", "routes", "workflow.ts"),
      "utf-8",
    );
    expect(routeSource).toContain("continue  inspect (idempotent)");
  });
});

describe("FR-9: every inert key produces the fail-open declared_not_enforced_v1 advisory — zero silent dead config", () => {
  function advisoriesFor(yaml: string) {
    const spec = parseWorkflowSpec(yaml, "test://fr9.yaml");
    const result = new WorkflowValidator().validate(spec);
    return {
      result,
      advisories: result.issues.filter((i) => i.code === "declared_not_enforced_v1"),
    };
  }

  it("a spec using EVERY v2 key gets one advisory per key class, all warnings, ok stays true (fail-open)", () => {
    const yaml = `workflow:
  id: fr9-all
  version: 1
  roles:
    worker:
      skill_refs: [some-skill]
      preferred_targets:
        - worker@rig
  steps:
    - id: only
      actor_role: worker
      allowed_exits:
        - done
  invariants:
    continuation_required: true
    preserve_lineage: true
    closure_required: true
    allowed_exits: [handoff, waiting, done, failed]
  closure:
    success: done well
  loop_guards:
    max_hops: 5
    spawn_budget: 2
`;
    const { result, advisories } = advisoriesFor(yaml);
    expect(result.ok).toBe(true); // fail-open: warnings never block
    const advisedKeys = advisories.map((a) => a.message.split('"')[1]);
    expect(advisedKeys).toContain("invariants.continuation_required");
    expect(advisedKeys).toContain("invariants.preserve_lineage");
    expect(advisedKeys).toContain("invariants.closure_required");
    expect(advisedKeys).toContain("closure.{success,degraded,failed}");
    expect(advisedKeys).toContain("loop_guards.spawn_budget");
    expect(advisedKeys).toContain("skill_refs");
    // OPR.0.4.6.WF2: gates[] and next_hop.mode "prefer" graduated from
    // advisories to PARSE-REMOVALS (spec_gates_removed /
    // spec_prefer_mode_removed) — covered in workflow-wf2-spec-language.test.ts.
    for (const a of advisories) expect(a.severity).toBe("warning");
    // spawn_budget's advisory names the WF-2/WF-6 acceptance pointer.
    const spawn = advisories.find((a) => a.message.includes("spawn_budget"))!;
    expect(spawn.message).toContain("parallel-frontier");
  });

  it("a spec using only CONSUMED keys (max_hops, preferred_targets, allowed_exits) gets ZERO advisories", () => {
    const yaml = `workflow:
  id: fr9-clean
  version: 1
  roles:
    worker:
      preferred_targets:
        - worker@rig
  steps:
    - id: only
      actor_role: worker
      allowed_exits:
        - done
  invariants:
    allowed_exits: [handoff, waiting, done, failed]
  loop_guards:
    max_hops: 5
`;
    const { advisories } = advisoriesFor(yaml);
    expect(advisories).toEqual([]);
  });
});
