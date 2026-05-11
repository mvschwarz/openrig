// Slice Story View v1 — slice → workflow_instance binding helper.
//
// Pins the load-bearing behaviors of findSliceWorkflowBinding:
//
//   - empty qitem set → no binding
//   - no instance touches the slice qitems → no binding
//   - trail signal: instance found via prior_qitem_id / next_qitem_id
//   - live frontier signal: instance found via current_frontier_json LIKE
//   - multiple instances bind: most-recent picked as primary; rest as
//     additionalInstanceIds
//   - terminal instance with empty frontier still binds via trail history
//   - empty frontier_json parses to []

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { findSliceWorkflowBinding } from "../src/domain/workflow/slice-workflow-binding.js";

function insertInstance(db: Database.Database, opts: {
  instanceId: string;
  workflowName?: string;
  workflowVersion?: string;
  status?: string;
  currentFrontier?: string[];
  currentStepId?: string | null;
  hopCount?: number;
  createdAt?: string;
}): void {
  db.prepare(
    `INSERT INTO workflow_instances (
       instance_id, workflow_name, workflow_version,
       created_by_session, created_at, status,
       current_frontier_json, current_step_id, hop_count
     ) VALUES (?, ?, ?, 'creator@r', ?, ?, ?, ?, ?)`
  ).run(
    opts.instanceId,
    opts.workflowName ?? "conveyor",
    opts.workflowVersion ?? "1",
    opts.createdAt ?? "2026-05-04T00:00:00.000Z",
    opts.status ?? "active",
    JSON.stringify(opts.currentFrontier ?? []),
    opts.currentStepId ?? null,
    opts.hopCount ?? 0,
  );
}

function ensureQitem(db: Database.Database, qitemId: string): void {
  // workflow_step_trails has FK constraints to queue_items on both
  // prior_qitem_id and next_qitem_id; FK enforcement is on, so the
  // qitem rows have to exist before the trail rows can land.
  db.prepare(
    `INSERT OR IGNORE INTO queue_items
       (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
     VALUES (?, '2026-05-04T00:00:00.000Z', '2026-05-04T00:00:00.000Z', 'src@r', 'dst@r', 'in-progress', 'routine', 'fixture')`
  ).run(qitemId);
}

