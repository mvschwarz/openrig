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
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "../src/db/migrations/052_workflow_instance_bound_rig.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";

// OPR.0.4.6.FAC1 commit 2 — the instance is bound to a rig at
// instantiation (AC-1; ARCH Q4; migration 052).
//
// The binding contract:
//   effective = input.targetRig ?? spec.target.rig ?? null
//   - the spec's target.rig is a DEFAULT the instantiate param overrides;
//   - null = unbound = byte-identical pre-FAC-1 behavior;
//   - a named rig must EXIST at instantiate (`bound_rig_unknown`, loud,
//     structured, BEFORE any mutation — no instance row is created);
//   - the binding persists the rig NAME (Q4: the durable operator-space
//     coordinate) on workflow_instances.bound_rig.

const SPEC_WITH_DEFAULT = `workflow:
  id: fac1-default-rig
  version: 1
  objective: bound-rig default test
  target:
    rig: factory-a
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - worker@rig
  steps:
    - id: act
      actor_role: worker
      allowed_exits:
        - handoff
        - done
`;

const SPEC_NO_TARGET = `workflow:
  id: fac1-no-target
  version: 1
  objective: unbound test
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - worker@rig
  steps:
    - id: act
      actor_role: worker
      allowed_exits:
        - done
`;

const ALL_MIGRATIONS = [
  coreSchema,
  eventsSchema,
  queueItemsSchema,
  queueTransitionsSchema,
  workflowSpecsSchema,
  workflowInstancesSchema,
  workflowStepTrailsSchema,
  workflowInstanceVersionSchema,
  workflowSpecJsonSchema,
  workflowResumeSchema,
  workflowInstanceBoundRigSchema,
];

