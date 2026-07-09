// OPR.0.4.6.WF1 FR-2 (G1) + FR-6 (G4): the deadline evaluator + the
// max_hops guard.
//
// FR-2: the pure evaluator's four-sub-state anchor classification
// (claimed-with-deadline / claimed-null-deadline / never-claimed /
// unclaimed-after-claim) — stuck is DERIVED, never stored; a normal
// re-projection self-clears it. Includes the arch-required NAMED test
// for the claimed → unclaimed → overdue path (third-state note,
// ACK Rev-1), exercised through REAL queue rows.
//
// FR-6: loop_guards.max_hops is COMPARED at projection (migration
// 034's comment made true): exceeding it converts the handoff into an
// honest structured failure — packet closed, instance failed, guard
// evidence in trail + event — and specs under budget see ZERO guard
// observability.

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
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import {
  evaluateStepDeadline,
  exceedsMaxHops,
  MAX_HOPS_BASELINE_V1,
  WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS,
} from "../src/domain/workflow-deadline.js";
import type { WorkflowInstance } from "../src/domain/workflow-types.js";

// ── pure-evaluator fixtures ──────────────────────────────────────────

const T0 = new Date("2026-07-06T00:00:00.000Z");
const THRESHOLD_MS = WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS * 1000;

function fakeInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    instanceId: "inst-1",
    workflowName: "wf",
    workflowVersion: "1",
    createdBySession: "ops@rig",
    createdAt: T0.toISOString(),
    status: "active",
    currentFrontier: ["q-1"],
    currentStepId: "step-a",
    hopCount: 0,
    fallbackSynthesis: null,
    lastContinuationDecision: null,
    completedAt: null,
    ...overrides,
  };
}

function fakePacket(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    qitemId: "q-1",
    tsCreated: T0.toISOString(),
    tsUpdated: T0.toISOString(),
    sourceSession: "ops@rig",
    destinationSession: "owner@rig",
    state: "pending",
    priority: "routine",
    tier: "mode2",
    tags: [],
    blockedOn: null,
    handedOffTo: null,
    handedOffFrom: null,
    expiresAt: null,
    closureReason: null,
    closureTarget: null,
    closureRequiredAt: null,
    claimedAt: null,
    lastNudgeAttempt: null,
    lastNudgeResult: null,
    lastHeartbeat: null,
    resolution: null,
    chainOfRecord: [],
    body: "",
    summary: null,
    evidenceRef: null,
    targetRepo: null,
    ...overrides,
  } as QueueItem;
}

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

