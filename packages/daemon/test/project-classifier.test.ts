import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import {
  ProjectClassifier,
  ProjectClassifierError,
} from "../src/domain/project-classifier.js";
import { ClassifierLeaseError } from "../src/domain/classifier-lease-manager.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("ProjectClassifier (PL-004 Phase B; L2 classifier write path)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let leaseMgr: ClassifierLeaseManager;
  let classifier: ProjectClassifier;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, classifierLeasesSchema, projectClassificationsSchema]);
    bus = new EventBus(db);
    leaseMgr = new ClassifierLeaseManager(db, bus);
    classifier = new ProjectClassifier(db, bus, leaseMgr);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("classify with valid lease creates project_classifications row + emits project.classified", () => {
    leaseMgr.acquire("alice@rig");
    const proj = classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      classificationType: "idea",
      classificationDestination: "planning@rig",
    });
    expect(proj.projectId).toMatch(/^[0-9A-Z]{26}$/); // ULID shape
    expect(proj.streamItemId).toBe("stream-1");
    expect(proj.classifierSession).toBe("alice@rig");
    expect(proj.classificationType).toBe("idea");
    expect(captured.some((e) => e.type === "project.classified")).toBe(true);
  });

  it("classify without active lease throws no_active_lease", () => {
    expect(() => classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
    })).toThrow(ClassifierLeaseError);
  });

  it("classify by non-holder throws lease_held", () => {
    leaseMgr.acquire("alice@rig");
    expect(() => classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "bob@rig",
    })).toThrow(/lease_held|alice@rig/);
  });

  it("classify is idempotent on stream_item_id (re-projection → idempotency_violation 409)", () => {
    leaseMgr.acquire("alice@rig");
    classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      classificationType: "idea",
    });
    expect(() => classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      classificationType: "bug",
    })).toThrow(ProjectClassifierError);
    try {
      classifier.classify({
        streamItemId: "stream-1",
        classifierSession: "alice@rig",
        classificationType: "bug",
      });
    } catch (err) {
      expect((err as ProjectClassifierError).code).toBe("idempotency_violation");
    }
  });

  it("first classification's classifier_session is preserved on re-projection attempts", () => {
    leaseMgr.acquire("alice@rig");
    const first = classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      classificationType: "idea",
    });
    // Reclaim + new lease + same session can also re-attempt — still rejected.
    leaseMgr.reclaim("operator@rig");
    leaseMgr.acquire("bob@rig");
    try {
      classifier.classify({
        streamItemId: "stream-1",
        classifierSession: "bob@rig",
        classificationType: "feature-request",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectClassifierError);
      expect((err as ProjectClassifierError).code).toBe("idempotency_violation");
    }
    const lookup = classifier.getByStreamItemId("stream-1");
    expect(lookup?.projectId).toBe(first.projectId);
    expect(lookup?.classifierSession).toBe("alice@rig"); // first wins
    expect(lookup?.classificationType).toBe("idea");
  });

  it("classify accepts all 6 classification fields + action; null when unset", () => {
    leaseMgr.acquire("alice@rig");
    const full = classifier.classify({
      streamItemId: "stream-full",
      classifierSession: "alice@rig",
      classificationType: "idea",
      classificationUrgency: "high",
      classificationMaturity: "ratified",
      classificationConfidence: "high",
      classificationDestination: "planning@rig",
      action: "create",
    });
    expect(full.classificationUrgency).toBe("high");
    expect(full.classificationMaturity).toBe("ratified");
    expect(full.classificationConfidence).toBe("high");
    expect(full.action).toBe("create");

    const minimal = classifier.classify({
      streamItemId: "stream-minimal",
      classifierSession: "alice@rig",
    });
    expect(minimal.classificationType).toBeNull();
    expect(minimal.classificationUrgency).toBeNull();
    expect(minimal.action).toBeNull();
  });

  it("list filters by classifierSession + classificationDestination", () => {
    leaseMgr.acquire("alice@rig");
    classifier.classify({
      streamItemId: "s1",
      classifierSession: "alice@rig",
      classificationDestination: "planning@rig",
    });
    classifier.classify({
      streamItemId: "s2",
      classifierSession: "alice@rig",
      classificationDestination: "delivery@rig",
    });
    classifier.classify({
      streamItemId: "s3",
      classifierSession: "alice@rig",
      classificationDestination: "planning@rig",
    });
    const planning = classifier.list({ classificationDestination: "planning@rig" });
    expect(planning).toHaveLength(2);
  });
});