function insertTrail(db: Database.Database, opts: {
  trailId: string;
  instanceId: string;
  stepId: string;
  stepRole: string;
  closedAt?: string;
  closureReason?: string;
  actorSession?: string;
  priorQitemId: string;
  nextQitemId?: string | null;
}): void {
  ensureQitem(db, opts.priorQitemId);
  if (opts.nextQitemId) ensureQitem(db, opts.nextQitemId);
  db.prepare(
    `INSERT INTO workflow_step_trails (
       trail_id, instance_id, step_id, step_role,
       closed_at, closure_reason, actor_session,
       prior_qitem_id, next_qitem_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.trailId,
    opts.instanceId,
    opts.stepId,
    opts.stepRole,
    opts.closedAt ?? "2026-05-04T01:00:00.000Z",
    opts.closureReason ?? "handoff",
    opts.actorSession ?? "actor@r",
    opts.priorQitemId,
    opts.nextQitemId ?? null,
  );
}

describe("PL-slice-story-view-v1 findSliceWorkflowBinding", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  });

  afterEach(() => db.close());

  it("returns no binding for empty qitem set", () => {
    expect(findSliceWorkflowBinding(db, [])).toEqual({ primary: null, additionalInstanceIds: [] });
  });

  it("returns no binding when no instance touches the slice qitems", () => {
    insertInstance(db, { instanceId: "inst-other", currentFrontier: ["q-other"] });
    insertTrail(db, { trailId: "t1", instanceId: "inst-other", stepId: "discovery", stepRole: "discovery-router", priorQitemId: "q-other" });
    expect(findSliceWorkflowBinding(db, ["q-slice-1", "q-slice-2"])).toEqual({ primary: null, additionalInstanceIds: [] });
  });

  it("trail signal: binds when prior_qitem_id is in slice qitems", () => {
    insertInstance(db, { instanceId: "inst-1", currentFrontier: [], currentStepId: "qa", hopCount: 4, status: "active" });
    insertTrail(db, { trailId: "t1", instanceId: "inst-1", stepId: "discovery", stepRole: "discovery-router", priorQitemId: "q-slice-1" });
    const result = findSliceWorkflowBinding(db, ["q-slice-1"]);
    expect(result.primary?.instanceId).toBe("inst-1");
    expect(result.primary?.workflowName).toBe("conveyor");
    expect(result.primary?.currentStepId).toBe("qa");
    expect(result.primary?.hopCount).toBe(4);
    expect(result.additionalInstanceIds).toEqual([]);
  });

  it("trail signal: binds when next_qitem_id is in slice qitems", () => {
    insertInstance(db, { instanceId: "inst-2", currentFrontier: [] });
    insertTrail(db, { trailId: "t2", instanceId: "inst-2", stepId: "delivery", stepRole: "delivery-driver", priorQitemId: "q-prior", nextQitemId: "q-slice-1" });
    const result = findSliceWorkflowBinding(db, ["q-slice-1"]);
    expect(result.primary?.instanceId).toBe("inst-2");
  });

  it("live frontier signal: binds when current_frontier_json contains a slice qitem", () => {
    insertInstance(db, { instanceId: "inst-live", currentFrontier: ["q-slice-active"], currentStepId: "delivery", status: "active" });
    const result = findSliceWorkflowBinding(db, ["q-slice-active"]);
    expect(result.primary?.instanceId).toBe("inst-live");
    expect(result.primary?.currentFrontier).toEqual(["q-slice-active"]);
    expect(result.primary?.status).toBe("active");
  });

  it("multiple instances bind: most-recent picked as primary; rest exposed as additionalInstanceIds", () => {
    insertInstance(db, { instanceId: "inst-old", createdAt: "2026-05-01T00:00:00.000Z", currentFrontier: [] });
    insertInstance(db, { instanceId: "inst-mid", createdAt: "2026-05-02T00:00:00.000Z", currentFrontier: [] });
    insertInstance(db, { instanceId: "inst-new", createdAt: "2026-05-04T00:00:00.000Z", currentFrontier: [] });
    insertTrail(db, { trailId: "t-old", instanceId: "inst-old", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    insertTrail(db, { trailId: "t-mid", instanceId: "inst-mid", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    insertTrail(db, { trailId: "t-new", instanceId: "inst-new", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    const result = findSliceWorkflowBinding(db, ["q-1"]);
    expect(result.primary?.instanceId).toBe("inst-new");
    expect(result.additionalInstanceIds.sort()).toEqual(["inst-mid", "inst-old"]);
  });

  it("terminal instance with empty frontier still binds via trail history", () => {
    insertInstance(db, { instanceId: "inst-done", status: "completed", currentFrontier: [], currentStepId: null });
    insertTrail(db, { trailId: "t-done", instanceId: "inst-done", stepId: "qa", stepRole: "qa-tester", priorQitemId: "q-final", closureReason: "done" });
    const result = findSliceWorkflowBinding(db, ["q-final"]);
    expect(result.primary?.instanceId).toBe("inst-done");
    expect(result.primary?.status).toBe("completed");
    expect(result.primary?.currentStepId).toBeNull();
    expect(result.primary?.currentFrontier).toEqual([]);
  });

  it("malformed current_frontier_json parses to empty array (graceful)", () => {
    db.prepare(
      `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json)
       VALUES ('inst-bad', 'x', '1', 'c@r', '2026-05-04T00:00:00.000Z', 'active', 'not-valid-json')`
    ).run();
    insertTrail(db, { trailId: "t-bad", instanceId: "inst-bad", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    const result = findSliceWorkflowBinding(db, ["q-1"]);
    expect(result.primary?.currentFrontier).toEqual([]);
  });

  it("union of trail + frontier signals deduplicates the same instance", () => {
    // Single instance reachable via BOTH signals — should not appear twice.
    insertInstance(db, { instanceId: "inst-both", currentFrontier: ["q-1"] });
    insertTrail(db, { trailId: "t-both", instanceId: "inst-both", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    const result = findSliceWorkflowBinding(db, ["q-1"]);
    expect(result.primary?.instanceId).toBe("inst-both");
    expect(result.additionalInstanceIds).toEqual([]);
  });

  // V0.3.1 slice 13 walk-item 7 — declaration-fallback path. When the
  // slice/mission frontmatter declares `workflow_spec: <name>@<ver>`
  // but no live instance touches the slice, the binding falls back to
  // a synthetic record so the downstream projector can render the
  // spec graph (currentStepId: null → projectSpecGraph(spec, null)).
  describe("declaration-fallback binding (slice 13)", () => {
    it("returns synthetic binding when declaration provided + no live instance", () => {
      const result = findSliceWorkflowBinding(db, ["q-no-instance"], {
        name: "openrig-velocity",
        version: "1.0",
      });
      expect(result.primary).not.toBeNull();
      expect(result.primary?.instanceId).toBeNull();
      expect(result.primary?.workflowName).toBe("openrig-velocity");
      expect(result.primary?.workflowVersion).toBe("1.0");
      expect(result.primary?.currentStepId).toBeNull();
      expect(result.primary?.currentFrontier).toEqual([]);
      expect(result.primary?.status).toBe("declared");
      expect(result.additionalInstanceIds).toEqual([]);
    });

    it("declaration is IGNORED when a live instance already binds (live signal wins)", () => {
      insertInstance(db, {
        instanceId: "inst-live",
        currentFrontier: ["q-live"],
        workflowName: "different-spec",
        workflowVersion: "2.0",
      });
      insertTrail(db, {
        trailId: "t-live",
        instanceId: "inst-live",
        stepId: "x",
        stepRole: "r",
        priorQitemId: "q-live",
      });
      const result = findSliceWorkflowBinding(db, ["q-live"], {
        name: "openrig-velocity",
        version: "1.0",
      });
      // Live wins; declaration metadata is not surfaced when a real
      // instance is present.
      expect(result.primary?.instanceId).toBe("inst-live");
      expect(result.primary?.workflowName).toBe("different-spec");
    });

    it("no declaration AND no live instance → null binding (current behavior preserved)", () => {
      const result = findSliceWorkflowBinding(db, ["q-no-instance"]);
      expect(result.primary).toBeNull();
    });

    it("empty qitemIds + declaration provided → still returns synthetic binding (mission case)", () => {
      const result = findSliceWorkflowBinding(db, [], {
        name: "openrig-velocity",
        version: "1.0",
      });
      expect(result.primary?.workflowName).toBe("openrig-velocity");
      expect(result.primary?.instanceId).toBeNull();
    });
  });
});
