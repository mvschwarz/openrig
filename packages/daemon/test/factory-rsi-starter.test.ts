// OPR.0.4.6.FAC2 C1 — the single-rig RSI factory MVP workflow spec.
//
// Proves the two things that make it a coherent inner loop on the SHIPPED engine:
//  1. it VALIDATES clean — the bounded remediation loops are sanctioned by the
//     enforceable max_hops guard (WF-1), the WF-2 branch mappings resolve,
//     and every role→seat pins 1:1;
//  2. the inner loop is DETERMINISTIC + ENGINE-ROUTED — `review` hands to
//     `release_prep`, while qa/review `failed` route to `implement` (bounded
//     remediation) — all without any orchestrator relay. Dogfood is DECOUPLED
//     from this gated loop (out-of-band, feeds the next plan; the continuous
//     runtime mechanism is a later release), so it is a declared role, not a step.
//
// VM-only doctrine: authored here, executed at the coherent VM lease.

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
// The human release gate parks a packet on human@kernel, which requires the
// queue-item summary + evidence_ref columns (migrations 044 + 048) — without
// them the park silently no-ops the fields and fails honestly.
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const BUILTIN_WORKFLOW_DIR = resolve(import.meta.dirname, "../src/builtins/workflow-specs");
const RSI_SPEC = join(BUILTIN_WORKFLOW_DIR, "factory-rsi.yaml");

