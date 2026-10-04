import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionsArchiveSchema } from "../src/db/migrations/054_queue_transitions_archive.js";
import { occupantTenuresSchema } from "../src/db/migrations/060_occupant_tenures.js";
import { archiveIdentityProvenanceSchema } from "../src/db/migrations/082_archive_identity_provenance.js";
import { readTelemetryPage, TELEMETRY_LIMITS, TELEMETRY_PAGE_SQL } from "../src/domain/finite-telemetry.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";
const source = { hostId: "host-test", bootEpoch: "boot-test" };
const time = "2026-10-04T09:00:00.000Z";
const databases: Database.Database[] = [];
function fixture() {
    const db = new Database(":memory:");
    databases.push(db);
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY); INSERT INTO nodes VALUES ('node-a'); INSERT INTO nodes VALUES ('node-b')");
    for (const schema of [eventsSchema, queueTransitionsSchema, queueTransitionsArchiveSchema, occupantTenuresSchema])
        db.exec(schema.sql);
    db.exec("ALTER TABLE queue_transitions ADD COLUMN identity_provenance TEXT");
    db.exec(archiveIdentityProvenanceSchema.sql);
    return db;
}
function events(db: Database.Database, count: number, start = 1, step = 1) {
    const insert = db.prepare("INSERT INTO events(seq, rig_id, node_id, type, payload, created_at) VALUES (?, 'rig-a', 'node-a', 'node.started', 'private payload', '2026-10-04 09:00:00')");
    db.transaction(() => { for (let i = 0; i < count; i++)
        insert.run(BigInt(start + i * step)); })();
}
function transitions(db: Database.Database, count: number) {
    const insert = db.prepare("INSERT INTO queue_transitions(qitem_id, ts, state, transition_note, actor_session) VALUES ('q-a', ?, 'pending', 'private note', 'seat@rig')");
    db.transaction(() => { for (let i = 0; i < count; i++)
        insert.run(time); })();
}
function archive(db: Database.Database, above: number, through: number) {
    db.transaction(() => {
        db.prepare(`INSERT INTO queue_transitions_archive
      (transition_id,qitem_id,ts,state,transition_note,actor_session,closure_reason,closure_target,identity_provenance,archived_at)
      SELECT transition_id,qitem_id,ts,state,transition_note,actor_session,closure_reason,closure_target,identity_provenance,?
      FROM queue_transitions WHERE transition_id > ? AND transition_id <= ?`).run(time, above, through);
        db.prepare("DELETE FROM queue_transitions WHERE transition_id > ? AND transition_id <= ?").run(above, through);
    })();
}
function tenures(db: Database.Database, count: number, node = "node-a") {
    const insert = db.prepare("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind,boot_at) VALUES (?,?,?,?,'fresh',?)");
    db.transaction(() => { for (let i = 1; i <= count; i++)
        insert.run(`${node}-${i}`, node, i, `uuid-${node}-${i}`, time); })();
}
function app(db: Database.Database) {
    return new Hono().route("/api/telemetry", telemetryRoutes({ db: () => db, source, nowIso: () => time }));
}
afterEach(() => { for (const db of databases.splice(0))
    db.close(); });
