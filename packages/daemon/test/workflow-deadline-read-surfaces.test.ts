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
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import { workflowRoutes } from "../src/routes/workflow.js";

/**
 * OPR.0.4.6.WF1 FR-2 COMPLETION FIXBACK
 * (qitem-20260706211220-279039f5) — the ratified queryability clause:
 * "the instance surfaces as stuck (queryable via list/show/trace …)
 * with the evidence (step, owner, deadline, age)".
 *
 * These tests pin the read surfaces: every list row, show body, and
 * trace/continue instance carries the FULL derived classification
 * tuple; overdue classification appears without any state write and
 * self-clears semantics stay derived (a fresh read with a fresh clock
 * is all it takes). Serves BOTH WF-3's rollup and WF-5's ▲ source —
 * one shape, one evaluator home.
 */

const SPEC = `workflow:
  id: deadline-read-fixture
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
        - failed
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
      - failed
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

describe("WF-1 FR-2 completion fixback — deadline on the read surfaces", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let writerRuntime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      workflowInstanceVersionSchema, workflowSpecJsonSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    writerRuntime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-deadline-read-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  async function instantiate(): Promise<string> {
    const result = await writerRuntime.instantiate({
      specPath,
      rootObjective: "deadline read pins",
      createdBySession: "orch@rig",
    });
    return result.instance.instanceId;
  }

  /** A reader app whose runtime clock sits `offsetSeconds` in the future. */
  function readerAppAt(offsetSeconds: number): Hono {
    const reader = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      now: () => new Date(Date.now() + offsetSeconds * 1000),
    });
    return buildApp({ eventBus: bus, runtime: reader });
  }

  it("a fresh instance reads healthy on list, show, and trace — deadline present, evidence null", async () => {
    const instanceId = await instantiate();
    const app = readerAppAt(0);

    const list = await (await app.request("/api/workflow/list")).json() as Array<Record<string, unknown>>;
    const row = list.find((r) => r.instanceId === instanceId);
    expect(row?.deadline).toEqual({ state: "healthy", evidence: null });

    const show = await (await app.request(`/api/workflow/${instanceId}`)).json() as Record<string, unknown>;
    expect(show.deadline).toEqual({ state: "healthy", evidence: null });

    const trace = await (await app.request(`/api/workflow/${instanceId}/trace`)).json() as { instance: Record<string, unknown> };
    expect(trace.instance.deadline).toEqual({ state: "healthy", evidence: null });
  });

  it("past the threshold the SAME rows read overdue-unclaimed with the FULL tuple — no write happened", async () => {
    const instanceId = await instantiate();
    const app = readerAppAt(WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60);

    const show = await (await app.request(`/api/workflow/${instanceId}`)).json() as {
      deadline: { state: string; evidence: Record<string, unknown> | null };
    };
    expect(show.deadline.state).toBe("overdue-unclaimed");
    const ev = show.deadline.evidence;
    expect(ev).not.toBeNull();
    // The ratified tuple: step, owner, deadline anchor, age.
    expect(ev?.stepId).toBe("produce");
    expect(ev?.ownerSession).toBe("producer@rig");
    expect(ev?.anchor).toBe("created_at");
    expect(typeof ev?.anchorAt).toBe("string");
    expect(ev?.overdueBySeconds).toBeGreaterThanOrEqual(0);
    expect(ev?.ageSeconds).toBeGreaterThanOrEqual(WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS);

    // list carries the identical classification (same evaluator, same read).
    const list = await (await app.request("/api/workflow/list?status=active")).json() as Array<{
      instanceId: string; deadline: { state: string };
    }>;
    expect(list.find((r) => r.instanceId === instanceId)?.deadline.state).toBe("overdue-unclaimed");

    // DERIVED, NEVER STORED: a reader at the present clock still says healthy.
    const freshApp = readerAppAt(0);
    const fresh = await (await freshApp.request(`/api/workflow/${instanceId}`)).json() as {
      deadline: { state: string };
    };
    expect(fresh.deadline.state).toBe("healthy");
  });

  it("continue's instance carries the verdict too (trace/continue share the enriched shape)", async () => {
    const instanceId = await instantiate();
    const app = readerAppAt(WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60);
    const res = await app.request(`/api/workflow/${instanceId}/continue`, { method: "POST" });
    const body = await res.json() as { instance: { deadline: { state: string } } };
    expect(body.instance.deadline.state).toBe("overdue-unclaimed");
  });

  it("a terminal instance (empty frontier) reads healthy — nothing to be overdue on", async () => {
    const instanceId = await instantiate();
    // Close the entry step terminally via the projector path.
    const trace = await (await readerAppAt(0).request(`/api/workflow/${instanceId}/trace`)).json() as {
      instance: { currentFrontier: string[] };
    };
    const packetId = trace.instance.currentFrontier[0];
    await writerRuntime.project({
      instanceId,
      currentPacketId: packetId,
      exit: "failed",
      actorSession: "producer@rig",
      resultNote: "fixture terminal close",
    });
    const app = readerAppAt(WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60);
    const show = await (await app.request(`/api/workflow/${instanceId}`)).json() as {
      status: string; deadline: { state: string; evidence: unknown };
    };
    expect(show.status).toBe("failed");
    expect(show.deadline).toEqual({ state: "healthy", evidence: null });
  });
});