describe("OPR.0.4.6.FAC2 factory-rsi factory workflow", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let runtime: WorkflowRuntime;
  let queueRepo: QueueRepository;

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
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
    ]);
    eventBus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-factory-rsi', 'factory-rsi')`).run();
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo });
  });

  afterEach(() => db.close());

  it("validates clean: cycle sanctioned by max_hops, branches resolve, roles 1:1", () => {
    const raw = readFileSync(RSI_SPEC, "utf-8");
    const spec = parseWorkflowSpec(raw, RSI_SPEC);

    expect(spec.target?.rig).toBe("factory-rsi");
    expect(spec.entry?.role).toBe("planner");
    expect(spec.coordination_terminal_turn_rule).toBe("hot_potato");
    expect(spec.steps.map((s) => s.id)).toEqual([
      "plan",
      "implement",
      "qa_check",
      "review",
      "release_prep",
      "release_signoff",
    ]);
    // The inner loop forwards review → release_prep; the remediation branches are
    // declared on the closed exit enum.
    const stepById = Object.fromEntries(spec.steps.map((s) => [s.id, s]));
    expect(stepById["review"]!.next_hop?.suggested_roles).toEqual(["release_manager"]);
    expect(stepById["qa_check"]!.next_hop?.on).toEqual({ failed: "implement" });
    expect(stepById["review"]!.next_hop?.on).toEqual({ failed: "implement" });
    // Dogfood is DECOUPLED: a declared role (targeting the dogfood seat) that feeds
    // the next plan out-of-band — intentionally NOT an inner-loop step.
    expect(spec.roles?.dogfood?.preferred_targets).toEqual(["dogfood-tester@factory-rsi"]);
    expect(spec.steps.some((s) => s.actor_role === "dogfood")).toBe(false);
    // The cycle exists only under an enforceable guard.
    expect(spec.loop_guards?.max_hops).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(spec.loop_guards?.max_hops)).toBe(true);
    // The exception dial is wired to the declared orchestrator role.
    expect(spec.exception_routing?.default).toBe("orchestrator");
    expect(spec.exception_routing?.orchestrator_role).toBe("orchestrator");
    // Prep-before-sign-off (rev1 fix): release_prep is UN-gated (the
    // release-manager's prep runs first) and hands off to the SEPARATE gated
    // release_signoff step, which holds the ship decision on the human seat.
    expect(stepById["release_prep"]!.gate).toBeUndefined();
    expect(stepById["release_prep"]!.next_hop?.on).toEqual({ handoff: "release_signoff" });
    expect(stepById["release_signoff"]!.gate?.target).toBe("human@kernel");

    const validation = new WorkflowValidator().validate(spec);
    expect(validation.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.summary.entryRole).toBe("planner");
  });

  it("forward walk resolves each role to its 1:1 factory-rsi seat", async () => {
    const created = await runtime.instantiate({
      specPath: RSI_SPEC,
      rootObjective: "RSI cycle 1",
      createdBySession: "plan-planner@factory-rsi",
    });
    expect(created.instance.currentStepId).toBe("plan");

    let packetId = created.entryQitemId;
    const forward: Array<[string, string, string]> = [
      // [actor, expected nextStep, expected next owner]
      ["plan-planner@factory-rsi", "implement", "build-implementer@factory-rsi"],
      ["build-implementer@factory-rsi", "qa_check", "check-qa@factory-rsi"],
      ["check-qa@factory-rsi", "review", "review-reviewer@factory-rsi"],
      ["review-reviewer@factory-rsi", "release_prep", "release-manager@factory-rsi"],
    ];
    for (const [actor, nextStep, nextOwner] of forward) {
      const projected = await runtime.project({
        instanceId: created.instance.instanceId,
        currentPacketId: packetId,
        exit: "handoff",
        actorSession: actor,
      });
      expect(projected.nextStepId).toBe(nextStep);
      expect(projected.nextOwnerSession).toBe(nextOwner);
      packetId = projected.nextQitemId!;
    }
  });

  it("release leg (rev1 regression): review → release_prep RUNS un-gated → release_signoff holds the human gate (PREP BEFORE sign-off)", async () => {
    // The inner loop lands on release_prep after review — the release-manager's
    // EXECUTABLE step, NOT a human park: the release-manager prepares the artifacts
    // here, BEFORE any gate. On the OLD (gate-on-release_prep) shape the instance
    // would already be waiting / blocked-on-human at this point — that inverted
    // ordering (sign-off before prep) is exactly the rev1-r1/r2 blocker.
    const walk = await walkToReleasePrep(runtime);
    expect(walk.stepId).toBe("release_prep");
    expect(walk.ownerSession).toBe("release-manager@factory-rsi");
    expect(runtime.instanceStore.getById(walk.instanceId)?.status).toBe("active");
    expect(queueRepo.getById(walk.packetId)?.state).not.toBe("blocked");

    // The release-manager finishes prep and hands off to the sign-off gate.
    const toSignoff = await runtime.project({
      instanceId: walk.instanceId,
      currentPacketId: walk.packetId,
      exit: "handoff",
      actorSession: "release-manager@factory-rsi",
      resultNote: "release artifacts prepared",
    });
    expect(toSignoff.nextStepId).toBe("release_signoff");
    // NOW — and only now, after prep exists — the human gate parks the packet on
    // the human seat, with summary + evidence_ref carried (migrations 044 + 048).
    const signoffItem = queueRepo.getById(toSignoff.nextQitemId!);
    expect(signoffItem?.state).toBe("blocked");
    expect(signoffItem?.blockedOn).toBe("human@kernel");
    expect(signoffItem?.summary).toBeTruthy();
    expect(signoffItem?.evidenceRef).toBe("proof/PROOF.md");
    expect(runtime.instanceStore.getById(walk.instanceId)?.status).toBe("waiting");
  });

  it("qa_check `failed` (artifact verdict) routes to implement for bounded remediation", async () => {
    const created = await runtime.instantiate({
      specPath: RSI_SPEC,
      rootObjective: "RSI remediation",
      createdBySession: "plan-planner@factory-rsi",
    });
    // plan → implement → qa_check
    let packetId = created.entryQitemId;
    for (const actor of ["plan-planner@factory-rsi", "build-implementer@factory-rsi"]) {
      const p = await runtime.project({
        instanceId: created.instance.instanceId,
        currentPacketId: packetId,
        exit: "handoff",
        actorSession: actor,
      });
      packetId = p.nextQitemId!;
    }
    const projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "failed",
      actorSession: "check-qa@factory-rsi",
      resultNote: "check failed the artifact",
    });
    expect(projected.nextStepId).toBe("implement");
    expect(projected.nextOwnerSession).toBe("build-implementer@factory-rsi");
  });
});

/** Walk a fresh instance plan→implement→qa_check→review (all handoff); the last
 *  hop lands on release_prep (the inner loop's release step). */
async function walkToReleasePrep(
  runtime: WorkflowRuntime,
): Promise<{ instanceId: string; packetId: string; stepId: string; ownerSession: string }> {
  const created = await runtime.instantiate({
    specPath: RSI_SPEC,
    rootObjective: "walk to release_prep",
    createdBySession: "plan-planner@factory-rsi",
  });
  let packetId = created.entryQitemId;
  let stepId = "plan";
  let ownerSession = "plan-planner@factory-rsi";
  for (const actor of [
    "plan-planner@factory-rsi",
    "build-implementer@factory-rsi",
    "check-qa@factory-rsi",
    "review-reviewer@factory-rsi",
  ]) {
    const p = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: actor,
    });
    packetId = p.nextQitemId!;
    stepId = p.nextStepId!;
    ownerSession = p.nextOwnerSession!;
  }
  return { instanceId: created.instance.instanceId, packetId, stepId, ownerSession };
}
