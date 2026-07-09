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
// OPR.0.4.6.FAC1 (guard code-review blocker at 6e991a9d): route-level
// regressions for the new bound-rig HTTP status mapping.
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "../src/db/migrations/052_workflow_instance_bound_rig.js";

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
    const body = (await res.json()) as { ok: boolean; summary: { entryRole: string | null } };
    expect(body.ok).toBe(true);
    expect(body.summary.entryRole).toBe("producer");
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

  // OPR.0.3.3.04.1 (AC-3) discriminator-flip: a discovered spec must be
  // instantiable BY NAME (no hidden file path). Pre-fix, instantiate fed the
  // bare name to readThrough -> spec_file_missing (404); post-fix it resolves
  // the name against the seeded cache to the stored sourcePath -> 201.
  it("POST /instantiate resolves a seeded spec BY NAME (AC-3 reachability), not just a literal path", async () => {
    // Seed the spec into the cache the way the starter-spec-loader does at seed
    // time: a readThrough caches `routes-fixture` by name with its sourcePath.
    const seed = await app.request("/api/workflow/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath }),
    });
    expect(seed.status).toBe(200);
    // Instantiate by the discovered NAME (no path).
    const res = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: "routes-fixture", rootObjective: "by-name", createdBySession: "ops@rig" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { instance: { instanceId: string }; entryQitemId: string };
    expect(body.instance.instanceId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.entryQitemId).toBeDefined();
  });

  // OPR.0.3.3.04.1: literal-sourcePath fallback preserved. An identifier that is
  // neither a cached name nor an existing file resolves as a literal path and
  // 404s honestly (spec_file_missing) - name-resolution does not mask real
  // missing-path errors.
  it("POST /instantiate falls back to literal sourcePath for an unmatched name (honest 404)", async () => {
    const res = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: "no-such-name", rootObjective: "x", createdBySession: "ops@rig" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /instantiate surfaces queue destination validation as 400", async () => {
    const rejectingQueueRepo = new QueueRepository(db, bus, { validateRig: () => false });
    const rejectingRuntime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo: rejectingQueueRepo,
    });
    const rejectingApp = buildApp({ eventBus: bus, runtime: rejectingRuntime });

    const res = await rejectingApp.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "test", createdBySession: "ops@rig" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_destination_rig");
    expect(body.error).not.toBe("internal_error");
    expect(body.message).toContain("producer@rig");
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

// ── OPR.0.4.6.WF1 guard blocker 1 regression ─────────────────────────

import { vi } from "vitest";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";