describe("FAC-1 C2: workflow instance bound rig (migration 052)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let defaultSpecPath: string;
  let noTargetSpecPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    // Registered rigs: the spec default (factory-a), the override target
    // (factory-b), and the queue-destination rig for worker@rig.
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-a', 'factory-a')`).run();
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-b', 'factory-b')`).run();
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    tmp = mkdtempSync(join(tmpdir(), "wf-boundrig-"));
    defaultSpecPath = join(tmp, "default-rig.yaml");
    writeFileSync(defaultSpecPath, SPEC_WITH_DEFAULT);
    noTargetSpecPath = join(tmp, "no-target.yaml");
    writeFileSync(noTargetSpecPath, SPEC_NO_TARGET);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function boundRigColumn(instanceId: string): string | null {
    const row = db
      .prepare(`SELECT bound_rig FROM workflow_instances WHERE instance_id = ?`)
      .get(instanceId) as { bound_rig: string | null } | undefined;
    expect(row).toBeDefined();
    return row!.bound_rig;
  }

  it("default-from-spec: no override → boundRig = spec target.rig, persisted as the NAME", async () => {
    const result = await runtime.instantiate({
      specPath: defaultSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
    });
    expect(result.instance.boundRig).toBe("factory-a");
    expect(boundRigColumn(result.instance.instanceId)).toBe("factory-a");
    // A resolvable spec-default binds cleanly — no advisory.
    expect(result.advisories).toEqual([]);
  });

  it("override-wins: instantiate targetRig beats the spec default (default-with-override, AC-1)", async () => {
    const result = await runtime.instantiate({
      specPath: defaultSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
      targetRig: "factory-b",
    });
    expect(result.instance.boundRig).toBe("factory-b");
    expect(boundRigColumn(result.instance.instanceId)).toBe("factory-b");
  });

  it("null-unbound: no spec default and no override → boundRig null (today's behavior byte-identical)", async () => {
    const result = await runtime.instantiate({
      specPath: noTargetSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
    });
    expect(result.instance.boundRig).toBeNull();
    expect(boundRigColumn(result.instance.instanceId)).toBeNull();
    // Unbound with no bad default — no advisory.
    expect(result.advisories).toEqual([]);
  });

  // AUTHORITATIVE-PATH NEGATIVE (guard-critical, arch ruling 2026-07-07):
  // an explicit operator `--rig X` (input.targetRig) is authoritative — an
  // unknown X HARD-FAILS `bound_rig_unknown` and must NEVER enter the
  // spec-default degrade branch. This is the named negative the narrow
  // guard confirm checks (the provenance split must not soften the
  // explicit demand). Contrast with the spec-default degrade test below.
  it("explicit --rig unknown STILL hard-fails bound_rig_unknown BEFORE any mutation (never degrades)", async () => {
    const before = db.prepare(`SELECT COUNT(*) as c FROM workflow_instances`).get() as { c: number };
    let thrown: unknown;
    try {
      await runtime.instantiate({
        specPath: noTargetSpecPath,
        rootObjective: "test",
        createdBySession: "orch@rig",
        targetRig: "no-such-rig",
      });
    } catch (err) {
      thrown = err;
    }
    // It THREW (did not degrade to an unbound result with an advisory).
    expect(thrown).toBeInstanceOf(WorkflowProjectorError);
    const e = thrown as WorkflowProjectorError;
    expect(e.code).toBe("bound_rig_unknown");
    // The what/why/fix contract: names the rig, lists registered rigs.
    expect(e.message).toContain("no-such-rig");
    expect(e.message).toContain("factory-a");
    expect((e.details?.["registeredRigs"] as string[]) ?? []).toContain("factory-b");
    // No instance row was created (validation-before-mutation).
    const after = db.prepare(`SELECT COUNT(*) as c FROM workflow_instances`).get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  // Guard the other direction too: an explicit --rig that DOES exist,
  // over a spec whose default is BAD, binds to the explicit rig and emits
  // NO advisory (the explicit demand is honored; the bad default is moot).
  it("explicit --rig (known) over a bad spec-default binds explicitly, no advisory", async () => {
    const badSpecPath = join(tmp, "bad-default-explicit.yaml");
    writeFileSync(badSpecPath, SPEC_WITH_DEFAULT.replace("rig: factory-a", "rig: vanished-rig"));
    const result = await runtime.instantiate({
      specPath: badSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
      targetRig: "factory-b",
    });
    expect(result.instance.boundRig).toBe("factory-b");
    expect(result.advisories).toEqual([]);
  });

  // OPR.0.4.6.FAC1 arch ruling 2026-07-07 (target-rig zero-regression,
  // "Option A refined by PROVENANCE"): an unknown SPEC-DEFAULT target.rig
  // is ADVISORY, not authoritative — it DEGRADES to unbound with a loud
  // advisory rather than hard-failing. (Prior behavior asserted here was
  // an AC-1 zero-regression violation: shipped builtins like `conveyor`
  // declare target.rig AND route via preferred_targets, so a hard-fail on
  // the default would regress a shipped spec's instantiate.) The explicit
  // `--rig` path keeps its hard-fail — see the authoritative-negative test
  // above. SPEC_WITH_DEFAULT declares preferred_targets: [worker@rig] and
  // `rig` is registered, so the unbound instance still routes and succeeds.
  it("spec-default unknown DEGRADES to unbound + a LOUD advisory (advisory provenance, not a hard-fail)", async () => {
    const badSpecPath = join(tmp, "bad-default.yaml");
    writeFileSync(badSpecPath, SPEC_WITH_DEFAULT.replace("rig: factory-a", "rig: vanished-rig"));
    const before = db.prepare(`SELECT COUNT(*) as c FROM workflow_instances`).get() as { c: number };
    const result = await runtime.instantiate({
      specPath: badSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
    });
    // Degrades to unbound (routes via preferred_targets — byte-identical
    // pre-FAC-1 behavior for a spec that carries a descriptive target.rig).
    expect(result.instance.boundRig).toBeNull();
    expect(boundRigColumn(result.instance.instanceId)).toBeNull();
    // The advisory is genuinely LOUD (guard invariant): it names the
    // absent default rig AND the unbound consequence — never silent.
    expect(result.advisories.length).toBeGreaterThan(0);
    const advisory = result.advisories.join(" ");
    expect(advisory).toContain("vanished-rig");
    expect(advisory).toContain("UNBOUND");
    // The instance WAS created (degrade, not fail).
    const after = db.prepare(`SELECT COUNT(*) as c FROM workflow_instances`).get() as { c: number };
    expect(after.c).toBe(before.c + 1);
  });

  it("legacy-fixture degrade: without migration 052 the store's column probe keeps the legacy INSERT (boundRig reads null, nothing crashes)", () => {
    const legacyDb = createDb();
    migrate(legacyDb, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
    ]);
    const store = new WorkflowInstanceStore(legacyDb);
    const instance = store.create({
      workflowName: "legacy",
      workflowVersion: "1",
      createdBySession: "orch@rig",
      boundRig: "factory-a", // silently untracked pre-052 — the probe degrades
    });
    expect(instance.boundRig).toBeNull();
    legacyDb.close();
  });
});
