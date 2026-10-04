import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
export type TelemetryStream = "events" | "queue-transitions" | "tenures";
export interface TelemetrySource {
    hostId: string | null;
    bootEpoch: string | null;
}
export interface TelemetryRead {
    cursor?: string;
    start?: string;
    limit?: string;
    nodeId?: string;
    rigId?: string;
    qitemId?: string;
}
export const TELEMETRY_LIMITS = { rows: 128, responseBytes: 128 * 1024, recordBytes: 4096, cursorBytes: 2048 } as const;
type Row = Record<string, string | null> & {
    _id: string;
};
type Cursor = {
    v: 1;
    stream: TelemetryStream;
    boot: string;
    filter: string;
    last: string;
    through: string | null;
};
type Gap = {
    code: string;
    id?: string;
    field?: string;
    from?: string;
    through?: string;
};
const MAX_ID = 9223372036854775807n;
export class TelemetryInputError extends Error {
}
// Column names and caps are source-owned, never request SQL. The CASE prevents
// oversized legacy metadata from being materialized, not just from being sent.
function field(column: string, alias: string, cap = 256): string {
    return `CASE WHEN typeof(${column}) = 'text' AND octet_length(${column}) <= ${cap} THEN ${column} END AS ${alias},
    CASE WHEN ${column} IS NULL THEN NULL WHEN typeof(${column}) != 'text' THEN 'invalid_type'
      WHEN octet_length(${column}) > ${cap} THEN 'oversized_field' END AS _gap_${alias}`;
}
const eventFields = [field("rig_id", "rigId"), field("node_id", "nodeId"), field("type", "type", 128), field("created_at", "originalTimestamp", 128)].join(",");
const transitionFields = [field("qitem_id", "qitemId"), field("ts", "originalTimestamp", 128), field("state", "state", 128),
    field("actor_session", "actorSession", 512), field("identity_provenance", "identityProvenance", 128),
    field("closure_reason", "closureReason", 128), field("closure_target", "closureTarget", 512)].join(",");
const tenureFields = [field("node_id", "nodeId"), field("generation_uuid", "generationUuid"), field("kind", "kind", 128),
    field("native_session_id_at_boot", "nativeSessionIdAtBoot"), field("boot_at", "originalTimestamp", 128)].join(",");
