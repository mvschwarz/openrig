import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { classificationFieldsAndAttemptsSchema } from "../src/db/migrations/086_classification_fields_and_attempts.js";
import { classificationIdentityProvenanceSchema } from "../src/db/migrations/089_classification_identity_provenance.js";
import { streamDispositionsSchema } from "../src/db/migrations/129_stream_dispositions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier, ProjectClassifierError } from "../src/domain/project-classifier.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { DispositionError, getDisposition, markApplied, unappliedDispositions } from "../src/domain/stream-dispositions.js";
import { projectsRoutes } from "../src/routes/projects.js";

const DIGEST = "sha256:" + "a".repeat(64);
const create = (over: Record<string, unknown> = {}) => ({
  disposition: "create", ownerSession: "dev-lead@rig", workQitemId: null,
  effect: { operation: "create", qitemId: "qitem-stream-S1", destination: "dev-lead@rig" },
  templateDigest: DIGEST, templateText: "name: stream\n", request: '{"state":{}}', provenance: { requestedModel: "typesafe/jev-1.13" }, ...over,
});

describe("stream dispositions (slice 22): accepted judgment beside a write-once classification", () => {
  let db: Database.Database, bus: EventBus, leases: ClassifierLeaseManager, classifier: ProjectClassifier, stream: StreamStore;
  const lease = () => leases.getActiveLease()!.leaseId;
  const rows = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, classifierLeasesSchema, projectClassificationsSchema,
      classificationFieldsAndAttemptsSchema, classificationIdentityProvenanceSchema, streamDispositionsSchema]);
    bus = new EventBus(db); leases = new ClassifierLeaseManager(db, bus); classifier = new ProjectClassifier(db, bus, leases); stream = new StreamStore(db, bus);
    for (const id of ["S1", "S2"]) stream.emit({ streamItemId: id, sourceSession: "poster@rig", body: `observation ${id}` });
    leases.acquire("intake@rig");
  });
  afterEach(() => db.close());

  it("is written with the classification, and its effect is fixed", () => {
    const p = classifier.classify({ streamItemId: "S1", classifierSession: "intake@rig", leaseId: lease(), classificationDestination: "dev-lead@rig", action: "create", disposition: create() });
    expect(getDisposition(db, "S1")).toMatchObject({ projectId: p.projectId, disposition: "create", ownerSession: "dev-lead@rig",
      effect: { operation: "create", qitemId: "qitem-stream-S1", destination: "dev-lead@rig" }, templateText: "name: stream\n", request: '{"state":{}}',
      provenance: { requestedModel: "typesafe/jev-1.13" }, appliedAt: null });
    expect(unappliedDispositions(db, 10).map(d => d.streamItemId)).toEqual(["S1"]);
  });

  it("rolls back the classification when the disposition can't be stored", () => {
    // An orphan row for S2 makes the disposition insert fail after the classification insert.
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO stream_dispositions (stream_item_id, project_id, disposition, accepted_by, effect_operation, template_digest, template_text, request_json, provenance_json, accepted_at)
      VALUES ('S2', 'orphan', 'no_action', 'intake@rig', 'none', ?, 'x', 'x', 'null', 'then')`).run(DIGEST);
    db.pragma("foreign_keys = ON");
    expect(() => classifier.classify({ streamItemId: "S2", classifierSession: "intake@rig", leaseId: lease(), action: "no_action",
      disposition: create({ disposition: "no_action", ownerSession: null, effect: { operation: "none", qitemId: null, destination: null } }) })).toThrow();
    expect(rows("project_classifications")).toBe(0);
  });

  it.each<[string, Record<string, unknown>, string | undefined]>([
    ["create whose owner isn't the classification destination", {}, "someone-else@rig"],
    ["create without a derived id", { effect: { operation: "create", qitemId: null, destination: "dev-lead@rig" } }, "dev-lead@rig"],
    ["join without its work item as the target", { disposition: "join", workQitemId: "qitem-9", effect: { operation: "note", qitemId: "qitem-8", destination: null } }, undefined],
    ["no_action with an effect target", { disposition: "no_action", effect: { operation: "none", qitemId: "qitem-9", destination: null } }, undefined],
    ["an effect that doesn't match the disposition", { disposition: "duplicate", effect: { operation: "create", qitemId: "q", destination: "dev-lead@rig" } }, undefined],
    ["a digest that isn't sha256", { templateDigest: "md5:x" }, "dev-lead@rig"],
    ["no request", { request: "" }, "dev-lead@rig"],
  ])("refuses %s, before writing anything", (_name, over, destination) => {
    let error: unknown;
    try { classifier.classify({ streamItemId: "S1", classifierSession: "intake@rig", leaseId: lease(), classificationDestination: destination, disposition: create(over) }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ProjectClassifierError);
    expect((error as ProjectClassifierError).code).toBe("invalid_disposition");
    expect([rows("project_classifications"), rows("stream_dispositions")]).toEqual([0, 0]);
  });

  it("records an effect's outcome once; a repeat returns the first record", () => {
    classifier.classify({ streamItemId: "S1", classifierSession: "intake@rig", leaseId: lease(), classificationDestination: "dev-lead@rig", disposition: create() });
    expect(markApplied(db, "S1", { outcome: "created" }, "t1")).toMatchObject({ appliedAt: "t1", applied: { outcome: "created" } });
    expect(markApplied(db, "S1", { outcome: "conflict" }, "t2")).toMatchObject({ appliedAt: "t1", applied: { outcome: "created" } });
    expect(unappliedDispositions(db, 10)).toEqual([]);
    expect(() => markApplied(db, "S9", {}, "t3")).toThrow(DispositionError);
  });

  describe("routes", () => {
    let app: Hono;
    const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    beforeEach(() => {
      app = new Hono();
      app.use("*", async (c, next) => {
        c.set("db" as never, db); c.set("eventBus" as never, bus); c.set("projectClassifier" as never, classifier); c.set("classifierLeaseManager" as never, leases);
        await next();
      });
      app.route("/api/projects", projectsRoutes());
    });

    it("accepts a disposition with the classification, lists it unapplied, and lets only the lease holder record it", async () => {
      const posted = await app.request("/api/projects/project", json({ streamItemId: "S1", classifierSession: "intake@rig", leaseId: lease(),
        classificationDestination: "dev-lead@rig", action: "create", disposition: create() }));
      expect(posted.status).toBe(201);
      expect(await (await app.request("/api/projects/dispositions/unapplied")).json()).toMatchObject([{ streamItemId: "S1" }]);
      expect((await app.request("/api/projects/dispositions/S1/applied", json({ classifierSession: "other@rig", applied: {} }))).status).toBe(409);
      const recorded = await app.request("/api/projects/dispositions/S1/applied", json({ classifierSession: "intake@rig", leaseId: lease(), applied: { outcome: "created" } }));
      expect(recorded.status).toBe(200);
      expect(await (await app.request("/api/projects/dispositions/S1")).json()).toMatchObject({ applied: { outcome: "created" } });
      expect((await app.request("/api/projects/dispositions/S2")).status).toBe(404);
    });

    it("an invalid disposition is a 400 and writes no classification", async () => {
      const posted = await app.request("/api/projects/project", json({ streamItemId: "S1", classifierSession: "intake@rig", leaseId: lease(),
        classificationDestination: "dev-lead@rig", disposition: create({ disposition: "escalate" }) }));
      expect(posted.status).toBe(400);
      expect(await posted.json()).toMatchObject({ error: "invalid_disposition" });
      expect(rows("project_classifications")).toBe(0);
    });
  });
});
