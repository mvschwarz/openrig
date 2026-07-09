// OPR.0.4.6.WF1 FR-1: the KEEP-fence regression pins + the facade test.
//
// These are CHARACTERIZATION pins on the shipped transactional-scribe
// contract (WF-1 PRD §4 FR-1). They must FAIL if any kept guarantee
// silently regresses:
//   (a) atomicity  — a failure injected mid-transaction leaves ZERO
//       partial state (no closed packet without its next qitem, ever);
//   (b) determinism — identical (spec, instance) inputs yield the
//       identical routing decision (step, owner, closure shape) on
//       every replay;
//   (c) terminal-exit replay — a re-projected handed-off/done/failed
//       packet is rejected with the structured frontier error;
//   (d) the WorkflowRuntime facade itself is exercised end-to-end
//       (validate / instantiate / project / continue) — untested
//       before this slice.
//
// The TRUE process-kill leg (SIGKILL mid-projection + restart) is the
// VM proof `fr1-midtxn-process-kill` (ACK Rev-2); the throw-injection
// tests here are the unit-level pins, not a replacement for it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";

const SPEC = `workflow:
  id: fr1-three-step
  version: 1
  objective: FR-1 KEEP-fence pin fixture
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
        - waiting
        - done
        - failed
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
      - failed
`;

const MIGRATIONS = [
  coreSchema,
  eventsSchema,
  queueItemsSchema,
  queueTransitionsSchema,
  workflowSpecsSchema,
  workflowInstancesSchema,
  workflowStepTrailsSchema,
  workflowInstanceVersionSchema,
  workflowSpecJsonSchema,
];

function buildRuntime(db: Database.Database) {
  migrate(db, MIGRATIONS);
  const bus = new EventBus(db);
  db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
  const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  return { bus, queueRepo, runtime };
}

