import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "../src/db/migrations/052_workflow_instance_bound_rig.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "../src/domain/workflow-role-resolver.js";

// OPR.0.4.6.FAC1 commit 3 — the capability resolver (AC-2 core; BR-1/2/
// 3/5; ARCH Q1/Q2/Q3/Q5; GUARD B1-B4). Two layers here:
//   1. the PURE policy (selectRoleSeat) — behavior vectors (the full
//      determinism/permutation vector set is commit 4's);
//   2. the SIX owner-resolution call-site rows, each wired through a
//      REAL db (projector next-step · human-gate owner · handler-role
//      gate destination · entry · eager/structural · resume) + the Q3
//      exception-routing uniformity pass + vanished-rig honesty +
//      unbound byte-parity.

// ---------- layer 1: the pure policy ----------

function facts(over: Partial<RoleSeatCandidateFacts>): RoleSeatCandidateFacts {
  return {
    logicalId: "dev.x",
    role: "driver",
    nodeKind: "agent",
    lifecycleState: "running",
    runtime: "claude-code",
    pendingWorkCount: 0,
    coordinate: "dev-x@factory-a",
    rawSessionName: "dev-x@factory-a",
    ...over,
  };
}

describe("FAC-1 C3: selectRoleSeat (pure policy behavior)", () => {
  it("selects the qualified seat and names every decoy's disqualifier (the decoy axes)", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [
        facts({ logicalId: "dev.dead", coordinate: "dev-dead@f", rawSessionName: "dev-dead@f", lifecycleState: "detached" }),
        facts({ logicalId: "dev.wrongrt", coordinate: "dev-wrongrt@f", rawSessionName: "dev-wrongrt@f", runtime: "codex" }),
        facts({ logicalId: "dev.roleless", coordinate: "dev-roleless@f", rawSessionName: "dev-roleless@f", role: null }),
        facts({ logicalId: "dev.adopted", coordinate: "dev-adopted@f", rawSessionName: "my-raw-tmux" }),
        facts({ logicalId: "dev.good", coordinate: "dev-good@f", rawSessionName: "dev-good@f" }),
      ],
      harness: "claude-code",
    });
    expect(result.seat).toBe("dev-good@f");
    const byId = new Map(result.disqualified.map((d) => [d.logicalId, d.disqualifier]));
    expect(byId.get("dev.dead")).toBe("not_live(lifecycleState=detached)");
    expect(byId.get("dev.wrongrt")).toBe("runtime_mismatch(codex≠claude-code)");
    expect(byId.get("dev.roleless")).toBe("role_not_declared");
    expect(byId.get("dev.adopted")).toBe("adopted_seat_not_role_resolvable_v1");
  });

  it("unpinned steps accept any agent runtime; least pending backlog wins; coordinate codepoint breaks ties", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [
        facts({ logicalId: "a", coordinate: "dev-b@f", rawSessionName: "dev-b@f", pendingWorkCount: 2, runtime: "codex" }),
        facts({ logicalId: "b", coordinate: "dev-c@f", rawSessionName: "dev-c@f", pendingWorkCount: 0 }),
        facts({ logicalId: "c", coordinate: "dev-a@f", rawSessionName: "dev-a@f", pendingWorkCount: 0 }),
      ],
    });
    expect(result.seat).toBe("dev-a@f"); // 0-load tie → codepoint ascending
    expect(result.qualified.map((q) => q.coordinate)).toEqual(["dev-a@f", "dev-c@f", "dev-b@f"]);
  });

  it("returns seat=null with the full disqualified list when nothing qualifies", () => {
    const result = selectRoleSeat({
      role: "qa",
      candidates: [facts({ role: "qa", lifecycleState: "detached" })],
    });
    expect(result.seat).toBeNull();
    expect(result.disqualified).toHaveLength(1);
  });

  it("infrastructure/terminal nodes are out of scope entirely (never listed)", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [facts({ nodeKind: "infrastructure" })],
    });
    expect(result.seat).toBeNull();
    expect(result.disqualified).toHaveLength(0);
  });
});

// ---------- layer 2: the six call-site rows over a real db ----------

const ROLE_ONLY_SPEC = `workflow:
  id: fac1-role-only
  version: 1
  objective: role-only two-step flow
  target:
    rig: factory-a
  entry:
    role: planner
  roles:
    planner: {}
    driver: {}
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
        - failed
    - id: build
      actor_role: driver
      allowed_exits:
        - done
        - failed
`;

const HANDLER_GATE_SPEC = `workflow:
  id: fac1-handler-gate
  version: 1
  objective: role-only handler gate
  target:
    rig: factory-a
  entry:
    role: planner
  roles:
    planner: {}
    guard: {}
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
    - id: gatecheck
      actor_role: planner
      gate:
        target: guard
        summary: guard check
`;

const HUMAN_GATE_SPEC = `workflow:
  id: fac1-human-gate
  version: 1
  objective: role-only human gate
  entry:
    role: planner
  target:
    rig: factory-a
  roles:
    planner: {}
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
    - id: signoff
      actor_role: planner
      gate:
        target: human@kernel
        summary: sign this off
        evidence_ref: proof/x.md
`;

