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
/** Metadata in a page is clipped too, visibly, so the serialized page stays under READ_PAGE_BYTES. */
const FIELD_CHARS = 256;
const TAGS_BYTES = 2048;

type Position = { ts: string; key: string };
type SubscriptionRow = { reader_session: string; hint_tags: string | null; hint_type: string | null; read_through_ts: string;
  read_through_key: string; created_by: string; created_at: string; updated_at: string };
type ItemRow = { stream_item_id: string; ts_emitted: string; stream_sort_key: string; source_session: string; body: string;
  hint_type: string | null; hint_urgency: string | null; hint_destination: string | null; hint_tags: string | null; interrupt: number;
  body_kept_bytes: number | null; body_original_bytes: number | null };

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

const noLoneHigh = (s: string) => /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
function excerptOf(body: string): string {
  return body.length <= READ_EXCERPT_CHARS ? body : noLoneHigh(body.slice(0, READ_EXCERPT_CHARS));
}

/** Clips page metadata, noting in `cut` that something was clipped. Stored values are never changed. */
function clip(value: string | null, cut: { hit: boolean }): string | null {
  if (value === null || value.length <= FIELD_CHARS) return value;
  cut.hit = true;
  return `${noLoneHigh(value.slice(0, FIELD_CHARS))}…`;
}
function clipTags(tags: unknown[] | null, cut: { hit: boolean }): string[] | null {
  if (!tags) return null;
  const kept: string[] = [];
  let bytes = 0;
  for (const tag of tags) {
    const value = clip(typeof tag === "string" ? tag : JSON.stringify(tag), cut)!;
    const n = Buffer.byteLength(JSON.stringify(value)) + 1;
    if (bytes + n > TAGS_BYTES) { cut.hit = true; break; }
    kept.push(value); bytes += n;
  }
  return kept;
}

function pageItem(r: ItemRow) {
  const cut = { hit: false };
  const excerpt = excerptOf(r.body);
  const tags = r.hint_tags ? JSON.parse(r.hint_tags) as unknown : null;
  return { streamItemId: clip(r.stream_item_id, cut)!, streamSortKey: r.stream_sort_key, tsEmitted: r.ts_emitted, sourceSession: clip(r.source_session, cut)!,
    hintType: clip(r.hint_type, cut), hintUrgency: clip(r.hint_urgency, cut), hintDestination: clip(r.hint_destination, cut),
    hintTags: clipTags(Array.isArray(tags) ? tags : tags === null ? null : [tags], cut), interrupt: r.interrupt === 1, bytes: Buffer.byteLength(r.body), excerpt,
    ...(excerpt.length < r.body.length ? { excerptTruncated: true } : {}),
    ...(r.body_original_bytes != null ? { bodyTruncated: { keptBytes: r.body_kept_bytes ?? 0, originalBytes: r.body_original_bytes } } : {}),
    ...(cut.hit ? { metadataTruncated: true } : {}) };
}

/**
 * One bounded page for the reader: at most `limit` (≤ 20) items, excerpts of at most 2,000 characters, and at most
 * 64 KiB for the whole serialized page, metadata included (always at least one item; oversized metadata is clipped
 * and marked). A body stored truncated at the emit cap says so (`bodyTruncated`), apart from an excerpt that's only
 * shortened (`excerptTruncated`; `rig stream show` reads the stored body). The cursor advances past the items returned
 * and no further. When retention has pruned beyond the reader's cursor, `gap` says so on every page until the cursor
 * passes it. Returns null when the reader has no subscription.
 */
export function readPage(db: Database.Database, reader: string, opts: { limit?: number; nowIso?: string } = {}) {
  const s = getSubscription(db, reader);
  if (!s) return null;
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? READ_PAGE_ITEMS)), READ_PAGE_ITEMS);
  const m = matching(s, s.readThrough);
  const rows = db.prepare(`SELECT stream_item_id, ts_emitted, stream_sort_key, source_session, body, hint_type, hint_urgency, hint_destination,
    hint_tags, interrupt, body_kept_bytes, body_original_bytes FROM stream_items WHERE ${m.where} ORDER BY ts_emitted, stream_sort_key LIMIT ?`)
    .all(...m.params, limit + 1) as ItemRow[];
  const mark = retentionMark(db);
  const gap = mark && before(s.readThrough, mark) ? { reason: "retention", from: s.readThrough.ts, through: mark.ts, prunedItemsTotal: mark.prunedItems,
    detail: "Items in this range that weren't classified, disposed or acted on were pruned before you read them; some may have matched your filter." } : undefined;
  const cut = { hit: false };
  const subscription = { readerSession: clip(s.readerSession, cut)!, hintTags: clipTags(s.hintTags, cut) ?? [], hintType: clip(s.hintType, cut),
    ...(cut.hit ? { metadataTruncated: true } : {}) };
  // The envelope at its largest (cursor strings and counts at full width), then items while the whole page fits.
  let pageBytes = Buffer.byteLength(JSON.stringify({ subscription, items: [], readThrough: { ts: "x".repeat(64), key: "x".repeat(64) }, more: false,
    unread: { items: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER }, ...(gap ? { gap } : {}) }));
  const page: ItemRow[] = [];
  const items: Array<ReturnType<typeof pageItem>> = [];
  for (const r of rows.slice(0, limit)) {
    const item = pageItem(r);
    const size = Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
    if (items.length && pageBytes + size > READ_PAGE_BYTES) break;
    page.push(r); items.push(item); pageBytes += size;
  }
  const last = page.at(-1);
  // With nothing retained to read, the cursor moves to the pruned edge so the same gap isn't reported again.
  const next = last ? { ts: last.ts_emitted, key: last.stream_sort_key } : gap && mark ? { ts: mark.ts, key: mark.key } : s.readThrough;
  if (next !== s.readThrough) {
    db.prepare("UPDATE stream_subscriptions SET read_through_ts = ?, read_through_key = ?, updated_at = ? WHERE reader_session = ?")
      .run(next.ts, next.key, opts.nowIso ?? new Date().toISOString(), reader);
  }
  return { subscription, items, readThrough: next, more: rows.length > page.length, unread: unread(db, s, next), ...(gap ? { gap } : {}) };
}