describe("FR-5 route contract: instance_version_conflict is HTTP 409 with expected/actual in the body (guard blocker 1)", () => {
  it("POST /project as the stale concurrent loser returns 409, never 500", async () => {
    const db2 = createDb();
    migrate(db2, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus2 = new EventBus(db2);
    db2.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo2 = new QueueRepository(db2, bus2, { validateRig: () => true });
    const runtime2 = new WorkflowRuntime({ db: db2, eventBus: bus2, queueRepo: queueRepo2 });
    const app2 = buildApp({ eventBus: bus2, runtime: runtime2 });
    const tmp2 = mkdtempSync(join(tmpdir(), "wf-route-409-"));
    const specPath2 = join(tmp2, "spec.yaml");
    writeFileSync(specPath2, SPEC);
    try {
      const inst = await runtime2.instantiate({
        specPath: specPath2,
        rootObjective: "route 409 pin",
        createdBySession: "ops@rig",
      });
      // Simulate the race exactly as the unit pin does: the route's
      // project() reads the instance, then a concurrent writer bumps
      // the version before the transaction body runs.
      const realGet = runtime2.instanceStore.getByIdOrThrow.bind(runtime2.instanceStore);
      vi.spyOn(runtime2.instanceStore, "getByIdOrThrow").mockImplementationOnce(
        (id: string) => {
          const stale = realGet(id);
          db2.prepare(
            `UPDATE workflow_instances SET version = version + 1 WHERE instance_id = ?`,
          ).run(id);
          return stale;
        },
      );
      const res = await app2.request("/api/workflow/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: inst.instance.instanceId,
          currentPacketId: inst.entryQitemId,
          exit: "handoff",
          actorSession: "producer@rig",
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("instance_version_conflict");
      expect(typeof body.expectedVersion).toBe("number");
      expect(typeof body.actualVersion).toBe("number");
      expect(body.actualVersion).toBe((body.expectedVersion as number) + 1);
      vi.restoreAllMocks();
      // Whole-txn rollback: the packet is untouched; a clean retry works.
      const retry = await app2.request("/api/workflow/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: inst.instance.instanceId,
          currentPacketId: inst.entryQitemId,
          exit: "handoff",
          actorSession: "producer@rig",
        }),
      });
      expect(retry.status).toBe(200);
    } finally {
      db2.close();
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

// ── OPR.0.4.6.WF1 guard round-2 blocker regression ───────────────────

describe("FR-7 route contract: strict-validation rejections are structured 400s, never 500s (guard round-2 blocker)", () => {
  let db3: Database.Database;
  let app3: Hono;
  let tmp3: string;

  beforeEach(() => {
    db3 = createDb();
    migrate(db3, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus3 = new EventBus(db3);
    db3.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo3 = new QueueRepository(db3, bus3, { validateRig: () => true });
    const runtime3 = new WorkflowRuntime({ db: db3, eventBus: bus3, queueRepo: queueRepo3 });
    app3 = buildApp({ eventBus: bus3, runtime: runtime3 });
    tmp3 = mkdtempSync(join(tmpdir(), "wf-route-400-"));
  });

  afterEach(() => {
    db3.close();
    rmSync(tmp3, { recursive: true, force: true });
  });

  it("POST /validate on a spec with a root sibling of workflow: returns 400 + spec_unknown_key + details", async () => {
    const p = join(tmp3, "root-sibling.yaml");
    writeFileSync(p, SPEC + "extra_root_key: true\n");
    const res = await app3.request("/api/workflow/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specPath: p }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("spec_unknown_key");
    expect(body.key).toBe("extra_root_key");
    expect(body.path).toBe("(document root)");
  });

  it("POST /validate on an invalid loop_guards.max_hops returns 400 + spec_field_invalid + field details", async () => {
    const p = join(tmp3, "bad-maxhops.yaml");
    writeFileSync(p, SPEC + "  loop_guards:\n    max_hops: nope\n");
    const res = await app3.request("/api/workflow/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specPath: p }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("spec_field_invalid");
    expect(body.field).toBe("workflow.loop_guards.max_hops");
  });

  it("POST /instantiate hits the same mapper: a strict-validation rejection is 400, never 500", async () => {
    const p = join(tmp3, "bad-instantiate.yaml");
    writeFileSync(p, SPEC + "  loop_guards:\n    max_hops: nope\n");
    const res = await app3.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specPath: p,
        rootObjective: "must not 500",
        createdBySession: "ops@rig",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("spec_field_invalid");
  });
});

// ── OPR.0.4.6.WF2 (guard blocker 2): the new language/routing failures are
// STRUCTURED 400/409s on the public route surface, never 500s. ──────────────

describe("workflow routes — WF-2 structured error boundaries", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    db = createDb();
    const { bindingsSessionsSchema } = await import("../src/db/migrations/002_bindings_sessions.js");
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = buildApp({ eventBus: bus, runtime });
    tmp = mkdtempSync(join(tmpdir(), "wf2-routes-"));
    prevHome = process.env.OPENRIG_HOME;
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.OPENRIG_HOME;
    else process.env.OPENRIG_HOME = prevHome;
  });

  async function instantiate(specPath: string): Promise<Response> {
    return app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "boundary test", createdBySession: "ops@rig" }),
    });
  }

  it("a registered REMOTE host pin instantiates to 400 host_pin_remote_unsupported naming MH-3 (never 500)", async () => {
    writeFileSync(
      join(tmp, "hosts.yaml"),
      "hosts:\n  - id: vps-1\n    transport: ssh\n    target: vps-1.invalid\n",
    );
    process.env.OPENRIG_HOME = tmp;
    const specPath = join(tmp, "remote.yaml");
    writeFileSync(specPath, `workflow:
  id: rb-remote
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      host: vps-1
`);
    const res = await instantiate(specPath);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("host_pin_remote_unsupported");
    expect(body.message).toContain("MH-3");
  });

  it("an unsatisfiable harness pin instantiates to 409 harness_pin_unsatisfied (never 500)", async () => {
    const specPath = join(tmp, "harness.yaml");
    writeFileSync(specPath, `workflow:
  id: rb-harness
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      harness: codex
`);
    // No seeded seat runs codex → structured routing conflict.
    const res = await instantiate(specPath);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("harness_pin_unsatisfied");
  });

  it("gate field/target failures surface as 400 spec_invalid with the named validator issues (never 500)", async () => {
    const specPath = join(tmp, "gate.yaml");
    writeFileSync(specPath, `workflow:
  id: rb-gate
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      gate:
        target: nobody-anywhere
`);
    const res = await instantiate(specPath);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: Array<{ code: string }> };
    expect(body.error).toBe("spec_invalid");
    expect(body.issues?.some((i) => i.code === "gate_target_unresolved")).toBe(true);
  });
});

