// Workflows in Spec Library + Activation Lens v0 — boundToWorkflow filter.
//
// Pins that GET /api/slices?boundToWorkflow=<name>:<version> narrows the
// slice list to those whose primary workflow_instance binding matches the
// requested spec (name + version), via the same findSliceWorkflowBinding
// helper Slice Story View v1 uses for its detail projection.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { slicesRoutes } from "../src/routes/slices.js";

function buildApp(opts: { indexer: SliceIndexer; projector: SliceDetailProjector }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, opts.indexer);
    c.set("sliceDetailProjector" as never, opts.projector);
    await next();
  });
  app.route("/api/slices", slicesRoutes());
  return app;
}

function writeSlice(slicesRoot: string, name: string, body: string, qitemIds: string[]): void {
  const dir = path.join(slicesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const qitemBlock = qitemIds.length > 0
    ? `qitems:\n${qitemIds.map((q) => `  - ${q}`).join("\n")}\n`
    : "";
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `---\nstatus: active\n${qitemBlock}---\n# ${body}`,
  );
}

function ensureQitem(db: Database.Database, qitemId: string, body = "fixture"): void {
  db.prepare(
    `INSERT OR IGNORE INTO queue_items
       (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
     VALUES (?, '2026-05-04T00:00:00.000Z', '2026-05-04T00:00:00.000Z', 'src@r', 'dst@r', 'in-progress', 'routine', ?)`,
  ).run(qitemId, body);
}

function insertInstance(db: Database.Database, opts: {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  currentFrontier: string[];
  createdAt?: string;
}): void {
  db.prepare(
    `INSERT INTO workflow_instances (
       instance_id, workflow_name, workflow_version,
       created_by_session, created_at, status,
       current_frontier_json, current_step_id, hop_count
     ) VALUES (?, ?, ?, 'creator@r', ?, 'active', ?, NULL, 0)`,
  ).run(
    opts.instanceId,
    opts.workflowName,
    opts.workflowVersion,
    opts.createdAt ?? "2026-05-04T00:00:00.000Z",
    JSON.stringify(opts.currentFrontier),
  );
}

describe("GET /api/slices?boundToWorkflow=<name>:<version>", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let cleanupDir: string;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "slices-bound-test-"));
    cleanupDir = base;
    slicesRoot = path.join(base, "slices");
    fs.mkdirSync(slicesRoot, { recursive: true });
    const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer });
    app = buildApp({ indexer, projector });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanupDir, { recursive: true, force: true });
  });

  it("narrows the list to slices whose primary instance matches the spec", async () => {
    const qBound = "01J0BOUND0000000000000000";
    const qOther = "01J0OTHER0000000000000000";
    // Body text mentions the slice name so SliceIndexer.matchQitems
    // associates the qitem with the slice.
    ensureQitem(db, qBound, "work for alpha");
    ensureQitem(db, qOther, "work for beta");
    writeSlice(slicesRoot, "alpha", "alpha slice", [qBound]);
    writeSlice(slicesRoot, "beta", "beta slice", [qOther]);

    insertInstance(db, {
      instanceId: "inst-alpha",
      workflowName: "rsi-v2-hot-potato",
      workflowVersion: "1",
      currentFrontier: [qBound],
    });
    insertInstance(db, {
      instanceId: "inst-beta",
      workflowName: "other-workflow",
      workflowVersion: "1",
      currentFrontier: [qOther],
    });

    const res = await app.request("/api/slices?boundToWorkflow=rsi-v2-hot-potato:1");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      slices: Array<{ name: string }>;
      boundToWorkflow: { specName: string; specVersion: string; matched: number; total: number };
    };
    expect(body.slices.map((s) => s.name)).toEqual(["alpha"]);
    expect(body.boundToWorkflow.specName).toBe("rsi-v2-hot-potato");
    expect(body.boundToWorkflow.specVersion).toBe("1");
    expect(body.boundToWorkflow.matched).toBe(1);
  });

  it("returns an empty list when no slice matches", async () => {
    const q = "01J0NOMATCH00000000000000";
    ensureQitem(db, q, "work for alpha");
    writeSlice(slicesRoot, "alpha", "alpha slice", [q]);
    insertInstance(db, {
      instanceId: "inst-1",
      workflowName: "actual",
      workflowVersion: "1",
      currentFrontier: [q],
    });

    const res = await app.request("/api/slices?boundToWorkflow=missing:1");
    const body = await res.json() as { slices: unknown[]; boundToWorkflow: { matched: number } };
    expect(body.slices).toHaveLength(0);
    expect(body.boundToWorkflow.matched).toBe(0);
  });

  it("400s on malformed boundToWorkflow value (no colon)", async () => {
    writeSlice(slicesRoot, "alpha", "alpha slice", []);
    const res = await app.request("/api/slices?boundToWorkflow=just-name");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("boundToWorkflow_invalid");
  });

  it("returns the unfiltered list when boundToWorkflow is absent", async () => {
    writeSlice(slicesRoot, "alpha", "alpha slice", []);
    writeSlice(slicesRoot, "beta", "beta slice", []);
    const res = await app.request("/api/slices");
    const body = await res.json() as { slices: Array<{ name: string }>; boundToWorkflow: unknown };
    expect(body.slices.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(body.boundToWorkflow).toBeNull();
  });
});
