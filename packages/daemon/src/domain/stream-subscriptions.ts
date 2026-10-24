import type Database from "better-sqlite3";

/**
 * Slice 22 outcome 9: hub readers. A reader seat subscribes with a filter over the existing hint fields
 * (topic = `hint_tags`, optionally `hint_type`); items addressed to it (`hint_destination`) always match.
 * Naming the reader is enough: with no tags or type, the filter is the reader's own ids (session, seat name,
 * logical id). Reading returns a bounded page of excerpts after the reader's cursor and advances the cursor
 * past the items returned. The cursor is read progress, never a disposition. Delivery (urgent and digest
 * wakes) is not here: it extends #1856's intake item when that lands, and reading also works on a reader's
 * ordinary wake.
 */

export const READ_PAGE_ITEMS = 20;
export const READ_EXCERPT_CHARS = 2000;
export const READ_PAGE_BYTES = 64 * 1024;

type Position = { ts: string; key: string };
type SubscriptionRow = { reader_session: string; hint_tags: string | null; hint_type: string | null; read_through_ts: string;
  read_through_key: string; created_by: string; created_at: string; updated_at: string };
type ItemRow = { stream_item_id: string; ts_emitted: string; stream_sort_key: string; source_session: string; body: string;
  hint_type: string | null; hint_urgency: string | null; hint_destination: string | null; hint_tags: string | null; interrupt: number };

export interface StreamSubscription {
  readerSession: string;
  hintTags: string[];
  hintType: string | null;
  readThrough: Position;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const toSubscription = (r: SubscriptionRow): StreamSubscription => ({ readerSession: r.reader_session,
  hintTags: r.hint_tags ? JSON.parse(r.hint_tags) as string[] : [], hintType: r.hint_type,
  readThrough: { ts: r.read_through_ts, key: r.read_through_key }, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });
const before = (a: Position, b: Position) => a.ts < b.ts || (a.ts === b.ts && a.key < b.key);

/** The ids a reader is known by: its session, its seat name and, when this daemon has its node, its logical id. */
function readerIds(db: Database.Database, reader: string): string[] {
  let logical: string | undefined;
  try {
    logical = (db.prepare(`SELECT n.logical_id AS id FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE s.session_name = ? ORDER BY s.created_at DESC LIMIT 1`).get(reader) as { id?: string } | undefined)?.id;
  } catch { /* a database without topology tables still has the session and seat name */ }
  return [...new Set([reader, reader.split("@")[0], logical].filter((x): x is string => !!x))];
}

export function getSubscription(db: Database.Database, reader: string): StreamSubscription | null {
  const row = db.prepare("SELECT * FROM stream_subscriptions WHERE reader_session = ?").get(reader) as SubscriptionRow | undefined;
  return row ? toSubscription(row) : null;
}

export function listSubscriptions(db: Database.Database): Array<StreamSubscription & { unread: { items: number; bytes: number } }> {
  return (db.prepare("SELECT * FROM stream_subscriptions ORDER BY reader_session").all() as SubscriptionRow[])
    .map(toSubscription).map(s => ({ ...s, unread: unread(db, s, s.readThrough) }));
}

/** Creates or updates a reader's subscription. A new one reads from now on; an update keeps the reader's cursor. */
export function subscribe(db: Database.Database, input: { readerSession: string; hintTags?: string[] | null; hintType?: string | null; actor: string },
  nowIso = new Date().toISOString()): StreamSubscription {
  const tags = input.hintTags?.length ? [...new Set(input.hintTags)] : input.hintType ? [] : readerIds(db, input.readerSession);
  db.prepare(`INSERT INTO stream_subscriptions (reader_session, hint_tags, hint_type, read_through_ts, read_through_key, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, ?, ?)
    ON CONFLICT(reader_session) DO UPDATE SET hint_tags = excluded.hint_tags, hint_type = excluded.hint_type, updated_at = excluded.updated_at`)
    .run(input.readerSession, JSON.stringify(tags), input.hintType ?? null, nowIso, input.actor, nowIso, nowIso);
  return getSubscription(db, input.readerSession)!;
}

export function unsubscribe(db: Database.Database, reader: string): boolean {
  return db.prepare("DELETE FROM stream_subscriptions WHERE reader_session = ?").run(reader).changes > 0;
}

/** The subscription's match over unarchived items after a position. */
function matching(s: StreamSubscription, after: Position): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const partParams: unknown[] = [];
  if (s.hintTags.length) {
    parts.push(`EXISTS (SELECT 1 FROM json_each(stream_items.hint_tags) WHERE json_each.value IN (${s.hintTags.map(() => "?").join(", ")}))`);
    partParams.push(...s.hintTags);
  }
  if (s.hintType) { parts.push("hint_type = ?"); partParams.push(s.hintType); }
  return { where: `archived_at IS NULL AND (ts_emitted, stream_sort_key) > (?, ?) AND (hint_destination = ? OR (${parts.join(" AND ") || "0"}))`,
    params: [after.ts, after.key, s.readerSession, ...partParams] };
}