// Export the exact statements for query-plan controls. No payload, note, body,
// current-owner join, or history window function enters this projection.
export const TELEMETRY_PAGE_SQL = {
    events: `SELECT CAST(seq AS TEXT) AS _id, ${eventFields} FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
    active: `SELECT CAST(transition_id AS TEXT) AS _id, ${transitionFields} FROM queue_transitions WHERE transition_id > ? AND transition_id <= ? ORDER BY transition_id LIMIT ?`,
    archive: `SELECT CAST(transition_id AS TEXT) AS _id, ${transitionFields} FROM queue_transitions_archive WHERE transition_id > ? AND transition_id <= ? ORDER BY transition_id LIMIT ?`,
    tenures: `SELECT CAST(generation_ordinal AS TEXT) AS _id, ${tenureFields} FROM occupant_tenures WHERE node_id = ? AND generation_ordinal < ? AND generation_ordinal <= ? ORDER BY generation_ordinal DESC LIMIT ?`,
};
function id(value: unknown): value is string {
    return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= MAX_ID;
}
function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function decode(raw: string): Cursor {
    if (Buffer.byteLength(raw) > TELEMETRY_LIMITS.cursorBytes || !/^[A-Za-z0-9_-]+$/.test(raw))
        throw new TelemetryInputError("Invalid telemetry cursor");
    let value: Partial<Cursor>;
    try {
        value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    }
    catch {
        throw new TelemetryInputError("Invalid telemetry cursor");
    }
    if (!value || value.v !== 1 || !["events", "queue-transitions", "tenures"].includes(value.stream ?? "") ||
        typeof value.boot !== "string" || value.boot.length > 128 || typeof value.filter !== "string" || value.filter.length !== 64 ||
        !id(value.last) || !(value.through === null || id(value.through)))
        throw new TelemetryInputError("Invalid telemetry cursor");
    return value as Cursor;
}
function boundedFilter(value: string | undefined): string | null {
    if (value === undefined)
        return null;
    if (!value || Buffer.byteLength(value) > 256)
        throw new TelemetryInputError("Telemetry filter must contain 1 to 256 bytes");
    return value;
}
function utc(value: string | null): string | null {
    if (!value)
        return null;
    const explicit = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? value.replace(" ", "T") + "Z" : value;
    if (!/(Z|[+-]\d\d:\d\d)$/.test(explicit))
        return null;
    const time = Date.parse(explicit);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function bounds(db: Database.Database, table: string, key: string, nodeId?: string): {
    low: string | null;
    high: string;
} {
    const where = nodeId === undefined ? "" : "WHERE node_id = ?";
    const args = nodeId === undefined ? [] : [nodeId, nodeId];
    // Separate indexed min/max seeks: a combined MIN/MAX aggregate can scan all rows.
    return db.prepare(`SELECT
    (SELECT CAST(${key} AS TEXT) FROM ${table} ${where} ORDER BY ${key} LIMIT 1) AS low,
    COALESCE((SELECT CAST(${key} AS TEXT) FROM ${table} ${where} ORDER BY ${key} DESC LIMIT 1), '0') AS high`).get(...args) as {
        low: string | null;
        high: string;
    };
}
/** One read snapshot and a finite source prefix. No writes, subscription or catch-up loop. */
export function readTelemetryPage(db: Database.Database, source: TelemetrySource, stream: TelemetryStream, input: TelemetryRead, observedAt = new Date().toISOString()) {
    const nodeId = boundedFilter(input.nodeId), rigId = boundedFilter(input.rigId), qitemId = boundedFilter(input.qitemId);
    if (stream === "tenures" ? (!nodeId || rigId || qitemId) : stream === "events" ? qitemId : (nodeId || rigId))
        throw new TelemetryInputError("Unsupported filter for telemetry stream");
    if (input.cursor !== undefined && input.start !== undefined)
        throw new TelemetryInputError("Use cursor or start, not both");
    if (input.start !== undefined && !["latest", "retained"].includes(input.start))
        throw new TelemetryInputError("start must be latest or retained");
    if (stream === "tenures" && input.start !== undefined)
        throw new TelemetryInputError("Tenures start newest first; use a cursor to continue");
    const limit = input.limit === undefined ? (stream === "tenures" ? 32 : 128) : Number(input.limit);
    if ((input.limit !== undefined && !/^[0-9]+$/.test(input.limit)) || !Number.isInteger(limit) || limit < 1 || limit > TELEMETRY_LIMITS.rows)
        throw new TelemetryInputError("limit must be an integer from 1 to 128");
    const filter = createHash("sha256").update(JSON.stringify([nodeId, rigId, qitemId])).digest("hex");
    const previous = input.cursor === undefined ? null : decode(input.cursor);
    if (previous && (previous.stream !== stream || previous.filter !== filter))
        throw new TelemetryInputError("Cursor stream or filters do not match");
    if (previous?.through !== null && previous?.through !== undefined && stream !== "tenures" && BigInt(previous.last) > BigInt(previous.through))
        throw new TelemetryInputError("Cursor is past its window");
    if (previous && stream === "tenures" && (previous.last === "0" || previous.through === null || BigInt(previous.last) > BigInt(previous.through)))
        throw new TelemetryInputError("Invalid tenure cursor window");
    if (!source.bootEpoch || Buffer.byteLength(source.bootEpoch) > 128)
        throw new Error("telemetry_source_unavailable");
    const boot = source.bootEpoch;
    return db.transaction(() => {
        const ranges = stream === "events" ? [bounds(db, "events", "seq")] : stream === "tenures" ? [bounds(db, "occupant_tenures", "generation_ordinal", nodeId!)] :
            [bounds(db, "queue_transitions", "transition_id"), bounds(db, "queue_transitions_archive", "transition_id")];
        const high = ranges.reduce((a, b) => BigInt(a) > BigInt(b.high) ? a : b.high, "0");
        const lows = ranges.flatMap(r => r.low === null ? [] : [r.low]);
        const low = lows.reduce<string | null>((a, b) => a === null || BigInt(b) < BigInt(a) ? b : a, null);
        if (!id(high) || (low !== null && (!id(low) || low === "0")))
            throw new Error("telemetry_source_id_unavailable");
        const gaps: Gap[] = [];
        let gapCount = 0;
        const gap = (entry: Gap) => { gapCount++; if (gaps.length < 32)
            gaps.push(entry); };
        const startLatest = stream !== "tenures" && !previous && input.start !== "retained";
        let last = previous?.last ?? (startLatest ? high : "0");
        const requestedAfter = stream === "tenures" ? null : last;
        const through = previous?.through ?? high;
        const rows: Array<Record<string, string | null>> = [];
        let fetched = 0, scanned = 0, filtered = 0, withheld = 0, rowBytes = 0;
        let capReason: string | null = null;
        const cursor = (lastId: string, end: string | null) => encode({ v: 1, stream, boot, filter, last: lastId, through: end });
        const reset = previous && (previous.boot !== boot || BigInt(previous.last) > BigInt(high) || (previous.through !== null && BigInt(previous.through) > BigInt(high)));
        if (reset)
            gap({ code: previous.boot !== boot ? "boot_boundary_history_unverified" : "watermark_regression_history_unverified" });
        if (startLatest)
            gap({ code: `historical_${stream === "events" ? "events" : "transitions"}_not_read`, through: high });
        if (stream === "tenures" && low === null)
            gap({ code: "tenure_history_unavailable" });
        if (!reset && !startLatest && stream !== "tenures" && low && BigInt(last) + 1n < BigInt(low)) {
            const missingThrough = BigInt(low) - 1n < BigInt(through) ? (BigInt(low) - 1n).toString() : through;
            gap({ code: "before_retained_floor", from: (BigInt(last) + 1n).toString(), through: missingThrough });
            last = missingThrough;
        }
        if (!reset && !startLatest) {
            const args = [BigInt(last), BigInt(through), limit] as const;
            let candidates: Row[];
            if (stream === "events")
                candidates = db.prepare(TELEMETRY_PAGE_SQL.events).all(...args) as Row[];
            else if (stream === "tenures") {
                // An inclusive first page avoids max-int + 1 overflowing the SQLite binding.
                const query = previous ? TELEMETRY_PAGE_SQL.tenures : TELEMETRY_PAGE_SQL.tenures.replace("generation_ordinal < ? AND ", "");
                candidates = db.prepare(query).all(...(previous ? [nodeId, BigInt(last), BigInt(through), limit] : [nodeId, BigInt(through), limit])) as Row[];
            }
            else {
                candidates = [...db.prepare(TELEMETRY_PAGE_SQL.active).all(...args), ...db.prepare(TELEMETRY_PAGE_SQL.archive).all(...args)] as Row[];
                candidates.sort((a, b) => BigInt(a._id) < BigInt(b._id) ? -1 : BigInt(a._id) > BigInt(b._id) ? 1 : 0);
            }
            fetched = candidates.length;
            for (let i = 0; i < candidates.length && scanned < limit; i++) {
                const raw = candidates[i]!;
                let conflict = false;
                while (candidates[i + 1]?._id === raw._id) {
                    if (JSON.stringify(candidates[++i]) !== JSON.stringify(raw))
                        conflict = true;
                }
                const matches = (!nodeId || raw.nodeId === nodeId) && (!rigId || raw.rigId === rigId) && (!qitemId || raw.qitemId === qitemId);
                const record: Record<string, string | null> = { [stream === "events" ? "seq" : stream === "tenures" ? "generationOrdinal" : "transitionId"]: raw._id };
                for (const [key, value] of Object.entries(raw))
                    if (!key.startsWith("_"))
                        record[key] = value;
                record[stream === "tenures" ? "bootAt" : "createdAt"] = utc(raw.originalTimestamp ?? null);
                const size = Buffer.byteLength(JSON.stringify(record));
                // Reserve 16 KiB for the bounded envelope/cursors/gap details.
                if (matches && !conflict && size <= TELEMETRY_LIMITS.recordBytes && rowBytes + size + 1 > TELEMETRY_LIMITS.responseBytes - 16 * 1024) {
                    capReason = "response_byte_limit";
                    break;
                }
                if (stream !== "tenures" && BigInt(raw._id) > BigInt(last) + 1n)
                    gap({ code: "retained_sequence_gap", from: (BigInt(last) + 1n).toString(), through: (BigInt(raw._id) - 1n).toString() });
                if (stream === "tenures" && (previous || scanned > 0) && BigInt(raw._id) + 1n < BigInt(last))
                    gap({ code: "retained_ordinal_gap", from: (BigInt(raw._id) + 1n).toString(), through: (BigInt(last) - 1n).toString() });
                last = raw._id;
                scanned++;
                if (conflict) {
                    gap({ code: "conflicting_transition_id", id: raw._id });
                    withheld++;
                    continue;
                }
                for (const [key, value] of Object.entries(raw))
                    if (key.startsWith("_gap_") && value)
                        gap({ code: value, id: raw._id, field: key.slice(5) });
                if (raw.originalTimestamp !== null && !record[stream === "tenures" ? "bootAt" : "createdAt"])
                    gap({ code: "invalid_timestamp", id: raw._id });
                if (!matches) {
                    filtered++;
                    continue;
                }
                if (size > TELEMETRY_LIMITS.recordBytes) {
                    gap({ code: "record_byte_limit", id: raw._id });
                    withheld++;
                    continue;
                }
                rows.push(record);
                rowBytes += size + 1;
            }
            // A vanished tail inside an old window must not create an endless empty page.
            if (stream !== "tenures" && scanned < limit && !capReason && BigInt(last) < BigInt(through)) {
                gap({ code: "retained_sequence_gap", from: (BigInt(last) + 1n).toString(), through });
                last = through;
            }
            if (stream === "tenures" && previous && scanned === 0)
                gap({ code: "requested_tenure_window_unavailable" });
        }
        let hasMore = false;
        if (!reset && !startLatest) {
            hasMore = stream === "tenures" ? low !== null && BigInt(last) > BigInt(low) : BigInt(last) < BigInt(through);
            if (hasMore && !capReason)
                capReason = "source_row_limit";
        }
        const page = {
            requestedAfter, requestedBefore: stream === "tenures" ? previous?.last ?? null : null,
            lastScanned: last, through, retainedHighWatermark: high, hasMore,
            nextCursor: reset ? null : stream === "tenures" ? (hasMore ? cursor(last, through) : null) : cursor(last, hasMore ? through : null),
            restartCursor: reset ? (stream === "tenures" ? null : cursor(high, null)) : null,
            fetched, scanned, filtered, withheld, returned: rows.length, capReason,
        };
        const result = {
            schemaVersion: 1, stream, observedAt,
            source: { hostId: source.hostId && Buffer.byteLength(source.hostId) <= 256 ? source.hostId : null, bootEpoch: boot, sequenceSpaceId: null },
            rows, page,
            coverage: { status: reset ? "unavailable" : gapCount ? "partial" : "retained_window", historyCompleteness: "unknown", retainedMinimum: low,
                gaps, gapCount, gapDetailsTruncated: gapCount > gaps.length, eventPayloads: "not_read" },
        };
        if (Buffer.byteLength(JSON.stringify(result)) > TELEMETRY_LIMITS.responseBytes)
            throw new Error("telemetry_response_bound_exceeded");
        return result;
    })();
}
