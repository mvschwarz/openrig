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

  it("list latest returns the newest bounded active rows in chronological order", () => {
    expect(store.list({ limit: 5, direction: "latest" })).toEqual([]);
    const items = Array.from({ length: 7 }, (_, index) =>
      store.emit({ sourceSession: "alice@rig", body: `item-${index + 1}` }),
    );

    expect(store.list({ limit: 5, direction: "latest" }).map((item) => item.body)).toEqual([
      "item-3", "item-4", "item-5", "item-6", "item-7",
    ]);

    store.archive(items[6]!.streamItemId);
    expect(store.list({ limit: 5, direction: "latest" }).map((item) => item.body)).toEqual([
      "item-2", "item-3", "item-4", "item-5", "item-6",
    ]);
  });

  it("list latest uses the canonical timestamp + sort-key tuple and keeps filters", () => {
    const first = store.emit({ sourceSession: "alice@rig", body: "first", hintDestination: "bob@rig" });
    const second = store.emit({ sourceSession: "alice@rig", body: "second", hintDestination: "bob@rig" });
    store.emit({ sourceSession: "carol@rig", body: "filtered-out", hintDestination: "bob@rig" });
    db.prepare("UPDATE stream_items SET ts_emitted = ? WHERE stream_item_id IN (?, ?)")
      .run("2026-08-03T07:00:00.000Z", first.streamItemId, second.streamItemId);

    expect(store.list({ limit: 1, direction: "latest", sourceSession: "alice@rig" }).map((item) => item.body)).toEqual(["second"]);
    expect(store.list({ limit: 5, direction: "latest", sourceSession: "alice@rig", hintDestination: "bob@rig" }).map((item) => item.body)).toEqual(["first", "second"]);
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

  it("list filters by exact tag and inclusive time window without changing cursor order", () => {
    const before = store.emit({
      sourceSession: "alice@rig",
      body: "before",
      hintTags: ["review"],
    });
    const lower = store.emit({
      sourceSession: "alice@rig",
      body: "lower-bound",
      hintTags: ["review", "context"],
    });
    const upper = store.emit({
      sourceSession: "alice@rig",
      body: "upper-bound",
      hintTags: ["review"],
    });
    const wrongSource = store.emit({
      sourceSession: "bob@rig",
      body: "wrong-source",
      hintTags: ["review"],
    });
    const substringOnly = store.emit({
      sourceSession: "alice@rig",
      body: "substring-only",
      hintTags: ["review-request"],
    });

    const setTime = db.prepare("UPDATE stream_items SET ts_emitted = ? WHERE stream_item_id = ?");
    setTime.run("2026-08-03T08:59:59.999Z", before.streamItemId);
    setTime.run("2026-08-03T09:00:00.000Z", lower.streamItemId);
    setTime.run("2026-08-03T10:00:00.000Z", upper.streamItemId);
    setTime.run("2026-08-03T09:30:00.000Z", wrongSource.streamItemId);
    setTime.run("2026-08-03T09:45:00.000Z", substringOnly.streamItemId);

    const options = {
      sourceSession: "alice@rig",
      hintTag: "review",
      since: "2026-08-03T09:00:00.000Z",
      until: "2026-08-03T10:00:00.000Z",
    };
    expect(store.list(options).map((item) => item.body)).toEqual(["lower-bound", "upper-bound"]);
    expect(store.list({ ...options, afterSortKey: lower.streamSortKey }).map((item) => item.body)).toEqual([
      "upper-bound",
    ]);
    expect(store.list({ hintTag: "review-request" }).map((item) => item.body)).toEqual(["substring-only"]);
  });

  it("list composes tag, time, source, archive, and latest-page filters", () => {
    const matching = Array.from({ length: 4 }, (_, index) => store.emit({
      sourceSession: "alice@rig",
      body: `matching-${index + 1}`,
      hintTags: ["context"],
    }));
    const wrongSource = store.emit({ sourceSession: "bob@rig", body: "wrong-source", hintTags: ["context"] });
    const wrongTag = store.emit({ sourceSession: "alice@rig", body: "wrong-tag", hintTags: ["context-extra"] });
    const outsideWindow = store.emit({ sourceSession: "alice@rig", body: "outside-window", hintTags: ["context"] });
    const archived = store.emit({ sourceSession: "alice@rig", body: "archived-newest", hintTags: ["context"] });

    const setTime = db.prepare("UPDATE stream_items SET ts_emitted = ? WHERE stream_item_id = ?");
    matching.forEach((item, index) => setTime.run(`2026-08-03T09:0${index}:00.000Z`, item.streamItemId));
    setTime.run("2026-08-03T09:01:30.000Z", wrongSource.streamItemId);
    setTime.run("2026-08-03T09:02:30.000Z", wrongTag.streamItemId);
    setTime.run("2026-08-03T09:04:00.000Z", archived.streamItemId);
    setTime.run("2026-08-03T09:05:00.000Z", outsideWindow.streamItemId);
    store.archive(archived.streamItemId);

    expect(store.list({
      sourceSession: "alice@rig",
      hintTag: "context",
      since: "2026-08-03T09:00:00.000Z",
      until: "2026-08-03T09:04:00.000Z",
      direction: "latest",
      limit: 2,
    }).map((item) => item.body)).toEqual(["matching-3", "matching-4"]);
    expect(store.list({
      sourceSession: "alice@rig",
      hintTag: "context",
      since: "2026-08-03T09:00:00.000Z",
      until: "2026-08-03T09:04:00.000Z",
      direction: "latest",
      includeArchived: true,
      limit: 2,
    }).map((item) => item.body)).toEqual(["matching-4", "archived-newest"]);
  });
});
