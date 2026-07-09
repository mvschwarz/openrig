import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { resolveDefaultOwner } from "../src/domain/workflow-projector.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "../src/domain/workflow-role-resolver.js";
import type { WorkflowSpec } from "../src/domain/workflow-types.js";

// OPR.0.4.6.FAC1 commit 4 — determinism + zero-regression + handover
// pins (ARCH F1/F2; QA-3/QA-6; GUARD B1; planner2 §4.8). Tests only.
//
// The VM captures prove WIRING; PURITY is proven HERE (the QA-6/F2
// split — a capture-only purity proof is theater). The proof matrix
// labels the runtime repetition leg accordingly.

// ---------- the named unit-vector set (purity) ----------

function facts(over: Partial<RoleSeatCandidateFacts>): RoleSeatCandidateFacts {
  return {
    logicalId: "dev.x",
    role: "driver",
    nodeKind: "agent",
    lifecycleState: "running",
    runtime: "claude-code",
    pendingWorkCount: 0,
    coordinate: "dev-x@f",
    rawSessionName: "dev-x@f",
    ...over,
  };
}

function seat(coordinate: string, pendingWorkCount = 0): RoleSeatCandidateFacts {
  return facts({ logicalId: coordinate, coordinate, rawSessionName: coordinate, pendingWorkCount });
}

describe("FAC-1 C4: the named determinism unit vectors (QA-6 / ARCH F2)", () => {
  const CANDIDATES = [seat("dev-b@f", 1), seat("dev-a@f", 0), seat("dev-c@f", 0)];

  it("repeatability: the same candidate set yields the same seat, every call", () => {
    const first = selectRoleSeat({ role: "driver", candidates: CANDIDATES }).seat;
    for (let i = 0; i < 10; i++) {
      expect(selectRoleSeat({ role: "driver", candidates: CANDIDATES }).seat).toBe(first);
    }
  });

  it("permutation-invariance: candidate-array ORDER never affects the outcome", () => {
    // Deterministic permutations (no runtime randomness in a
    // determinism test): rotate + reverse cover distinct orderings.
    const perms: RoleSeatCandidateFacts[][] = [
      CANDIDATES,
      [...CANDIDATES].reverse(),
      [CANDIDATES[1]!, CANDIDATES[2]!, CANDIDATES[0]!],
      [CANDIDATES[2]!, CANDIDATES[0]!, CANDIDATES[1]!],
      [CANDIDATES[2]!, CANDIDATES[1]!, CANDIDATES[0]!],
      [CANDIDATES[1]!, CANDIDATES[0]!, CANDIDATES[2]!],
    ];
    const results = perms.map((p) => selectRoleSeat({ role: "driver", candidates: p }).seat);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("dev-a@f");
  });

  it("THE PINNED COUNTERINTUITIVE VECTOR: driver10@rig < driver2@rig (plain codepoint, never natural sort)", () => {
    // Anyone \"fixing\" this into natural sort breaks cross-version
    // replay determinism — the pin exists so the fix is impossible to
    // make silently.
    const result = selectRoleSeat({
      role: "driver",
      candidates: [seat("dev-driver2@rig"), seat("dev-driver10@rig")],
    });
    expect(result.seat).toBe("dev-driver10@rig");
  });

  it("case handling pinned: plain codepoint compare (uppercase sorts before lowercase)", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [seat("dev-a@f"), seat("Dev-a@f")],
    });
    expect(result.seat).toBe("Dev-a@f"); // 'D' (68) < 'd' (100)
  });

  it("NULL-coordinate exclusion: a never-launched seat cannot crash the comparator or win", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [
        facts({ logicalId: "flat", coordinate: null, rawSessionName: null }),
        seat("dev-a@f"),
      ],
    });
    expect(result.seat).toBe("dev-a@f");
    const nullOne = result.disqualified.find((d) => d.logicalId === "flat");
    // A coordinate-less RUNNING seat is named, never silently skipped.
    expect(nullOne?.disqualifier).toBe("coordinate_underivable");
  });

  it("STATIC IMPORT AUDIT: the policy module carries no clock / randomness / locale / db dependency", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "../src/domain/workflow-role-resolver.ts"),
      "utf-8",
    );
    // Audit CODE lines only — the module's own doc comments NAME the
    // banned constructs (that is their job); a comment-inclusive match
    // trips on itself (VM-caught first run).
    const code = source
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n");
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now|new Date\(/);
    expect(code).not.toMatch(/localeCompare|Intl\./);
    expect(code).not.toMatch(/\basync\b|await/);
    // ZERO runtime imports: the only permissible import lines are
    // type-only (import type ...). Today the module imports nothing.
    const runtimeImports = code
      .split("\n")
      .filter((l) => /^import /.test(l) && !/^import type /.test(l));
    expect(runtimeImports).toEqual([]);
  });
});

