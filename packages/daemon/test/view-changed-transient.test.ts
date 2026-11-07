import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
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
import { ViewProjector } from "../src/domain/view-projector.js";
import { wireViewEventBridge } from "../src/domain/view-event-bridge.js";
import { eventsRoute } from "../src/routes/events.js";
import { viewsRoutes } from "../src/routes/views.js";
import type { PersistedEvent } from "../src/domain/types.js";

/**
 * view.changed is transient: the bridge's high-volume view.changed (up to 6 per queue event) is delivered to the live
 * subscribers in memory and never stored. These tests pin the delivery the view SSE streams depend on (order, exactly
 * once, the trigger's seq as id), that nothing reaches the events table or /api/events, and that the notify watermark
 * does not move.
 */

const QUEUE_UPDATED_VIEWS = ["activity", "escalations", "founder", "held", "pod-load", "recently-active"];
const QUEUE_CREATED_VIEWS = ["activity", "founder", "pod-load", "recently-active"];

interface Frame { id: string; data: string }

/** Read SSE frames (`data: {...}` + `id: <n>`, blank-line separated) until `enough` says so or the time runs out. */
async function readFrames(res: Response, enough: (frames: Frame[]) => boolean, timeoutMs = 1500): Promise<Frame[]> {
  const frames: Frame[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!enough(frames) && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))),
      ]);
      if (done && !value) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const block of blocks) {
        let id = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (data) frames.push({ id, data });
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return frames;
}

