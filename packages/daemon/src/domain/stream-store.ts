import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import type { EventBus } from "./event-bus.js";

const ulid = monotonicFactory();

export interface StreamItem {
  streamItemId: string;
  tsEmitted: string;
  streamSortKey: string;
  sourceSession: string;
  body: string;
  format: string;
  hintType: string | null;
  hintUrgency: string | null;
  hintDestination: string | null;
  hintTags: string[] | null;
  interrupt: boolean;
  archivedAt: string | null;
}

export interface StreamEmitInput {
  streamItemId?: string;
  sourceSession: string;
  body: string;
  format?: string;
  hintType?: string | null;
  hintUrgency?: string | null;
  hintDestination?: string | null;
  hintTags?: string[] | null;
  interrupt?: boolean;
}

export interface StreamListOptions {
  limit?: number;
  afterSortKey?: string;
  sourceSession?: string;
  hintDestination?: string;
  includeArchived?: boolean;
}

interface StreamItemRow {
  stream_item_id: string;
  ts_emitted: string;
  stream_sort_key: string;
  source_session: string;
  body: string;
  format: string;
  hint_type: string | null;
  hint_urgency: string | null;
  hint_destination: string | null;
  hint_tags: string | null;
  interrupt: number;
  archived_at: string | null;
}

/**
 * L1 — Stream store. Append-only intake/audit root.
 * Items are immutable after emit (only `archived_at` may be set).
 */
export class StreamStore {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;

  constructor(db: Database.Database, eventBus: EventBus) {
    this.db = db;
    this.eventBus = eventBus;
  }

  /**
   * Idempotent emit: same `streamItemId` returns the existing row.
   */
  emit(input: StreamEmitInput): StreamItem {
    const tsEmitted = new Date().toISOString();
    const id = input.streamItemId ?? ulid();

    const existing = this.getByIdRaw(id);
    if (existing) return this.rowToItem(existing);

    const sortKey = ulid();
    const interrupt = input.interrupt ? 1 : 0;
    const tagsJson = input.hintTags ? JSON.stringify(input.hintTags) : null;

    const persistTxn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO stream_items (
            stream_item_id, ts_emitted, stream_sort_key, source_session, body,
            format, hint_type, hint_urgency, hint_destination, hint_tags, interrupt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          tsEmitted,
          sortKey,
          input.sourceSession,
          input.body,
          input.format ?? "text",
          input.hintType ?? null,
          input.hintUrgency ?? null,
          input.hintDestination ?? null,
          tagsJson,
          interrupt
        );

      return this.eventBus.persistWithinTransaction({
        type: "stream.emitted",
        streamItemId: id,
        sourceSession: input.sourceSession,
        hintDestination: input.hintDestination ?? null,
        hintType: input.hintType ?? null,
        hintUrgency: input.hintUrgency ?? null,
        interrupt: Boolean(input.interrupt),
      });
    });

    const persistedEvent = persistTxn();
    this.eventBus.notifySubscribers(persistedEvent);

    return this.rowToItem(this.getByIdRaw(id)!);
  }

  getById(streamItemId: string): StreamItem | null {
    const row = this.getByIdRaw(streamItemId);
    return row ? this.rowToItem(row) : null;
  }

  list(opts?: StreamListOptions): StreamItem[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!opts?.includeArchived) {
      conditions.push("archived_at IS NULL");
    }
    if (opts?.afterSortKey) {
      conditions.push("(ts_emitted, stream_sort_key) > (SELECT ts_emitted, stream_sort_key FROM stream_items WHERE stream_sort_key = ?)");
      params.push(opts.afterSortKey);
    }
    if (opts?.sourceSession) {
      conditions.push("source_session = ?");
      params.push(opts.sourceSession);
    }
    if (opts?.hintDestination) {
      conditions.push("hint_destination = ?");
      params.push(opts.hintDestination);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM stream_items ${where} ORDER BY ts_emitted ASC, stream_sort_key ASC LIMIT ?`
      )
      .all(...params) as StreamItemRow[];

    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * Soft-archive — sets `archived_at`. Items remain in the table for audit.
   */
  archive(streamItemId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE stream_items SET archived_at = datetime('now') WHERE stream_item_id = ? AND archived_at IS NULL"
      )
      .run(streamItemId);
    return result.changes > 0;
  }

  private getByIdRaw(streamItemId: string): StreamItemRow | undefined {
    return this.db
      .prepare("SELECT * FROM stream_items WHERE stream_item_id = ?")
      .get(streamItemId) as StreamItemRow | undefined;
  }

  private rowToItem(row: StreamItemRow): StreamItem {
    return {
      streamItemId: row.stream_item_id,
      tsEmitted: row.ts_emitted,
      streamSortKey: row.stream_sort_key,
      sourceSession: row.source_session,
      body: row.body,
      format: row.format,
      hintType: row.hint_type,
      hintUrgency: row.hint_urgency,
      hintDestination: row.hint_destination,
      hintTags: row.hint_tags ? (JSON.parse(row.hint_tags) as string[]) : null,
      interrupt: row.interrupt === 1,
      archivedAt: row.archived_at,
    };
  }
}
