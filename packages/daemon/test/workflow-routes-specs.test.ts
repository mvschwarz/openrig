// Built-in workflow specs — GET /api/workflow/specs route tests.
//
// Drives the new specs route against a hand-mounted Hono app with a
// bare WorkflowRuntime + the new isBuiltIn computation. Pins the
// load-bearing behaviors:
//
//   - empty cache: { specs: [] }
//   - mixed (built-in + operator) rows: isBuiltIn flag set per row
//   - workflowBuiltinSpecsDir context unset: isBuiltIn=false for all
//     (graceful fallback — surface still works, no indicator)
//   - route-order: literal /specs not shadowed by /:instance_id catchall

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { workflowRoutes } from "../src/routes/workflow.js";

const ALPHA_SPEC = `workflow:
  id: alpha-spec
  version: 1
  objective: alpha test
  roles:
    a:
      preferred_targets: [a@r]
  steps:
    - id: only
      actor_role: a
      allowed_exits: [handoff]
`;

function buildApp(opts: { runtime: WorkflowRuntime; eventBus: EventBus; builtinDir?: string }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("workflowRuntime" as never, opts.runtime);
    c.set("eventBus" as never, opts.eventBus);
    c.set("workflowBuiltinSpecsDir" as never, opts.builtinDir);
    await next();
  });
  app.route("/api/workflow", workflowRoutes());
  return app;
}

describe("GET /api/workflow/specs", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let eventBus: EventBus;
  let cleanupRoot: string;
  let builtinDir: string;
  let operatorDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    eventBus = new EventBus(db);
    const queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo });
    cleanupRoot = mkdtempSync(join(tmpdir(), "specs-route-"));
    builtinDir = join(cleanupRoot, "builtin", "workflow-specs");
    operatorDir = join(cleanupRoot, "operator");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(operatorDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  it("returns { specs: [] } when no specs are cached", async () => {
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specs: unknown[] };
    expect(body.specs).toEqual([]);
  });

  it("returns each cached spec with the canonical fields", async () => {
    const operatorSpec = join(operatorDir, "alpha.yaml");
    writeFileSync(operatorSpec, ALPHA_SPEC);
    runtime.specCache.readThrough(operatorSpec);
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specs: Array<Record<string, unknown>> };
    expect(body.specs).toHaveLength(1);
    expect(body.specs[0]).toMatchObject({
      name: "alpha-spec",
      version: "1",
      sourcePath: operatorSpec,
      isBuiltIn: false,
    });
  });

  it("computes isBuiltIn=true for specs whose sourcePath is under builtinDir", async () => {
    const builtinSpec = join(builtinDir, "alpha.yaml");
    writeFileSync(builtinSpec, ALPHA_SPEC);
    runtime.specCache.readThrough(builtinSpec);
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    const body = (await res.json()) as { specs: Array<{ name: string; isBuiltIn: boolean }> };
    expect(body.specs[0]?.isBuiltIn).toBe(true);
  });

  it("isBuiltIn=false when workflowBuiltinSpecsDir context is unset (graceful)", async () => {
    const builtinSpec = join(builtinDir, "alpha.yaml");
    writeFileSync(builtinSpec, ALPHA_SPEC);
    runtime.specCache.readThrough(builtinSpec);
    const app = buildApp({ runtime, eventBus });  // no builtinDir
    const res = await app.request("/api/workflow/specs");
    const body = (await res.json()) as { specs: Array<{ isBuiltIn: boolean }> };
    expect(body.specs[0]?.isBuiltIn).toBe(false);
  });

  it("mixed built-in + operator: each row gets the correct isBuiltIn flag", async () => {
    const builtinPath = join(builtinDir, "alpha.yaml");
    writeFileSync(builtinPath, ALPHA_SPEC);
    runtime.specCache.readThrough(builtinPath);

    // Operator authors a different spec at workspace path.
    const operatorPath = join(operatorDir, "beta.yaml");
    writeFileSync(operatorPath, ALPHA_SPEC.replace(/alpha-spec/g, "beta-spec").replace(/alpha test/g, "beta test"));
    runtime.specCache.readThrough(operatorPath);

    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    const body = (await res.json()) as { specs: Array<{ name: string; isBuiltIn: boolean }> };
    const byName = new Map(body.specs.map((s) => [s.name, s.isBuiltIn]));
    expect(byName.get("alpha-spec")).toBe(true);
    expect(byName.get("beta-spec")).toBe(false);
  });

  it("does NOT mark sibling-suffix paths as built-in (false-positive guard)", async () => {
    // Spec at path /tmp/.../builtin/workflow-specs-OTHER/foo.yaml should
    // NOT be marked isBuiltIn just because its prefix matches the
    // builtinDir string. The route uses path.sep boundary semantics.
    const siblingDir = `${builtinDir}-other`;
    mkdirSync(siblingDir, { recursive: true });
    const siblingPath = join(siblingDir, "alpha.yaml");
    writeFileSync(siblingPath, ALPHA_SPEC);
    runtime.specCache.readThrough(siblingPath);
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    const body = (await res.json()) as { specs: Array<{ isBuiltIn: boolean }> };
    expect(body.specs[0]?.isBuiltIn).toBe(false);
  });

  it("route-order: literal /specs is NOT shadowed by /:instance_id catchall", async () => {
    // Without the route-order fix, GET /api/workflow/specs would hit the
    // /:instance_id handler which returns 404 for "specs" as a fake id.
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specs: unknown };
    // Has the specs envelope shape, not the instance-not-found error.
    expect(body).toHaveProperty("specs");
    expect(body).not.toHaveProperty("error");
  });
});