describe("evaluateStepDeadline (FR-2 — the four-sub-state anchor classification)", () => {
  it("sub-state 1 (claimed WITH closure_required_at): overdue-claimed once the deadline passes, healthy before", () => {
    const deadline = at(T0, 15 * 60 * 1000).toISOString();
    const packet = fakePacket({
      state: "in-progress",
      claimedAt: T0.toISOString(),
      closureRequiredAt: deadline,
    });
    const inst = fakeInstance();

    const before = evaluateStepDeadline(inst, [packet], at(T0, 14 * 60 * 1000));
    expect(before.state).toBe("healthy");

    const after = evaluateStepDeadline(inst, [packet], at(T0, 16 * 60 * 1000));
    expect(after.state).toBe("overdue-claimed");
    expect(after.evidence?.anchor).toBe("closure_required_at");
    expect(after.evidence?.ownerSession).toBe("owner@rig");
    expect(after.evidence?.stepId).toBe("step-a");
    expect(after.evidence?.overdueBySeconds).toBe(60);
  });

  it("sub-state 2 (claimed with NULL closure_required_at — the mode2 reality): anchors on claimed_at + threshold", () => {
    const claimedAt = at(T0, 60_000).toISOString();
    const packet = fakePacket({
      state: "in-progress",
      claimedAt,
      closureRequiredAt: null,
    });
    const inst = fakeInstance();

    const justBefore = evaluateStepDeadline(
      inst,
      [packet],
      at(T0, 60_000 + THRESHOLD_MS - 1000),
    );
    expect(justBefore.state).toBe("healthy");

    const after = evaluateStepDeadline(
      inst,
      [packet],
      at(T0, 60_000 + THRESHOLD_MS + 1000),
    );
    expect(after.state).toBe("overdue-claimed");
    expect(after.evidence?.anchor).toBe("claimed_at");
    expect(after.evidence?.claimedAt).toBe(claimedAt);
  });

  it("sub-state 3 (never-claimed — the dead-seat-BEFORE-claim / lost-nudge case): anchors on created_at + threshold", () => {
    const packet = fakePacket({ state: "pending" });
    const inst = fakeInstance();

    expect(
      evaluateStepDeadline(inst, [packet], at(T0, THRESHOLD_MS - 1000)).state,
    ).toBe("healthy");

    const verdict = evaluateStepDeadline(inst, [packet], at(T0, THRESHOLD_MS + 5000));
    expect(verdict.state).toBe("overdue-unclaimed");
    expect(verdict.evidence?.anchor).toBe("created_at");
    expect(verdict.evidence?.claimedAt).toBeNull();
    expect(verdict.evidence?.ageSeconds).toBeGreaterThanOrEqual(
      WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS,
    );
  });

  it("a blocked (waiting-park) frontier packet is HEALTHY — park-duration policy is WF-5's lane", () => {
    const packet = fakePacket({ state: "blocked", blockedOn: "external-gate" });
    const inst = fakeInstance({ status: "waiting" });
    const verdict = evaluateStepDeadline(inst, [packet], at(T0, 10 * THRESHOLD_MS));
    expect(verdict.state).toBe("healthy");
  });

  it("terminal instances are always healthy; empty frontier is healthy; packets not on the frontier are ignored", () => {
    const oldPacket = fakePacket({ state: "pending" });
    expect(
      evaluateStepDeadline(
        fakeInstance({ status: "completed" }),
        [oldPacket],
        at(T0, 10 * THRESHOLD_MS),
      ).state,
    ).toBe("healthy");
    expect(
      evaluateStepDeadline(fakeInstance({ currentFrontier: [] }), [], at(T0, 10 * THRESHOLD_MS))
        .state,
    ).toBe("healthy");
    expect(
      evaluateStepDeadline(
        fakeInstance({ currentFrontier: ["some-other-packet"] }),
        [oldPacket],
        at(T0, 10 * THRESHOLD_MS),
      ).state,
    ).toBe("healthy");
  });
});

// ── real-row integration: the arch-NAMED third-state test ───────────

const SPEC = `workflow:
  id: fr2-deadline
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

describe("FR-2 named test: claimed → unclaimed → overdue (the arch third state, REAL queue rows)", () => {
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
    tmp = mkdtempSync(join(tmpdir(), "wf-deadline-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a claimed-then-unclaimed frontier packet classifies overdue-unclaimed on the created_at anchor (may surface IMMEDIATELY after unclaim — safe direction), and a normal re-projection self-clears", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "third-state walk",
      createdBySession: "ops@rig",
    });

    // Claim, then unclaim — the unclaim NULLs claimed_at AND
    // closure_required_at (queue-repository :908-917), leaving the row
    // indistinguishable from never-claimed.
    queueRepo.claim({ qitemId: inst.entryQitemId, destinationSession: "worker@rig" });
    const claimed = queueRepo.getById(inst.entryQitemId)!;
    expect(claimed.state).toBe("in-progress");
    queueRepo.unclaim(inst.entryQitemId, "worker@rig", "seat died mid-claim");
    const unclaimed = queueRepo.getById(inst.entryQitemId)!;
    expect(unclaimed.state).toBe("pending");
    expect(unclaimed.claimedAt).toBeNull();
    expect(unclaimed.closureRequiredAt).toBeNull();

    const instance = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);

    // The created_at anchor INCLUDES the elapsed claimed period: at
    // created_at + threshold the packet is overdue even though the
    // unclaim just happened.
    const past = new Date(
      new Date(unclaimed.tsCreated).getTime() + THRESHOLD_MS + 1000,
    );
    const verdict = evaluateStepDeadline(instance, [unclaimed], past);
    expect(verdict.state).toBe("overdue-unclaimed");
    expect(verdict.evidence?.anchor).toBe("created_at");
    expect(verdict.evidence?.packetId).toBe(inst.entryQitemId);

    // Self-clearing: the owner recovers and projects normally — the
    // instance's NEW frontier packet is fresh, so recomposition reads
    // healthy with no hand-clearing (stuck was never stored).
    const projected = await runtime.project({
      instanceId: instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    const advanced = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
    const nextPacket = queueRepo.getById(projected.nextQitemId!)!;
    const after = evaluateStepDeadline(advanced, [nextPacket], new Date(nextPacket.tsCreated));
    expect(after.state).toBe("healthy");
  });
});

// ── FR-6: max_hops enforcement ───────────────────────────────────────

const CYCLIC_SPEC = `workflow:
  id: fr6-cycle
  version: 1
  entry:
    role: ping
  roles:
    ping:
      preferred_targets:
        - ping@rig
    pong:
      preferred_targets:
        - pong@rig
  steps:
    - id: ping-step
      actor_role: ping
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - pong
    - id: pong-step
      actor_role: pong
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - ping
  loop_guards:
    max_hops: 3
