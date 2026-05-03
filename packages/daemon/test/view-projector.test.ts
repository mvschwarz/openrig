import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import {
  ViewProjector,
  ViewProjectorError,
  BUILT_IN_VIEW_NAMES,
} from "../src/domain/view-projector.js";

describe("ViewProjector (PL-004 Phase B; L5 read-only projections)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let projector: ViewProjector;

  beforeEach(async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, viewsCustomSchema]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    projector = new ViewProjector(db, bus);
    // Seed live qitems for the views to project over.
    await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "planning@product-lab",
      body: "design new feature",
      priority: "routine",
      tier: "deep",
      nudge: false,
    });
    await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "planning@product-lab",
      body: "fix critical bug",
      priority: "critical",
      tier: "fast",
      nudge: false,
    });
    const blocked = await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "delivery@product-lab",
      body: "blocked work",
      nudge: false,
    });
    queueRepo.update({
      qitemId: blocked.qitemId,
      actorSession: "delivery@product-lab",
      state: "blocked",
      transitionNote: "blocked on dep",
    });
    // Fixture rig (should be excluded by default).
    await queueRepo.create({
      sourceSession: "alice@test-rig",
      destinationSession: "bob@test-rig",
      body: "fixture work",
      nudge: false,
    });
  });

  afterEach(() => {
    db.close();
    delete process.env.OPENRIG_VIEW_INCLUDE_FIXTURES;
  });

  it("BUILT_IN_VIEW_NAMES includes all 6 expected names", () => {
    expect([...BUILT_IN_VIEW_NAMES]).toEqual([
      "recently-active",
      "founder",
      "pod-load",
      "escalations",
      "held",
      "activity",
    ]);
  });

  it("show recently-active returns active-state qitems by ts_updated DESC, fixtures excluded", () => {
    const result = projector.show("recently-active");
    expect(result.viewName).toBe("recently-active");
    expect(result.rowCount).toBe(3); // 3 product-lab qitems; fixture excluded
    expect(result.rows.every((r) => !String(r.destination_session).includes("@test-"))).toBe(true);
  });

  it("show founder returns critical-priority OR fast/critical-tier qitems", () => {
    const result = projector.show("founder");
    expect(result.rowCount).toBe(1); // only the critical/fast qitem
    expect(result.rows[0]!.priority).toBe("critical");
  });

  it("show pod-load groups counts by destination_session", () => {
    const result = projector.show("pod-load");
    expect(result.rowCount).toBe(2); // planning@... and delivery@...
    const podMap = new Map<string, number>(result.rows.map((r) => [String(r.pod), Number(r.active_count)]));
    expect(podMap.get("planning@product-lab")).toBe(2);
    expect(podMap.get("delivery@product-lab")).toBe(1);
  });

  it("show held returns blocked qitems", () => {
    const result = projector.show("held");
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]!.state).toBe("blocked");
  });

  it("show escalations returns qitems with closure_reason='escalation'", () => {
    // No escalations in fixture; should return 0.
    const result = projector.show("escalations");
    expect(result.rowCount).toBe(0);
  });

  it("show activity returns recent transitions joined to active qitems", () => {
    const result = projector.show("activity");
    expect(result.rowCount).toBeGreaterThan(0);
    // Each row has a transition_id (from queue_transitions).
    expect(result.rows[0]).toHaveProperty("transition_id");
  });

  it("OPENRIG_VIEW_INCLUDE_FIXTURES=1 includes fixture rigs", () => {
    process.env.OPENRIG_VIEW_INCLUDE_FIXTURES = "1";
    const result = projector.show("recently-active");
    expect(result.rowCount).toBe(4); // including the fixture qitem
  });

  it("show with --rig filter narrows by session-suffix match", () => {
    const result = projector.show("recently-active", { rig: "product-lab" });
    expect(result.rowCount).toBe(3); // all 3 product-lab qitems
  });

  it("show <unknown-view> throws view_not_found", () => {
    expect(() => projector.show("nonexistent-view")).toThrow(ViewProjectorError);
  });

  it("registerCustomView accepts arbitrary SQL + lookup works via show", () => {
    const view = projector.registerCustomView({
      viewName: "all-pending",
      definition: "SELECT qitem_id, destination_session FROM queue_items WHERE state = 'pending'",
      registeredBySession: "operator@rig",
    });
    expect(view.viewId).toMatch(/^[0-9A-Z]{26}$/);
    const result = projector.show("all-pending");
    expect(result.viewName).toBe("all-pending");
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it("registerCustomView rejects reserved built-in name", () => {
    try {
      projector.registerCustomView({
        viewName: "recently-active",
        definition: "SELECT 1",
        registeredBySession: "operator@rig",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ViewProjectorError);
      expect((err as ViewProjectorError).code).toBe("view_name_reserved");
    }
  });

  it("registerCustomView re-registration updates definition (not duplicate)", () => {
    const first = projector.registerCustomView({
      viewName: "my-view",
      definition: "SELECT 1 as a",
      registeredBySession: "operator@rig",
    });
    const second = projector.registerCustomView({
      viewName: "my-view",
      definition: "SELECT 2 as b",
      registeredBySession: "operator@rig",
    });
    expect(second.viewId).toBe(first.viewId);
    expect(second.definition).toContain("SELECT 2");
    expect(projector.listCustomViews()).toHaveLength(1);
  });

  it("list returns built-in view names + custom view records", () => {
    projector.registerCustomView({
      viewName: "my-view",
      definition: "SELECT 1",
      registeredBySession: "operator@rig",
    });
    const result = projector.list();
    expect(result.builtIn).toEqual([
      "recently-active",
      "founder",
      "pod-load",
      "escalations",
      "held",
      "activity",
    ]);
    expect(result.custom).toHaveLength(1);
    expect(result.custom[0]!.viewName).toBe("my-view");
  });

  it("notifyViewChanged emits view.changed event", () => {
    const captured: unknown[] = [];
    bus.subscribe((e) => captured.push(e));
    projector.notifyViewChanged("recently-active", "queue.created");
    expect(captured.some((e) => (e as { type: string }).type === "view.changed")).toBe(true);
  });
});
