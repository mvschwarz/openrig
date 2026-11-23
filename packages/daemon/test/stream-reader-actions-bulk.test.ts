import { beforeEach, afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { readerActions, recordReaderAction, type ReaderAction } from "../src/domain/stream-reader-actions.js";
import { streamRoutes } from "../src/routes/stream.js";

let db: Database.Database, app: Hono, stream: StreamStore;
const T1 = "2026-01-01T00:00:00.000Z", T2 = "2026-01-02T00:00:00.000Z";
const record = (id: string, reader: string, action: "act" | "decline" | "duplicate", time = T1) => recordReaderAction(db, {
  streamItemId: id, readerSession: reader, action, ...(action === "act" ? { workQitemId: "q-work" } :
    action === "decline" ? { reason: "other work" } : { duplicateOf: "q-work" }),
}, time).action;
async function page(query = "") {
  const response = await app.request("/api/stream/actions/list" + (query ? "?" + query : ""));
  expect(response.status).toBe(200); return response.json();
}
async function all(query = "") {
  const actions: ReaderAction[] = []; let cursor: string | null = null;
  do {
    const result = await page(query + (cursor ? "&afterActionId=" + cursor : ""));
    actions.push(...result.items); cursor = result.nextAfterActionId;
    expect(result.hasMore).toBe(cursor !== null);
  } while (cursor);
  return actions;
}

beforeEach(() => {
  db = createDb(); migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db); stream = new StreamStore(db, bus);
  db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body) VALUES('q-work','t','t','writer@rig','worker@rig','pending','work')").run();
  for (const [id, source, tag] of [["S1", "writer-a@rig", "decision"], ["S2", "writer-b@rig", "decision"],
    ["S3", "writer-a@rig", "status"], ["empty", "writer-a@rig", "decision"]]) {
    stream.emit({ streamItemId: id!, sourceSession: source!, hintTags: [tag!], body: id! });
  }
  app = new Hono();
  app.use("*", async (c, next) => { c.set("streamStore" as never, stream); c.set("eventBus" as never, bus); await next(); });
  app.route("/api/stream", streamRoutes());
});
afterEach(() => db.close());

it("bulk actions preserve full per-item history, kinds, attribution and tied-time paging including archives", async () => {
  record("S1", "reader-a@rig", "act"); record("S1", "reader-a@rig", "act"); record("S1", "reader-a@rig", "decline");
  record("S1", "reader-b@rig", "duplicate"); record("S2", "reader-a@rig", "act"); record("S3", "reader-c@rig", "act");
  stream.archive("S2");
  const expected = ["S1", "S2", "S3"].flatMap(id => readerActions(db, id).history).sort((a, b) => a.actionId.localeCompare(b.actionId));
  const before = db.serialize(); const result = await all("limit=2");
  expect(result).toEqual(expected); expect(new Set(result.map(a => a.actionId)).size).toBe(expected.length);
  expect(result.map(a => a.action)).toEqual(["act", "act", "decline", "duplicate", "act", "act"]);
  expect(db.serialize().equals(before)).toBe(true);
});

it("bulk actions current mode equals every per-item current across page boundaries", async () => {
  record("S1", "reader-a@rig", "act", T2); record("S1", "reader-a@rig", "decline", T1);
  record("S1", "reader-b@rig", "duplicate"); record("S2", "reader-a@rig", "act");
  const expected = ["S1", "S2"].flatMap(id => readerActions(db, id).current).sort((a, b) => a.actionId.localeCompare(b.actionId));
  expect(await all("mode=current&limit=1")).toEqual(expected);
});

it("bulk actions reduce current before action, time and cursor filters, without reviving a historical act", async () => {
  const old = record("S1", "reader-a@rig", "act", T2);
  record("S1", "reader-a@rig", "decline", T1);
  for (const filter of ["action=act", "since=" + T2, "action=act&afterActionId=" + old.actionId]) {
    expect((await page("mode=current&" + filter)).items).toEqual([]);
  }
  expect((await page("mode=history&action=act&since=" + T2)).items).toEqual([old]);
});

it("bulk actions compose item metadata, actor, kind and inclusive action-time filters", async () => {
  record("S1", "reader-a@rig", "act", T1); const wanted = record("S1", "reader-b@rig", "act", T2);
  record("S2", "reader-b@rig", "act", T2); record("S3", "reader-b@rig", "act", T2);
  expect((await page("hintTag=decision&sourceSession=writer-a%40rig&readerSession=reader-b%40rig&action=act&since=" + T2 + "&until=" + T2)).items).toEqual([wanted]);
  expect((await page("since=2026-01-02T01:00:00%2B01:00&until=" + T2)).items).toHaveLength(3);
});

it("bulk actions distinguish a partial page, a present empty item, and requested missing items", async () => {
  record("S1", "reader-a@rig", "act"); record("S1", "reader-b@rig", "decline");
  const partial = await page("streamItemId=S1&streamItemId=empty&streamItemId=gone&limit=1");
  expect(partial).toMatchObject({ mode: "history", hasMore: true, missingStreamItemIds: ["gone"], historyScope: "retained" });
  expect(partial.nextAfterActionId).toBe(partial.items[0].actionId);
  expect(await page("streamItemId=empty")).toMatchObject({ items: [], hasMore: false, nextAfterActionId: null, missingStreamItemIds: [] });
  expect(await page("streamItemId=gone&streamItemId=gone")).toMatchObject({ items: [], hasMore: false, missingStreamItemIds: ["gone"] });
});

it("bulk actions keep manually orphaned history as the old read does, while flagging missing requested metadata", async () => {
  const action = record("S1", "reader-a@rig", "act");
  db.pragma("foreign_keys = OFF"); db.prepare("DELETE FROM stream_items WHERE stream_item_id='S1'").run(); db.pragma("foreign_keys = ON");
  expect((await page("streamItemId=S1")).items).toEqual(readerActions(db, "S1").history);
  expect(await page("streamItemId=S1")).toMatchObject({ items: [action], missingStreamItemIds: ["S1"] });
  expect((await page("hintTag=decision")).items).toEqual([]); // missing metadata cannot match an item tag
});

it("bulk actions bound page size and keep the old per-item response unchanged", async () => {
  record("S1", "reader-a@rig", "act"); record("S1", "reader-b@rig", "duplicate");
  expect(await page("limit=10000")).toMatchObject({ limit: 500, hasMore: false });
  expect(await page("limit=0")).toMatchObject({ limit: 1, hasMore: true });
  const before = readerActions(db, "S1"); const response = await app.request("/api/stream/S1/actions");
  expect(await response.json()).toEqual({ streamItemId: "S1", ...before });
});

it.each(["mode=other", "action=other", "limit=no", "since=not-a-date", "until=2026-02-31T00:00:00Z",
  "since=2026-01-01T00:00:00.0001Z", "since=" + T2 + "&until=" + T1])("bulk actions reject malformed query %s", async query => {
  expect((await app.request("/api/stream/actions/list?" + query)).status).toBe(400);
});

it("keeps an existing reader-actions item lookup distinct from the bulk route", async () => {
  stream.emit({ streamItemId: "reader-actions", sourceSession: "writer@rig", body: "existing item" });
  const response = await app.request("/api/stream/reader-actions");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ streamItemId: "reader-actions", body: "existing item" });
});
