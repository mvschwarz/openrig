// OPR.0.4.6.WF1 FR-5 (G3): real idempotency — the waiting-replay hole
// closed by ABSORPTION under the guard-ratified FULL CLOSURE-INTENT
// IDENTITY (G-WF1-1), plus the optimistic-concurrency version guard.
//
// The guard-named test set (ACK Rev-2 / plan commit 5):
//   (a) different blockedOn      → NEW decision recorded (new trail row)
//   (b) different resultNote     → NEW decision recorded
//   (c) different actorSession   → NEW decision recorded
//   (d) different closureEvidence→ NEW decision recorded
//   (e) EXACT replay             → ABSORBED: one trail row, same outcome
//   (f) terminal replay          → the 409 stands unchanged (FR-1c)
//
// Version guard: a stale writer (read version N, another writer commits
// N+1) throws structured instance_version_conflict naming
// expected/actual and its WHOLE transaction rolls back.

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
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowInstanceError } from "../src/domain/workflow-instance-store.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";

const SPEC = `workflow:
  id: fr5-replay
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
`;

describe("FR-5: waiting-replay absorption + the version guard", () => {
  let db: Database.Database;
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
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-replay-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function instantiateAndPark(evidence?: Record<string, unknown>) {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "replay walk",
      createdBySession: "ops@rig",
    });
    const first = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      resultNote: "parked for the gate",
      blockedOn: "gate-x",
      closureEvidence: evidence,
    });
    return { inst, first };
  }

  it("(e) EXACT replay → ABSORBED: zero writes, one trail row, same recorded outcome, version un-bumped", async () => {
    const { inst, first } = await instantiateAndPark({ note: "evidence-1" });
    const versionAfterFirst = runtime.instanceStore.getByIdOrThrow(
      inst.instance.instanceId,
    ).version;
    const trailAfterFirst = runtime.trailLog.countForInstance(inst.instance.instanceId);

    const replay = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      resultNote: "parked for the gate",
      blockedOn: "gate-x",
      closureEvidence: { note: "evidence-1" },
    });
    expect(replay.absorbedReplay).toBe(true);
    expect(replay.closureReason).toBe("waiting");
    expect(replay.nextQitemId).toBe(first.nextQitemId); // both null
    // ZERO writes: one trail row, version un-bumped (DB-verifiable).
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(
      trailAfterFirst,
    );
    expect(
      runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId).version,
    ).toBe(versionAfterFirst);
  });

  it("(e2) the effective-blocker normalization: first park with NO blockedOn (defaults external-gate), replay naming external-gate explicitly → still an exact match, absorbed", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "normalization walk",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
    });
    const replay = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      blockedOn: "external-gate",
    });
    expect(replay.absorbedReplay).toBe(true);
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(1);
  });

  const NEGATIVES: Array<{
    label: string;
    mutate: (base: {
      resultNote: string;
      blockedOn: string;
      actorSession: string;
      closureEvidence: Record<string, unknown>;
    }) => Partial<{
      resultNote: string;
      blockedOn: string;
      actorSession: string;
      closureEvidence: Record<string, unknown>;
    }>;
  }> = [
    { label: "(a) different blockedOn", mutate: () => ({ blockedOn: "gate-y" }) },
    { label: "(b) different resultNote", mutate: () => ({ resultNote: "re-parked: new reason" }) },
    { label: "(c) different actorSession", mutate: () => ({ actorSession: "worker-replacement@rig" }) },
    {
      label: "(d) different closureEvidence",
      mutate: () => ({ closureEvidence: { note: "evidence-2", extra: true } }),
    },
  ];

  for (const { label, mutate } of NEGATIVES) {
    it(`${label} → a NEW legitimate decision recorded through the normal write path (second trail row, updated decision), never absorbed, never rejected`, async () => {
      const { inst } = await instantiateAndPark({ note: "evidence-1" });
      const base = {
        resultNote: "parked for the gate",
        blockedOn: "gate-x",
        actorSession: "worker@rig",
        closureEvidence: { note: "evidence-1" },
      };
      const changed = { ...base, ...mutate(base) };

      const second = await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "waiting",
        actorSession: changed.actorSession,
        resultNote: changed.resultNote,
        blockedOn: changed.blockedOn,
        closureEvidence: changed.closureEvidence,
      });
      expect(second.absorbedReplay).toBeUndefined();
      expect(second.closureReason).toBe("waiting");
      // Second trail row + updated stored decision.
      expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(2);
      const updated = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
      const decision = updated.lastContinuationDecision!;
      expect(decision.actorSession).toBe(changed.actorSession);
      expect(decision.resultNote).toBe(changed.resultNote);
      expect(decision.blockedOn).toBe(changed.blockedOn);
    });
  }

  it("(f) terminal replay → the shipped frontier 409 stands unchanged (FR-1c; absorption never touches the terminal guard)", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "terminal replay",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "worker@rig",
      }),
    ).rejects.toMatchObject({ code: "packet_not_on_frontier" });
  });

  it("version guard: a STALE writer (another writer advanced the instance after its read) throws structured instance_version_conflict and its whole transaction rolls back", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "race walk",
      createdBySession: "ops@rig",
    });

    // Writer A reads the instance state...
    const staleRead = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);

    // ...writer B commits an advance first (waiting park bumps version).
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      blockedOn: "gate-x",
    });
    const afterB = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(afterB.version).toBe(staleRead.version + 1);

    // Writer A now attempts its write with the stale expected version.
    let thrown: unknown;
    try {
      runtime.instanceStore.updateFrontier(
        inst.instance.instanceId,
        ["phantom-packet"],
        "active",
        { expectedVersion: staleRead.version },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowInstanceError);
    const conflict = thrown as WorkflowInstanceError;
    expect(conflict.code).toBe("instance_version_conflict");
    expect(conflict.details?.expectedVersion).toBe(staleRead.version);
    expect(conflict.details?.actualVersion).toBe(afterB.version);
    // Nothing changed under the failed guarded write.
    const final = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(final.currentFrontier).toEqual(afterB.currentFrontier);
    expect(final.version).toBe(afterB.version);
  });

  it("version guard at the projector: a stale instance read inside project() rolls the WHOLE scribe transaction back (no closed packet, no trail row)", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "projector race walk",
      createdBySession: "ops@rig",
    });

    // Simulate the race: project() reads the instance, then another
    // writer bumps the version before project()'s transaction runs.
    const realGet = runtime.instanceStore.getByIdOrThrow.bind(runtime.instanceStore);
    const spy = vi
      .spyOn(runtime.instanceStore, "getByIdOrThrow")
      .mockImplementationOnce((id: string) => {
        const current = realGet(id);
        // Out-of-band concurrent bump AFTER our stale read.
        db.prepare(
          `UPDATE workflow_instances SET version = version + 1 WHERE instance_id = ?`,
        ).run(id);
        return current; // the STALE view
      });

    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "worker@rig",
      }),
    ).rejects.toMatchObject({ code: "instance_version_conflict" });
    spy.mockRestore();

    // WHOLE-txn rollback: packet unclosed, no next qitem, no trail row.
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe("pending");
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(0);
    const qitemCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }
    ).n;
    expect(qitemCount).toBe(1); // only the entry packet
  });

  it("BR-2 stays true: WorkflowProjectorError is still what non-FR-5 rejections throw (sanity: absorbed vs rejected are distinct classes)", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "class sanity",
      createdBySession: "ops@rig",
    });
    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: "not-a-real-packet",
        exit: "waiting",
        actorSession: "worker@rig",
      }),
    ).rejects.toBeInstanceOf(WorkflowProjectorError);
  });
});