describe("FAC-1 C3: the six owner-resolution call sites on a bound rig", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let tmp: string;
  let rigAId: string;
  let sessionSeq = 0;

  function seedSeat(
    rigId: string,
    rigName: string,
    pod: string,
    member: string,
    opts: { role?: string; runtime?: string; sessionStatus?: string | null; rawName?: string },
  ): string {
    const podRec =
      podRepo.getPodByNamespace(rigId, pod) ?? podRepo.createPod(rigId, pod, pod);
    const node = rigRepo.addNode(rigId, `${pod}.${member}`, {
      role: opts.role,
      runtime: opts.runtime ?? "claude-code",
      cwd: "/tmp",
      podId: podRec.id,
      agentRef: "local:agents/x",
      profile: "default",
    });
    const coordinate = `${pod}-${member}@${rigName}`;
    if (opts.sessionStatus !== null) {
      sessionSeq += 1;
      db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)`).run(
        `s-${String(sessionSeq).padStart(4, "0")}`,
        node.id,
        opts.rawName ?? coordinate,
        opts.sessionStatus ?? "running",
      );
    }
    return coordinate;
  }

  function writeSpec(name: string, content: string): string {
    const p = join(tmp, name);
    writeFileSync(p, content);
    return p;
  }

  beforeEach(() => {
    db = createFullTestDb();
    // createFullTestDb carries the node/rig/queue set; the workflow
    // tables ride the canonical migration objects on top. 044/048 are
    // load-bearing for the human-gate park path (summary/evidence_ref
    // columns — VM-caught: without them the gate item's create-carried
    // summary silently drops and validateHumanPark fails at park).
    migrate(db, [
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
      workflowResumeSchema,
      workflowInstanceBoundRigSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    const rigA = rigRepo.createRig("factory-a");
    rigAId = rigA.id;
    tmp = mkdtempSync(join(tmpdir(), "wf-fac1-"));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ROW 3 + ROW 1: entry resolves live on the bound rig; the next step resolves-and-records at projection with owner_resolution trail evidence", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const driverSeat = seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);

    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "t",
      createdBySession: "orch@factory-a",
    });
    // ROW 3: entry resolved by capability (no preferred_targets anywhere).
    expect(inst.entryOwnerSession).toBe("dev-planner1@factory-a");
    expect(inst.instance.boundRig).toBe("factory-a");

    // ROW 1: projector next-step resolves the driver role and RECORDS it.
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(driverSeat);
    const packet = queueRepo.getById(projected.nextQitemId!);
    expect(packet?.destinationSession).toBe(driverSeat);
    // owner_resolution trail evidence (mode=role, boundRig named).
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    const evidence = trail.find((t) => t.priorQitemId === inst.entryQitemId)?.closureEvidence as
      | Record<string, Record<string, unknown>>
      | null;
    expect(evidence?.["owner_resolution"]).toMatchObject({
      mode: "role",
      role: "driver",
      boundRig: "factory-a",
      seat: driverSeat,
    });
  });

  it("ROW 1 decoys: the qualified seat wins over dead / wrong-runtime / role-less / loaded decoys", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "dead1", { role: "driver", sessionStatus: "stopped" });
    seedSeat(rigAId, "factory-a", "dev", "wrongrt", { role: "driver", runtime: "codex" });
    seedSeat(rigAId, "factory-a", "dev", "roleless", {});
    const loaded = seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const idle = seedSeat(rigAId, "factory-a", "dev", "driver2", { role: "driver" });
    // Load the first driver with a PENDING item (claimed items rank zero).
    await queueRepo.create({ sourceSession: "orch@factory-a", destinationSession: loaded, body: "busywork" });

    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(idle);
  });

  it("ROW 2b: a role-only HANDLER-ROLE gate resolves the handler seat by capability on the bound rig", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const guardSeat = seedSeat(rigAId, "factory-a", "rev", "guard1", { role: "guard" });
    const specPath = writeSpec("handler-gate.yaml", HANDLER_GATE_SPEC);

    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(guardSeat);
    // Handler-role gates park nothing on a human; instance parks waiting on the gate item.
    expect(projected.instance.status).toBe("waiting");
  });

  it("ROW 2a: a role-only HUMAN-gated step's parked packet OWNER resolves by capability on the bound rig", async () => {
    const plannerSeat = seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const specPath = writeSpec("human-gate.yaml", HUMAN_GATE_SPEC);

    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: plannerSeat,
    });
    // The gate packet belongs to the ROLE OWNER (capability-resolved) and parks on the human.
    const packet = queueRepo.getById(projected.nextQitemId!);
    expect(packet?.destinationSession).toBe(plannerSeat);
    expect(packet?.blockedOn).toBe("human@kernel");
  });

  it("ROW 4: instantiate hard-fails ONLY on structural zero-role coverage; a declared-but-stopped seat instantiates fine", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);

    // No seat declares "driver" anywhere → structural hard-fail, loud.
    await expect(
      runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" }),
    ).rejects.toMatchObject({ code: "bound_rig_role_uncovered" });

    // A STOPPED driver seat = structural coverage (existence, not
    // liveness) → instantiate succeeds; liveness is projection's concern.
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver", sessionStatus: "stopped" });
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    expect(inst.instance.boundRig).toBe("factory-a");
  });

  it("ROW 4 scale-out timing: the stopped role seat comes alive AFTER instantiate and resolves at projection (guard B1 pin)", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    // Node exists role-declared but NOT running at instantiate.
    const nodeCoord = seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver", sessionStatus: null });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });

    // Seat comes alive BEFORE the step projects (the warm-up story).
    const node = db.prepare(`SELECT id FROM nodes WHERE logical_id = 'dev.driver1'`).get() as { id: string };
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-late', ?, ?, 'running')`).run(
      node.id,
      nodeCoord,
    );
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(nodeCoord);
  });

  it("ROW 5: resume RE-RESOLVES by capability — inventory changed between failure and resume routes the NEW seat", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const firstDriver = seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(firstDriver);
    // The driver step fails → instance failed.
    await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "failed",
      actorSession: firstDriver,
      resultNote: "driver died",
    });
    // Inventory changes: driver1 stops; a fresh driver0 (codepoint-earlier) comes up.
    db.prepare(`UPDATE sessions SET status = 'stopped' WHERE session_name = ?`).run(firstDriver);
    const newDriver = seedSeat(rigAId, "factory-a", "dev", "driver0", { role: "driver" });

    const resumed = await runtime.resume({ instanceId: inst.instance.instanceId, actorSession: "orch@factory-a" });
    expect(resumed.ownerSession).toBe(newDriver); // re-resolve, never copy
  });

  it("Q3: a bound instance's unmapped-failed exception routes to the rig-local orchestrator seat by capability (dial position 3)", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const orchSeat = seedSeat(rigAId, "factory-a", "orch", "lead", { role: "orchestrator" });
    // The role-only spec + the WF-5 dial: orchestrator_role declared,
    // orchestrator role with ZERO preferred_targets (the capability leg).
    const specText = ROLE_ONLY_SPEC.replace(
      "  roles:",
      "  exception_routing:\n    orchestrator_role: orchestrator\n  roles:\n    orchestrator: {}",
    );
    const specPath = writeSpec("role-exc.yaml", specText);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    // Fail the ENTRY packet (unmapped failed → class-a exception born in-txn).
    await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "dev-planner1@factory-a",
      resultNote: "boom",
    });
    const items = db
      .prepare(
        `SELECT destination_session FROM queue_items WHERE tags LIKE '%workflow-exception%' AND tags LIKE ?`,
      )
      .all(`%instance:${inst.instance.instanceId}%`) as Array<{ destination_session: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.destination_session).toBe(orchSeat);
  });

  it("vanished rig: the bound rig torn down mid-run fails resolution loud with bound_rig_not_found", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    // The rig vanishes (name no longer resolves).
    db.prepare(`UPDATE rigs SET name = 'renamed-away' WHERE id = ?`).run(rigAId);
    await expect(
      runtime.projector.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "dev-planner1@factory-a",
      }),
    ).rejects.toMatchObject({ code: "bound_rig_not_found" });
  });

  it("loud-with-candidates: all role seats stopped → structured per-candidate disqualifiers; zero-declaring → the named zero-candidate message", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver", sessionStatus: "stopped" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    let thrown: unknown;
    try {
      await runtime.projector.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "dev-planner1@factory-a",
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as WorkflowProjectorError;
    expect(e.code).toBe("next_owner_unresolved");
    const candidates = e.details?.["candidates"] as Array<{ coordinate: string; disqualifier: string }>;
    const driver1 = candidates.find((c) => c.coordinate === "dev-driver1@factory-a");
    expect(driver1?.disqualifier).toMatch(/^not_live\(lifecycleState=/);

    // Zero-candidate: a fresh rig where NO seat declares the entry role.
    const rigB = rigRepo.createRig("factory-b");
    seedSeat(rigB.id, "factory-b", "dev", "somebody", {});
    // Structural check fires first at instantiate — the named zero-coverage error.
    await expect(
      runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a", targetRig: "factory-b" }),
    ).rejects.toMatchObject({ code: "bound_rig_role_uncovered" });
  });

  it("UNBOUND byte-parity: a no-target role step on an unbound instance keeps the shipped next_owner_unresolved shape (no candidates machinery)", async () => {
    const unboundSpec = ROLE_ONLY_SPEC.replace("  target:\n    rig: factory-a\n", "");
    const specPath = writeSpec("unbound.yaml", unboundSpec);
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "t",
      createdBySession: "orch@factory-a",
      entryOwnerSession: "dev-planner1@factory-a",
    });
    expect(inst.instance.boundRig).toBeNull();
    let thrown: unknown;
    try {
      await runtime.projector.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "dev-planner1@factory-a",
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as WorkflowProjectorError;
    expect(e.code).toBe("next_owner_unresolved");
    // The SHIPPED unbound message (supply nextOwnerSession / add
    // preferred_targets) — no bound-rig candidates block.
    expect(e.message).toContain("supply nextOwnerSession explicitly");
    expect(e.details?.["candidates"]).toBeUndefined();
  });
});