// ---------- tier-2 byte-parity vectors (the zero-regression fence) ----------

describe("FAC-1 C4: tier-2 byte-parity (declared preferred_targets are NEVER inventory-filtered)", () => {
  const runtimeOf = (session: string): string | null =>
    session.includes("codex") ? "codex" : "claude-code";

  function specWith(targets: string[] | undefined): WorkflowSpec {
    return {
      id: "parity",
      version: "1",
      roles: { driver: targets ? { preferred_targets: targets } : {} },
      steps: [{ id: "s1", actor_role: "driver" }],
    };
  }

  it("unpinned targets[0] wins even when a bound-rig context with a 'better' role seat is supplied", () => {
    const spec = specWith(["declared-seat@rig", "second@rig"]);
    const ctx = {
      boundRig: "factory-a",
      candidatesForRig: () => {
        throw new Error("tier-2 must NEVER read inventory");
      },
    };
    const owner = resolveDefaultOwner(spec, spec.steps[0]!, runtimeOf, ctx);
    expect(owner).toBe("declared-seat@rig");
  });

  it("a DEAD declared target is still returned — liveness-filtering declared targets is the named regression", () => {
    // The fence: tier 2 consults NO inventory, so a stopped/dead
    // declared seat routes exactly as today (WF-5's stuck class owns
    // the consequence, not the resolver).
    const spec = specWith(["dead-seat@rig"]);
    const ctx = {
      boundRig: "factory-a",
      candidatesForRig: () => {
        throw new Error("tier-2 must NEVER read inventory");
      },
    };
    expect(resolveDefaultOwner(spec, spec.steps[0]!, runtimeOf, ctx)).toBe("dead-seat@rig");
  });

  it("harness-pinned selection WITHIN declared targets is untouched by the context", () => {
    const spec = specWith(["wrong-codex@rig", "right-claude@rig"]);
    const step = { ...spec.steps[0]!, harness: "claude-code" as const };
    const ctx = {
      boundRig: "factory-a",
      candidatesForRig: () => {
        throw new Error("tier-2 must NEVER read inventory");
      },
    };
    expect(resolveDefaultOwner(spec, step, runtimeOf, ctx)).toBe("right-claude@rig");
  });

  it("unbound no-targets stays byte-identical: null return, no context machinery", () => {
    const spec = specWith(undefined);
    expect(resolveDefaultOwner(spec, spec.steps[0]!, runtimeOf, undefined)).toBeNull();
  });
});

// ---------- replay pins with the read-spy (GUARD B1, binding) ----------

const ROLE_ONLY_SPEC = `workflow:
  id: fac1-c4-replay
  version: 1
  objective: replay pins
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
        - waiting
    - id: build
      actor_role: driver
      allowed_exits:
        - done
`;

