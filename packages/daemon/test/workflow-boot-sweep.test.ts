// OPR.0.4.6.WF1 FR-4 (G5): the startup resume sweep.
//
//   - re-arms missing keepalives (heals pre-WF-1 instances);
//   - reissues LOST post-commit nudges (a pending frontier packet with
//     last_nudge_attempt NULL was routed but never nudged — the exact
//     commit-then-crash window, detected deterministically from the
//     nudge ledger, not a heuristic);
//   - surfaces stuck instances (the FR-2 evaluator; the UNCLAIMED
//     frontier is a first-class sweep case — never invisible to an
//     in-progress-only scan like findOverdue);
//   - zero in-flight instances = a no-op with no side effects;
//   - one observable summary line naming counts.

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
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { findArmedKeepaliveJob } from "../src/domain/workflow-keepalive-arming.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";

const SPEC = `workflow:
  id: fr4-sweep
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
    - id: follow
      actor_role: next
      allowed_exits:
        - done
`;

describe("runWorkflowBootSweep (FR-4)", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;
  let logLines: string[];
  let sentNudges: Array<{ session: string; text: string }>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      watchdogJobsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    sentNudges = [];
    queueRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      transport: {
        send: async (session: string, text: string) => {
          sentNudges.push({ session, text });
          return { ok: true, verified: true };
        },
      },
    });
    watchdogRepo = new WatchdogJobsRepository(db);
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
    });
    tmp = mkdtempSync(join(tmpdir(), "wf-sweep-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
    logLines = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function sweep() {
    return runWorkflowBootSweep({
      instanceStore: runtime.instanceStore,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
      log: (line) => logLines.push(line),
    });
  }

  it("zero in-flight instances: a no-op with no side effects and an observable line", async () => {
    const result = await sweep();
    expect(result).toEqual({
      instancesSwept: 0,
      keepalivesArmed: 0,
      lostNudgesReissued: 0,
      stuckSurfaced: 0,
      exceptionItemsCreated: 0,
    });
    expect(watchdogRepo.listAll()).toHaveLength(0);
    expect(sentNudges).toHaveLength(0);
    expect(logLines.some((l) => l.includes("0 in-flight"))).toBe(true);
  });

  it("re-arms the keepalive for a pre-WF-1 instance (no active job) and reports it healthily armed", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "re-arm walk",
      createdBySession: "ops@rig",
    });
    // Simulate pre-WF-1: no active job for the instance.
    const armed = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)!;
    watchdogRepo.markTerminal(armed.jobId, "simulated_pre_wf1_state");

    const result = await sweep();
    expect(result.instancesSwept).toBe(1);
    expect(result.keepalivesArmed).toBe(1);
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).not.toBeNull();
  });

  it("LOST-NUDGE recovery: a pending frontier packet with last_nudge_attempt NULL is re-nudged at boot (the commit-then-crash window)", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "lost nudge walk",
      createdBySession: "ops@rig",
    });
    // Simulate the lost post-commit nudge: NULL the ledger (instantiate's
    // own nudge stamped it via the test transport above).
    db.prepare(
      `UPDATE queue_items SET last_nudge_attempt = NULL, last_nudge_result = NULL WHERE qitem_id = ?`,
    ).run(inst.entryQitemId);
    sentNudges.length = 0;

    const result = await sweep();
    expect(result.lostNudgesReissued).toBe(1);
    expect(sentNudges.some((n) => n.session === "worker@rig")).toBe(true);
    // The nudge ledger is stamped again — a second sweep does NOT re-reissue.
    const again = await sweep();
    expect(again.lostNudgesReissued).toBe(0);
  });

  it("surfaces a stuck instance (overdue-unclaimed — the first-class unclaimed-frontier case) with evidence in the log and a re-nudge", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "stuck walk",
      createdBySession: "ops@rig",
    });
    const past = new Date(
      Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 120) * 1000,
    ).toISOString();
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(
      past,
      inst.entryQitemId,
    );
    sentNudges.length = 0;

    const result = await sweep();
    expect(result.stuckSurfaced).toBe(1);
    const stuckLine = logLines.find((l) => l.includes("STUCK"));
    expect(stuckLine).toBeDefined();
    expect(stuckLine).toContain(inst.instance.instanceId);
    expect(stuckLine).toContain("overdue-unclaimed");
    expect(stuckLine).toContain("worker@rig");
    expect(sentNudges.some((n) => n.session === "worker@rig")).toBe(true);
    // Summary line names counts.
    expect(
      logLines.some((l) => l.includes("1 in-flight") && l.includes("1 stuck")),
    ).toBe(true);
  });

  it("a healthy in-flight instance sweeps clean: armed, zero reissues, zero stuck", async () => {
    await runtime.instantiate({
      specPath,
      rootObjective: "healthy walk",
      createdBySession: "ops@rig",
    });
    const result = await sweep();
    expect(result.instancesSwept).toBe(1);
    expect(result.keepalivesArmed).toBe(0); // instantiate already armed it
    expect(result.lostNudgesReissued).toBe(0); // instantiate's nudge stamped the ledger
    expect(result.stuckSurfaced).toBe(0);
  });
});