describe("view.changed is transient (never stored, delivered live)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let projector: ViewProjector;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, viewsCustomSchema]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    projector = new ViewProjector(db, bus);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("viewProjector" as never, projector);
      await next();
    });
    app.route("/api/events", eventsRoute);
    app.route("/api/views", viewsRoutes());
  });

  afterEach(() => db.close());

  function storedViewChanged(): number {
    return (db.prepare("SELECT count(*) AS n FROM events WHERE type = 'view.changed'").get() as { n: number }).n;
  }

  async function subscribedBy(stream: Promise<Response>, before: number): Promise<Response> {
    const res = await stream;
    for (let i = 0; i < 100 && bus.subscriberCount <= before; i++) await new Promise((r) => setTimeout(r, 5));
    expect(bus.subscriberCount).toBeGreaterThan(before);
    return res;
  }

  async function claimedItem(): Promise<string> {
    const item = await queueRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x", nudge: false });
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    return item.qitemId;
  }

  it("a real queue.created reaches the subscriber as view.changed and stores no view.changed row", async () => {
    wireViewEventBridge(bus, projector);
    const captured: PersistedEvent[] = [];
    bus.subscribe((event) => captured.push(event));

    await queueRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "real path", nudge: false });

    const created = captured.find((event) => event.type === "queue.created");
    expect(created).toBeDefined();
    const views = captured
      .filter((event) => event.type === "view.changed" && event.cause === "queue.created")
      .map((event) => (event as { viewName: string }).viewName)
      .sort();
    expect(views).toEqual(QUEUE_CREATED_VIEWS);
    expect(bus.replayAll(0).filter((event) => event.type === "view.changed")).toHaveLength(0);
    expect(storedViewChanged()).toBe(0);
  });

  it("queue.updated comes before exactly its 6 view.changed, each delivered once, to subscribers wired before and after the bridge", async () => {
    const before: PersistedEvent[] = [];
    bus.subscribe((event) => before.push(event));
    wireViewEventBridge(bus, projector);
    const after: PersistedEvent[] = [];
    bus.subscribe((event) => after.push(event)); // as the SSE handlers do in production: after the bridge
    const qitemId = await claimedItem();
    before.length = 0;
    after.length = 0;

    queueRepo.update({ qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });

    for (const seen of [before, after]) {
      const triggers = seen.filter((event) => event.type === "queue.updated");
      expect(triggers).toHaveLength(1);
      const at = seen.indexOf(triggers[0]!);
      const ofTrigger = seen.filter((event) => event.type === "view.changed" && event.cause === "queue.updated");
      expect(ofTrigger).toHaveLength(6);
      expect(seen.slice(at + 1, at + 7)).toEqual(ofTrigger); // right after the trigger, nothing in between
      expect(new Set(ofTrigger.map((event) => (event as { viewName: string }).viewName))).toEqual(new Set(QUEUE_UPDATED_VIEWS));
      expect(new Set(ofTrigger).size).toBe(6); // no object delivered twice to the same subscriber
      expect(seen.filter((event) => event === triggers[0] || ofTrigger.includes(event))).toHaveLength(1 + 6);
    }
  });

  it("publishTransient and notifyViewChanged move neither the notify watermark nor maxSeq", async () => {
    // Two delivered events: the watermark is at the 2nd. Transients caused by the 1st (below the watermark) and by a
    // stored row not drained yet (above it) must leave the watermark where it is, checked after every call.
    const first = bus.emit({ type: "rig.created", rigId: "rig-a" });
    const second = bus.emit({ type: "rig.created", rigId: "rig-b" });
    const watermark = bus.getNotifyDrainStatus().watermark;
    expect(watermark).toBe(second.seq);

    bus.publishTransient({ type: "view.changed", viewName: "activity", cause: "below" }, first.seq);
    expect(bus.getNotifyDrainStatus().watermark).toBe(watermark);
    projector.notifyViewChanged("activity", "below", first.seq);
    expect(bus.getNotifyDrainStatus().watermark).toBe(watermark);

    const undrained = bus.persistWithinTransaction({ type: "rig.created", rigId: "rig-c" }); // stored, not notified
    const max = bus.maxSeq();
    expect(max).toBe(undrained.seq);
    bus.publishTransient({ type: "view.changed", viewName: "activity", cause: "above" }, undrained.seq);
    expect(bus.getNotifyDrainStatus().watermark).toBe(watermark);
    projector.notifyViewChanged("activity", "no-cause"); // the default seq is maxSeq(), the undrained row's
    expect(bus.getNotifyDrainStatus().watermark).toBe(watermark);
    expect(bus.maxSeq()).toBe(max);
  });

  it("/api/events streams the queue events but never a transient view.changed, live or replayed", async () => {
    wireViewEventBridge(bus, projector);
    const subscribers = bus.subscriberCount;
    const live = await subscribedBy(app.request("/api/events?replay=0"), subscribers);
    await queueRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "live", nudge: false });
    // A stored sentinel after the trigger: frames go out in order, one per read, so reading up to it reads every frame
    // the trigger's fan-out could have written (its transients included) before asserting their absence.
    bus.emit({ type: "rig.created", rigId: "sentinel-after-trigger" });
    const liveFrames = await readFrames(live, (frames) => frames.some((f) => f.data.includes("sentinel-after-trigger")));
    expect(liveFrames.some((f) => f.data.includes("sentinel-after-trigger"))).toBe(true);
    expect(liveFrames.some((f) => f.data.includes('"type":"queue.created"'))).toBe(true);
    expect(liveFrames.filter((f) => f.data.includes('"type":"view.changed"'))).toEqual([]);

    const qitemId = await claimedItem();
    queueRepo.update({ qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    const stored = bus.replayAll(0).length;
    for (const req of [app.request("/api/events?replay=100"), app.request("/api/events", { headers: { "Last-Event-ID": "0" } })]) {
      const frames = await readFrames(await req, (f) => f.length >= stored, 500);
      expect(frames).toHaveLength(stored);
      expect(frames.some((f) => f.data.includes('"type":"queue.updated"'))).toBe(true);
      expect(frames.filter((f) => f.data.includes('"type":"view.changed"'))).toEqual([]);
      expect(frames.map((f) => Number(f.id))).toEqual(bus.replayAll(0).map((event) => event.seq));
    }
  });

  it("an event a subscriber stores on a delivered view.changed comes after it, once, to every subscriber, with a higher seq", async () => {
    wireViewEventBridge(bus, projector);
    let emitted: PersistedEvent | null = null;
    const emitter: PersistedEvent[] = [];
    bus.subscribe((event) => {
      emitter.push(event);
      if (!emitted && event.type === "view.changed" && event.viewName === "founder") {
        emitted = bus.emit({ type: "rig.created", rigId: "rig-from-transient" });
      }
    });
    const observer: PersistedEvent[] = [];
    bus.subscribe((event) => observer.push(event)); // inscribed after the subscriber that emits

    await queueRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x", nudge: false });

    expect(emitted).not.toBeNull();
    const trigger = observer.find((event) => event.type === "queue.created")!;
    expect(emitted!.seq).toBeGreaterThan(trigger.seq);
    for (const seen of [emitter, observer]) {
      const cause = seen.findIndex((event) => event.type === "view.changed" && event.viewName === "founder");
      const rig = seen.findIndex((event) => event.type === "rig.created");
      expect(cause).toBeGreaterThanOrEqual(0);
      expect(seen[cause]).toMatchObject({ transient: true, seq: trigger.seq }); // the cause is the trigger's transient
      expect(rig).toBeGreaterThan(cause);
      const storedSeqs = seen.filter((event) => !event.transient).map((event) => event.seq);
      expect(storedSeqs).toEqual(bus.replayAll(0).map((event) => event.seq)); // each stored seq exactly once, in order
    }
  });

  it("notifyViewChanged outside any fan-out delivers within the same synchronous call", () => {
    const captured: PersistedEvent[] = [];
    bus.subscribe((event) => captured.push(event));
    projector.notifyViewChanged("pod-load", "direct-call");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ type: "view.changed", viewName: "pod-load", cause: "direct-call", transient: true });
  });

  it("an event a subscriber stores on a view.changed delivered outside any fan-out reaches every subscriber", () => {
    let stored: PersistedEvent | null = null;
    bus.subscribe((event) => {
      if (!stored && event.type === "view.changed") stored = bus.emit({ type: "rig.created", rigId: "rig-from-direct" });
    });
    const observer: PersistedEvent[] = [];
    bus.subscribe((event) => observer.push(event));

    projector.notifyViewChanged("activity", "direct-call");

    expect(stored).not.toBeNull();
    expect(observer.map((event) => event.type)).toEqual(["view.changed", "rig.created"]);
    expect(observer[1]!.seq).toBe(stored!.seq);
  });

  it("an envelope that rolls back inside a fan-out drops only its own transients, not the ones its trigger caused", async () => {
    wireViewEventBridge(bus, projector);
    let failed = false;
    bus.subscribe((event) => {
      if (failed || event.type !== "queue.created") return;
      failed = true;
      expect(() => bus.withNotifyEnvelope(() => {
        projector.notifyViewChanged("activity", "rolled-back");
        throw new Error("rollback");
      })).toThrow("rollback");
    });
    const observer: PersistedEvent[] = [];
    bus.subscribe((event) => observer.push(event));

    await queueRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x", nudge: false });

    const views = observer.filter((event) => event.type === "view.changed");
    expect(views.map((event) => event.cause)).toEqual(Array(QUEUE_CREATED_VIEWS.length).fill("queue.created"));
  });

  it("the view SSE sends the 6 view.changed of a queue.updated with the trigger's seq as id", async () => {
    wireViewEventBridge(bus, projector);
    const qitemId = await claimedItem();
    let triggerSeq = -1;
    bus.subscribe((event) => { if (event.type === "queue.updated") triggerSeq = event.seq; });
    const subscribers = bus.subscriberCount;
    const sse = await subscribedBy(app.request("/api/views/sse"), subscribers);

    queueRepo.update({ qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });

    const frames = await readFrames(sse, (f) => f.filter((x) => x.data.includes('"cause":"queue.updated"')).length >= 6);
    const ofTrigger = frames.filter((f) => f.data.includes('"cause":"queue.updated"'));
    expect(ofTrigger).toHaveLength(6);
    expect(triggerSeq).toBeGreaterThan(0);
    expect(ofTrigger.map((f) => f.id)).toEqual(Array(6).fill(String(triggerSeq)));
  });
});
