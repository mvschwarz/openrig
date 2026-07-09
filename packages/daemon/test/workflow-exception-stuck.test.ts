// OPR.0.4.6.WF5 FR-2 class (b): detection-time stuck/overdue exception
// items — sweep-created, occurrence-deduped across re-detections and
// across BOTH detection paths (sweep + keepalive), never-lost when the
// spec is uncached, and missed-item re-creation (the crash-surviving
// guarantee's honest twin: one OPEN item per occurrence at all times).

import { describe, it, expect, afterEach } from "vitest";
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
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { makeEnsureStuckExceptionItem } from "../src/domain/workflow-exception-escalation.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";

const SPEC = `workflow:
  id: wf5-stuck-pipeline
  version: 1
  objective: WF-5 class-b fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    orch:
      preferred_targets:
        - orch-lead@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - done
  exception_routing:
    orchestrator_role: orch
`;

const MIGRATIONS = [
  coreSchema,
  eventsSchema,
  queueItemsSchema,
  queueTransitionsSchema,
  watchdogJobsSchema,
  workflowSpecsSchema,
  workflowInstancesSchema,
  workflowStepTrailsSchema,
  queueItemSummarySchema,
  queueItemEvidenceRefSchema,
  workflowInstanceVersionSchema,
  workflowSpecJsonSchema,
];

function exceptionRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT * FROM queue_items WHERE tags LIKE '%exception:stuck_overdue%' ORDER BY ts_created`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe("WF-5 FR-2 class (b): detection-time stuck exception items", () => {
  let db: Database.Database;
  let tmp: string;

  const build = async () => {
    db = createDb();
    migrate(db, MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    const watchdogJobsRepo = new WatchdogJobsRepository(db);
    const ensurer = makeEnsureStuckExceptionItem({
      db,
      queueRepo,
      resolveRoute: (n, v, c) => runtime.resolveExceptionRouteFor(n, v, c),
      humanFallbackSeat: "human@host",
    });
    tmp = mkdtempSync(join(tmpdir(), "wf5-stuck-"));
    const specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "stuck walk",
      createdBySession: "ops@rig",
    });
    const packetId = inst.instance.currentFrontier[0]!;
    // Backdate the never-claimed packet past the single-home threshold.
    const past = new Date(
      Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 3600) * 1000,
    ).toISOString();
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(past, packetId);
    return { queueRepo, runtime, watchdogJobsRepo, ensurer, inst, packetId };
  };

  const sweep = (f: Awaited<ReturnType<typeof build>>) =>
    runWorkflowBootSweep({
      instanceStore: f.runtime.instanceStore,
      queueRepo: f.queueRepo,
      watchdogJobsRepo: f.watchdogJobsRepo,
      ensureStuckExceptionItem: f.ensurer,
    });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("the sweep creates ONE item for an overdue instance, routed per the dial with the ordinary tier and the occurrence tag", async () => {
    const f = await build();
    const result = await sweep(f);
    expect(result.stuckSurfaced).toBe(1);
    expect(result.exceptionItemsCreated).toBe(1);

    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    const item = rows[0]!;
    expect(item.destination_session).toBe("orch-lead@rig");
    expect(item.tier).not.toBe("human-gate");
    const tags = String(item.tags);
    expect(tags).toContain(`occurrence:${f.packetId}`);
    expect(tags).toContain("step:produce");
    expect(String(item.evidence_ref)).toContain("rig workflow trace");
    expect(String(item.body)).toContain("dead-seat");
  });

  it("re-detection DEDUPES: a second sweep updates/re-nudges the ONE item, never a duplicate", async () => {
    const f = await build();
    await sweep(f);
    const second = await sweep(f);
    expect(second.stuckSurfaced).toBe(1);
    expect(second.exceptionItemsCreated).toBe(0);
    expect(exceptionRows(db)).toHaveLength(1);
  });

  it("BOTH detection paths share the occurrence: keepalive evaluation after a sweep dedupes into the same single item", async () => {
    const f = await build();
    await sweep(f);
    const policy = makeWorkflowKeepalivePolicy({ db, ensureStuckExceptionItem: f.ensurer });
    const evaluation = await policy.evaluate({
      jobId: "job-1",
      policy: "workflow-keepalive",
      target: { session: "producer@rig" },
      context: { workflow_instance_id: f.inst.instance.instanceId, deadline_gated: true },
    } as never);
    expect(evaluation.action).toBe("send");
    expect(exceptionRows(db)).toHaveLength(1);
  });

  it("keepalive alone (no prior sweep) creates the item at its detection tick", async () => {
    const f = await build();
    const policy = makeWorkflowKeepalivePolicy({ db, ensureStuckExceptionItem: f.ensurer });
    await policy.evaluate({
      jobId: "job-1",
      policy: "workflow-keepalive",
      target: { session: "producer@rig" },
      context: { workflow_instance_id: f.inst.instance.instanceId, deadline_gated: true },
    } as never);
    expect(exceptionRows(db)).toHaveLength(1);
  });

  it("NEVER-LOST: an uncached spec (resolveRoute null) still routes — human@host with the human-gate tier", async () => {
    const f = await build();
    const blindEnsurer = makeEnsureStuckExceptionItem({
      db,
      queueRepo: f.queueRepo,
      resolveRoute: () => null,
      humanFallbackSeat: "human@host",
    });
    await runWorkflowBootSweep({
      instanceStore: f.runtime.instanceStore,
      queueRepo: f.queueRepo,
      watchdogJobsRepo: f.watchdogJobsRepo,
      ensureStuckExceptionItem: blindEnsurer,
    });
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("human@host");
    expect(rows[0]!.tier).toBe("human-gate");
  });

  it("a MISSED (hand-closed) item with the episode still live is RE-CREATED on the next pass — one OPEN item per occurrence, always", async () => {
    const f = await build();
    await sweep(f);
    const first = exceptionRows(db)[0]!;
    // Simulate the missed-item state: closed out-of-band while the
    // instance is still stuck on the SAME packet.
    db.prepare(`UPDATE queue_items SET state = 'done' WHERE qitem_id = ?`).run(first.qitem_id);
    const again = await sweep(f);
    expect(again.exceptionItemsCreated).toBe(1);
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(2);
    const open = rows.filter((r) => r.state !== "done");
    expect(open).toHaveLength(1);
    expect(String(open[0]!.tags)).toContain(`occurrence:${f.packetId}`);
  });

  it("healthy instances create NOTHING (the zero-noise negative)", async () => {
    const f = await build();
    // Restore the packet to fresh (un-backdate).
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(
      new Date().toISOString(),
      f.packetId,
    );
    const result = await sweep(f);
    expect(result.stuckSurfaced).toBe(0);
    expect(result.exceptionItemsCreated).toBe(0);
    expect(exceptionRows(db)).toHaveLength(0);
  });
});
