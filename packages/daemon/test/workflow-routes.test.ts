import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
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
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { workflowRoutes } from "../src/routes/workflow.js";

const SPEC = `workflow:
  id: routes-fixture
  version: 1
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
`;

function buildApp(opts: { eventBus: EventBus; runtime: WorkflowRuntime }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("workflowRuntime" as never, opts.runtime);
    await next();
  });
  app.route("/api/workflow", workflowRoutes());
  return app;
}

describe("workflow routes (PL-004 Phase D)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = buildApp({ eventBus: bus, runtime });
    tmp = mkdtempSync(join(tmpdir(), "wf-routes-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("POST /validate returns ok=true for a valid spec", async () => {
    const res = await app.request("/api/workflow/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("POST /validate returns 404 for missing file", async () => {
    const res = await app.request("/api/workflow/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: join(tmp, "missing.yaml") }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /instantiate returns 201 with instance + entry qitem", async () => {
    const res = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "test", createdBySession: "ops@rig" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { instance: { instanceId: string }; entryQitemId: string };
    expect(body.instance.instanceId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.entryQitemId).toBeDefined();
  });

  it("POST /project closes packet + creates next packet", async () => {
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const created = (await create.json()) as { instance: { instanceId: string }; entryQitemId: string };
    const res = await app.request("/api/workflow/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: created.instance.instanceId,
        currentPacketId: created.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextStepId: string; nextOwnerSession: string };
    expect(body.nextStepId).toBe("review");
    expect(body.nextOwnerSession).toBe("reviewer@rig");
  });

  // R3 fix (guard blocker): exit_not_allowed must surface as HTTP 400
  // (not 500 internal-server-error) with structured details preserved.
  // Asserts no side effects on the public path: queue still pending,
  // instance state unchanged.
  it("POST /project surfaces exit_not_allowed as 400 with structured details + no side effects", async () => {
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const created = (await create.json()) as { instance: { instanceId: string }; entryQitemId: string };

    // Capture pre-rejection state via the public surface.
    const beforeShow = await app.request(`/api/workflow/${created.instance.instanceId}`);
    const beforeInstance = (await beforeShow.json()) as {
      currentFrontier: string[];
      currentStepId: string | null;
      status: string;
    };

    // Attempt exit=done on the produce step (which only allows handoff).
    const res = await app.request("/api/workflow/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: created.instance.instanceId,
        currentPacketId: created.entryQitemId,
        exit: "done",
        actorSession: "producer@rig",
      }),
    });

    // R3 critical: 400 (NOT 500), structured error code + details preserved.
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as {
      error: string;
      message: string;
      stepId?: string;
      attemptedExit?: string;
      allowedExits?: string[];
    };
    expect(body.error).toBe("exit_not_allowed");
    expect(body.error).not.toBe("internal_error");
    expect(body.message).toContain("produce");
    expect(body.stepId).toBe("produce");
    expect(body.attemptedExit).toBe("done");
    expect(body.allowedExits).toEqual(["handoff"]);

    // No side effects through the public path: instance unchanged.
    const afterShow = await app.request(`/api/workflow/${created.instance.instanceId}`);
    const afterInstance = (await afterShow.json()) as {
      currentFrontier: string[];
      currentStepId: string | null;
      status: string;
    };
    expect(afterInstance.currentFrontier).toEqual(beforeInstance.currentFrontier);
    expect(afterInstance.currentStepId).toBe(beforeInstance.currentStepId);
    expect(afterInstance.status).toBe(beforeInstance.status);
    // Trail still empty (no projected step closure recorded).
    const traceRes = await app.request(`/api/workflow/${created.instance.instanceId}/trace`);
    const trace = (await traceRes.json()) as { trail: Array<unknown> };
    expect(trace.trail).toEqual([]);
  });

  it("GET /list returns all instances", async () => {
    await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const res = await app.request("/api/workflow/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<unknown>;
    expect(body).toHaveLength(1);
  });

  it("GET /list?status=active filters by status", async () => {
    await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const res = await app.request("/api/workflow/list?status=completed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<unknown>;
    expect(body).toHaveLength(0);
  });

  it("GET /:instance_id returns 404 for unknown id", async () => {
    const res = await app.request("/api/workflow/unknown-id");
    expect(res.status).toBe(404);
  });

  it("GET /:instance_id returns instance for known id", async () => {
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const created = (await create.json()) as { instance: { instanceId: string } };
    const res = await app.request(`/api/workflow/${created.instance.instanceId}`);
    expect(res.status).toBe(200);
  });

  it("GET /:instance_id/trace returns instance + trail", async () => {
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const created = (await create.json()) as { instance: { instanceId: string } };
    const res = await app.request(`/api/workflow/${created.instance.instanceId}/trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: { instanceId: string }; trail: Array<unknown> };
    expect(body.trail).toEqual([]);
  });

  // Phase A R1 SSE route-order discipline tests.
  it("R1 SSE pattern: GET /api/workflow/sse returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/workflow/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/workflow/watch returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/workflow/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/workflow/sse does NOT return instance_not_found (route-order regression guard)", async () => {
    const res = await app.request("/api/workflow/sse");
    try {
      expect(res.status).not.toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});
