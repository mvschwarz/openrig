import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StreamStore } from "../src/domain/stream-store.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("StreamStore", () => {
  let db: Database.Database;
  let bus: EventBus;
  let store: StreamStore;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema]);
    bus = new EventBus(db);
    store = new StreamStore(db, bus);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("emit assigns ULID + sort key when not provided", () => {
    const item = store.emit({ sourceSession: "alice@rig", body: "hello" });
    expect(item.streamItemId).toMatch(/^[0-9A-Z]{26}$/);
    expect(item.streamSortKey).toMatch(/^[0-9A-Z]{26}$/);
    expect(item.body).toBe("hello");
    expect(item.format).toBe("text");
    expect(item.interrupt).toBe(false);
  });

  it("emit is idempotent on stream_item_id", () => {
    const id = "01HXYZ_FIXED_ID_FOR_TEST_AB";
    const a = store.emit({ streamItemId: id, sourceSession: "alice@rig", body: "first" });
    const b = store.emit({ streamItemId: id, sourceSession: "alice@rig", body: "second-ignored" });
    expect(a.streamItemId).toBe(b.streamItemId);
    expect(b.body).toBe("first");
  });

  it("emit fires stream.emitted event with hint metadata", () => {
    store.emit({
      sourceSession: "alice@rig",
      body: "tagged",
      hintDestination: "bob@rig",
      hintType: "review",
      hintUrgency: "urgent",
      interrupt: true,
    });
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.type).toBe("stream.emitted");
    if (ev.type === "stream.emitted") {
      expect(ev.hintDestination).toBe("bob@rig");
      expect(ev.hintType).toBe("review");
      expect(ev.hintUrgency).toBe("urgent");
      expect(ev.interrupt).toBe(true);
    }
  });

  it("list returns chronological order, excludes archived by default", () => {
    const a = store.emit({ sourceSession: "alice@rig", body: "first" });
    store.emit({ sourceSession: "alice@rig", body: "second" });
    store.emit({ sourceSession: "alice@rig", body: "third" });
    store.archive(a.streamItemId);

    const items = store.list();
    expect(items.map((i) => i.body)).toEqual(["second", "third"]);

    const withArchived = store.list({ includeArchived: true });
    expect(withArchived).toHaveLength(3);
  });

  it("list filters by sourceSession + hintDestination", () => {
    store.emit({ sourceSession: "alice@rig", body: "a-msg", hintDestination: "bob@rig" });
    store.emit({ sourceSession: "carol@rig", body: "c-msg", hintDestination: "bob@rig" });
    store.emit({ sourceSession: "alice@rig", body: "a2", hintDestination: "dave@rig" });

    expect(store.list({ sourceSession: "alice@rig" })).toHaveLength(2);
    expect(store.list({ hintDestination: "bob@rig" })).toHaveLength(2);
    expect(store.list({ sourceSession: "alice@rig", hintDestination: "bob@rig" })).toHaveLength(1);
  });

  it("getById returns null for unknown id", () => {
    expect(store.getById("nonexistent")).toBeNull();
  });

  it("hint_tags JSON-roundtrip", () => {
    const item = store.emit({
      sourceSession: "alice@rig",
      body: "tagged",
      hintTags: ["urgent", "review", "phase-a"],
    });
    expect(item.hintTags).toEqual(["urgent", "review", "phase-a"]);
    const fetched = store.getById(item.streamItemId);
    expect(fetched?.hintTags).toEqual(["urgent", "review", "phase-a"]);
  });
});
