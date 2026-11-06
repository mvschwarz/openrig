import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionsArchiveSchema } from "../src/db/migrations/054_queue_transitions_archive.js";
import { occupantTenuresSchema } from "../src/db/migrations/060_occupant_tenures.js";
import { archiveIdentityProvenanceSchema } from "../src/db/migrations/082_archive_identity_provenance.js";
import { readTelemetryPage, TELEMETRY_LIMITS, TELEMETRY_PAGE_SQL } from "../src/domain/finite-telemetry.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";
import {
    exportQueueTransitionsOnce,
    main as runExporterCli,
    parseExporterArgs,
    TELEMETRY_OTLP_LIMITS,
    TelemetryCheckpointError,
    TelemetryExportError,
    TelemetrySourceError,
} from "../../../docs/reference/telemetry-otlp.mjs";
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
afterEach(async () => {
    for (const db of databases.splice(0))
        db.close();
    for (const srv of servers.splice(0))
        await new Promise<void>(resolveClose => srv.close(() => resolveClose()));
    for (const dir of tempDirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
const servers: Server[] = [];
const tempDirs: string[] = [];
const exporterScriptPath = resolve(import.meta.dirname, "../../../docs/reference/telemetry-otlp.mjs");
const execFileAsync = promisify(execFile);
function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), "openrig-telemetry-otlp-"));
    tempDirs.push(dir);
    return dir;
}
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    const srv = createServer(handler);
    servers.push(srv);
    await new Promise<void>(resolveListen => srv.listen(0, "127.0.0.1", () => resolveListen()));
    const addr = srv.address();
    if (!addr || typeof addr === "string")
        throw new Error("unexpected server address");
    return `http://127.0.0.1:${addr.port}`;
}
async function startSourceServer(db: Database.Database, getSource: () => { hostId: string | null; bootEpoch: string | null } = () => source) {
    let requests = 0;
    const baseUrl = await listen(async (req, res) => {
        requests++;
        const hono = new Hono().route("/api/telemetry", telemetryRoutes({ db: () => db, source: getSource(), nowIso: () => time }));
        const response = await hono.request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method ?? "GET" });
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
    });
    return { baseUrl, getRequests: () => requests };
}
type ReceiverOutcome = {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Record<string, unknown>;
    delayMs?: number;
    dropSocket?: boolean;
};
async function startOtlpReceiver(outcomes: ReceiverOutcome[] = []) {
    const received: Array<{
        path: string;
        contentType: string | undefined;
        rawBody: string;
        json: any;
        records: Array<{
            timeUnixNano?: string;
            observedTimeUnixNano?: string;
            severityText?: string;
            body?: string;
            attributes: Record<string, string | number | boolean>;
        }>;
        resourceAttributes: Record<string, string | number | boolean>;
        scopeName?: string;
    }> = [];
    let attempts = 0;
    const baseUrl = await listen((req, res) => {
        attempts++;
        const chunks: Buffer[] = [];
        req.on("data", chunk => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
            const rawBody = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try {
                json = JSON.parse(rawBody);
            }
            catch {
                json = null;
            }
            const attrMap = (attrs: any[] = []) => Object.fromEntries(attrs.map(a => [
                a.key,
                a.value?.stringValue ?? a.value?.intValue ?? a.value?.boolValue,
            ]));
            const rl = json?.resourceLogs?.[0];
            const sl = rl?.scopeLogs?.[0];
            const records = (sl?.logRecords ?? []).map((r: any) => ({
                timeUnixNano: r.timeUnixNano,
                observedTimeUnixNano: r.observedTimeUnixNano,
                severityText: r.severityText,
                body: r.body?.stringValue,
                attributes: attrMap(r.attributes),
            }));
            received.push({
                path: req.url ?? "",
                contentType: req.headers["content-type"],
                rawBody,
                json,
                records,
                resourceAttributes: attrMap(rl?.resource?.attributes),
                scopeName: sl?.scope?.name,
            });
            const outcome = outcomes.shift() ?? { status: 200, body: {} };
            const respond = () => {
                if (outcome.dropSocket) {
                    req.socket.destroy();
                    return;
                }
                res.statusCode = outcome.status ?? 200;
                res.setHeader("content-type", "application/json");
                for (const [k, v] of Object.entries(outcome.headers ?? {}))
                    res.setHeader(k, v);
                const payload = typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body ?? {});
                res.end(payload);
            };
            if (outcome.delayMs)
                setTimeout(respond, outcome.delayMs);
            else
                respond();
        });
    });
    return { endpointUrl: `${baseUrl}/v1/logs`, baseUrl, received, getAttempts: () => attempts };
}
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
    it.each([0, 2, 3])("retains the observed tenure floor when %i oldest ordinals disappear", (removed) => {
        const db = fixture();
        tenures(db, 35);
        const first = readTelemetryPage(db, source, "tenures", { nodeId: "node-a" });
        expect(first.coverage.retainedMinimum).toBe("1");
        expect(first.page.lastScanned).toBe("4");
        db.prepare("DELETE FROM occupant_tenures WHERE generation_ordinal <= ?").run(removed);
        const next = readTelemetryPage(db, source, "tenures", { nodeId: "node-a", cursor: first.page.nextCursor! });
        expect(next.rows.map(row => row.generationOrdinal)).toEqual([3, 2, 1].filter(n => n > removed).map(String));
        expect(next.page.hasMore).toBe(false);
        if (removed) {
            expect(next.coverage.status).toBe("partial");
            expect(next.coverage.gaps).toContainEqual({ code: "tenure_floor_history_unavailable", from: "1", through: String(removed) });
        } else expect(next.coverage.gapCount).toBe(0);
    });
    it("does not invent lost tenure history below the first observed retained floor", () => {
        const db = fixture();
        tenures(db, 35);
        db.exec("DELETE FROM occupant_tenures WHERE generation_ordinal < 3");
        const first = readTelemetryPage(db, source, "tenures", { nodeId: "node-a" });
        expect(first.coverage.retainedMinimum).toBe("3");
        const next = readTelemetryPage(db, source, "tenures", { nodeId: "node-a", cursor: first.page.nextCursor! });
        expect(next.rows.map(row => row.generationOrdinal)).toEqual(["3"]);
        expect(next.coverage.gapCount).toBe(0);
        expect(next.coverage.historyCompleteness).toBe("unknown");
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
describe("reference OTLP queue-transition log exporter", () => {
    it("exports allowlisted queue transitions and gaps, preserves 64-bit decimal IDs, separates event vs observed timestamps, and gates qitemId on opt-in", async () => {
        const db = fixture();
        const insert = db.prepare(`INSERT INTO queue_transitions
      (transition_id, qitem_id, ts, state, transition_note, actor_session, closure_reason, closure_target, identity_provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        insert.run(9007199254740993n, "q-secret-item", "2026-10-04 09:00:00", "done", "PRIVATE_NOTE_TEXT", "secret-actor@rig", "handed_off_to", "secret-target@rig", "transport:v1");
        insert.run(9007199254740994n, "q-secret-item", "not-a-timestamp", "in-progress", "PRIVATE_NOTE_2", "secret-actor-2@rig", "unallowlisted_reason", "secret-target-2@rig", "unallowlisted_prov");
        const src = await startSourceServer(db);
        const otlp = await startOtlpReceiver();
        const dir = tempDir();
        const checkpointDefault = join(dir, "checkpoint-default.json");
        const resDefault = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: checkpointDefault,
            namespace: "source-test",
            start: "retained",
        });
        expect(resDefault).toMatchObject({
            outcome: "exported",
            exportedRecords: 4,
            rejectedLogRecords: 0,
            replayedPending: false,
            discontinuity: false,
            hasMore: false,
            source: { hostId: "host-test", bootEpoch: "boot-test", sequenceSpaceId: null },
            coverage: { status: "partial", historyCompleteness: "unknown" },
        });
        expect(otlp.received).toHaveLength(1);
        const batch = otlp.received[0]!;
        expect(batch.path).toBe("/v1/logs");
        expect(batch.contentType).toBe("application/json");
        expect(batch.resourceAttributes).toMatchObject({
            "service.name": "openrig-telemetry-exporter",
            "service.namespace": "source-test",
            "openrig.source.namespace": "source-test",
            "openrig.source.boot_epoch": "boot-test",
            "openrig.source.host_id": "host-test",
        });
        expect(batch.scopeName).toBe("openrig.telemetry.queue_transitions");
        expect(batch.records).toHaveLength(4);
        const [rec1, rec2, floorGapRec, gapRec] = batch.records;
        expect(rec1).toMatchObject({
            timeUnixNano: String(BigInt(Date.parse(time)) * 1000000n),
            observedTimeUnixNano: String(BigInt(Date.parse(time)) * 1000000n),
            severityText: "INFO",
            body: "openrig.queue.transition",
            attributes: {
                "openrig.record.kind": "queue_transition",
                "openrig.stream": "queue-transitions",
                "openrig.transition.id": "9007199254740993",
                "openrig.queue.state": "done",
                "openrig.identity.provenance": "transport:v1",
                "openrig.queue.closure_reason": "handed_off_to",
                "openrig.coverage.status": "partial",
                "openrig.coverage.history_completeness": "unknown",
                "openrig.delivery.replayed": false,
            },
        });
        expect(rec1!.attributes["openrig.qitem.id"]).toBeUndefined();
        expect(rec2!.timeUnixNano).toBeUndefined();
        expect(rec2!.observedTimeUnixNano).toBe(String(BigInt(Date.parse(time)) * 1000000n));
        expect(rec2!.attributes["openrig.transition.id"]).toBe("9007199254740994");
        expect(rec2!.attributes["openrig.queue.state"]).toBe("in-progress");
        expect(rec2!.attributes["openrig.identity.provenance"]).toBeUndefined();
        expect(rec2!.attributes["openrig.queue.closure_reason"]).toBeUndefined();
        expect(floorGapRec).toMatchObject({
            observedTimeUnixNano: String(BigInt(Date.parse(time)) * 1000000n),
            severityText: "WARN",
            body: "openrig.telemetry.gap",
            attributes: {
                "openrig.record.kind": "coverage_gap",
                "openrig.stream": "queue-transitions",
                "openrig.gap.code": "before_retained_floor",
                "openrig.gap.from": "1",
                "openrig.gap.through": "9007199254740992",
                "openrig.coverage.status": "partial",
                "openrig.coverage.history_completeness": "unknown",
            },
        });
        expect(gapRec).toMatchObject({
            observedTimeUnixNano: String(BigInt(Date.parse(time)) * 1000000n),
            severityText: "WARN",
            body: "openrig.telemetry.gap",
            attributes: {
                "openrig.record.kind": "coverage_gap",
                "openrig.stream": "queue-transitions",
                "openrig.gap.code": "invalid_timestamp",
                "openrig.gap.id": "9007199254740994",
                "openrig.coverage.status": "partial",
                "openrig.coverage.history_completeness": "unknown",
            },
        });
        expect(gapRec!.timeUnixNano).toBeUndefined();
        const serializedAll = batch.rawBody + readFileSync(checkpointDefault, "utf8");
        for (const forbidden of ["PRIVATE_NOTE", "secret-actor", "secret-target", "q-secret-item", "not-a-timestamp", "unallowlisted", "traceId", "spanId"]) {
            expect(serializedAll).not.toContain(forbidden);
        }
        const checkpointOptIn = join(dir, "checkpoint-optin.json");
        await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: checkpointOptIn,
            namespace: "source-test",
            start: "retained",
            includeQitemId: true,
        });
        expect(otlp.received[1]!.records[0]!.attributes["openrig.qitem.id"]).toBe("q-secret-item");
    });
    it("drains finite active+archive windows, advances on empty filtered pages, and summarizes truncated gap details", async () => {
        const db = fixture();
        transitions(db, 200);
        archive(db, 0, 90);
        const src = await startSourceServer(db);
        const otlp = await startOtlpReceiver();
        const dir = tempDir();
        const unfilteredCkpt = join(dir, "unfiltered.json");
        const first = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: unfilteredCkpt,
            namespace: "source-test",
            start: "retained",
        });
        expect(first).toMatchObject({ outcome: "exported", exportedRecords: 128, hasMore: true });
        const second = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: unfilteredCkpt,
            namespace: "source-test",
            start: "retained",
        });
        expect(second).toMatchObject({ outcome: "exported", exportedRecords: 72, hasMore: false });
        expect(otlp.received[0]!.records[0]!.attributes["openrig.transition.id"]).toBe("1");
        expect(otlp.received[1]!.records[71]!.attributes["openrig.transition.id"]).toBe("200");
        const filteredCkpt = join(dir, "filtered.json");
        const f1 = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: filteredCkpt,
            namespace: "source-test",
            start: "retained",
            qitemId: "unmatched-qitem",
        });
        expect(f1).toMatchObject({ outcome: "empty_page_advanced", exportedRecords: 0, hasMore: true });
        expect(otlp.received).toHaveLength(2);
        const f2 = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: filteredCkpt,
            namespace: "source-test",
            start: "retained",
            qitemId: "unmatched-qitem",
        });
        expect(f2).toMatchObject({ outcome: "empty_page_advanced", exportedRecords: 0, hasMore: false });
        expect(f2.cursor).not.toBe(f1.cursor);
        const saved = JSON.parse(readFileSync(filteredCkpt, "utf8"));
        expect(saved.source.sequenceSpaceId).toBeNull();
        expect(saved.coverage.historyCompleteness).toBe("unknown");
        db.prepare("UPDATE queue_transitions SET state = ? WHERE transition_id > 150").run("x".repeat(200));
        const truncCkpt = join(dir, "truncated-gaps.json");
        const truncRes = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: truncCkpt,
            namespace: "source-test",
            start: "retained",
            limit: 128,
        });
        expect(truncRes.outcome).toBe("exported");
        const truncRes2 = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: truncCkpt,
            namespace: "source-test",
            start: "retained",
            limit: 128,
        });
        expect(truncRes2.outcome).toBe("exported");
        const lastBatch = otlp.received.at(-1)!;
        const truncGap = lastBatch.records.find(r => r.attributes["openrig.gap.code"] === "gap_details_truncated");
        expect(truncGap).toBeDefined();
        expect(truncGap!.attributes["openrig.gap.total_count"]).toBe("50");
        expect(truncGap!.attributes["openrig.gap.omitted_count"]).toBe("18");
    });
    it("exports named discontinuity gaps before adopting fresh restartCursor on daemon boot change or watermark regression", async () => {
        const db = fixture();
        transitions(db, 2);
        let currentSource = { ...source };
        const src = await startSourceServer(db, () => currentSource);
        const otlp = await startOtlpReceiver();
        const ckpt = join(tempDir(), "discontinuity.json");
        const step1 = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            limit: 1,
        });
        expect(step1).toMatchObject({ outcome: "exported", exportedRecords: 1, hasMore: true });
        transitions(db, 2);
        currentSource = { hostId: "host-test", bootEpoch: "boot-after-restart" };
        const rebootStep = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            limit: 1,
        });
        expect(rebootStep).toMatchObject({
            outcome: "exported",
            discontinuity: true,
            exportedRecords: 1,
            source: { hostId: "host-test", bootEpoch: "boot-after-restart", sequenceSpaceId: null },
        });
        expect(otlp.received[1]!.records).toEqual([
            expect.objectContaining({
                body: "openrig.telemetry.gap",
                attributes: expect.objectContaining({
                    "openrig.gap.code": "boot_boundary_history_unverified",
                    "openrig.coverage.status": "unavailable",
                }),
            }),
        ]);
        transitions(db, 1);
        const postReboot = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
        });
        expect(postReboot.exportedRecords).toBe(1);
        expect(otlp.received[2]!.records[0]!.attributes["openrig.transition.id"]).toBe("5");
        db.exec("DELETE FROM queue_transitions WHERE transition_id > 1");
        const regressedStep = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
        });
        expect(regressedStep).toMatchObject({ outcome: "exported", discontinuity: true, exportedRecords: 1 });
        expect(otlp.received[3]!.records[0]!.attributes["openrig.gap.code"]).toBe("watermark_regression_history_unverified");
    });
    it("persists pending batch atomically before send, pauses source ingestion on receiver failure, and replays pending batch on restart", async () => {
        const db = fixture();
        transitions(db, 2);
        const src = await startSourceServer(db);
        const otlp = await startOtlpReceiver([
            { dropSocket: true },
            { delayMs: 250, status: 200, body: {} },
            { status: 200, body: {} },
        ]);
        const ckpt = join(tempDir(), "pending-replay.json");
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            timeoutMs: 80,
            retryMs: 10,
            maxRetryMs: 20,
            maxRetries: 1,
        })).rejects.toThrow(TelemetryExportError);
        expect(src.getRequests()).toBe(1);
        expect(otlp.getAttempts()).toBe(2);
        const pendingDisk = JSON.parse(readFileSync(ckpt, "utf8"));
        expect(pendingDisk.cursor).toBeNull();
        expect(pendingDisk.pending).toMatchObject({
            recordCount: 2,
            nextCursor: expect.any(String),
        });
        transitions(db, 3);
        const replayRes = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            timeoutMs: 500,
        });
        expect(src.getRequests()).toBe(1);
        expect(replayRes).toMatchObject({
            outcome: "exported",
            replayedPending: true,
            exportedRecords: 2,
        });
        expect(otlp.received.at(-1)!.records.every(r => r.attributes["openrig.delivery.replayed"] === true)).toBe(true);
        const resolvedDisk = JSON.parse(readFileSync(ckpt, "utf8"));
        expect(resolvedDisk.pending).toBeNull();
        expect(resolvedDisk.cursor).toBe(pendingDisk.pending.nextCursor);
    });
    it("fails visibly without resetting on malformed, oversized, or config-mismatched checkpoints", async () => {
        const db = fixture();
        transitions(db, 1);
        const src = await startSourceServer(db);
        const otlp = await startOtlpReceiver();
        const dir = tempDir();
        const malformedPath = join(dir, "malformed.json");
        writeFileSync(malformedPath, "{not-valid-json");
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: malformedPath,
            namespace: "source-test",
        })).rejects.toMatchObject({ name: "TelemetryCheckpointError", code: "checkpoint_malformed" });
        expect(readFileSync(malformedPath, "utf8")).toBe("{not-valid-json");
        const oversizedPath = join(dir, "oversized.json");
        writeFileSync(oversizedPath, "x".repeat(TELEMETRY_OTLP_LIMITS.checkpointBytes + 1));
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: oversizedPath,
            namespace: "source-test",
        })).rejects.toMatchObject({ name: "TelemetryCheckpointError", code: "checkpoint_exceeds_byte_limit" });
        const validPath = join(dir, "valid.json");
        await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: validPath,
            namespace: "source-test",
            start: "retained",
        });
        const originalSnapshot = readFileSync(validPath, "utf8");
        for (const override of [
            { namespace: "other-ns" },
            { start: "latest" as const },
            { qitemId: "q-other" },
            { includeQitemId: true },
            { endpointUrl: `${otlp.baseUrl}/other/v1/logs` },
        ]) {
            await expect(exportQueueTransitionsOnce({
                sourceUrl: src.baseUrl,
                endpointUrl: otlp.endpointUrl,
                checkpointPath: validPath,
                namespace: "source-test",
                start: "retained",
                ...override,
            })).rejects.toMatchObject({ name: "TelemetryCheckpointError", code: "checkpoint_config_mismatch" });
            expect(readFileSync(validPath, "utf8")).toBe(originalSnapshot);
        }
        const tamperedPendingPath = join(dir, "tampered-pending.json");
        const tamperedObj = JSON.parse(originalSnapshot);
        tamperedObj.pending = {
            recordCount: 1,
            nextCursor: tamperedObj.cursor,
            discontinuity: false,
            hasMore: false,
            source: tamperedObj.source,
            coverage: tamperedObj.coverage,
            payload: { resourceLogs: [{ scopeLogs: [{ scope: { name: "openrig.telemetry.queue_transitions" }, logRecords: [{ traceId: "invented", body: { stringValue: "openrig.queue.transition" }, attributes: [] }] }] }] },
        };
        const tamperedText = JSON.stringify(tamperedObj);
        writeFileSync(tamperedPendingPath, tamperedText);
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: tamperedPendingPath,
            namespace: "source-test",
            start: "retained",
        })).rejects.toMatchObject({ name: "TelemetryCheckpointError", code: "checkpoint_malformed" });
        expect(readFileSync(tamperedPendingPath, "utf8")).toBe(tamperedText);
    });
    it("handles retryable statuses with bounded Retry-After, partialSuccess without retry or body leak, permanent stop/drop, and response uncertainty", async () => {
        const db = fixture();
        transitions(db, 3);
        const src = await startSourceServer(db);
        const otlp = await startOtlpReceiver([
            { status: 429, headers: { "retry-after": "60" }, body: "RATE_LIMIT_RAW_SECRET" },
            { status: 503, body: "UNAVAILABLE_RAW_SECRET" },
            { status: 200, body: { partialSuccess: { rejectedLogRecords: "1", errorMessage: "COLLECTOR_INTERNAL_SECRET" } } },
            { status: 400, body: "PERMANENT_BAD_REQUEST_SECRET" },
            { status: 400, body: "PERMANENT_BAD_REQUEST_SECRET_2" },
        ]);
        const dir = tempDir();
        const ckpt = join(dir, "outcomes.json");
        const diagnostics: Array<Record<string, unknown>> = [];
        const step1 = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            limit: 2,
            retryMs: 5,
            maxRetryMs: 25,
            maxRetries: 2,
            onDiagnostic: (d: Record<string, unknown>) => diagnostics.push(d),
        });
        expect(step1).toMatchObject({
            outcome: "partial_success",
            exportedRecords: 2,
            rejectedLogRecords: 1,
            partialSuccessWarning: true,
            retryDelaysMs: [25, 10],
        });
        expect(otlp.getAttempts()).toBe(3);
        expect(JSON.stringify([step1, diagnostics])).not.toContain("COLLECTOR_INTERNAL_SECRET");
        const invalidRespRx = await startOtlpReceiver([
            { status: 200, body: "<html>not-json</html>" },
            { status: 200, body: {} },
        ]);
        const invalidRespCkpt = join(dir, "invalid-resp.json");
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: invalidRespRx.endpointUrl,
            checkpointPath: invalidRespCkpt,
            namespace: "source-test",
            start: "retained",
            limit: 2,
            maxRetries: 2,
            onPermanentError: "drop",
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_invalid_response", status: 200 });
        expect(invalidRespRx.getAttempts()).toBe(1);
        const invalidRespSaved = JSON.parse(readFileSync(invalidRespCkpt, "utf8"));
        expect(invalidRespSaved.cursor).toBeNull();
        expect(invalidRespSaved.pending?.blocked).toEqual({ code: "otlp_invalid_response", status: 200 });
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: invalidRespRx.endpointUrl,
            checkpointPath: invalidRespCkpt,
            namespace: "source-test",
            start: "retained",
            limit: 2,
            onPermanentError: "drop",
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_invalid_response", status: 200 });
        expect(invalidRespRx.getAttempts()).toBe(1);
        let stopErr: unknown;
        try {
            await exportQueueTransitionsOnce({
                sourceUrl: src.baseUrl,
                endpointUrl: otlp.endpointUrl,
                checkpointPath: ckpt,
                namespace: "source-test",
                start: "retained",
                limit: 2,
                onPermanentError: "stop",
            });
        }
        catch (err) {
            stopErr = err;
        }
        expect(stopErr).toMatchObject({ name: "TelemetryExportError", code: "otlp_permanent_rejection", status: 400 });
        expect(String((stopErr as Error)?.message)).not.toContain("PERMANENT_BAD_REQUEST_SECRET");
        expect(JSON.parse(readFileSync(ckpt, "utf8")).pending).not.toBeNull();
        const attemptsAfterStop = otlp.getAttempts();
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            limit: 2,
            onPermanentError: "stop",
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_permanent_rejection", status: 400 });
        expect(otlp.getAttempts()).toBe(attemptsAfterStop);
        const dropped = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            limit: 2,
            onPermanentError: "drop",
            onDiagnostic: (d: Record<string, unknown>) => diagnostics.push(d),
        });
        expect(dropped).toMatchObject({
            outcome: "dropped_permanent_rejection",
            droppedRecords: 1,
            status: 400,
        });
        expect(otlp.getAttempts()).toBe(attemptsAfterStop);
        expect(JSON.parse(readFileSync(ckpt, "utf8")).pending).toBeNull();
        expect(JSON.stringify(diagnostics)).not.toContain("PERMANENT_BAD_REQUEST_SECRET");
        for (const nonRetryable5xx of [500, 501]) {
            transitions(db, 1);
            const rx5xx = await startOtlpReceiver([
                { status: nonRetryable5xx, body: `RAW_SERVER_ERROR_SECRET_${nonRetryable5xx}` },
                { status: 200, body: {} },
            ]);
            const ckpt5xx = join(dir, `outcomes-${nonRetryable5xx}.json`);
            const diags5xx: Array<Record<string, unknown>> = [];
            let firstErr: unknown;
            try {
                await exportQueueTransitionsOnce({
                    sourceUrl: src.baseUrl,
                    endpointUrl: rx5xx.endpointUrl,
                    checkpointPath: ckpt5xx,
                    namespace: "source-test",
                    start: "retained",
                    limit: 1,
                    maxRetries: 2,
                    onPermanentError: "stop",
                    onDiagnostic: (d: Record<string, unknown>) => diags5xx.push(d),
                });
            }
            catch (err) {
                firstErr = err;
            }
            expect(firstErr).toMatchObject({ name: "TelemetryExportError", code: "otlp_permanent_rejection", status: nonRetryable5xx });
            expect(String((firstErr as Error)?.message)).not.toContain(`RAW_SERVER_ERROR_SECRET_${nonRetryable5xx}`);
            expect(rx5xx.getAttempts()).toBe(1);
            expect(JSON.parse(readFileSync(ckpt5xx, "utf8")).pending?.blocked).toEqual({
                code: "otlp_permanent_rejection",
                status: nonRetryable5xx,
            });
            await expect(exportQueueTransitionsOnce({
                sourceUrl: src.baseUrl,
                endpointUrl: rx5xx.endpointUrl,
                checkpointPath: ckpt5xx,
                namespace: "source-test",
                start: "retained",
                limit: 1,
                onPermanentError: "stop",
            })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_permanent_rejection", status: nonRetryable5xx });
            expect(rx5xx.getAttempts()).toBe(1);
            const dropped5xx = await exportQueueTransitionsOnce({
                sourceUrl: src.baseUrl,
                endpointUrl: rx5xx.endpointUrl,
                checkpointPath: ckpt5xx,
                namespace: "source-test",
                start: "retained",
                limit: 1,
                onPermanentError: "drop",
                onDiagnostic: (d: Record<string, unknown>) => diags5xx.push(d),
            });
            expect(dropped5xx).toMatchObject({
                outcome: "dropped_permanent_rejection",
                droppedRecords: 1,
                status: nonRetryable5xx,
            });
            expect(rx5xx.getAttempts()).toBe(1);
            expect(JSON.parse(readFileSync(ckpt5xx, "utf8")).pending).toBeNull();
            expect(JSON.stringify(diags5xx)).not.toContain(`RAW_SERVER_ERROR_SECRET_${nonRetryable5xx}`);
        }
    });
    it("exports and checkpoints a maximum 128-row + 33-gap (161-record) batch compactly below byte bounds", async () => {
        const db = fixture();
        const insert = db.prepare(`INSERT INTO queue_transitions
      (qitem_id, ts, state, transition_note, actor_session, closure_reason, closure_target, identity_provenance)
      VALUES (?, ?, 'done', 'note', ?, 'handed_off_to', 'target', 'transport:v1')`);
        const maxQitem = "q-" + "a".repeat(250);
        const oversizedActor = "a".repeat(520);
        db.transaction(() => {
            for (let i = 0; i < 128; i++) {
                insert.run(maxQitem, time, i < 40 ? oversizedActor : "seat@rig");
            }
        })();
        const src = await startSourceServer(db);
        const otlp = await startOtlpReceiver([{ dropSocket: true }, { status: 200, body: {} }]);
        const ckpt = join(tempDir(), "max-batch-ckpt.json");
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            includeQitemId: true,
            maxRetries: 0,
        })).rejects.toThrow(TelemetryExportError);
        const rawCkpt = readFileSync(ckpt, "utf8");
        expect(Buffer.byteLength(rawCkpt)).toBeLessThanOrEqual(TELEMETRY_OTLP_LIMITS.checkpointBytes);
        expect(rawCkpt.trim().split("\n")).toHaveLength(1);
        const parsedCkpt = JSON.parse(rawCkpt);
        expect(parsedCkpt.pending.recordCount).toBe(161);
        expect(parsedCkpt.pending.payload.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(161);
        const res = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: ckpt,
            namespace: "source-test",
            start: "retained",
            includeQitemId: true,
        });
        expect(res).toMatchObject({ outcome: "exported", exportedRecords: 161, replayedPending: true });
    });
    it("rejects source errors, non-JSON content-types, non-200 OTLP responses, oversized responses without auto-retry, and supports CLI --help and --once", async () => {
        const db = fixture();
        transitions(db, 2);
        const src = await startSourceServer(db);
        const otlp = await startOtlpReceiver();
        const dir = tempDir();
        expect(() => parseExporterArgs(["--source", "http://user:pass@127.0.0.1:7433", "--endpoint", otlp.endpointUrl, "--checkpoint", join(dir, "c.json"), "--namespace", "ns"])).toThrow();
        expect(() => parseExporterArgs(["--source", src.baseUrl, "--endpoint", `${otlp.baseUrl}/v1/traces`, "--checkpoint", join(dir, "c.json"), "--namespace", "ns"])).toThrow();
        expect(parseExporterArgs(["--help"])).toMatchObject({ help: true });
        const helpRun = await execFileAsync(process.execPath, [exporterScriptPath, "--help"], { encoding: "utf8" });
        expect(helpRun.stdout).toContain("7433");
        expect(helpRun.stdout).toContain("example-source");
        const cliCkpt = join(dir, "cli-ckpt.json");
        const latestCkpt = join(dir, "latest-ckpt.json");
        const latestInit = await exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: latestCkpt,
            namespace: "example-source",
        });
        expect(latestInit).toMatchObject({ outcome: "exported", exportedRecords: 1, hasMore: false });
        expect(otlp.received[0]!.records[0]!.attributes).toMatchObject({
            "openrig.gap.code": "historical_transitions_not_read",
            "openrig.gap.through": "2",
        });
        const run1 = await execFileAsync(process.execPath, [
            exporterScriptPath,
            "--source", src.baseUrl,
            "--endpoint", otlp.endpointUrl,
            "--checkpoint", cliCkpt,
            "--namespace", "example-source",
            "--start", "retained",
            "--once",
        ], { encoding: "utf8" });
        expect(run1.stderr).toBe("");
        expect(otlp.received).toHaveLength(2);
        expect(otlp.received[1]!.records.map(r => r.attributes["openrig.transition.id"])).toEqual(["1", "2"]);
        transitions(db, 1);
        const code = await runExporterCli([
            "--source", src.baseUrl,
            "--endpoint", otlp.endpointUrl,
            "--checkpoint", cliCkpt,
            "--namespace", "example-source",
            "--start", "retained",
            "--once",
        ]);
        expect(code).toBe(0);
        expect(otlp.received).toHaveLength(3);
        expect(otlp.received[2]!.records.map(r => r.attributes["openrig.transition.id"])).toEqual(["3"]);
        const proxyMimeOtlp = await startOtlpReceiver([
            { status: 200, headers: { "content-type": "text/html" }, body: "{}" },
            { status: 200, body: {} },
        ]);
        const proxyMimeCkpt = join(dir, "proxy-mime-otlp.json");
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: proxyMimeOtlp.endpointUrl,
            checkpointPath: proxyMimeCkpt,
            namespace: "example-source",
            start: "retained",
            maxRetries: 2,
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_invalid_content_type", status: 200 });
        expect(proxyMimeOtlp.getAttempts()).toBe(1);
        const savedMimeCkpt = JSON.parse(readFileSync(proxyMimeCkpt, "utf8"));
        expect(savedMimeCkpt.cursor).toBeNull();
        expect(savedMimeCkpt.pending?.blocked).toEqual({ code: "otlp_invalid_content_type", status: 200 });
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: proxyMimeOtlp.endpointUrl,
            checkpointPath: proxyMimeCkpt,
            namespace: "example-source",
            start: "retained",
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_invalid_content_type", status: 200 });
        expect(proxyMimeOtlp.getAttempts()).toBe(1);
        const proxyStatusOtlp = await startOtlpReceiver([
            { status: 202, headers: { "content-type": "application/json" }, body: "{}" },
            { status: 200, body: {} },
        ]);
        const proxyStatusCkpt = join(dir, "proxy-status-otlp.json");
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: proxyStatusOtlp.endpointUrl,
            checkpointPath: proxyStatusCkpt,
            namespace: "example-source",
            start: "retained",
            maxRetries: 2,
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_unexpected_status", status: 202 });
        expect(proxyStatusOtlp.getAttempts()).toBe(1);
        const savedStatusCkpt = JSON.parse(readFileSync(proxyStatusCkpt, "utf8"));
        expect(savedStatusCkpt.cursor).toBeNull();
        expect(savedStatusCkpt.pending?.blocked).toEqual({ code: "otlp_unexpected_status", status: 202 });
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: proxyStatusOtlp.endpointUrl,
            checkpointPath: proxyStatusCkpt,
            namespace: "example-source",
            start: "retained",
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_unexpected_status", status: 202 });
        expect(proxyStatusOtlp.getAttempts()).toBe(1);
        let oversizedOtlpCalls = 0;
        const oversizedOtlpUrl = await listen((_req, res) => {
            oversizedOtlpCalls++;
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end("x".repeat(TELEMETRY_OTLP_LIMITS.otlpResponseBytes + 1024));
        });
        const oversizedOtlpCkpt = join(dir, "oversized-otlp.json");
        const oversizedDiags: Array<Record<string, unknown>> = [];
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: `${oversizedOtlpUrl}/v1/logs`,
            checkpointPath: oversizedOtlpCkpt,
            namespace: "example-source",
            start: "retained",
            maxRetries: 2,
            onDiagnostic: (d: Record<string, unknown>) => oversizedDiags.push(d),
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_response_too_large" });
        expect(oversizedOtlpCalls).toBe(1);
        expect(oversizedDiags).toContainEqual(expect.objectContaining({ type: "otlp_response_too_large" }));
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: `${oversizedOtlpUrl}/v1/logs`,
            checkpointPath: oversizedOtlpCkpt,
            namespace: "example-source",
            start: "retained",
        })).rejects.toMatchObject({ name: "TelemetryExportError", code: "otlp_response_too_large" });
        expect(oversizedOtlpCalls).toBe(1);
        const htmlSourceUrl = await listen((_req, res) => {
            res.statusCode = 200;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end("{}");
        });
        await expect(exportQueueTransitionsOnce({
            sourceUrl: htmlSourceUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: join(dir, "html-src.json"),
            namespace: "example-source",
        })).rejects.toMatchObject({ name: "TelemetrySourceError", code: "source_invalid_content_type" });
        const oversizedSourceUrl = await listen((_req, res) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end("x".repeat(TELEMETRY_OTLP_LIMITS.sourceResponseBytes + 1024));
        });
        await expect(exportQueueTransitionsOnce({
            sourceUrl: oversizedSourceUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: join(dir, "oversized-src.json"),
            namespace: "example-source",
        })).rejects.toMatchObject({ name: "TelemetrySourceError", code: "source_response_too_large" });
        db.exec("DROP TABLE queue_transitions");
        await expect(exportQueueTransitionsOnce({
            sourceUrl: src.baseUrl,
            endpointUrl: otlp.endpointUrl,
            checkpointPath: cliCkpt,
            namespace: "example-source",
            start: "retained",
        })).rejects.toMatchObject({ name: "TelemetrySourceError", status: 503 });
    });
});