describe("finite telemetry history", () => {
    it("starts at the high watermark, then reads one new window with decimal IDs intact", () => {
        const db = fixture();
        events(db, 1);
        const checkpoint = readTelemetryPage(db, source, "events", {}, time);
        expect(checkpoint.rows).toEqual([]);
        expect(checkpoint.coverage.gaps).toEqual([{ code: "historical_events_not_read", through: "1" }]);
        db.prepare("INSERT INTO events(seq,type,payload) VALUES (?, 'node.stopped', 'private')").run(9007199254740993n);
        const next = readTelemetryPage(db, source, "events", { cursor: checkpoint.page.nextCursor! }, time);
        expect(next.rows[0]!.seq).toBe("9007199254740993");
        expect(next.page.lastScanned).toBe("9007199254740993");
        expect(next.source.sequenceSpaceId).toBeNull();
        expect(next.coverage.historyCompleteness).toBe("unknown");
    });
    it("bounds a large sparse source before filtering and advances on no matches", () => {
        const db = fixture();
        events(db, 5000, 1, 3);
        const first = readTelemetryPage(db, source, "events", { start: "retained", nodeId: "node-b" });
        expect(first.rows).toEqual([]);
        expect(first.page).toMatchObject({ fetched: 128, scanned: 128, filtered: 128, lastScanned: "382", through: "14998", hasMore: true });
        expect(first.coverage.gapDetailsTruncated).toBe(true);
        expect(first.coverage.gaps).toHaveLength(32);
        const next = readTelemetryPage(db, source, "events", { cursor: first.page.nextCursor!, nodeId: "node-b" });
        expect(next.page).toMatchObject({ fetched: 128, scanned: 128, lastScanned: "766", through: "14998" });
    });
    it("keeps a fixed window under new writes and opens the next only when complete", () => {
        const db = fixture();
        events(db, 3);
        const first = readTelemetryPage(db, source, "events", { start: "retained", limit: "2" });
        events(db, 1, 4);
        const second = readTelemetryPage(db, source, "events", { cursor: first.page.nextCursor! });
        expect(second.rows.map(row => row.seq)).toEqual(["3"]);
        expect(second.page).toMatchObject({ through: "3", retainedHighWatermark: "4", hasMore: false });
        const third = readTelemetryPage(db, source, "events", { cursor: second.page.nextCursor! });
        expect(third.rows.map(row => row.seq)).toEqual(["4"]);
    });
    it("names boot changes and watermark regressions without advancing the old checkpoint", () => {
        const db = fixture();
        events(db, 3);
        const first = readTelemetryPage(db, source, "events", { start: "retained", limit: "1" });
        const reboot = readTelemetryPage(db, { ...source, bootEpoch: "boot-new" }, "events", { cursor: first.page.nextCursor! });
        expect(reboot.rows).toEqual([]);
        expect(reboot.page).toMatchObject({ lastScanned: "1", through: "3", nextCursor: null });
        expect(reboot.page.restartCursor).toEqual(expect.any(String));
        expect(reboot.coverage).toMatchObject({ status: "unavailable", gaps: [{ code: "boot_boundary_history_unverified" }] });
        db.exec("DELETE FROM events WHERE seq > 1");
        const regressed = readTelemetryPage(db, source, "events", { cursor: first.page.nextCursor! });
        expect(regressed.coverage.gaps[0]!.code).toBe("watermark_regression_history_unverified");
        expect(regressed.rows).toEqual([]);
    });
    it("does not loop or cross the fixed watermark when the old window disappears", () => {
        const db = fixture();
        events(db, 4);
        const first = readTelemetryPage(db, source, "events", { start: "retained", limit: "1" });
        db.exec("DELETE FROM events");
        events(db, 1, 10);
        const lost = readTelemetryPage(db, source, "events", { cursor: first.page.nextCursor! });
        expect(lost.page).toMatchObject({ lastScanned: "4", through: "4", scanned: 0, hasMore: false });
        expect(lost.coverage.gaps).toContainEqual({ code: "before_retained_floor", from: "2", through: "4" });
        const next = readTelemetryPage(db, source, "events", { cursor: lost.page.nextCursor! });
        expect(next.rows.map(row => row.seq)).toEqual(["10"]);
    });
    it("merges active/archive IDs across a move without replaying or losing records", () => {
        const db = fixture();
        transitions(db, 300);
        archive(db, 0, 100);
        const first = readTelemetryPage(db, source, "queue-transitions", { start: "retained" });
        expect(first.rows.map(row => row.transitionId)).toEqual(Array.from({ length: 128 }, (_, i) => String(i + 1)));
        expect(first.page.fetched).toBe(228);
        archive(db, 100, 250);
        const second = readTelemetryPage(db, source, "queue-transitions", { cursor: first.page.nextCursor! });
        expect(second.rows.map(row => row.transitionId)).toEqual(Array.from({ length: 128 }, (_, i) => String(i + 129)));
        expect(second.page.fetched).toBeLessThanOrEqual(256);
        const third = readTelemetryPage(db, source, "queue-transitions", { cursor: second.page.nextCursor! });
        expect(third.rows.map(row => row.transitionId)).toEqual(Array.from({ length: 44 }, (_, i) => String(i + 257)));
        expect(third.page.hasMore).toBe(false);
        expect(first.rows[0]).toMatchObject({ qitemId: "q-a", state: "pending", actorSession: "seat@rig", identityProvenance: null, closureTarget: null });
    });
    it("deduplicates equal projections and withholds conflicting IDs with a named gap", () => {
        const db = fixture();
        transitions(db, 2);
        db.prepare(`INSERT INTO queue_transitions_archive
      (transition_id,qitem_id,ts,state,transition_note,actor_session,archived_at)
      SELECT transition_id,qitem_id,ts,state,'different private note',actor_session,? FROM queue_transitions`).run(time);
        db.exec("UPDATE queue_transitions_archive SET state = 'done' WHERE transition_id = 2");
        const page = readTelemetryPage(db, source, "queue-transitions", { start: "retained" });
        expect(page.page).toMatchObject({ fetched: 4, scanned: 2, withheld: 1, returned: 1, lastScanned: "2" });
        expect(page.coverage.gaps).toContainEqual({ code: "conflicting_transition_id", id: "2" });
    });
    it("uses source caps before qitem filtering, including repeated same-state records", () => {
        const db = fixture();
        transitions(db, 300);
        const page = readTelemetryPage(db, source, "queue-transitions", { start: "retained", qitemId: "unmatched" });
        expect(page.rows).toEqual([]);
        expect(page.page).toMatchObject({ scanned: 128, filtered: 128, lastScanned: "128", hasMore: true });
    });
    it("does not select payloads/notes and nulls oversized metadata before materializing it", async () => {
        const db = fixture();
        events(db, 1);
        transitions(db, 1);
        const secret = "SYNTHETIC_PRIVATE_BODY_".repeat(50000);
        db.prepare("UPDATE events SET payload = ?, node_id = ?, type = ?").run(secret, "n".repeat(257), "é".repeat(65));
        db.prepare("UPDATE queue_transitions SET transition_note = ?, actor_session = ?").run(secret, "a".repeat(513));
        const response = await app(db).request("/api/telemetry/v1/events?start=retained");
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.rows[0]).toMatchObject({ nodeId: null, type: null, createdAt: time });
        expect(body.coverage.gaps).toContainEqual({ code: "oversized_field", id: "1", field: "nodeId" });
        const transition = readTelemetryPage(db, source, "queue-transitions", { start: "retained" });
        expect(transition.rows[0]!.actorSession).toBeNull();
        expect(JSON.stringify([body, transition])).not.toContain("SYNTHETIC_PRIVATE");
        for (const sql of Object.values(TELEMETRY_PAGE_SQL))
            expect(sql).not.toMatch(/\b(payload|transition_note|SELECT\s+\*)\b/i);
        expect(db.prepare("SELECT octet_length('é') AS bytes").get()).toEqual({ bytes: 2 });
    });
    it("stops at the response cap without advancing over the unreturned next record", () => {
        const db = fixture();
        transitions(db, 128);
        db.prepare("UPDATE queue_transitions SET actor_session = ?").run("\u0001".repeat(450));
        const first = readTelemetryPage(db, source, "queue-transitions", { start: "retained" });
        expect(first.page.capReason).toBe("response_byte_limit");
        expect(first.rows.length).toBeGreaterThan(1);
        expect(first.rows.length).toBeLessThan(128);
        expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(TELEMETRY_LIMITS.responseBytes);
        const next = readTelemetryPage(db, source, "queue-transitions", { cursor: first.page.nextCursor! });
        expect(BigInt(next.rows[0]!.transitionId!)).toBe(BigInt(first.page.lastScanned) + 1n);
        db.prepare("UPDATE queue_transitions SET closure_target = ?").run("\u0002".repeat(450));
        const withheld = readTelemetryPage(db, source, "queue-transitions", { start: "retained" });
        expect(withheld.rows).toEqual([]);
        expect(withheld.page).toMatchObject({ scanned: 128, withheld: 128, lastScanned: "128", hasMore: false });
        expect(withheld.coverage.gaps[0]!.code).toBe("record_byte_limit");
    });
    it("returns newest 32 tenures, retaining null native binding and one fixed descending window", () => {
        const db = fixture();
        tenures(db, 35);
        tenures(db, 40, "node-b");
        const first = readTelemetryPage(db, source, "tenures", { nodeId: "node-a" });
        expect(first.rows).toHaveLength(32);
        expect(first.rows[0]).toMatchObject({ nodeId: "node-a", generationOrdinal: "35", generationUuid: "uuid-node-a-35", nativeSessionIdAtBoot: null, bootAt: time });
        expect(first.page).toMatchObject({ through: "35", lastScanned: "4", hasMore: true });
        db.prepare("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('new','node-a',36,'new-uuid','handover')").run();
        const next = readTelemetryPage(db, source, "tenures", { nodeId: "node-a", cursor: first.page.nextCursor! });
        expect(next.rows.map(row => row.generationOrdinal)).toEqual(["3", "2", "1"]);
        expect(next.page.nextCursor).toBeNull();
        db.exec("DELETE FROM nodes WHERE id = 'node-a'");
        const empty = readTelemetryPage(db, source, "tenures", { nodeId: "node-a" });
        expect(empty.rows).toEqual([]);
        expect(empty.coverage.gaps[0]!.code).toBe("tenure_history_unavailable");
    });
    it("matches the collector metadata contract without deriving semantic state from event kind", async () => {
        const db = fixture();
        events(db, 1);
        tenures(db, 1);
        const eventResponse = await app(db).request("/api/telemetry/v1/events?start=retained");
        const tenureResponse = await app(db).request("/api/telemetry/v1/nodes/node-a/tenures");
        const event = (await eventResponse.json()).rows[0];
        const tenure = (await tenureResponse.json()).rows[0];
        // The consumer's snake_case mapping; no current-node/name/native join and no payload read.
        expect({ seq: event.seq, rig_id: event.rigId, node_id: event.nodeId, type: event.type, created_at: event.createdAt, state: "unknown" })
            .toEqual({ seq: "1", rig_id: "rig-a", node_id: "node-a", type: "node.started", created_at: time, state: "unknown" });
        expect({ node_id: tenure.nodeId, generation_ordinal: tenure.generationOrdinal, generation_uuid: tenure.generationUuid, kind: tenure.kind, native_session_id_at_boot: tenure.nativeSessionIdAtBoot, boot_at: tenure.bootAt })
            .toEqual({ node_id: "node-a", generation_ordinal: "1", generation_uuid: "uuid-node-a-1", kind: "fresh", native_session_id_at_boot: null, boot_at: time });
    });
    it("uses indexed key ranges for the actual page SQL, without temp sorting or filter scans", () => {
        const db = fixture();
        events(db, 5000, 1, 7);
        transitions(db, 5000);
        archive(db, 0, 2500);
        tenures(db, 200);
        const queries = [
            [TELEMETRY_PAGE_SQL.events, [0n, 999999n, 128], /SEARCH events USING INTEGER PRIMARY KEY/],
            [TELEMETRY_PAGE_SQL.active, [0n, 999999n, 128], /SEARCH queue_transitions USING INTEGER PRIMARY KEY/],
            [TELEMETRY_PAGE_SQL.archive, [0n, 999999n, 128], /SEARCH queue_transitions_archive USING INTEGER PRIMARY KEY/],
            [TELEMETRY_PAGE_SQL.tenures, ["node-a", 201n, 200n, 128], /SEARCH occupant_tenures USING INDEX sqlite_autoindex_occupant_tenures_3/],
        ] as const;
        for (const [sql, args, expected] of queries) {
            const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{
                detail: string;
            }>).map(row => row.detail).join("\n");
            expect(details).toMatch(expected);
            expect(details).not.toMatch(/TEMP B-TREE|SCAN /);
        }
    });
    it("returns named input and source errors instead of an empty successful page", async () => {
        const db = fixture();
        events(db, 2);
        const first = readTelemetryPage(db, source, "events", { start: "retained", limit: "1" });
        for (const query of ["cursor=bad", "limit=129", "limit=0", "limit=1.5", "start=all", `cursor=${first.page.nextCursor}&nodeId=other`, "cursor=" + "a".repeat(2049)]) {
            const response = await app(db).request(`/api/telemetry/v1/events?${query}`);
            expect(response.status).toBe(400);
            expect((await response.json()).code).toBe("telemetry_invalid_request");
        }
        db.exec("DROP TABLE events");
        const broken = await app(db).request("/api/telemetry/v1/events");
        expect(broken.status).toBe(503);
        expect(await broken.json()).toEqual({ code: "telemetry_read_unavailable", error: "Telemetry history could not be read.", coverage: { status: "unavailable", historyCompleteness: "unknown" } });
    });
});
