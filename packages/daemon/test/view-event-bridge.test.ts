import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier } from "../src/domain/project-classifier.js";
import { wireViewEventBridge } from "../src/domain/view-event-bridge.js";
import type { PersistedEvent } from "../src/domain/types.js";

/**
 * View event bridge tests (PL-004 Phase B R1; closes guard BLOCKER 2).
 *
 * The bridge subscribes to coordination state-mutation events and emits
 * view.changed for affected built-in views via ViewProjector.notifyViewChanged.
 * Without this, /api/views/:name/sse never receives change notifications.
 */

describe("view-event-bridge (PL-004 Phase B R1; BLOCKER 2 fix)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let inbox: InboxHandler;
  let streamStore: StreamStore;
  let projector: ViewProjector;
  let leaseMgr: ClassifierLeaseManager;
  let classifier: ProjectClassifier;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema,
      streamItemsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema,
      classifierLeasesSchema, projectClassificationsSchema, viewsCustomSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    streamStore = new StreamStore(db, bus);
    projector = new ViewProjector(db, bus);
    leaseMgr = new ClassifierLeaseManager(db, bus);
    classifier = new ProjectClassifier(db, bus, leaseMgr);
    captured = [];
    bus.subscribe((e) => captured.push(e));
    wireViewEventBridge(bus, projector);
  });

  afterEach(() => db.close());

  function viewChangedEvents(): Array<{ viewName: string; cause: string }> {
    return captured
      .filter((e) => e.type === "view.changed")
      .map((e) => ({ viewName: (e as { viewName: string }).viewName, cause: (e as { cause: string }).cause }));
  }

  it("queue.created triggers view.changed for recently-active + founder + pod-load + activity", async () => {
    await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    const events = viewChangedEvents();
    const viewNames = events.map((e) => e.viewName);
    expect(viewNames).toContain("recently-active");
    expect(viewNames).toContain("founder");
    expect(viewNames).toContain("pod-load");
    expect(viewNames).toContain("activity");
    // Each event has cause = the source event type.
    expect(events.every((e) => e.cause === "queue.created")).toBe(true);
  });

  it("queue.handed_off triggers view.changed for recently-active + pod-load + activity", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    captured.length = 0; // reset to focus on the handoff event
    await queueRepo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      nudge: false,
    });
    const events = viewChangedEvents();
    expect(events.some((e) => e.viewName === "recently-active" && e.cause === "queue.handed_off")).toBe(true);
    expect(events.some((e) => e.viewName === "pod-load" && e.cause === "queue.handed_off")).toBe(true);
    expect(events.some((e) => e.viewName === "activity" && e.cause === "queue.handed_off")).toBe(true);
    // queue.handed_off ALSO emits queue.created for the new qitem (which fires its own view.changed batch).
  });

  it("R2: queue.updated triggers view.changed for ALL 6 built-in views (state mutations may affect any)", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    captured.length = 0;
    queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    const events = viewChangedEvents();
    const updateViewNames = events
      .filter((e) => e.cause === "queue.updated")
      .map((e) => e.viewName)
      .sort();
    // R2 mapping: queue.updated → all 6 built-in views.
    expect(updateViewNames).toEqual([
      "activity",
      "escalations",
      "founder",
      "held",
      "pod-load",
      "recently-active",
    ]);
  });

  it("R2: queue.updated for pending → blocked transition triggers view.changed for held + activity (and others)", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test-blocked",
      nudge: false,
    });
    captured.length = 0;
    queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "blocked",
      transitionNote: "blocked on dep",
    });
    const events = viewChangedEvents();
    const updateViews = events.filter((e) => e.cause === "queue.updated").map((e) => e.viewName);
    // held + activity are the most semantically affected, but all 6 fire conservatively.
    expect(updateViews).toContain("held");
    expect(updateViews).toContain("activity");
  });

  it("queue.claimed triggers view.changed for recently-active + pod-load + activity", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    captured.length = 0;
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    const events = viewChangedEvents();
    const claimEvents = events.filter((e) => e.cause === "queue.claimed");
    expect(claimEvents.map((e) => e.viewName).sort()).toEqual(["activity", "pod-load", "recently-active"]);
  });

  it("inbox.absorbed triggers view.changed for recently-active + pod-load + activity", async () => {
    const drop = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "test",
    });
    captured.length = 0;
    await inbox.absorb(drop.inboxId, "bob@rig");
    const events = viewChangedEvents();
    const absorbEvents = events.filter((e) => e.cause === "inbox.absorbed");
    expect(absorbEvents.map((e) => e.viewName).sort()).toEqual(["activity", "pod-load", "recently-active"]);
  });

  it("inbox.denied triggers view.changed for activity only", () => {
    const drop = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "test",
    });
    captured.length = 0;
    inbox.deny(drop.inboxId, "bob@rig", "off-topic");
    const events = viewChangedEvents();
    const denyEvents = events.filter((e) => e.cause === "inbox.denied");
    expect(denyEvents.map((e) => e.viewName)).toEqual(["activity"]);
  });

  it("project.classified triggers view.changed for activity only", () => {
    streamStore.emit({ streamItemId: "stream-1", sourceSession: "discovery@rig", body: "x" });
    leaseMgr.acquire("alice@rig");
    captured.length = 0;
    classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      classificationType: "idea",
    });
    const events = viewChangedEvents();
    const classifyEvents = events.filter((e) => e.cause === "project.classified");
    expect(classifyEvents.map((e) => e.viewName)).toEqual(["activity"]);
  });

  it("classifier.lease_acquired does NOT trigger view.changed (lease lifecycle is project SSE, not view SSE)", () => {
    leaseMgr.acquire("alice@rig");
    const events = viewChangedEvents();
    expect(events.filter((e) => e.cause === "classifier.lease_acquired")).toHaveLength(0);
  });

  it("view.changed itself does NOT trigger view.changed (no feedback loop)", () => {
    projector.notifyViewChanged("recently-active", "manual-test");
    captured.length = 0;
    projector.notifyViewChanged("recently-active", "manual-test-2");
    // The bridge should not re-emit view.changed in response to view.changed.
    const newViewChangedEvents = captured.filter((e) => e.type === "view.changed");
    // Only the direct notifyViewChanged call's event; no echo.
    expect(newViewChangedEvents).toHaveLength(1);
    expect((newViewChangedEvents[0] as { cause: string }).cause).toBe("manual-test-2");
  });

  it("unsubscribe stops the bridge", async () => {
    // Re-wire and capture the unsubscribe function.
    const localCaptured: PersistedEvent[] = [];
    bus.subscribe((e) => localCaptured.push(e));
    const stop = wireViewEventBridge(bus, projector);
    stop();
    await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test-after-unsubscribe",
      nudge: false,
    });
    // The MAIN bridge from beforeEach is still wired; it emits view.changed.
    // The local one we just stopped doesn't emit. Verify only ONE bridge fired
    // (not two): activity should appear exactly once.
    const activityEvents = captured.filter(
      (e) => e.type === "view.changed" && (e as { viewName: string }).viewName === "activity" && (e as { cause: string }).cause === "queue.created",
    );
    expect(activityEvents).toHaveLength(1);
  });
});