`;

describe("FR-6: loop_guards.max_hops enforced at projection (G4 — migration 034's comment made true)", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let events: Array<Record<string, unknown> & { type: string }>;

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
    events = [];
    bus.subscribe((e) => events.push(e as never));
    tmp = mkdtempSync(join(tmpdir(), "wf-maxhops-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exceedsMaxHops helper: undefined guard never trips; baseline offsets the window (arch N1 seam for WF-5 resume)", () => {
    expect(exceedsMaxHops(999, MAX_HOPS_BASELINE_V1, undefined)).toBe(false);
    expect(exceedsMaxHops(2, 0, 3)).toBe(false); // hop 3 of 3 — allowed
    expect(exceedsMaxHops(3, 0, 3)).toBe(true); // hop 4 — over
    // A WF-5-style redrive amends the baseline: same hopCount, fresh window.
    expect(exceedsMaxHops(3, 3, 3)).toBe(false);
  });

  it("a cyclic spec loops until max_hops, then the NEXT handoff converts to an honest structured failure: packet closed, instance failed, guard evidence in trail + workflow.failed event", async () => {
    const specPath = join(tmp, "cycle.yaml");
    writeFileSync(specPath, CYCLIC_SPEC);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "loop until the guard",
      createdBySession: "ops@rig",
    });

    // Hops 1..3 succeed (max_hops: 3).
    let packetId = inst.entryQitemId;
    const owners = ["ping@rig", "pong@rig", "ping@rig"];
    for (let hop = 0; hop < 3; hop++) {
      const projected = await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: packetId,
        exit: "handoff",
        actorSession: owners[hop]!,
      });
      expect(projected.closureReason).toBe("handoff");
      expect(projected.nextQitemId).not.toBeNull();
      packetId = projected.nextQitemId!;
    }
    const atBudget = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(atBudget.hopCount).toBe(3);
    expect(atBudget.status).toBe("active");

    // Hop 4 attempt: the guard trips. The projection SUCCEEDS as an
    // honest failure — never a thrown loop, never a parked potato.
    const tripped = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "pong@rig",
    });
    expect(tripped.closureReason).toBe("failed");
    expect(tripped.nextQitemId).toBeNull();

    // Instance failed honestly; step cleared; hop count NOT bumped.
    const failed = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(failed.status).toBe("failed");
    expect(failed.currentStepId).toBeNull();
    expect(failed.hopCount).toBe(3);

    // The frontier owner's packet closed honestly (BR-3 failed shape).
    const closed = queueRepo.getById(packetId)!;
    expect(closed.state).toBe("done");
    expect(closed.closureReason).toBe("denied");
    expect(String(closed.closureTarget)).toContain("max_hops_exceeded");

    // Trail records the guard evidence.
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    const guardRow = trail.find((t) => t.closureReason === "failed")!;
    expect(guardRow).toBeDefined();
    const guard = guardRow.closureEvidence?.max_hops_guard as Record<string, unknown>;
    expect(guard?.code).toBe("max_hops_exceeded");
    expect(guard?.maxHops).toBe(3);
    expect(guard?.attemptedHop).toBe(4);

    // workflow.failed emitted with the guard named.
    const failedEvent = events.find((e) => e.type === "workflow.failed");
    expect(failedEvent).toBeDefined();
    expect(String((failedEvent as Record<string, unknown>).reason)).toContain(
      "max_hops_exceeded",
    );
  });

  it("zero guard observability: an UNGUARDED LINEAR spec routes with no guard fields anywhere, and a guarded spec under budget shows none either (happy path unchanged)", async () => {
    // Unguarded specs must be acyclic post-FR-7 (an unguarded cycle no
    // longer validates — by design), so the no-guard case is linear.
    const linearSpec = `workflow:
  id: fr6-linear
  version: 1
  entry:
    role: ping
  roles:
    ping:
      preferred_targets:
        - ping@rig
    pong:
      preferred_targets:
        - pong@rig
  steps:
    - id: first
      actor_role: ping
      allowed_exits:
        - handoff
    - id: second
      actor_role: pong
      allowed_exits:
        - handoff
    - id: last
      actor_role: ping
      allowed_exits:
        - done
