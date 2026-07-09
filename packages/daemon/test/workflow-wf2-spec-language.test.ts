// OPR.0.4.6.WF2 — full-featured spec language: parser strictness for the
// new fields (FR-6), the gates[]/prefer parse-removals (FR-4/FR-5),
// conditional-on-outcome branching language + validation + EXECUTION
// (FR-1 — the one named engine extension), harness pins (FR-2), the
// host-pin MH-3 boundary (FR-3), gate compilation to the shipped
// primitives (FR-5), and the zero-regression spine (BR-3).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { parseWorkflowSpec, WorkflowSpecError } from "../src/domain/workflow-spec-cache.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { resolveNextStep } from "../src/domain/workflow-projector.js";

// ── spec fixtures ────────────────────────────────────────────────────

const BRANCHED_SPEC = `workflow:
  id: wf2-branched
  version: 1
  loop_guards:
    max_hops: 8
  roles:
    builder:
      preferred_targets: [builder@rig]
    fixer:
      preferred_targets: [fixer@rig]
    prover:
      preferred_targets: [prover@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, waiting, done, failed]
      next_hop:
        on: { failed: remediate }
    - id: verify
      actor_role: prover
      allowed_exits: [handoff, waiting, done, failed]
      next_hop:
        on: { failed: remediate }
    - id: remediate
      actor_role: fixer
      allowed_exits: [handoff, waiting, done, failed]
      next_hop:
        suggested_roles: [prover]
`;

// Same shape WITHOUT the branch map — the zero-regression twin.
const LINEAR_SPEC = `workflow:
  id: wf2-linear
  version: 1
  roles:
    builder:
      preferred_targets: [builder@rig]
    prover:
      preferred_targets: [prover@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, waiting, done, failed]
    - id: verify
      actor_role: prover
      allowed_exits: [handoff, waiting, done, failed]
`;

const HARNESS_SPEC = `workflow:
  id: wf2-harness
  version: 1
  roles:
    builder:
      preferred_targets: [claude-seat@rig, codex-seat@rig]
    prover:
      preferred_targets: [codex-seat@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, done]
      harness: codex
    - id: prove
      actor_role: prover
      allowed_exits: [done]
`;

const GATED_HUMAN_SPEC = `workflow:
  id: wf2-gated-human
  version: 1
  roles:
    builder:
      preferred_targets: [builder@rig]
    prover:
      preferred_targets: [prover@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, done]
    - id: signoff
      actor_role: prover
      allowed_exits: [done]
      gate:
        target: human@kernel
        summary: "Sign off the release"
        evidence_ref: proof/PROOF.md
`;

const GATED_HANDLER_SPEC = `workflow:
  id: wf2-gated-handler
  version: 1
  roles:
    builder:
      preferred_targets: [builder@rig]
    checker:
      preferred_targets: [checker@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, done]
    - id: checkpoint
      actor_role: builder
      allowed_exits: [done]
      gate:
        target: checker
        summary: "Handler check before close"
`;

// rev1-r2 blocker pin: a step with BOTH a harness pin and a handler-role
// gate — the pin must bind the handler seat (the packet's actual routed
// destination), never be silently bypassed.
const GATED_HANDLER_PINNED_SPEC = `workflow:
  id: wf2-gated-handler-pinned
  version: 1
  roles:
    builder:
      preferred_targets: [builder@rig]
    checker:
      preferred_targets: [claude-check@rig, codex-check@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, done]
    - id: checkpoint
      actor_role: builder
      allowed_exits: [done]
      harness: codex
      gate:
        target: checker
        summary: "Pinned handler check"
`;