function unread(db: Database.Database, s: StreamSubscription, after: Position): { items: number; bytes: number } {
  const m = matching(s, after);
  const r = db.prepare(`SELECT COUNT(*) AS items, COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS bytes FROM stream_items WHERE ${m.where}`)
    .get(...m.params) as { items: number; bytes: number };
  return { items: r.items, bytes: r.bytes };
}

function retentionMark(db: Database.Database): (Position & { prunedItems: number }) | null {
  const r = db.prepare("SELECT pruned_through_ts, pruned_through_key, pruned_items FROM stream_retention_marks WHERE id = 1").get() as
    { pruned_through_ts: string; pruned_through_key: string; pruned_items: number } | undefined;
  return r ? { ts: r.pruned_through_ts, key: r.pruned_through_key, prunedItems: r.pruned_items } : null;
}

function excerptOf(body: string): string {
  if (body.length <= READ_EXCERPT_CHARS) return body;
  const cut = body.slice(0, READ_EXCERPT_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * One bounded page for the reader: at most `limit` (≤ 20) items, excerpts of at most 2,000 characters, and at most
 * 64 KiB of excerpts (always at least one item). The cursor advances past the items returned and no further. When
 * retention has pruned beyond the reader's cursor, `gap` says so on every page until the cursor passes it.
 * Returns null when the reader has no subscription.
 */
export function readPage(db: Database.Database, reader: string, opts: { limit?: number; nowIso?: string } = {}) {
  const s = getSubscription(db, reader);
  if (!s) return null;
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? READ_PAGE_ITEMS)), READ_PAGE_ITEMS);
  const m = matching(s, s.readThrough);
  const rows = db.prepare(`SELECT stream_item_id, ts_emitted, stream_sort_key, source_session, body, hint_type, hint_urgency, hint_destination,
    hint_tags, interrupt FROM stream_items WHERE ${m.where} ORDER BY ts_emitted, stream_sort_key LIMIT ?`).all(...m.params, limit + 1) as ItemRow[];
  const page: ItemRow[] = [];
  let pageBytes = 0;
  for (const r of rows.slice(0, limit)) {
    const size = Buffer.byteLength(excerptOf(r.body));
    if (page.length && pageBytes + size > READ_PAGE_BYTES) break;
    page.push(r); pageBytes += size;
  }
  const mark = retentionMark(db);
  const gap = mark && before(s.readThrough, mark) ? { reason: "retention", from: s.readThrough.ts, through: mark.ts, prunedItemsTotal: mark.prunedItems,
    detail: "Items in this range that weren't classified, disposed or acted on were pruned before you read them; some may have matched your filter." } : undefined;
  const last = page.at(-1);
  // With nothing retained to read, the cursor moves to the pruned edge so the same gap isn't reported again.
  const next = last ? { ts: last.ts_emitted, key: last.stream_sort_key } : gap && mark ? { ts: mark.ts, key: mark.key } : s.readThrough;
  if (next !== s.readThrough) {
    db.prepare("UPDATE stream_subscriptions SET read_through_ts = ?, read_through_key = ?, updated_at = ? WHERE reader_session = ?")
      .run(next.ts, next.key, opts.nowIso ?? new Date().toISOString(), reader);
  }
  return {
    subscription: { readerSession: s.readerSession, hintTags: s.hintTags, hintType: s.hintType },
    items: page.map(r => {
      const excerpt = excerptOf(r.body);
      return { streamItemId: r.stream_item_id, tsEmitted: r.ts_emitted, sourceSession: r.source_session, hintType: r.hint_type,
        hintUrgency: r.hint_urgency, hintDestination: r.hint_destination, hintTags: r.hint_tags ? JSON.parse(r.hint_tags) as string[] : null,
        interrupt: r.interrupt === 1, bytes: Buffer.byteLength(r.body), excerpt, ...(excerpt.length < r.body.length ? { excerptTruncated: true } : {}) };
    }),
    readThrough: next,
    more: rows.length > page.length,
    unread: unread(db, s, next),
    ...(gap ? { gap } : {}),
  };
}