`;
    expect(linearSpec).not.toContain("loop_guards");
    const specPath = join(tmp, "plain.yaml");
    writeFileSync(specPath, linearSpec);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "no guard declared",
      createdBySession: "ops@rig",
    });
    let packetId = inst.entryQitemId;
    const owners = ["ping@rig", "pong@rig"];
    for (let hop = 0; hop < 2; hop++) {
      const projected = await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: packetId,
        exit: "handoff",
        actorSession: owners[hop]!,
      });
      expect(projected.closureReason).toBe("handoff");
      packetId = projected.nextQitemId!;
    }
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    expect(trail.length).toBeGreaterThan(0);
    for (const row of trail) {
      expect(row.closureEvidence?.max_hops_guard).toBeUndefined();
    }
    // Guarded-under-budget: the cyclic fixture's hops 1..3 in the trip
    // test above already assert closureReason handoff with no guard
    // evidence until the budget is exceeded.
  });
});

// ── the arch-named honest-degrade test (mid-build contract fold #2) ──

import {
  WorkflowSpecCache,
  resetLegacyRehydrationWarnings,
} from "../src/domain/workflow-spec-cache.js";

describe("legacy pre-050 rehydration degrades VISIBLY, never a silent no-guards run", () => {
  it("a pre-050 cache row resolved via getByNameVersion warns once naming the missing fidelity + the heal path", () => {
    const legacyDb = createDb();
    // Deliberately WITHOUT migration 050 — the legacy fixture shape.
    migrate(legacyDb, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
    ]);
    const cache = new WorkflowSpecCache(legacyDb);
    const legacyTmp = mkdtempSync(join(tmpdir(), "wf-legacy-"));
    const legacySpecPath = join(legacyTmp, "legacy.yaml");
    writeFileSync(legacySpecPath, CYCLIC_SPEC);
    try {
      resetLegacyRehydrationWarnings();
      cache.readThrough(legacySpecPath);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const row = cache.getByNameVersion("fr6-cycle", "1");
      // Honest degrade: guards absent AND the advisory fired.
      expect(row?.spec.loop_guards).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("WITHOUT full fidelity");
      expect(String(warnSpy.mock.calls[0]![0])).toContain("fr6-cycle@1");
      // Once per spec per process — a second read stays quiet.
      cache.getByNameVersion("fr6-cycle", "1");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    } finally {
      legacyDb.close();
      rmSync(legacyTmp, { recursive: true, force: true });
    }
  });
});