describe("FAC-1 C4: replay pins — zero role-resolution inventory reads on BOTH replay classes", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let tmp: string;
  let rigAId: string;
  let specPath: string;
  let sessionSeq = 0;

  function seedSeat(pod: string, member: string, opts: { role?: string; sessionStatus?: string }): string {
    const podRec = podRepo.getPodByNamespace(rigAId, pod) ?? podRepo.createPod(rigAId, pod, pod);
    const node = rigRepo.addNode(rigAId, `${pod}.${member}`, {
      role: opts.role,
      runtime: "claude-code",
      cwd: "/tmp",
      podId: podRec.id,
      agentRef: "local:agents/x",
      profile: "default",
    });
    const coordinate = `${pod}-${member}@factory-a`;
    sessionSeq += 1;
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)`).run(
      `s-${String(sessionSeq).padStart(4, "0")}`,
      node.id,
      coordinate,
      opts.sessionStatus ?? "running",
    );
    return coordinate;
  }

  /** The read-spy: counts prepared statements that touch the node
   *  inventory surface (nodes/sessions/bindings FROM-reads). Role
   *  resolution is the only workflow-path consumer of these tables
   *  inside project(); replays must never trigger them. */
  function spyInventoryReads(): { count: () => number; restore: () => void } {
    const orig = db.prepare.bind(db);
    let n = 0;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/FROM nodes\b/i.test(sql)) n += 1;
      return orig(sql);
    };
    return {
      count: () => n,
      restore: () => {
        delete (db as unknown as Record<string, unknown>)["prepare"];
      },
    };
  }

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [
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
    rigAId = rigRepo.createRig("factory-a").id;
    tmp = mkdtempSync(join(tmpdir(), "wf-c4-"));
    specPath = join(tmp, "replay.yaml");
    writeFileSync(specPath, ROLE_ONLY_SPEC);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("TERMINAL replay: inventory changes between resolve+record and the replay; the 409 stands, the recorded destination is unchanged, and ZERO inventory reads happen", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    const firstDriver = seedSeat("dev", "driver1", { role: "driver" });
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(firstDriver);

    // Inventory changes: a fresh, less-loaded, codepoint-earlier seat.
    seedSeat("dev", "driver0", { role: "driver" });

    const spy = spyInventoryReads();
    try {
      await expect(
        runtime.projector.project({
          instanceId: inst.instance.instanceId,
          currentPacketId: inst.entryQitemId, // already closed → not on frontier
          exit: "handoff",
          actorSession: "dev-planner1@factory-a",
        }),
      ).rejects.toMatchObject({ code: "packet_not_on_frontier" });
      expect(spy.count()).toBe(0); // guard B1: the replay read NOTHING
    } finally {
      spy.restore();
    }
    // The recorded destination is the determinism anchor — unchanged.
    const packet = queueRepo.getById(projected.nextQitemId!);
    expect(packet?.destinationSession).toBe(firstDriver);
  });

  it("ABSORBED waiting replay: the exact duplicate is absorbed with zero writes AND zero inventory reads", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    seedSeat("dev", "driver1", { role: "driver" });
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const parkInput = {
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting" as const,
      actorSession: "dev-planner1@factory-a",
      blockedOn: "external-gate",
    };
    await runtime.projector.project(parkInput);

    // Inventory changes between park and replay (immaterial — and the
    // spy proves the replay never looks).
    seedSeat("dev", "driver0", { role: "driver" });

    const spy = spyInventoryReads();
    try {
      const replayed = await runtime.projector.project(parkInput);
      expect(replayed.absorbedReplay).toBe(true);
      expect(spy.count()).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it("HANDOVER stability pin (AC-3): the occupant swaps behind the seat; the recorded destination AND a fresh resolution both still address the same coordinate", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    const driverSeat = seedSeat("dev", "driver1", { role: "driver" });
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(driverSeat);

    // Simulate the handover mutation (SeatHandoverMutationResult shape):
    // occupant-era fields change; a NEW session row registers under the
    // SAME canonical coordinate (the handover relaunch reuses it).
    const node = db.prepare(`SELECT id FROM nodes WHERE logical_id = 'dev.driver1'`).get() as { id: string };
    db.prepare(`UPDATE sessions SET status = 'stopped' WHERE node_id = ?`).run(node.id);
    db.prepare(`UPDATE nodes SET previous_occupant = ?, handover_result = 'handed_over' WHERE id = ?`).run(
      driverSeat,
      node.id,
    );
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-successor', ?, ?, 'running')`).run(
      node.id,
      driverSeat,
    );

    // (a) the recorded destination still addresses the seat (coordinate-stable).
    const packet = queueRepo.getById(projected.nextQitemId!);
    expect(packet?.destinationSession).toBe(driverSeat);

    // (b) a FRESH resolution (a second bound instance) picks the same coordinate.
    const inst2 = await runtime.instantiate({ specPath, rootObjective: "t2", createdBySession: "orch@factory-a" });
    const projected2 = await runtime.projector.project({
      instanceId: inst2.instance.instanceId,
      currentPacketId: inst2.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected2.nextOwnerSession).toBe(driverSeat);
  });

  it("compat: an ENTRY-OWNER override at instantiate beats the resolver on a bound rig", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    seedSeat("dev", "driver1", { role: "driver" });
    const override = seedSeat("dev", "special", {});
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "t",
      createdBySession: "orch@factory-a",
      entryOwnerSession: override,
    });
    expect(inst.entryOwnerSession).toBe(override);
  });

  it("compat: an EXPLICIT nextOwnerSession override beats the resolver under a bound rig", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    seedSeat("dev", "driver1", { role: "driver" });
    const override = seedSeat("dev", "special", {});
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
      nextOwnerSession: override,
    });
    expect(projected.nextOwnerSession).toBe(override);
    // Evidence records the explicit mode.
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    const evidence = trail[0]?.closureEvidence as Record<string, Record<string, unknown>> | null;
    expect(evidence?.["owner_resolution"]?.["mode"]).toBe("explicit");
  });
});
