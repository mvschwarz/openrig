import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { classificationFieldsAndAttemptsSchema } from "../src/db/migrations/086_classification_fields_and_attempts.js";
import { classificationIdentityProvenanceSchema } from "../src/db/migrations/089_classification_identity_provenance.js";
import { streamDispositionsSchema } from "../src/db/migrations/129_stream_dispositions.js";
import { streamSubscriptionsSchema } from "../src/db/migrations/130_stream_subscriptions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier } from "../src/domain/project-classifier.js";
import { STREAM_BODY_CAP_BYTES, StreamStore } from "../src/domain/stream-store.js";
import { READ_PAGE_BYTES, listSubscriptions, readPage, subscribe } from "../src/domain/stream-subscriptions.js";
import { pruneStreamItems, runQueueRetentionSweep } from "../src/domain/queue-retention.js";
import { streamRoutes } from "../src/routes/stream.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const EARLIER = "2020-01-01T00:00:00.000Z";

describe("stream hub readers (slice 22 outcome 9)", () => {
  let db: Database.Database, bus: EventBus, stream: StreamStore;
  const emit = (id: string, over: Record<string, unknown> = {}) => stream.emit({ streamItemId: id, sourceSession: "poster@rig", body: `obs ${id}`, ...over });
  const ids = (page: ReturnType<typeof readPage>) => page!.items.map(i => i.streamItemId);

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, streamItemsSchema, classifierLeasesSchema, projectClassificationsSchema,
      classificationFieldsAndAttemptsSchema, classificationIdentityProvenanceSchema, streamDispositionsSchema, streamSubscriptionsSchema]);
    bus = new EventBus(db); stream = new StreamStore(db, bus);
  });
  afterEach(() => db.close());

  it("naming the reader is enough: addressed or tagged with its ids matches, another topic stays filtered", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev.lead')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('s1', 'n1', 'dev-lead@rig')").run();
    expect(subscribe(db, { readerSession: "dev-lead@rig", actor: "desk@rig" }, EARLIER).hintTags).toEqual(["dev-lead@rig", "dev-lead", "dev.lead"]);
    emit("A", { hintDestination: "dev-lead@rig" }); emit("B", { hintTags: ["dev.lead"] }); emit("C", { hintTags: ["docs"] }); emit("D", { hintTags: ["dev-lead"] });
    expect(ids(readPage(db, "dev-lead@rig"))).toEqual(["A", "B", "D"]);
    // Named topics, and a type: addressed items still match.
    subscribe(db, { readerSession: "qa@rig", hintTags: ["docs"], actor: "desk@rig" }, EARLIER);
    subscribe(db, { readerSession: "ops@rig", hintType: "incident", actor: "desk@rig" }, EARLIER);
    emit("E", { hintTags: ["docs"], hintType: "incident" }); emit("F", { hintDestination: "qa@rig" });
    expect(ids(readPage(db, "qa@rig"))).toEqual(["C", "E", "F"]);
    expect(ids(readPage(db, "ops@rig"))).toEqual(["E"]);
  });

  it("catch-up after an interruption resumes at the cursor and drops nothing; an update keeps the cursor", () => {
    subscribe(db, { readerSession: "hub@rig", hintTags: ["ci"], actor: "desk@rig" }, EARLIER);
    for (let i = 0; i < 25; i++) emit(`I${String(i).padStart(2, "0")}`, { hintTags: ["ci"] });
    const first = readPage(db, "hub@rig")!;
    expect(first.items).toHaveLength(20);
    expect(first).toMatchObject({ more: true, unread: { items: 5 } });
    subscribe(db, { readerSession: "hub@rig", hintTags: ["ci", "pr"], actor: "desk@rig" });
    const second = readPage(db, "hub@rig")!;
    expect(ids(second)).toEqual(["I20", "I21", "I22", "I23", "I24"]);
    expect(second).toMatchObject({ more: false, unread: { items: 0, bytes: 0 } });
    expect(readPage(db, "hub@rig")!.items).toEqual([]);
    expect(listSubscriptions(db)).toMatchObject([{ readerSession: "hub@rig", hintTags: ["ci", "pr"], unread: { items: 0 } }]);
    expect(readPage(db, "nobody@rig")).toBeNull();
  });

  it("a burst stays bounded: bodies capped at 16 KiB with a visible marker, and read says which content was discarded", () => {
    subscribe(db, { readerSession: "hub@rig", hintTags: ["ci"], actor: "desk@rig" }, EARLIER);
    const big = emit("BIG", { body: "é".repeat(20_000), hintTags: ["ci"] });
    expect(big.bodyTruncated).toEqual({ keptBytes: expect.any(Number), originalBytes: 40_000 });
    const stored = stream.getById("BIG")!;
    expect(Buffer.byteLength(stored.body)).toBeLessThanOrEqual(STREAM_BODY_CAP_BYTES);
    expect(stored.body).toMatch(new RegExp(`\\[truncated by OpenRig: kept ${big.bodyTruncated!.keptBytes} of 40000 bytes\\]$`));
    expect(stored.body).not.toContain("\uFFFD");
    expect(stored.bodyTruncated).toEqual(big.bodyTruncated); // show reads it back, not only emit's reply
    expect(emit("SMALL", { body: "x".repeat(100), hintTags: ["ci"] }).bodyTruncated).toBeUndefined();
    const page = readPage(db, "hub@rig")!;
    // The excerpt is shortened (recoverable with show); the stored body also lost content (not recoverable).
    expect(page.items[0]).toMatchObject({ streamItemId: "BIG", excerptTruncated: true, bodyTruncated: big.bodyTruncated });
    expect(page.items[1]).toMatchObject({ streamItemId: "SMALL" });
    expect(page.items[1]).not.toHaveProperty("bodyTruncated");
    expect(page.items[1]).not.toHaveProperty("excerptTruncated");
  });

  it("the whole serialized page stays under 64 KiB: multiline multibyte excerpts, an oversized tag, a long subscription", () => {
    const size = (page: unknown) => Buffer.byteLength(JSON.stringify(page));
    subscribe(db, { readerSession: "hub@rig", hintTags: ["burst"], actor: "desk@rig" }, EARLIER);
    // 20 items of 2,000-character excerpts, half newlines and quotes (escaped to 2 bytes) and half two-byte characters.
    for (let i = 0; i < 20; i++) emit(`W${String(i).padStart(2, "0")}`, { body: "\n\"é".repeat(1_000), hintTags: ["burst"] });
    const first = readPage(db, "hub@rig")!;
    expect(size(first)).toBeLessThanOrEqual(READ_PAGE_BYTES);
    expect(first.items.length).toBeLessThan(20);
    expect(first.more).toBe(true);
    const rest = readPage(db, "hub@rig")!;
    expect(first.items.length + rest.items.length + (rest.more ? readPage(db, "hub@rig")!.items.length : 0)).toBe(20); // nothing skipped
    // One item whose tag alone is 70,000 characters: clipped in the page, marked, and the cursor still moves past it.
    subscribe(db, { readerSession: "tags@rig", hintTags: ["t".repeat(70_000), "x"], actor: "desk@rig" }, EARLIER);
    emit("HUGE", { body: "small", hintTags: ["t".repeat(70_000)] });
    const huge = readPage(db, "tags@rig")!;
    expect(size(huge)).toBeLessThanOrEqual(READ_PAGE_BYTES);
    expect(huge.items).toMatchObject([{ streamItemId: "HUGE", metadataTruncated: true }]);
    expect(huge.subscription).toMatchObject({ metadataTruncated: true });
    expect(readPage(db, "tags@rig")!.items).toEqual([]);
  });

  it("retention keeps referenced items, prunes the rest by age or count, and a reader behind it sees the gap", async () => {
    const leases = new ClassifierLeaseManager(db, bus);
    const classifier = new ProjectClassifier(db, bus, leases);
    subscribe(db, { readerSession: "hub@rig", hintTags: ["ci"], actor: "desk@rig" }, EARLIER);
    for (const id of ["P1", "P2", "P3", "P4"]) emit(id, { hintTags: ["ci"] });
    leases.acquire("intake@rig");
    classifier.classify({ streamItemId: "P2", classifierSession: "intake@rig", leaseId: leases.getActiveLease()!.leaseId, action: "no_action" });
    // Count cap: keep the newest 1 unreferenced item (P4); P2 is classified and stays.
    expect(pruneStreamItems(db, { nowIso: new Date().toISOString(), streamMaxItems: 1 })).toEqual({ deletedRows: 2 });
    expect(stream.list({ limit: 10 }).map(i => i.streamItemId)).toEqual(["P2", "P4"]);
    const page = readPage(db, "hub@rig")!;
    expect(ids(page)).toEqual(["P2", "P4"]);
    expect(page.gap).toMatchObject({ reason: "retention", prunedItemsTotal: 2 });
    expect(readPage(db, "hub@rig")!.gap).toBeUndefined();
    // Age: 40 days on, the remaining unreferenced item goes too.
    expect(pruneStreamItems(db, { nowIso: new Date(Date.now() + 40 * 86_400_000).toISOString() })).toEqual({ deletedRows: 1 });
    expect(stream.list({ limit: 10 }).map(i => i.streamItemId)).toEqual(["P2"]);
  });

  it("retention keeps history that existed before the upgrade and prunes what's emitted after; a fresh install has no floor", () => {
    const later = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const upgraded = createDb();
    migrate(upgraded, ALL_MIGRATIONS.slice(0, ALL_MIGRATIONS.findIndex((m) => m.name === "130_stream_subscriptions.sql"))); // an install at 129
    new StreamStore(upgraded, new EventBus(upgraded)).emit({ streamItemId: "OLD", sourceSession: "poster@rig", body: "history before the upgrade" });
    migrate(upgraded, ALL_MIGRATIONS); // the upgrade
    const after = new StreamStore(upgraded, new EventBus(upgraded));
    after.emit({ streamItemId: "NEW", sourceSession: "poster@rig", body: "emitted after the upgrade" });
    expect(pruneStreamItems(upgraded, { nowIso: later })).toEqual({ deletedRows: 1 });
    expect(after.getById("OLD")).not.toBeNull();
    expect(after.getById("NEW")).toBeNull();
    // The count cap doesn't touch it either.
    expect(pruneStreamItems(upgraded, { nowIso: new Date().toISOString(), streamMaxItems: 1 })).toEqual({ deletedRows: 0 });
    upgraded.close();
    const fresh = createDb();
    migrate(fresh, ALL_MIGRATIONS);
    const freshStream = new StreamStore(fresh, new EventBus(fresh));
    freshStream.emit({ streamItemId: "F1", sourceSession: "poster@rig", body: "a fresh install's item" });
    expect(pruneStreamItems(fresh, { nowIso: later })).toEqual({ deletedRows: 1 });
    expect(freshStream.getById("F1")).toBeNull();
    fresh.close();
  });

  it("the daemon's retention sweep runs the stream pass", async () => {
    const full = createDb();
    migrate(full, ALL_MIGRATIONS);
    const fullStream = new StreamStore(full, new EventBus(full));
    fullStream.emit({ streamItemId: "OLD", sourceSession: "poster@rig", body: "old" });
    expect(await runQueueRetentionSweep(full, { nowIso: new Date(Date.now() + 40 * 86_400_000).toISOString() }))
      .toMatchObject({ streamDeleted: 1, streamBatches: 1 });
    expect(fullStream.getById("OLD")).toBeNull();
    full.close();
  });

  it("a reader whose unread range was pruned with nothing retained gets the gap once, not an empty success", () => {
    subscribe(db, { readerSession: "hub@rig", hintTags: ["ci"], actor: "desk@rig" }, EARLIER);
    emit("Q1", { hintTags: ["ci"] });
    pruneStreamItems(db, { nowIso: new Date(Date.now() + 40 * 86_400_000).toISOString() });
    const page = readPage(db, "hub@rig")!;
    expect(page).toMatchObject({ items: [], gap: { reason: "retention", prunedItemsTotal: 1 } });
    expect(readPage(db, "hub@rig")!.gap).toBeUndefined();
  });

  describe("routes", () => {
    let app: Hono;
    const call = (path: string, method: string, body?: unknown, session = "dev-lead@rig") => app.request(`/api/stream${path}`, {
      method, headers: { "Content-Type": "application/json", "X-OpenRig-Session": session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    beforeEach(() => {
      app = new Hono();
      app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("streamStore" as never, stream); await next(); });
      app.route("/api/stream", streamRoutes());
    });

    it("subscribe, list, read as the transport identity, unsubscribe", async () => {
      expect((await call("/subscriptions", "POST", { readerSession: "not a session" })).status).toBe(400);
      expect((await call("/read", "POST", {})).status).toBe(404);
      const sub = await call("/subscriptions", "POST", { readerSession: "dev-lead@rig", hintTags: ["ci", " ", 3] }, "desk@rig");
      expect(sub.status).toBe(200);
      expect(await sub.json()).toMatchObject({ readerSession: "dev-lead@rig", hintTags: ["ci"], createdBy: "desk@rig" });
      emit("R1", { hintTags: ["ci"] });
      expect(await (await call("/subscriptions", "GET")).json()).toMatchObject([{ readerSession: "dev-lead@rig", unread: { items: 1 } }]);
      // The header decides the reader; a body reader is ignored when the transport names one.
      expect((await call("/read", "POST", { reader: "dev-lead@rig" }, "someone-else@rig")).status).toBe(404);
      const read = await call("/read", "POST", { limit: 5 });
      expect(await read.json()).toMatchObject({ items: [{ streamItemId: "R1", excerpt: "obs R1" }], unread: { items: 0 } });
      expect((await call("/subscriptions/dev-lead%40rig", "DELETE")).status).toBe(200);
      expect((await call("/subscriptions/dev-lead%40rig", "DELETE")).status).toBe(404);
    });

    it("a list cursor whose anchor was pruned reports it, instead of an empty success", async () => {
      const a = emit("L1"); emit("L2");
      expect(await (await call(`/list?afterSortKey=${a.streamSortKey}`, "GET")).json()).toMatchObject([{ streamItemId: "L2" }]);
      pruneStreamItems(db, { nowIso: new Date().toISOString(), streamMaxItems: 1 }); // deletes only the anchor
      const res = await call(`/list?afterSortKey=${a.streamSortKey}`, "GET");
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ error: "stream_cursor_expired", prunedThrough: a.tsEmitted, message: expect.stringContaining("--since") });
      expect(await (await call(`/list?since=${a.tsEmitted}`, "GET")).json()).toMatchObject([{ streamItemId: "L2" }]);
    });

    it("emit reports a truncated body instead of refusing it", async () => {
      const res = await call("/emit", "POST", { body: "x".repeat(STREAM_BODY_CAP_BYTES + 10) });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ bodyTruncated: { originalBytes: STREAM_BODY_CAP_BYTES + 10 } });
    });
  });
});
