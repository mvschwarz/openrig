import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { StreamStore } from "../src/domain/stream-store.js";
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
  let streamStore: StreamStore;
  let captured: PersistedEvent[];

  // R1 fix (BLOCKER 1): tests now migrate streamItemsSchema (Phase A
  // migration 023) and seed real stream_items rows so the L1→L2 FK +
  // existence check in project-classifier can be exercised end-to-end.
  // Helper that emits a stream item via Phase A's StreamStore.
  function seedStreamItem(streamItemId: string): void {
    streamStore.emit({
      streamItemId,
      sourceSession: "discovery@rig",
      body: `body for ${streamItemId}`,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, classifierLeasesSchema, projectClassificationsSchema]);
    bus = new EventBus(db);
    leaseMgr = new ClassifierLeaseManager(db, bus);
    classifier = new ProjectClassifier(db, bus, leaseMgr);
    streamStore = new StreamStore(db, bus);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("classify with valid lease creates project_classifications row + emits project.classified", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("stream-1");
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
    seedStreamItem("stream-1");
    expect(() => classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
    })).toThrow(ClassifierLeaseError);
  });

  it("classify by non-holder throws lease_held", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("stream-1");
    expect(() => classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "bob@rig",
    })).toThrow(/lease_held|alice@rig/);
  });

  it("R1 BLOCKER 1: classify of nonexistent stream_item_id throws unknown_stream_item (no FK violation surfaced)", () => {
    leaseMgr.acquire("alice@rig");
    // No seed: stream_items has no row for "nonexistent-stream".
    try {
      classifier.classify({
        streamItemId: "nonexistent-stream",
        classifierSession: "alice@rig",
        classificationType: "idea",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectClassifierError);
      expect((err as ProjectClassifierError).code).toBe("unknown_stream_item");
      expect((err as ProjectClassifierError).meta?.streamItemId).toBe("nonexistent-stream");
    }
    // Defense-in-depth: confirm no row was inserted (existence check fired
    // before INSERT, so FK constraint never had to defend).
    const projectionAttempts = classifier.list();
    expect(projectionAttempts).toHaveLength(0);
  });

  it("R1 BLOCKER 1: FK constraint is the safety net if existence check is bypassed", () => {
    // Direct INSERT bypassing project-classifier should be blocked by the
    // SQLite FK constraint (PRAGMA foreign_keys = ON in connection.ts).
    expect(() => {
      db.prepare(
        `INSERT INTO project_classifications (
          project_id, stream_item_id, classifier_session, ts_projected
        ) VALUES (?, ?, ?, ?)`
      ).run("proj-bypass", "nonexistent-via-bypass", "alice@rig", "2026-05-03T00:00:00Z");
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("classify is idempotent on stream_item_id (re-projection → idempotency_violation 409)", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("stream-1");
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
    seedStreamItem("stream-1");
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
    seedStreamItem("stream-full");
    seedStreamItem("stream-minimal");
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
    seedStreamItem("s1");
    seedStreamItem("s2");
    seedStreamItem("s3");
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
