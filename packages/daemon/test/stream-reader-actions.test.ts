import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { classificationFieldsAndAttemptsSchema } from "../src/db/migrations/086_classification_fields_and_attempts.js";
import { classificationIdentityProvenanceSchema } from "../src/db/migrations/089_classification_identity_provenance.js";
import { streamDispositionsSchema } from "../src/db/migrations/129_stream_dispositions.js";
import { streamSubscriptionsSchema } from "../src/db/migrations/130_stream_subscriptions.js";
import { streamReaderActionsSchema } from "../src/db/migrations/133_stream_reader_actions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier } from "../src/domain/project-classifier.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ReaderActionError, readerActions, recordReaderAction } from "../src/domain/stream-reader-actions.js";
import { pruneStreamItems } from "../src/domain/queue-retention.js";
import { streamRoutes } from "../src/routes/stream.js";

describe("stream reader actions (slice 22 outcome 9)", () => {
  let db: Database.Database, bus: EventBus, stream: StreamStore;
  const row = (id: string) => db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
    VALUES (?, 't', 't', 'x@rig', 'dev-lead@rig', 'pending', 'work')`).run(id);
  const act = (reader: string, action: string, over: Record<string, unknown> = {}) =>
    recordReaderAction(db, { streamItemId: "S1", readerSession: reader, action, ...over });
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ReaderActionError ? `${e.status} ${e.code}` : String(e); } return "ok"; };

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, classifierLeasesSchema, projectClassificationsSchema,
      classificationFieldsAndAttemptsSchema, classificationIdentityProvenanceSchema, streamDispositionsSchema, streamSubscriptionsSchema, streamReaderActionsSchema]);
    bus = new EventBus(db); stream = new StreamStore(db, bus);
    stream.emit({ streamItemId: "S1", sourceSession: "poster@rig", body: "the build is flaky" });
    row("q-1"); row("q-2");
  });
  afterEach(() => db.close());

  it("records act, decline and duplicate with the actor and the link or reason, and refuses what can't be linked", () => {
    expect(code(() => act("a@rig", "act"))).toBe("400 work_required");
    expect(code(() => act("a@rig", "act", { workQitemId: "q-404" }))).toBe("404 work_not_found");
    expect(code(() => act("a@rig", "decline"))).toBe("400 reason_required");
    expect(code(() => act("a@rig", "duplicate", { duplicateOf: "nothing" }))).toBe("404 duplicate_target_not_found");
    expect(code(() => act("a@rig", "ignore"))).toBe("400 action_invalid");
    expect(code(() => recordReaderAction(db, { streamItemId: "S9", readerSession: "a@rig", action: "decline", reason: "x" }))).toBe("404 stream_item_not_found");
    expect(act("a@rig", "act", { workQitemId: "q-1" })).toMatchObject({ action: { readerSession: "a@rig", action: "act", workQitemId: "q-1" } });
    expect(act("b@rig", "decline", { reason: "not my area" }).action).toMatchObject({ action: "decline", reason: "not my area" });
    expect(act("c@rig", "duplicate", { duplicateOf: "q-2" }).action).toMatchObject({ duplicateOf: "q-2" });
    expect(readerActions(db, "S1").current.map(a => `${a.readerSession}:${a.action}`)).toEqual(["a@rig:act", "b@rig:decline", "c@rig:duplicate"]);
  });

  it("two readers keep one accountable action: the second is shown the first's work, and the automatic path's", () => {
    expect(act("a@rig", "act", { workQitemId: "q-1" })).not.toHaveProperty("otherWork");
    expect(act("b@rig", "act", { workQitemId: "q-1" })).not.toHaveProperty("otherWork"); // joined the same work
    expect(act("c@rig", "act", { workQitemId: "q-2" })).toMatchObject({ otherWork: [{ qitemId: "q-1", by: "a@rig", source: "reader" },
      { qitemId: "q-1", by: "b@rig", source: "reader" }], note: expect.stringContaining("joining it") });
    const leases = new ClassifierLeaseManager(db, bus);
    leases.acquire("intake@rig");
    new ProjectClassifier(db, bus, leases).classify({ streamItemId: "S1", classifierSession: "intake@rig", leaseId: leases.getActiveLease()!.leaseId,
      action: "create", classificationDestination: "dev-lead@rig", disposition: { disposition: "create", ownerSession: "dev-lead@rig", workQitemId: null,
        effect: { operation: "create", qitemId: "qitem-stream-S1", destination: "dev-lead@rig" }, templateDigest: "sha256:" + "a".repeat(64),
        templateText: "name: stream\n", request: "{}", provenance: {} } });
    expect(act("d@rig", "act", { workQitemId: "q-1" }).otherWork).toEqual([{ qitemId: "q-2", current: "q-2", by: "c@rig", source: "reader" },
      { qitemId: "qitem-stream-S1", current: null, by: "intake@rig", source: "automatic" }]); // its row isn't created yet: lineage unknown
  });

  it("a decline is that reader's alone, and a correction keeps the earlier action inspectable", () => {
    act("a@rig", "decline", { reason: "not mine" });
    act("b@rig", "act", { workQitemId: "q-1" });
    act("a@rig", "act", { workQitemId: "q-1" });
    const { current, history } = readerActions(db, "S1");
    expect(current.map(a => `${a.readerSession}:${a.action}`)).toEqual(["b@rig:act", "a@rig:act"]);
    expect(history.map(a => `${a.readerSession}:${a.action}`)).toEqual(["a@rig:decline", "b@rig:act", "a@rig:act"]);
  });

  it("retention keeps an item a reader acted on", () => {
    stream.emit({ streamItemId: "S2", sourceSession: "poster@rig", body: "unread and untouched" });
    act("b@rig", "decline", { reason: "not mine" });
    expect(pruneStreamItems(db, { nowIso: new Date(Date.now() + 40 * 86_400_000).toISOString() })).toEqual({ deletedRows: 1 });
    expect(stream.getById("S1")).not.toBeNull();
    expect(stream.getById("S2")).toBeNull();
  });

  it("retention keeps a stream item a duplicate action names, even after the action is corrected", () => {
    stream.emit({ streamItemId: "S2", sourceSession: "poster@rig", body: "the original report" });
    act("a@rig", "duplicate", { duplicateOf: "S2" });
    act("a@rig", "decline", { reason: "not a duplicate after all" });
    expect(pruneStreamItems(db, { nowIso: new Date(Date.now() + 40 * 86_400_000).toISOString() })).toEqual({ deletedRows: 0 });
    expect(stream.getById("S2")).not.toBeNull();
  });

  it("one handed-on work chain isn't other work; unrelated work is still named, with its current row", () => {
    db.prepare("UPDATE queue_items SET state = 'handed-off', closure_reason = 'handed_off_to', closure_target = 'b@rig' WHERE qitem_id = 'q-1'").run();
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, handed_off_from)
      VALUES ('q-3', 't', 't', 'a@rig', 'b@rig', 'pending', 'work', 'q-1')`).run();
    act("a@rig", "act", { workQitemId: "q-1" });
    expect(act("b@rig", "act", { workQitemId: "q-3" })).not.toHaveProperty("otherWork");
    expect(act("c@rig", "act", { workQitemId: "q-2" }).otherWork).toEqual([
      { qitemId: "q-1", current: "q-3", by: "a@rig", source: "reader" }, { qitemId: "q-3", current: "q-3", by: "b@rig", source: "reader" }]);
  });

  it("routes: act as the transport identity, and the item's actions", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("streamStore" as never, stream); await next(); });
    app.route("/api/stream", streamRoutes());
    const post = (body: unknown) => app.request("/api/stream/S1/act", { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev-lead@rig" } });
    expect((await post({ action: "act", workQitemId: "q-404" })).status).toBe(404);
    const res = await post({ action: "act", workQitemId: "q-1", reader: "someone-else@rig" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ action: { readerSession: "dev-lead@rig", workQitemId: "q-1" } });
    expect(await (await app.request("/api/stream/S1/actions")).json()).toMatchObject({ streamItemId: "S1",
      current: [{ readerSession: "dev-lead@rig", action: "act" }], history: [{ action: "act" }] });
  });
});