// OPR.0.4.6.FAC1 — guard code-review blocker at 6e991a9d: the new bound-rig
// errors are thrown correctly in-domain but were MISSING from the route
// errorResponse mapper, so the public HTTP/CLI surface fell through to 500.
// These route-level regressions drive the REAL public surface (the domain
// tests in workflow-bound-rig / workflow-role-resolution do not) and pin the
// honest status: instantiate authoring-boundary → 400, project live-state
// conflict → 409. (The WF-1/WF-2 "new structured error needs a route-mapper
// entry the moment it exists" class, a third time.)
describe("workflow routes — FAC-1 bound-rig HTTP status mapping (guard blocker 6e991a9d)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let tmp: string;
  let sessionSeq = 0;

  // Role-only spec (ZERO preferred_targets) so the capability resolver + the
  // structural role-coverage check engage on the bound rig.
  const ROLE_ONLY = `workflow:
  id: fac1-route-roleonly
  version: 1
  entry:
    role: lead
  roles:
    lead: {}
    worker: {}
  steps:
    - id: plan
      actor_role: lead
      allowed_exits:
        - handoff
    - id: build
      actor_role: worker
      allowed_exits:
        - done
`;

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [
      queueItemSummarySchema, queueItemEvidenceRefSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      workflowInstanceVersionSchema, workflowSpecJsonSchema, workflowResumeSchema,
      workflowInstanceBoundRigSchema,
    ]);
    bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = buildApp({ eventBus: bus, runtime });
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-routes-boundrig-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedSeat(rigId: string, rigName: string, pod: string, member: string, role: string): string {
    const podRec = podRepo.getPodByNamespace(rigId, pod) ?? podRepo.createPod(rigId, pod, pod);
    const node = rigRepo.addNode(rigId, `${pod}.${member}`, {
      role, runtime: "claude-code", cwd: "/tmp", podId: podRec.id, agentRef: "local:agents/x", profile: "default",
    });
    sessionSeq += 1;
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)`).run(
      `s-${String(sessionSeq).padStart(4, "0")}`, node.id, `${pod}-${member}@${rigName}`, "running",
    );
    return `${pod}-${member}@${rigName}`;
  }
  function writeSpec(name: string, content: string): string {
    const p = join(tmp, name);
    writeFileSync(p, content);
    return p;
  }
  function post(path: string, body: unknown): Promise<Response> {
    return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  it("POST /instantiate: explicit --rig unknown → 400 bound_rig_unknown + structured details, no instance row (arch-ruling public contract)", async () => {
    const before = db.prepare(`SELECT COUNT(*) c FROM workflow_instances`).get() as { c: number };
    const specPath = writeSpec("ro-unknown.yaml", ROLE_ONLY);
    const res = await post("/api/workflow/instantiate", {
      specPath, rootObjective: "t", createdBySession: "ops@rig", targetRig: "no-such-rig",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; registeredRigs?: string[] };
    expect(body.error).toBe("bound_rig_unknown");
    expect(body.registeredRigs).toBeDefined();
    const after = db.prepare(`SELECT COUNT(*) c FROM workflow_instances`).get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("POST /instantiate: known bound rig structurally lacks a required role → 400 bound_rig_role_uncovered", async () => {
    const rig = rigRepo.createRig("factory-min");
    seedSeat(rig.id, "factory-min", "dev", "lead", "lead"); // covers entry 'lead', NOT 'worker'
    const specPath = writeSpec("ro-uncovered.yaml", ROLE_ONLY);
    const res = await post("/api/workflow/instantiate", {
      specPath, rootObjective: "t", createdBySession: "ops@factory-min", targetRig: "factory-min",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bound_rig_role_uncovered");
  });

  it("POST /project: persisted bound rig vanished mid-run → 409 bound_rig_not_found", async () => {
    const rig = rigRepo.createRig("factory-gone");
    seedSeat(rig.id, "factory-gone", "dev", "lead", "lead");
    seedSeat(rig.id, "factory-gone", "dev", "worker", "worker"); // both roles covered → instantiate succeeds bound
    const specPath = writeSpec("ro-vanish.yaml", ROLE_ONLY);
    const inst = await post("/api/workflow/instantiate", {
      specPath, rootObjective: "t", createdBySession: "ops@factory-gone", targetRig: "factory-gone",
    });
    expect(inst.status).toBe(201);
    const ib = (await inst.json()) as { instance: { instanceId: string }; entryQitemId: string; entryOwnerSession: string };
    // The bound rig is torn down mid-run.
    db.prepare(`DELETE FROM rigs WHERE name = 'factory-gone'`).run();
    // Projecting the entry resolves the role-only 'build' step on the vanished bound rig.
    const proj = await post("/api/workflow/project", {
      instanceId: ib.instance.instanceId, currentPacketId: ib.entryQitemId, exit: "handoff", actorSession: ib.entryOwnerSession,
    });
    expect(proj.status).toBe(409);
    expect(((await proj.json()) as { error: string }).error).toBe("bound_rig_not_found");
  });
});
