import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

/**
 * Slice 22 outcome 9: a reader's recorded action on a stream item. `act` links owned work the reader opened or
 * joined through the queue (it doesn't create work), `decline` records that reader's reason and nobody else's,
 * `duplicate` links what the item repeats. Rows are append-only; a reader's newest row is its current action.
 * When other work is already linked to the item, by another reader or by the automatic path, `act` still records
 * the link and names that work, so the reader can join it instead of keeping a second one.
 */

export const READER_ACTIONS = ["act", "decline", "duplicate"] as const;
export type ReaderActionKind = (typeof READER_ACTIONS)[number];

export interface ReaderAction {
  actionId: string;
  streamItemId: string;
  readerSession: string;
  action: ReaderActionKind;
  workQitemId: string | null;
  duplicateOf: string | null;
  reason: string | null;
  actedAt: string;
}

export class ReaderActionError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 404) { super(message); }
}

type Row = { action_id: string; stream_item_id: string; reader_session: string; action: ReaderActionKind; work_qitem_id: string | null;
  duplicate_of: string | null; reason: string | null; acted_at: string };
const toAction = (r: Row): ReaderAction => ({ actionId: r.action_id, streamItemId: r.stream_item_id, readerSession: r.reader_session, action: r.action,
  workQitemId: r.work_qitem_id, duplicateOf: r.duplicate_of, reason: r.reason, actedAt: r.acted_at });
const hasTable = (db: Database.Database, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const exists = (db: Database.Database, table: string, column: string, id: string) =>
  hasTable(db, table) && !!db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(id);

/** The row holding the work now: a handed-on or superseded row is followed to its successor (the row naming it as
 *  handed_off_from), up to 8 hops. Null when that can't be determined (a missing row, no recorded successor). */
function currentWork(db: Database.Database, qitemId: string): string | null {
  if (!hasTable(db, "queue_items")) return null;
  let id = qitemId;
  for (let hop = 0; hop <= 8; hop++) {
    const row = db.prepare("SELECT state, closure_reason FROM queue_items WHERE qitem_id = ?").get(id) as { state: string; closure_reason: string | null } | undefined;
    if (!row) return null;
    if (row.state !== "handed-off" && row.closure_reason !== "handed_off_to" && row.closure_reason !== "superseded") return id;
    const next = db.prepare("SELECT qitem_id FROM queue_items WHERE handed_off_from = ? ORDER BY ts_created DESC LIMIT 1").get(id) as { qitem_id: string } | undefined;
    if (!next) return null;
    id = next.qitem_id;
  }
  return null;
}

/** Every action on the item, oldest first, and each reader's current (newest) one. */
export function readerActions(db: Database.Database, streamItemId: string): { current: ReaderAction[]; history: ReaderAction[] } {
  const history = (db.prepare("SELECT * FROM stream_reader_actions WHERE stream_item_id = ? ORDER BY action_id").all(streamItemId) as Row[]).map(toAction);
  const latest = new Map<string, ReaderAction>();
  for (const a of history) latest.set(a.readerSession, a);
  return { current: [...latest.values()].sort((a, b) => a.actionId.localeCompare(b.actionId)), history };
}

export function recordReaderAction(db: Database.Database, input: { streamItemId: string; readerSession: string; action: string;
  workQitemId?: string | null; duplicateOf?: string | null; reason?: string | null }, nowIso = new Date().toISOString()) {
  const action = input.action as ReaderActionKind;
  if (!READER_ACTIONS.includes(action)) throw new ReaderActionError("action_invalid", `action must be one of ${READER_ACTIONS.join(", ")}`, 400);
  if (!exists(db, "stream_items", "stream_item_id", input.streamItemId)) {
    throw new ReaderActionError("stream_item_not_found", `stream item ${input.streamItemId} not found`, 404);
  }
  const work = action === "act" ? input.workQitemId?.trim() || null : null;
  const duplicateOf = action === "duplicate" ? input.duplicateOf?.trim() || null : null;
  const reason = input.reason?.trim() || null;
  if (action === "act" && !work) throw new ReaderActionError("work_required", "act links owned work: name its queue row", 400);
  if (action === "act" && !exists(db, "queue_items", "qitem_id", work!)) {
    throw new ReaderActionError("work_not_found", `queue row ${work} not found; open or join the work first, then link it`, 404);
  }
  if (action === "decline" && !reason) throw new ReaderActionError("reason_required", "a decline carries the reader's reason", 400);
  if (action === "duplicate" && !duplicateOf) throw new ReaderActionError("duplicate_required", "duplicate links the queue row or stream item it repeats", 400);
  if (action === "duplicate" && !exists(db, "queue_items", "qitem_id", duplicateOf!) && !exists(db, "stream_items", "stream_item_id", duplicateOf!)) {
    throw new ReaderActionError("duplicate_target_not_found", `${duplicateOf} is neither a queue row nor a stream item`, 404);
  }
  const actionId = ulid();
  db.prepare(`INSERT INTO stream_reader_actions (action_id, stream_item_id, reader_session, action, work_qitem_id, duplicate_of, reason, acted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(actionId, input.streamItemId, input.readerSession, action, work, duplicateOf, reason, nowIso);
  // One accountable action: name other work already linked to this item, by another reader or by the automatic path.
  // Work is compared by its current row (handoffs followed), so one handed-on chain isn't reported as competing work;
  // a link whose current row can't be determined is still named, with current unknown.
  const otherWork: Array<{ qitemId: string; current: string | null; by: string; source: "reader" | "automatic"; applied?: string }> = [];
  if (work) {
    const mine = currentWork(db, work) ?? work;
    const other = (linked: string) => { const current = currentWork(db, linked); return { current, same: (current ?? linked) === mine }; };
    for (const a of readerActions(db, input.streamItemId).current) {
      if (a.action !== "act" || a.readerSession === input.readerSession) continue;
      const o = other(a.workQitemId!);
      if (!o.same) otherWork.push({ qitemId: a.workQitemId!, current: o.current, by: a.readerSession, source: "reader" });
    }
    if (hasTable(db, "stream_dispositions")) {
      const d = db.prepare(`SELECT accepted_by, COALESCE(effect_qitem_id, work_qitem_id) AS linked, applied_json FROM stream_dispositions
        WHERE stream_item_id = ? AND disposition IN ('create', 'join', 'duplicate')`).get(input.streamItemId) as { accepted_by: string; linked: string | null; applied_json: string | null } | undefined;
      const o = d?.linked ? other(d.linked) : null;
      if (d?.linked && o && !o.same) {
        const applied = d.applied_json ? (JSON.parse(d.applied_json) as { outcome?: unknown }).outcome : undefined;
        otherWork.push({ qitemId: d.linked, current: o.current, by: d.accepted_by, source: "automatic", ...(typeof applied === "string" ? { applied } : {}) });
      }
    }
  }
  const recorded = toAction(db.prepare("SELECT * FROM stream_reader_actions WHERE action_id = ?").get(actionId) as Row);
  return { action: recorded, ...(otherWork.length ? { otherWork,
    note: "Other work is already linked to this item. Consider joining it (a note on that row) instead of keeping a second one." } : {}) };
}