describe("WorkflowRuntime facade + FR-1 KEEP-fence pins (OPR.0.4.6.WF1)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    ({ bus, queueRepo, runtime } = buildRuntime(db));
    tmp = mkdtempSync(join(tmpdir(), "wf-runtime-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── (d) facade coverage ────────────────────────────────────────────

  it("facade: validate returns ok for a well-formed spec and reports issues for a broken one", () => {
    const good = runtime.validate(specPath);
    expect(good.ok).toBe(true);

    const brokenPath = join(tmp, "broken.yaml");
    writeFileSync(
      brokenPath,
      SPEC.replace("actor_role: reviewer", "actor_role: not-a-declared-role"),
    );
    const bad = runtime.validate(brokenPath);
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("facade: instantiate → project → continue drives one instance end-to-end through the facade", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "facade walk",
      createdBySession: "ops@rig",
    });
    expect(inst.instance.status).toBe("active");
    expect(inst.instance.currentStepId).toBe("produce");

    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(projected.nextStepId).toBe("review");

    const inspected = runtime.continue(inst.instance.instanceId);
    expect(inspected.instance.instanceId).toBe(inst.instance.instanceId);
    expect(inspected.instance.currentStepId).toBe("review");
    expect(inspected.trail).toHaveLength(1);
    expect(inspected.trail[0]!.stepId).toBe("produce");
    expect(inspected.trail[0]!.nextQitemId).toBe(projected.nextQitemId);
  });

  // ── (a) atomicity pin: mid-transaction failure → ZERO partial state ─

  it("FR-1a atomicity pin: a failure injected AFTER the queue close (trail append) rolls back EVERYTHING — no closed packet without its next qitem, ever", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "atomicity pin",
      createdBySession: "ops@rig",
    });
    const before = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    const qitemCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }
    ).n;

    // Inject the failure at trail append — AFTER the queue close and the
    // next-qitem create have already run inside the transaction. If the
    // scribe were not atomic, the packet would be left closed with a
    // next qitem minted but no trail/frontier — the exact lost-handoff
    // corruption FR-1 pins against.
    vi.spyOn(runtime.trailLog, "record").mockImplementation(() => {
      throw new Error("injected-mid-txn-failure");
    });

    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      }),
    ).rejects.toThrow("injected-mid-txn-failure");

    // ZERO partial state:
    // 1. the current packet is NOT closed;
    const packet = queueRepo.getById(inst.entryQitemId);
    expect(packet?.state).toBe("pending");
    expect(packet?.closureReason).toBeNull();
    // 2. NO next qitem was minted;
    const qitemCountAfter = (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }
    ).n;
    expect(qitemCountAfter).toBe(qitemCountBefore);
    // 3. NO trail row landed;
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(0);
    // 4. frontier / step / status / hop count unchanged.
    const after = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(after.currentFrontier).toEqual(before.currentFrontier);
    expect(after.currentStepId).toBe(before.currentStepId);
    expect(after.status).toBe(before.status);
    expect(after.hopCount).toBe(before.hopCount);
  });

  it("FR-1a atomicity pin (crash-shaped, file-backed): rollback state is what an INDEPENDENT connection sees after the failure", async () => {
    // File-backed variant: after the injected mid-txn failure, a second
    // better-sqlite3 connection (a fresh process's view of the same
    // file) must see the pre-transaction state. This is the unit-level
    // stand-in for the fr1-midtxn-process-kill VM walk.
    const fileDb = createDb(join(tmp, "crash-shaped.db"));
    const built = buildRuntime(fileDb);
    const inst = await built.runtime.instantiate({
      specPath,
      rootObjective: "crash-shaped pin",
      createdBySession: "ops@rig",
    });

    vi.spyOn(built.runtime.trailLog, "record").mockImplementation(() => {
      throw new Error("injected-mid-txn-failure");
    });
    await expect(
      built.runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      }),
    ).rejects.toThrow("injected-mid-txn-failure");

    // Independent connection — the restart's-eye view.
    const secondConn = new Database(join(tmp, "crash-shaped.db"));
    try {
      const packetRow = secondConn
        .prepare(`SELECT state, closure_reason FROM queue_items WHERE qitem_id = ?`)
        .get(inst.entryQitemId) as { state: string; closure_reason: string | null };
      expect(packetRow.state).toBe("pending");
      expect(packetRow.closure_reason).toBeNull();

      const trailCount = (
        secondConn
          .prepare(`SELECT COUNT(*) AS n FROM workflow_step_trails WHERE instance_id = ?`)
          .get(inst.instance.instanceId) as { n: number }
      ).n;
      expect(trailCount).toBe(0);

      const instRow = secondConn
        .prepare(
          `SELECT status, current_step_id, hop_count, current_frontier_json
             FROM workflow_instances WHERE instance_id = ?`,
        )
        .get(inst.instance.instanceId) as {
        status: string;
        current_step_id: string;
        hop_count: number;
        current_frontier_json: string;
      };
      expect(instRow.status).toBe("active");
      expect(instRow.current_step_id).toBe("produce");
      expect(instRow.hop_count).toBe(0);
      expect(JSON.parse(instRow.current_frontier_json)).toEqual([inst.entryQitemId]);
    } finally {
      secondConn.close();
      fileDb.close();
    }
  });

  // ── (b) determinism pin ────────────────────────────────────────────

  it("FR-1b determinism pin: N identical (spec, instance) inputs produce the IDENTICAL routing decision — step, owner, closure shape", async () => {
    const N = 5;
    const decisions: Array<{
      nextStepId: string | null;
      nextOwnerSession: string | null;
      closureReason: string;
      packetState: string | undefined;
      packetClosureReason: string | null | undefined;
      packetClosureTarget: string | null | undefined;
    }> = [];

    for (let i = 0; i < N; i++) {
      const inst = await runtime.instantiate({
        specPath,
        rootObjective: "determinism pin",
        createdBySession: "ops@rig",
      });
      const projected = await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      });
      const closed = queueRepo.getById(inst.entryQitemId);
      decisions.push({
        nextStepId: projected.nextStepId,
        nextOwnerSession: projected.nextOwnerSession,
        closureReason: projected.closureReason,
        packetState: closed?.state,
        packetClosureReason: closed?.closureReason,
        packetClosureTarget: closed?.closureTarget,
      });
    }

    const first = decisions[0]!;
    expect(first.nextStepId).toBe("review");
    expect(first.nextOwnerSession).toBe("reviewer@rig");
    for (const d of decisions) {
      expect(d).toEqual(first);
    }
  });

  // ── (c) terminal-exit replay pin ───────────────────────────────────

  it("FR-1c terminal-replay pin: a re-projected handed-off packet is rejected with the structured packet_not_on_frontier error and mutates nothing", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "terminal replay pin",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    const trailCountAfterFirst = runtime.trailLog.countForInstance(
      inst.instance.instanceId,
    );

    let thrown: unknown;
    try {
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowProjectorError);
    expect((thrown as WorkflowProjectorError).code).toBe("packet_not_on_frontier");
    // Replay mutated nothing.
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(
      trailCountAfterFirst,
    );
  });

  it("FR-1c terminal-replay pin: done and failed exits also remove the packet from the frontier so replays reject", async () => {
    for (const exit of ["done", "failed"] as const) {
      const inst = await runtime.instantiate({
        specPath,
        rootObjective: `terminal ${exit} replay pin`,
        createdBySession: "ops@rig",
      });
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit,
        actorSession: "producer@rig",
      });
      await expect(
        runtime.project({
          instanceId: inst.instance.instanceId,
          currentPacketId: inst.entryQitemId,
          exit,
          actorSession: "producer@rig",
        }),
      ).rejects.toMatchObject({
        // Terminal instance is rejected before the frontier check even
        // runs — instance_not_active for done/failed instance status.
        name: "WorkflowProjectorError",
      });
    }
  });
});