function writeSpec(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("OPR.0.4.6.WF2 — spec language", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
      missionControlActionsSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    tmp = mkdtempSync(join(tmpdir(), "wf2-lang-"));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Seed a managed node + session so nodeRuntimeOf resolves a runtime. */
  function seedSeat(sessionName: string, runtimeName: string, nodeId: string): void {
    db.prepare(
      `INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'r-1', ?, ?)`,
    ).run(nodeId, sessionName.split("@")[0], runtimeName);
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`,
    ).run(`s-${nodeId}`, nodeId, sessionName);
  }

  // ── FR-6: parser strictness on the new surface ─────────────────────

  describe("FR-6 parser strictness (the raw seam)", () => {
    it("rejects the removed gates[] string list with the what/why/fix migration error", () => {
      const yaml = `workflow:
  id: legacy-gates
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      gates: [approval]
`;
      expect(() => parseWorkflowSpec(yaml, "legacy.yaml")).toThrowError(
        expect.objectContaining({ code: "spec_gates_removed" }),
      );
      try {
        parseWorkflowSpec(yaml, "legacy.yaml");
      } catch (e) {
        expect((e as WorkflowSpecError).message).toContain("gate:");
        expect((e as WorkflowSpecError).message).toContain("target:");
      }
    });

    it("rejects the removed next_hop.mode prefer with the migration error naming the alternatives", () => {
      const yaml = `workflow:
  id: legacy-prefer
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      next_hop:
        mode: prefer
        suggested_roles: [a]
`;
      expect(() => parseWorkflowSpec(yaml, "legacy.yaml")).toThrowError(
        expect.objectContaining({ code: "spec_prefer_mode_removed" }),
      );
      try {
        parseWorkflowSpec(yaml, "legacy.yaml");
      } catch (e) {
        expect((e as WorkflowSpecError).message).toContain("require");
        expect((e as WorkflowSpecError).message).toContain("forbid");
      }
    });

    it("rejects a branch key outside the closed exit enum, naming the allowed set", () => {
      const yaml = `workflow:
  id: bad-branch-key
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      next_hop:
        on: { success: s1 }
`;
      expect(() => parseWorkflowSpec(yaml, "bad.yaml")).toThrowError(
        expect.objectContaining({ code: "spec_branch_key_invalid" }),
      );
    });

    it("rejects harness: terminal with the teaching error naming the agent set", () => {
      const yaml = `workflow:
  id: bad-harness
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      harness: terminal
`;
      try {
        parseWorkflowSpec(yaml, "bad.yaml");
        expect.unreachable("should have thrown");
      } catch (e) {
        expect((e as WorkflowSpecError).code).toBe("spec_harness_invalid");
        expect((e as WorkflowSpecError).message).toContain("claude-code");
        expect((e as WorkflowSpecError).message).toContain("codex");
        expect((e as WorkflowSpecError).message).toContain("not an agent harness");
      }
    });

    it("rejects unknown gate keys against the closed gate keyset", () => {
      const yaml = `workflow:
  id: bad-gate-key
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      gate:
        target: human@kernel
        summary: ok
        evidence_ref: proof/x.md
        condition: always
`;
      expect(() => parseWorkflowSpec(yaml, "bad.yaml")).toThrowError(
        expect.objectContaining({ code: "spec_unknown_key" }),
      );
    });

    it("accepts every new field and carries it into the parsed spec (spec_json carriage)", () => {
      const spec = parseWorkflowSpec(readFixture(BRANCHED_SPEC), "branched.yaml");
      expect(spec.steps[0]!.next_hop?.on).toEqual({ failed: "remediate" });
      const gated = parseWorkflowSpec(readFixture(GATED_HUMAN_SPEC), "gated.yaml");
      expect(gated.steps[1]!.gate).toEqual({
        target: "human@kernel",
        summary: "Sign off the release",
        evidence_ref: "proof/PROOF.md",
      });
      const harness = parseWorkflowSpec(readFixture(HARNESS_SPEC), "harness.yaml");
      expect(harness.steps[0]!.harness).toBe("codex");
    });

    function readFixture(body: string): string {
      return body;
    }
  });

  // ── FR-1: branch language validation ───────────────────────────────

  describe("FR-1 branch validation", () => {
    it("rejects a branch target that does not exist", () => {
      const spec = parseWorkflowSpec(
        BRANCHED_SPEC.replace("on: { failed: remediate }", "on: { failed: nowhere }"),
        "x.yaml",
      );
      const result = new WorkflowValidator().validate(spec);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "branch_target_not_found")).toBe(true);
    });

    it("rejects an UNGUARDED branch-created cycle naming the max_hops fix", () => {
      const noGuard = BRANCHED_SPEC.replace("  loop_guards:\n    max_hops: 8\n", "");
      const spec = parseWorkflowSpec(noGuard, "x.yaml");
      const result = new WorkflowValidator().validate(spec);
      expect(result.ok).toBe(false);
      const cycleIssue = result.issues.find((i) => i.code === "cycle_without_max_hops");
      expect(cycleIssue).toBeDefined();
      expect(cycleIssue!.message).toContain("max_hops");
    });

    it("validates the SAME cycle when max_hops sanctions it", () => {
      const spec = parseWorkflowSpec(BRANCHED_SPEC, "x.yaml");
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("counts branch-only-reachable steps as reachable (no false unreachable)", () => {
      const spec = parseWorkflowSpec(BRANCHED_SPEC, "x.yaml");
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.some((i) => i.code === "step_unreachable")).toBe(false);
    });

    it("resolveNextStep: mapped exit wins; no exit / unmapped exit keeps structural semantics", () => {
      const spec = parseWorkflowSpec(BRANCHED_SPEC, "x.yaml");
      const build = spec.steps[0]!;
      expect(resolveNextStep(spec, build, "failed")?.id).toBe("remediate");
      expect(resolveNextStep(spec, build, "handoff")?.id).toBe("verify");
      expect(resolveNextStep(spec, build)?.id).toBe("verify");
    });
  });

  // ── FR-1: branch EXECUTION (the one engine extension) ──────────────

  describe("FR-1 branch execution", () => {
    async function startBranched(): Promise<{ instanceId: string; entryQitemId: string }> {
      const specPath = writeSpec(tmp, "branched.yaml", BRANCHED_SPEC);
      const result = await runtime.instantiate({
        specPath,
        rootObjective: "branch walk",
        createdBySession: "ops@rig",
      });
      return { instanceId: result.instance.instanceId, entryQitemId: result.entryQitemId };
    }

    it("a MAPPED failed exit routes to the branch target in the same txn: next qitem created, instance ACTIVE on the target, trail + decision record the branch", async () => {
      const { instanceId, entryQitemId } = await startBranched();
      const before = runtime.instanceStore.getByIdOrThrow(instanceId);
      const result = await runtime.project({
        instanceId,
        currentPacketId: entryQitemId,
        exit: "failed",
        actorSession: "builder@rig",
        resultNote: "build broke",
      });
      // Routed, not terminal:
      expect(result.nextQitemId).not.toBeNull();
      expect(result.nextStepId).toBe("remediate");
      expect(result.nextOwnerSession).toBe("fixer@rig");
      const instance = runtime.instanceStore.getByIdOrThrow(instanceId);
      expect(instance.status).toBe("active");
      expect(instance.currentStepId).toBe("remediate");
      expect(instance.currentFrontier).toEqual([result.nextQitemId]);
      // A branch route IS an advance (PIN 2): hop + version bumped.
      expect(instance.hopCount).toBe(before.hopCount + 1);
      expect(instance.version).toBeGreaterThan(before.version);
      // The honest closure shape for failed is preserved on the packet:
      const closed = queueRepo.getById(entryQitemId);
      expect(closed?.state).toBe("done");
      expect(closed?.closureReason).toBe("denied");
      // Decision + trail carry the ADDITIVE branch-taken record (PIN 1):
      expect(instance.lastContinuationDecision?.branchTaken).toBe("remediate");
      const trail = runtime.trailLog.listForInstance(instanceId);
      const row = trail.find((t) => t.priorQitemId === entryQitemId);
      expect(row?.closureReason).toBe("failed");
      expect(row?.closureEvidence).toMatchObject({
        branch_taken: { exit: "failed", target: "remediate" },
      });
      expect(row?.nextQitemId).toBe(result.nextQitemId);
      // The new packet exists, destined to the branch-target owner:
      const next = queueRepo.getById(result.nextQitemId!);
      expect(next?.destinationSession).toBe("fixer@rig");
      expect(next?.state).toBe("pending");
    });

    it("an UNMAPPED failed stays terminal exactly as today (zero regression off the branch path)", async () => {
      const specPath = writeSpec(tmp, "linear.yaml", LINEAR_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "negative",
        createdBySession: "ops@rig",
      });
      const result = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "failed",
        actorSession: "builder@rig",
      });
      expect(result.nextQitemId).toBeNull();
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("failed");
      expect(after.currentStepId).toBeNull();
      expect(after.lastContinuationDecision?.branchTaken).toBeNull();
    });

    it("same instance state → same branch on replay: a second identical failed-project is rejected by the frontier guard (the packet already routed)", async () => {
      const { instanceId, entryQitemId } = await startBranched();
      await runtime.project({
        instanceId,
        currentPacketId: entryQitemId,
        exit: "failed",
        actorSession: "builder@rig",
      });
      await expect(
        runtime.project({
          instanceId,
          currentPacketId: entryQitemId,
          exit: "failed",
          actorSession: "builder@rig",
        }),
      ).rejects.toMatchObject({ code: "packet_not_on_frontier" });
    });

    it("the max_hops guard fires ON the branch route (a guarded cycle fails honestly at the guard, never unbounded)", async () => {
      const tight = BRANCHED_SPEC.replace("max_hops: 8", "max_hops: 2");
      const specPath = writeSpec(tmp, "tight.yaml", tight);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "guard walk",
        createdBySession: "ops@rig",
      });
      // hop 1: build --failed--> remediate (branch route)
      const r1 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "failed",
        actorSession: "builder@rig",
      });
      // hop 2: remediate --handoff--> verify (structural)
      const r2 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: r1.nextQitemId!,
        exit: "handoff",
        actorSession: "fixer@rig",
      });
      // hop 3 would exceed max_hops=2 → engine-authored honest failure,
      // even though the exit is branch-mapped.
      const r3 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: r2.nextQitemId!,
        exit: "failed",
        actorSession: "prover@rig",
      });
      expect(r3.closureReason).toBe("failed");
      expect(r3.nextQitemId).toBeNull();
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("failed");
      const trail = runtime.trailLog.listForInstance(instance.instanceId);
      const guardRow = trail.find((t) => t.priorQitemId === r2.nextQitemId);
      expect(guardRow?.closureEvidence).toMatchObject({
        max_hops_guard: { code: "max_hops_exceeded" },
      });
    });
  });

  // ── FR-2: harness pins ──────────────────────────────────────────────

  describe("FR-2 harness pin", () => {
    it("routes a pinned step to the first preferred_target whose runtime matches", async () => {
      seedSeat("claude-seat@rig", "claude-code", "n-claude");
      seedSeat("codex-seat@rig", "codex", "n-codex");
      const specPath = writeSpec(tmp, "harness.yaml", HARNESS_SPEC);
      const result = await runtime.instantiate({
        specPath,
        rootObjective: "harness walk",
        createdBySession: "ops@rig",
      });
      // Entry step pins codex; claude-seat is FIRST in preferred_targets
      // but codex-seat matches the pin.
      expect(result.entryOwnerSession).toBe("codex-seat@rig");
      const entry = queueRepo.getById(result.entryQitemId);
      expect(entry?.destinationSession).toBe("codex-seat@rig");
    });

    it("an unsatisfiable pin fails loud naming the pin and each candidate's runtime", async () => {
      seedSeat("claude-seat@rig", "claude-code", "n-claude");
      seedSeat("codex-seat@rig", "claude-code", "n-codex-mislabeled");
      const specPath = writeSpec(tmp, "harness.yaml", HARNESS_SPEC);
      await expect(
        runtime.instantiate({
          specPath,
          rootObjective: "unsatisfiable",
          createdBySession: "ops@rig",
        }),
      ).rejects.toMatchObject({ code: "harness_pin_unsatisfied" });
    });

    it("an explicit owner override that violates the pin is rejected (never silently defeats a pin)", async () => {
      seedSeat("claude-seat@rig", "claude-code", "n-claude");
      seedSeat("codex-seat@rig", "codex", "n-codex");
      const specPath = writeSpec(tmp, "harness.yaml", HARNESS_SPEC);
      await expect(
        runtime.instantiate({
          specPath,
          rootObjective: "override",
          createdBySession: "ops@rig",
          entryOwnerSession: "claude-seat@rig",
        }),
      ).rejects.toMatchObject({ code: "harness_pin_unsatisfied" });
    });

    it("steps with no pin resolve preferred_targets[0] unchanged (zero regression)", async () => {
      const specPath = writeSpec(tmp, "linear.yaml", LINEAR_SPEC);
      const result = await runtime.instantiate({
        specPath,
        rootObjective: "no pin",
        createdBySession: "ops@rig",
      });
      expect(result.entryOwnerSession).toBe("builder@rig");
    });
  });

  // ── FR-3: host pins ─────────────────────────────────────────────────

  describe("FR-3 host pin", () => {
    it("host: local instantiates exactly like no pin", async () => {
      const local = LINEAR_SPEC.replace(
        "      allowed_exits: [handoff, waiting, done, failed]\n    - id: verify",
        "      allowed_exits: [handoff, waiting, done, failed]\n      host: local\n    - id: verify",
      );
      const specPath = writeSpec(tmp, "local.yaml", local);
      const result = await runtime.instantiate({
        specPath,
        rootObjective: "local host",
        createdBySession: "ops@rig",
      });
      expect(result.instance.status).toBe("active");
    });

    it("an unknown host id fails validation naming registered ids", () => {
      const spec = parseWorkflowSpec(
        LINEAR_SPEC.replace(
          "    - id: verify",
          "      host: ghost-host\n    - id: verify",
        ).replace("- id: build\n      actor_role: builder\n      allowed_exits: [handoff, waiting, done, failed]\n      host: ghost-host", "- id: build\n      actor_role: builder\n      allowed_exits: [handoff, waiting, done, failed]\n      host: ghost-host"),
        "x.yaml",
      );
      const result = new WorkflowValidator().validate(spec, undefined, () => ({
        registered: false,
        registeredIds: ["vps-1", "mini-2"],
      }));
      const issue = result.issues.find((i) => i.code === "host_not_registered");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain("vps-1");
    });

    it("a REGISTERED remote pin fails loud at instantiate with the MH-3 boundary + workaround, minting NO qitem", async () => {
      const remote = LINEAR_SPEC.replace(
        "      allowed_exits: [handoff, waiting, done, failed]\n    - id: verify",
        "      allowed_exits: [handoff, waiting, done, failed]\n      host: vps-1\n    - id: verify",
      );
      const specPath = writeSpec(tmp, "remote.yaml", remote);
      // Synthetic OPENRIG_HOME registry (never a real remote): vps-1 IS
      // registered, so registry-membership validation PASSES and the
      // MH-3 execution boundary is what fires — proving no qitem is
      // ever minted into a queue that cannot route it, and no silent
      // local fallback happens.
      const prevHome = process.env.OPENRIG_HOME;
      writeFileSync(
        join(tmp, "hosts.yaml"),
        "hosts:\n  - id: vps-1\n    transport: ssh\n    target: vps-1.invalid\n",
      );
      process.env.OPENRIG_HOME = tmp;
      try {
        const qitemsBefore = db.prepare(`SELECT COUNT(*) as c FROM queue_items`).get() as { c: number };
        await expect(
          runtime.instantiate({
            specPath,
            rootObjective: "remote host",
            createdBySession: "ops@rig",
          }),
        ).rejects.toMatchObject({ code: "host_pin_remote_unsupported" });
        const qitemsAfter = db.prepare(`SELECT COUNT(*) as c FROM queue_items`).get() as { c: number };
        expect(qitemsAfter.c).toBe(qitemsBefore.c);
        try {
          await runtime.instantiate({ specPath, rootObjective: "remote host", createdBySession: "ops@rig" });
          expect.unreachable("should have thrown");
        } catch (e) {
          expect((e as Error).message).toContain("MH-3");
          expect((e as Error).message).toContain("local");
        }
      } finally {
        if (prevHome === undefined) delete process.env.OPENRIG_HOME;
        else process.env.OPENRIG_HOME = prevHome;
      }
    });
  });

  // ── FR-5: gate compile, both target kinds ──────────────────────────

  describe("FR-5 gate compile", () => {
    it("HUMAN target: routing into the gated step creates the packet for the STEP OWNER parked blocked_on the human seat (summary + evidence_ref), instance waits, and the SHIPPED resolve verb continues the flow", async () => {
      const specPath = writeSpec(tmp, "gated-human.yaml", GATED_HUMAN_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "human gate",
        createdBySession: "ops@rig",
      });
      const result = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "handoff",
        actorSession: "builder@rig",
      });
      // Guard blocker 1: the leg-1 park shape — the packet belongs to the
      // gated step's ROLE OWNER and parks blocked_on the HUMAN seat (the
      // exact shape `rig queue resolve` acts on) — never an unresolvable
      // pending human-destined item.
      expect(result.nextOwnerSession).toBe("prover@rig");
      const gateItem = queueRepo.getById(result.nextQitemId!)!;
      expect(gateItem.destinationSession).toBe("prover@rig");
      expect(gateItem.state).toBe("blocked");
      expect(gateItem.blockedOn).toBe("human@kernel");
      expect(gateItem.summary).toBe("Sign off the release");
      expect(gateItem.evidenceRef).toBe("proof/PROOF.md");
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("waiting");
      expect(after.currentStepId).toBe("signoff");
      expect(after.currentFrontier).toEqual([result.nextQitemId]);

      // THE CONTINUATION PROOF: the shipped resolve verb unparks the gate
      // item; the step owner then projects onward and the flow completes —
      // no restart, no new machinery.
      const writeContract = new MissionControlWriteContract({
        db,
        eventBus: bus,
        queueRepo,
        actionLog: new MissionControlActionLog(db),
      });
      await writeContract.act({
        verb: "resolve",
        qitemId: result.nextQitemId!,
        actorSession: "human@kernel",
        decision: "signed off — ship it",
      });
      const resolved = queueRepo.getById(result.nextQitemId!)!;
      expect(resolved.state).toBe("in-progress");
      const done = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: result.nextQitemId!,
        exit: "done",
        actorSession: "prover@rig",
      });
      expect(done.nextQitemId).toBeNull();
      const finished = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(finished.status).toBe("completed");
    });

    it("HANDLER-ROLE target: routing into the gated step routes an ordinary agent item to the handler's seat and parks waiting with trail evidence", async () => {
      const specPath = writeSpec(tmp, "gated-handler.yaml", GATED_HANDLER_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "handler gate",
        createdBySession: "ops@rig",
      });
      const result = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "handoff",
        actorSession: "builder@rig",
      });
      expect(result.nextOwnerSession).toBe("checker@rig");
      const gateItem = queueRepo.getById(result.nextQitemId!);
      expect(gateItem?.destinationSession).toBe("checker@rig");
      // Ordinary agent item — NOT forced through the human path:
      expect(gateItem?.tier).not.toBe("human-gate");
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("waiting");
      const trail = runtime.trailLog.listForInstance(instance.instanceId);
      expect(trail.find((t) => t.priorQitemId === entryQitemId)?.nextQitemId).toBe(
        result.nextQitemId,
      );
    });

    it("rev1-r2 blocker: a harness pin on a handler-gated step binds the HANDLER seat — routes to the first runtime-matching target, never preferred_targets[0] blindly", async () => {
      seedSeat("claude-check@rig", "claude-code", "n-cc");
      seedSeat("codex-check@rig", "codex", "n-cx");
      const specPath = writeSpec(tmp, "gated-handler-pinned.yaml", GATED_HANDLER_PINNED_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "pinned handler gate",
        createdBySession: "ops@rig",
      });
      const result = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "handoff",
        actorSession: "builder@rig",
      });
      // claude-check@rig is FIRST in preferred_targets, but the step pins
      // codex — the codex seat must win.
      expect(result.nextOwnerSession).toBe("codex-check@rig");
      expect(queueRepo.getById(result.nextQitemId!)?.destinationSession).toBe("codex-check@rig");
    });

    it("rev1-r2 blocker: an unsatisfiable pin on a handler-gated step fails loud at INSTANTIATE naming the pin and candidates (the static loop covers gated steps)", async () => {
      seedSeat("claude-check@rig", "claude-code", "n-cc");
      seedSeat("codex-check@rig", "claude-code", "n-cx-mislabeled");
      const specPath = writeSpec(tmp, "gated-handler-pinned.yaml", GATED_HANDLER_PINNED_SPEC);
      await expect(
        runtime.instantiate({
          specPath,
          rootObjective: "unsatisfiable pinned handler gate",
          createdBySession: "ops@rig",
        }),
      ).rejects.toMatchObject({ code: "harness_pin_unsatisfied" });
      try {
        await runtime.instantiate({ specPath, rootObjective: "x", createdBySession: "ops@rig" });
        expect.unreachable("should have thrown");
      } catch (e) {
        expect((e as Error).message).toContain("codex");
        expect((e as Error).message).toContain("claude-check@rig");
      }
    });

    it("a gate on a target that is neither a human seat nor a declared role fails validation loud", () => {
      const spec = parseWorkflowSpec(
        GATED_HANDLER_SPEC.replace("target: checker", "target: nobody-anywhere"),
        "x.yaml",
      );
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.some((i) => i.code === "gate_target_unresolved")).toBe(true);
    });

    it("a HUMAN gate missing summary/evidence_ref fails validation (fail at author time, not mid-run)", () => {
      const spec = parseWorkflowSpec(
        GATED_HUMAN_SPEC.replace("        evidence_ref: proof/PROOF.md\n", ""),
        "x.yaml",
      );
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.some((i) => i.code === "gate_human_fields_missing")).toBe(true);
    });
  });

  // ── FR-4 + zero-regression spine ────────────────────────────────────

  describe("FR-4 dispositions + BR-3 zero regression", () => {
    it("every shipped builtin spec still parses and validates (no false rejections)", () => {
      const builtinDir = join(__dirname, "..", "src", "builtins", "workflow-specs");
      for (const name of [
        "conveyor.yaml",
        "basic-loop.yaml",
        "linear-build.yaml",
        "gated-release.yaml",
        "branched-remediation.yaml",
      ]) {
        const raw = readFileSync(join(builtinDir, name), "utf-8");
        const spec = parseWorkflowSpec(raw, name);
        const result = new WorkflowValidator().validate(spec);
        expect(
          result.issues.filter((i) => i.severity === "error"),
          `${name} should have zero validation errors`,
        ).toEqual([]);
      }
    });

    it("skill_refs still produces the fail-open explicitly-v2 advisory (warning, ok=true)", () => {
      const raw = readFileSync(
        join(__dirname, "..", "src", "builtins", "workflow-specs", "conveyor.yaml"),
        "utf-8",
      );
      const spec = parseWorkflowSpec(raw, "conveyor.yaml");
      const result = new WorkflowValidator().validate(spec);
      expect(result.ok).toBe(true);
      expect(
        result.issues.some(
          (i) => i.code === "declared_not_enforced_v1" && i.severity === "warning",
        ),
      ).toBe(true);
    });

    it("a no-WF-2-feature spec routes byte-identically: same owners, same closure shapes, same states", async () => {
      const specPath = writeSpec(tmp, "linear.yaml", LINEAR_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "regression spine",
        createdBySession: "ops@rig",
      });
      const r1 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "handoff",
        actorSession: "builder@rig",
      });
      expect(r1.nextOwnerSession).toBe("prover@rig");
      expect(queueRepo.getById(entryQitemId)?.closureReason).toBe("handed_off_to");
      const r2 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: r1.nextQitemId!,
        exit: "done",
        actorSession: "prover@rig",
      });
      expect(r2.nextQitemId).toBeNull();
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("completed");
    });
  });
});
