import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier } from "../src/domain/project-classifier.js";
import { projectsRoutes } from "../src/routes/projects.js";

function buildApp(opts: {
  eventBus: EventBus;
  classifier: ProjectClassifier;
  leaseMgr: ClassifierLeaseManager;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("projectClassifier" as never, opts.classifier);
    c.set("classifierLeaseManager" as never, opts.leaseMgr);
    await next();
  });
  app.route("/api/projects", projectsRoutes());
  return app;
}

describe("projects routes (PL-004 Phase B)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let leaseMgr: ClassifierLeaseManager;
  let classifier: ProjectClassifier;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, classifierLeasesSchema, projectClassificationsSchema]);
    bus = new EventBus(db);
    leaseMgr = new ClassifierLeaseManager(db, bus);
    classifier = new ProjectClassifier(db, bus, leaseMgr);
    app = buildApp({ eventBus: bus, classifier, leaseMgr });
  });

  afterEach(() => db.close());

  it("POST /api/projects/lease/acquire returns 201 + active lease", async () => {
    const res = await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    expect(res.status).toBe(201);
    const lease = (await res.json()) as { state: string; classifierSession: string };
    expect(lease.state).toBe("active");
    expect(lease.classifierSession).toBe("alice@rig");
  });

  it("POST /api/projects/project requires lease + idempotent on stream_item_id", async () => {
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    const first = await app.request("/api/projects/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamItemId: "stream-x",
        classifierSession: "alice@rig",
        classificationType: "idea",
      }),
    });
    expect(first.status).toBe(201);
    const project = (await first.json()) as { projectId: string };
    expect(project.projectId).toMatch(/^[0-9A-Z]{26}$/);

    const second = await app.request("/api/projects/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamItemId: "stream-x",
        classifierSession: "alice@rig",
        classificationType: "bug",
      }),
    });
    expect(second.status).toBe(409);
    const err = (await second.json()) as { error: string };
    expect(err.error).toBe("idempotency_violation");
  });

  it("POST /api/projects/project without active lease returns 409 no_active_lease", async () => {
    const res = await app.request("/api/projects/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamItemId: "stream-x",
        classifierSession: "alice@rig",
      }),
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("no_active_lease");
  });

  it("POST /api/projects/reclaim-classifier with --if-dead refuses on alive holder", async () => {
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    const res = await app.request("/api/projects/reclaim-classifier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ byClassifierSession: "operator@rig", ifDead: true }),
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("lease_still_active");
  });

  it("POST /api/projects/reclaim-classifier without --if-dead succeeds", async () => {
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    const res = await app.request("/api/projects/reclaim-classifier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ byClassifierSession: "operator@rig" }),
    });
    expect(res.status).toBe(200);
    const lease = (await res.json()) as { state: string; reclaimedBySession: string };
    expect(lease.state).toBe("reclaimed");
    expect(lease.reclaimedBySession).toBe("operator@rig");
  });

  it("GET /api/projects/lease returns active lease (or 404 if none)", async () => {
    let res = await app.request("/api/projects/lease");
    expect(res.status).toBe(404);

    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });

    res = await app.request("/api/projects/lease");
    expect(res.status).toBe(200);
    const lease = (await res.json()) as { classifierSession: string };
    expect(lease.classifierSession).toBe("alice@rig");
  });

  it("GET /api/projects/list filters by classifierSession + classificationDestination", async () => {
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    for (const [id, dest] of [["s1", "planning@rig"], ["s2", "delivery@rig"], ["s3", "planning@rig"]] as Array<[string, string]>) {
      await app.request("/api/projects/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamItemId: id,
          classifierSession: "alice@rig",
          classificationDestination: dest,
        }),
      });
    }
    const res = await app.request("/api/projects/list?classificationDestination=planning%40rig");
    const data = (await res.json()) as unknown[];
    expect(data).toHaveLength(2);
  });

  it("R1 SSE pattern: GET /api/projects/sse returns 200 + content-type text/event-stream (handler reached, not /:id)", async () => {
    const res = await app.request("/api/projects/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/projects/watch returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/projects/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/projects/sse does NOT return project_not_found (route-order regression guard)", async () => {
    const res = await app.request("/api/projects/sse");
    try {
      expect(res.status).not.toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});
