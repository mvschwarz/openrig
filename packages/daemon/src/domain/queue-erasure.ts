import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
import type Database from "better-sqlite3";

/**
 * Queue erasure: the maintained way to remove queue content, for closed-work retention and account deletion on a
 * daemon that serves several accounts. Two actions on a queue row:
 * - scrub: the row's content is removed and the row stays, content-free, with its id, endpoints, state and times
 *   (`content_erased_at` set). The create path's retry identity still finds it, so a retried create makes no new work.
 *   A later note, summary or reclose makes it eligible again.
 * - delete: the row and everything linked to it go. Only its id is kept, in `queue_erased_ids` (no endpoints, no
 *   content), and the create path refuses that id (`qitem_erased`).
 * The row's own copies follow it: its transitions, live and archived; events whose payload names it; its
 * mission-control audit rows. Copies another party holds (outbox and inbox entries, stream reader actions and
 * dispositions) go only when they're the owner's: both endpoints the account's (members scope) or the row's own
 * (other scopes). Others are kept and reported.
 *
 * Scope is exact. Account deletion takes the account's recorded membership (exact session names): a row whose two
 * endpoints are both members is deleted, whatever its state; a row with one member endpoint is reported as mixed and
 * left untouched. Named with the account's rig, it also removes the rig's own records that outlive the rig. Routine
 * retention touches only closed rows (done, canceled, denied, handed-off; never failed or open work), aged from the
 * start of their final closed state. A row a workflow still references is reported, never erased.
 *
 * A run selects everything first, then reads the events table once in seq windows to find the events naming each
 * selected row (no index serves a payload match, and one statement over a large table would hold the daemon), then
 * erases batch by batch, yielding between steps. Each batch is one transaction (better-sqlite3 commits a transaction
 * on return and rolls it back on a throw): it rechecks its rows, since anything may have changed them since selection
 * (a reopened row is open work again; a rerouted one may no longer be the account's), writes their ledger lines, then
 * changes their events, copies and rows. A row an unreadable event names is kept, so reruns keep reporting it. With a
 * ledger, a batch's lines carry its id, the database records that id in the batch's own transaction, and a commit line
 * follows the commit (an abort line a rollback), so a replay after a restore applies exactly what committed. A run
 * that stops, by its batch limit or an error, returns only what it committed; a rerun picks up the rest.
 */

/** The closed states routine retention may erase. `failed` stays out: account deletion covers it. */
export const CLOSED_QUEUE_STATES = ["done", "canceled", "denied", "handed-off"] as const;
/** The closure reasons whose closure_target names a successor; for the others it can be a reason or note. */
const ID_CLOSURE_REASONS = ["handed_off_to", "superseded"] as const;
/** A successor as a closure target names it: a session address, or a queue id (either with a host suffix). */
const ADDRESS_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/;
const QITEM_SHAPE = /^qitem-[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/;

/** A scrub keeps a closure target only when it names a successor: closure writes don't constrain the target, so text
 *  under a successor reason is cleared like any other note. */
function keepsClosureTarget(reason: unknown, target: unknown): boolean {
  return ID_CLOSURE_REASONS.includes(reason as (typeof ID_CLOSURE_REASONS)[number]) && typeof target === "string"
    && target.length <= 256 && (ADDRESS_SHAPE.test(target) || QITEM_SHAPE.test(target));
}

export type EraseAction = "scrub" | "delete";
export type EraseScope =
  | { kind: "members"; members: readonly string[]; rig?: string }
  | { kind: "ids"; entries: ReadonlyArray<{ qitemId: string; action: EraseAction; batch?: string }>;
      /** an erasure ledger's commit and abort lines: which of its batches committed */
      commits?: ReadonlyArray<{ batch: string; committed: boolean }> }
  | { kind: "routine"; contentDays: number; metadataDays: number };

/** A scope that can't be erased exactly; nothing was written. */
export class EraseRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface EraseOptions {
  scope: EraseScope;
  /** false: report what would be erased and write nothing */
  apply: boolean;
  nowIso: string;
  batchSize?: number;
  /** selection stops after this many pages and the run reports complete: false; a rerun continues */
  maxBatches?: number;
  /** events rows (by seq) read per step of the events walk */
  eventsWindow?: number;
  /** append each erased row's {qitemId, action, reason, erasedAt, batch} here, one JSON line each, before its batch
   *  changes anything, then {batch, committed} once the batch commits or rolls back. The file is opened before the run
   *  writes anything at all */
  ledgerPath?: string;
}

type Stage = "ledger" | "select" | "events" | "rows" | "unlinked" | "rig";
type CopyTable = "outbox_entries" | "inbox_entries" | "stream_reader_actions" | "stream_dispositions";
export type EraseGap = { code: "workflow-reference" | "not-found" | "changed-during-run" | "unreadable-event" | "ledger-unresolved"; qitemId: string };

export interface EraseReport {
  ok: true;
  applied: boolean;
  scope: EraseScope["kind"];
  /** false when the run stopped at maxBatches or on an error; rerun to continue */
  complete: boolean;
  /** complete, and nothing was left: no mixed rows or copies, gaps, unreadable events, or left-over entries or rig
   *  records */
  clean: boolean;
  /** why the run stopped early, and where; everything listed in qitems was committed before it */
  error?: { stage: Stage; message: string };
  /** rows erased (applied, committed) or that would be (dry run) */
  qitems: Array<{ qitemId: string; action: EraseAction; state: string }>;
  /** members scope: rows with exactly one member endpoint, left untouched */
  mixed: Array<{ qitemId: string; memberEndpoint: "source" | "destination" }>;
  /** rows not erased, and why: a workflow references them; (ids scope) no such row to scrub; the row changed after
   *  selection so it no longer qualifies (reopened, rerouted out of the account, written to out of its window, or an
   *  absent id created since); or an event naming it can't be read */
  gaps: EraseGap[];
  /** ids scope, delete: rows already gone whose id marker is (re)written; listed once the marker is committed */
  alreadyAbsent: string[];
  /** ids scope, a ledger replay: entries whose batch rolled back, so not replayed */
  skipped?: Array<{ qitemId: string; batch: string }>;
  /** an applied run with a ledger: batches this database recorded as committed whose commit line was missing (lost
   *  after the commit), written now. A batch with neither a line nor a record surfaces only on a replay, as the gap
   *  ledger-unresolved */
  ledger?: { reconciled: string[] };
  /** an erased row's copies held with someone else: mixed (one of their sessions is the owner's) or foreign (none) */
  keptCopies: Array<{ table: CopyTable; id: string; qitemId: string; ownership: "mixed" | "foreign" }>;
  /** events naming a selected row whose payload can't be read: kept, since what they hold can't be inspected. The
   *  rows they name are kept too (gap unreadable-event), so every rerun finds them again until they're resolved */
  unreadableEvents: Array<{ seq: number; qitemIds: string[] }>;
  /** copies erased with the rows, or that would be */
  linked: { transitions: number; archivedTransitions: number; outbox: number; inbox: number; events: number; streamActions: number; missionControl: number };
  /** members scope: entries between members that no queue row owns; mixed ones are counted and left */
  unlinked?: { outbox: number; inbox: number; streamItems: number; mixedEntries: number; referencedStreamItems: number };
  /** members scope with rig: whether the rig was found and verified, its records erased and left per table, the
   *  tables whose records can't be counted (an unverified removed rig), and when its erasure completed */
  rig?: { id: string; found: boolean; verified: boolean; erased: Record<string, number>; left: Record<string, number>; unknown: string[];
    completedAt?: string };
  routine?: { contentDays: number; metadataDays: number };
}

const DEFAULT_BATCH = 500;
const DEFAULT_MAX_BATCHES = 10_000;
const DEFAULT_EVENTS_WINDOW = 1_000;
/** Rows erased per transaction. Each one rechecks its rows and rewrites their events, so it's kept smaller than a
 *  selection page: on a 2.4M-event store, 500 rows held the daemon up to 0.5 s, and 100 up to 0.25 s. */
const ROWS_PER_TRANSACTION = 100;

function cutoffIso(nowIso: string, days: number): string {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) throw new Error(`queue-erasure: invalid nowIso ${JSON.stringify(nowIso)}`);
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const IDS = "(SELECT value FROM json_each(@ids))";
const MEMBERS = "(SELECT value FROM json_each(@members))";
/** The payload keys a row-naming event uses: queue events name it in qitemId; inbox, workflow and mission-control
 *  events use these others. */
const EVENT_ID_KEYS = ["qitemId", "promotedQitemId", "priorQitemId", "nextQitemId"] as const;
/** The content keys of row-naming events; a scrubbed event keeps its type and ids. closureTarget goes too, unless it
 *  names a successor. */
const EVENT_CONTENT_KEYS = ["summary", "reason", "error"] as const;
/** instr is a cheap prefilter for row-naming events: every id key ends in "temId" (qitemId, promotedQitemId, ...). */
const NAMES_A_ROW = "instr(payload, 'temId') > 0";

class Statements {
  constructor(private readonly db: Database.Database) {}
  private cache = new Map<string, Database.Statement>();
  get(sql: string): Database.Statement {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }
  count(sql: string, params: Record<string, unknown>): number {
    return (this.get(sql).get(params) as { n: number }).n;
  }
}

/** Rows a workflow still references (a step trail, a frontier binding or a failure record point at them by key, or
 *  a live instance's frontier names them): erasing them would break the workflow or its record. */
function workflowReferenced(st: Statements, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = st.get(`SELECT value AS id FROM json_each(@ids) j WHERE
      EXISTS (SELECT 1 FROM workflow_step_trails WHERE next_qitem_id = j.value OR prior_qitem_id = j.value)
      OR EXISTS (SELECT 1 FROM workflow_frontier_bindings WHERE packet_id = j.value)
      OR EXISTS (SELECT 1 FROM workflow_failure_occurrences WHERE failed_packet_id = j.value OR redrive_packet_id = j.value)
      OR EXISTS (SELECT 1 FROM workflow_instances WHERE status IN ('active', 'waiting')
                  AND current_frontier_json LIKE '%"' || j.value || '"%')`).all({ ids: JSON.stringify(ids) }) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

type Candidate = { qitemId: string; state: string; action: EraseAction; source: string; destination: string };
type Copy = { table: CopyTable; id: string; qitemId: string; sessions: Array<string | null> };
type Current = { qitemId: string; state: string; tsUpdated: string; erasedAt: string | null; source: string; destination: string };

/** The copies of these rows that another party holds, each found through its own indexed link. */
function linkedCopies(st: Statements, ids: string[]): Copy[] {
  const params = { ids: JSON.stringify(ids) };
  const copies = new Map<string, Copy>();
  const collect = (table: CopyTable, sql: string) => {
    for (const row of st.get(sql).all(params) as Array<{ id: string; qitemId: string; a: string | null; b: string | null }>) {
      copies.set(`${table}:${row.id}`, { table, id: String(row.id), qitemId: row.qitemId, sessions: [row.a, row.b] });
    }
  };
  collect("outbox_entries", `SELECT outbox_id AS id, audit_pointer AS qitemId, sender_session AS a, destination_session AS b
      FROM outbox_entries WHERE audit_pointer IN ${IDS}`);
  collect("outbox_entries", `SELECT outbox_id AS id, substr(outbox_id, 13) AS qitemId, sender_session AS a, destination_session AS b
      FROM outbox_entries WHERE outbox_id IN (SELECT 'wake-intent-' || value FROM json_each(@ids))`);
  collect("inbox_entries", `SELECT inbox_id AS id, absorbed_qitem_id AS qitemId, sender_session AS a, destination_session AS b
      FROM inbox_entries WHERE absorbed_qitem_id IN ${IDS}`);
  collect("inbox_entries", `SELECT inbox_id AS id, audit_pointer AS qitemId, sender_session AS a, destination_session AS b
      FROM inbox_entries WHERE audit_pointer IN ${IDS}`);
  collect("stream_reader_actions", `SELECT action_id AS id, work_qitem_id AS qitemId, reader_session AS a, NULL AS b
      FROM stream_reader_actions WHERE work_qitem_id IN ${IDS}`);
  collect("stream_reader_actions", `SELECT action_id AS id, duplicate_of AS qitemId, reader_session AS a, NULL AS b
      FROM stream_reader_actions WHERE duplicate_of IN ${IDS}`);
  collect("stream_dispositions", `SELECT stream_item_id AS id, work_qitem_id AS qitemId, accepted_by AS a, owner_session AS b
      FROM stream_dispositions WHERE work_qitem_id IN ${IDS}`);
  collect("stream_dispositions", `SELECT stream_item_id AS id, effect_qitem_id AS qitemId, accepted_by AS a, owner_session AS b
      FROM stream_dispositions WHERE effect_qitem_id IN ${IDS}`);
  return [...copies.values()];
}

const COPY_KEY: Record<CopyTable, string> = {
  outbox_entries: "outbox_id", inbox_entries: "inbox_id", stream_reader_actions: "action_id", stream_dispositions: "stream_item_id",
};

function eraseCopies(st: Statements, copies: Copy[], action: EraseAction): void {
  for (const table of Object.keys(COPY_KEY) as CopyTable[]) {
    const keys = copies.filter((copy) => copy.table === table).map((copy) => copy.id);
    if (keys.length === 0) continue;
    const params = { keys: JSON.stringify(keys) };
    const where = `${COPY_KEY[table]} IN (SELECT value FROM json_each(@keys))`;
    if (action === "delete") {
      st.get(`DELETE FROM ${table} WHERE ${where}`).run(params);
    } else if (table === "outbox_entries") {
      st.get(`UPDATE outbox_entries SET body = '', tags = NULL WHERE ${where}`).run(params);
    } else if (table === "inbox_entries") {
      st.get(`UPDATE inbox_entries SET body = '', tags = NULL, denied_reason = NULL WHERE ${where}`).run(params);
    } else if (table === "stream_reader_actions") {
      st.get(`UPDATE stream_reader_actions SET reason = NULL WHERE ${where}`).run(params);
    } else {
      st.get(`UPDATE stream_dispositions SET template_text = '', request_json = '{}', provenance_json = '{}', reason = NULL,
          result_json = NULL, applied_json = NULL WHERE ${where}`).run(params);
    }
  }
}

function scrubRows(st: Statements, ids: string[], nowIso: string): void {
  const params = { ids: JSON.stringify(ids) };
  // Closure targets that don't name a successor, found here: SQLite has no pattern match for the id shapes.
  for (const [table, key] of [["queue_items", "qitem_id"], ["queue_transitions", "transition_id"], ["queue_transitions_archive", "transition_id"]]) {
    const notes = (st.get(`SELECT ${key} AS k, closure_reason AS reason, closure_target AS target FROM ${table}
        WHERE qitem_id IN ${IDS} AND closure_target IS NOT NULL`).all(params) as Array<{ k: string | number; reason: string | null; target: string }>)
      .filter((row) => !keepsClosureTarget(row.reason, row.target)).map((row) => row.k);
    if (notes.length > 0) {
      st.get(`UPDATE ${table} SET closure_target = NULL WHERE ${key} IN (SELECT value FROM json_each(@keys))`).run({ keys: JSON.stringify(notes) });
    }
  }
  st.get(`UPDATE queue_items SET body = '', summary = NULL, resolution = NULL, tags = NULL, blocked_on = NULL,
      chain_of_record = NULL, evidence_ref = NULL, human_detail = NULL, human_questions = NULL, human_answers = NULL,
      delegated_decision = NULL, last_nudge_input_box = NULL, content_erased_at = @now WHERE qitem_id IN ${IDS}`).run({ ...params, now: nowIso });
  for (const table of ["queue_transitions", "queue_transitions_archive"]) {
    st.get(`UPDATE ${table} SET transition_note = NULL, identity_principal = NULL WHERE qitem_id IN ${IDS}`).run(params);
  }
  st.get(`UPDATE mission_control_actions SET before_state_json = NULL, after_state_json = NULL, reason = NULL,
      annotation = NULL, notify_result = NULL, audit_notes_json = NULL WHERE qitem_id IN ${IDS}`).run(params);
}

function deleteRows(st: Statements, ids: string[], nowIso: string, reason: string): void {
  const params = { ids: JSON.stringify(ids) };
  // mission_control_actions references queue_items by key, so it goes before the row.
  st.get(`DELETE FROM mission_control_actions WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`DELETE FROM queue_transition_wakes WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`DELETE FROM queue_transitions WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`DELETE FROM queue_transitions_archive WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`DELETE FROM queue_items WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`INSERT OR IGNORE INTO queue_erased_ids (qitem_id, erased_at, reason) SELECT value, @now, @reason FROM json_each(@ids)`)
    .run({ ...params, now: nowIso, reason });
}

type EventPayload = Record<string, unknown>;
/** A payload's own JSON, or null when it doesn't parse to an object. */
function parsePayload(text: string): EventPayload | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as EventPayload : null;
  } catch {
    return null;
  }
}
const namedIds = (payload: EventPayload) => EVENT_ID_KEYS.map((key) => payload[key]).filter((id): id is string => typeof id === "string");

/** Where each target row's events are: one read-only pass over events in seq windows, up to the seq it started at.
 *  Nothing changes here; each batch changes its own rows' events after rechecking the rows. A payload that names a
 *  target but can't be read is listed as unreadable. */
async function walkEvents(db: Database.Database, targets: Set<string>, window: number):
  Promise<{ seqs: Map<string, number[]>; unreadable: Array<{ seq: number; qitemIds: string[] }>; top: number }> {
  const found = { seqs: new Map<string, number[]>(), unreadable: [] as Array<{ seq: number; qitemIds: string[] }>, top: 0 };
  if (targets.size === 0) return found;
  found.top = (db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null }).seq ?? 0;
  const read = db.prepare(`SELECT seq, payload FROM events WHERE seq > ? AND seq <= ? AND ${NAMES_A_ROW}`);
  for (let lo = 0; lo < found.top; lo += window) {
    for (const row of read.all(lo, Math.min(lo + window, found.top)) as Array<{ seq: number; payload: string }>) {
      const payload = parsePayload(row.payload);
      if (payload === null) {
        const named = [...targets].filter((id) => row.payload.includes(id));
        if (named.length > 0) found.unreadable.push({ seq: row.seq, qitemIds: named });
        continue;
      }
      for (const id of new Set(namedIds(payload))) {
        if (!targets.has(id)) continue;
        const seqs = found.seqs.get(id);
        if (seqs) seqs.push(row.seq);
        else found.seqs.set(id, [row.seq]);
      }
    }
    await yieldToLoop();
  }
  return found;
}

/** When a closed row entered its final closed state: the earliest transition after the last one recorded in another
 *  state. A note on a closed row keeps its state, so it doesn't move this; a reopened and closed-again row counts
 *  from its latest close. */
function closedSince(st: Statements, qitemId: string, state: string, fallback: string): string {
  const lastOther = (st.get(`SELECT MAX(id) AS id FROM (
      SELECT transition_id AS id FROM queue_transitions WHERE qitem_id = @q AND state != @s
      UNION ALL SELECT transition_id AS id FROM queue_transitions_archive WHERE qitem_id = @q AND state != @s)`)
    .get({ q: qitemId, s: state }) as { id: number | null }).id ?? -1;
  const since = (st.get(`SELECT MIN(ts) AS ts FROM (
      SELECT ts FROM queue_transitions WHERE qitem_id = @q AND transition_id > @after
      UNION ALL SELECT ts FROM queue_transitions_archive WHERE qitem_id = @q AND transition_id > @after)`)
    .get({ q: qitemId, after: lastOther }) as { ts: string | null }).ts;
  return since ?? fallback;
}

function membersDigest(members: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([...new Set(members)].sort())).digest("hex");
}

type BatchPlan = {
  rows: Candidate[];
  absent: string[];
  dropped: EraseGap[];
  owned: Record<EraseAction, Copy[]>;
  kept: EraseReport["keptCopies"];
  counts: { transitions: number; archivedTransitions: number; missionControl: number };
  events: { rewrite: Array<[string, number]>; remove: number[]; seqs: number[] };
  unreadable: Array<{ seq: number; qitemIds: string[] }>;
};

/** The batches this database recorded as committed (each batch with ledger lines records its id in its own
 *  transaction). */
function recordedBatches(st: Statements, batches: string[]): Set<string> {
  if (batches.length === 0) return new Set();
  return new Set((st.get("SELECT batch_id AS id FROM queue_erasure_batches WHERE batch_id IN (SELECT value FROM json_each(@ids))")
    .all({ ids: JSON.stringify(batches) }) as Array<{ id: string }>).map((row) => row.id));
}

/** Before a run writes to the ledger: a last line cut short (a full disk, say) is closed off, so it can't fuse with the
 *  next one. A cut-short line is safe to delete by hand: an entry line's batch rolled back when its append failed, and
 *  a commit line is written again from the record. */
function endLedgerLine(path: string): void {
  const size = statSync(path).size;
  if (size === 0) return;
  const last = Buffer.alloc(1);
  const fd = openSync(path, "r");
  try {
    readSync(fd, last, 0, 1, size - 1);
  } finally {
    closeSync(fd);
  }
  if (last[0] !== 0x0a) appendFileSync(path, "\n");
}

/** Batches this database recorded as committed whose commit line isn't in the ledger yet (lost after the commit): the
 *  line is written now, from the record, without reading the ledger. A batch with neither a line nor a record isn't
 *  decided here or anywhere: on a restored database, one committed after the backup looks exactly like one that rolled
 *  back, so only its own line can say which, and a replay reports it. */
function reconcileLedger(st: Statements, path: string, nowIso: string): { reconciled: string[] } {
  const reconciled = (st.get("SELECT batch_id AS id FROM queue_erasure_batches WHERE line_at IS NULL ORDER BY rowid").all() as Array<{ id: string }>)
    .map((row) => row.id);
  if (reconciled.length === 0) return { reconciled };
  appendFileSync(path, reconciled.map((batch) => JSON.stringify({ batch, committed: true, at: nowIso, reconciled: true })).join("\n") + "\n");
  st.get("UPDATE queue_erasure_batches SET line_at = @now WHERE batch_id IN (SELECT value FROM json_each(@ids))")
    .run({ now: nowIso, ids: JSON.stringify(reconciled) });
  return { reconciled };
}

/** Erase queue rows in one scope. With apply false it reports exactly what an apply would erase and writes nothing. */
export async function eraseQueue(db: Database.Database, opts: EraseOptions): Promise<EraseReport> {
  const st = new Statements(db);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  const { scope } = opts;

  // A rig named with the members must be theirs, both ways: every member's session is named in the rig (departed
  // members included), and every session of it is a member. A rig already removed is verified only by the record an
  // earlier run kept with this membership.
  let rig: { id: string; name: string | null; found: boolean; verified: boolean; completedAt: string | null } | null = null;
  if (scope.kind === "members" && scope.rig !== undefined) {
    const name = (db.prepare("SELECT name FROM rigs WHERE id = ?").get(scope.rig) as { name: string } | undefined)?.name ?? null;
    if (name !== null) {
      const outside = scope.members.filter((member) => member.split("@")[1] !== name);
      const rigSessions = (db.prepare(`SELECT DISTINCT s.session_name AS name FROM sessions s JOIN nodes n ON n.id = s.node_id
          WHERE n.rig_id = ?`).all(scope.rig) as Array<{ name: string }>).map((row) => row.name);
      const unlisted = rigSessions.filter((session) => !scope.members.includes(session));
      if (outside.length > 0 || unlisted.length > 0) {
        throw new EraseRefusal("erase_rig_mismatch", [
          outside.length > 0 ? `These members aren't sessions of rig ${name}: ${outside.join(", ")}.` : "",
          unlisted.length > 0 ? `Rig ${name} has sessions the members don't list: ${unlisted.join(", ")}.` : "",
        ].filter(Boolean).join(" "));
      }
      rig = { id: scope.rig, name, found: true, verified: true, completedAt: null };
    } else {
      const kept = db.prepare(`SELECT rig_name AS name, members_digest AS digest, completed_at AS completedAt
          FROM queue_erased_rigs WHERE rig_id = ?`).get(scope.rig) as { name: string; digest: string; completedAt: string | null } | undefined;
      const verified = kept !== undefined && kept.digest === membersDigest(scope.members);
      rig = { id: scope.rig, name: verified && kept.name !== "" ? kept.name : null, found: false, verified,
        completedAt: verified ? kept.completedAt : null };
    }
  }

  const report: EraseReport = {
    ok: true, applied: opts.apply, scope: scope.kind, complete: true, clean: false, qitems: [], mixed: [], gaps: [],
    alreadyAbsent: [], keptCopies: [], unreadableEvents: [],
    linked: { transitions: 0, archivedTransitions: 0, outbox: 0, inbox: 0, events: 0, streamActions: 0, missionControl: 0 },
  };
  if (scope.kind === "routine") report.routine = { contentDays: scope.contentDays, metadataDays: scope.metadataDays };
  const reason = scope.kind === "members" ? "account-deletion" : scope.kind === "routine" ? "retention-metadata" : "erase-by-id";
  const ledgerReason = (action: EraseAction) => scope.kind === "routine" && action === "scrub" ? "retention-content" : reason;
  const memberSet = new Set(scope.kind === "members" ? scope.members : []);
  const members = JSON.stringify([...memberSet]);
  // A ledger replay applies only the batches that committed, by their own commit line or this database's record of
  // them. A rolled-back batch is skipped; one that is neither is reported and never replayed.
  let listed = scope.kind === "ids" ? scope.entries : [];
  if (scope.kind === "ids" && listed.some((entry) => entry.batch !== undefined)) {
    const marks = new Map((scope.commits ?? []).map(({ batch, committed }) => [batch, committed]));
    const recorded = recordedBatches(st, [...new Set(listed.flatMap((entry) => entry.batch !== undefined && !marks.has(entry.batch) ? [entry.batch] : []))]);
    const unresolved = new Set<string>();
    report.skipped = [];
    listed = listed.filter((entry) => {
      if (entry.batch === undefined) return true;
      const committed = marks.get(entry.batch) ?? (recorded.has(entry.batch) ? true : undefined);
      if (committed === true) return true;
      if (committed === false) report.skipped!.push({ qitemId: entry.qitemId, batch: entry.batch });
      else unresolved.add(entry.qitemId);
      return false;
    });
    for (const qitemId of [...unresolved].sort()) report.gaps.push({ code: "ledger-unresolved", qitemId });
  }
  const entries = scope.kind === "ids"
    ? [...new Map(listed.map((entry) => [entry.qitemId, entry.action])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
  const contentCutoff = scope.kind === "routine" && scope.contentDays > 0 ? cutoffIso(opts.nowIso, scope.contentDays) : null;
  const metadataCutoff = scope.kind === "routine" && scope.metadataDays > 0 ? cutoffIso(opts.nowIso, scope.metadataDays) : null;

  // What routine retention does with a row now: delete it past the row window, scrub it past the content window while
  // it has content, or nothing. A scrubbed row written to since (a note appends a transition without touching
  // ts_updated, and may since have been archived; a reclose moves both) has content again.
  const routineAction = (row: Current): EraseAction | null => {
    if (!CLOSED_QUEUE_STATES.includes(row.state as (typeof CLOSED_QUEUE_STATES)[number])) return null;
    const since = closedSince(st, row.qitemId, row.state, row.tsUpdated);
    if (metadataCutoff && since < metadataCutoff) return "delete";
    if (!contentCutoff || since >= contentCutoff) return null;
    const hasContent = !row.erasedAt || row.tsUpdated > row.erasedAt
      || st.get(`SELECT 1 FROM queue_transitions WHERE qitem_id = @q AND ts > @since
          UNION ALL SELECT 1 FROM queue_transitions_archive WHERE qitem_id = @q AND ts > @since LIMIT 1`)
        .get({ q: row.qitemId, since: row.erasedAt }) !== undefined;
    return hasContent ? "scrub" : null;
  };

  // Ids scope, delete: ids with no row at selection; their markers are written at the end.
  const absentAtSelect: string[] = [];
  // One page of candidate rows, keyed on qitem_id so selection moves forward without writing anything.
  const page = (after: string, offset: number): { rows: Candidate[]; last: string | null; seen: number } => {
    const select = "qitem_id AS qitemId, state, source_session AS source, destination_session AS destination";
    if (scope.kind === "ids") {
      const slice = entries.slice(offset, offset + batchSize);
      const found = new Map((st.get(`SELECT ${select} FROM queue_items WHERE qitem_id IN ${IDS}`)
        .all({ ids: JSON.stringify(slice.map(([id]) => id)) }) as Array<Omit<Candidate, "action">>).map((row) => [row.qitemId, row]));
      const rows: Candidate[] = [];
      for (const [id, action] of slice) {
        const row = found.get(id);
        if (row !== undefined) rows.push({ ...row, action });
        else if (action === "delete") absentAtSelect.push(id);
        else report.gaps.push({ code: "not-found", qitemId: id });
      }
      return { rows, last: null, seen: slice.length };
    }
    if (scope.kind === "members") {
      const found = st.get(`SELECT ${select} FROM queue_items
          WHERE qitem_id > @after AND (source_session IN ${MEMBERS} OR destination_session IN ${MEMBERS})
          ORDER BY qitem_id LIMIT @limit`).all({ members, after, limit: batchSize }) as Array<Omit<Candidate, "action">>;
      const rows: Candidate[] = [];
      for (const row of found) {
        const fromMember = memberSet.has(row.source);
        const toMember = memberSet.has(row.destination);
        if (fromMember && toMember) rows.push({ ...row, action: "delete" });
        else report.mixed.push({ qitemId: row.qitemId, memberEndpoint: fromMember ? "source" : "destination" });
      }
      return { rows, last: found.at(-1)?.qitemId ?? null, seen: found.length };
    }
    // +state keeps the planner on the primary key, so a page reads forward from @after; the state index would sort
    // every closed row on each page (1.4 s a page on a 44k-row store).
    const closed = CLOSED_QUEUE_STATES.map((state) => `'${state}'`).join(", ");
    const found = st.get(`SELECT ${select}, ts_updated AS tsUpdated, content_erased_at AS erasedAt
        FROM queue_items WHERE qitem_id > @after AND +state IN (${closed}) ORDER BY qitem_id LIMIT @limit`)
      .all({ after, limit: batchSize }) as Array<Omit<Candidate, "action"> & { tsUpdated: string; erasedAt: string | null }>;
    const rows: Candidate[] = [];
    for (const { tsUpdated, erasedAt, ...row } of found) {
      const action = routineAction({ ...row, tsUpdated, erasedAt });
      if (action !== null) rows.push({ ...row, action });
    }
    return { rows, last: found.at(-1)?.qitemId ?? null, seen: found.length };
  };

  // Whose copies these are: the account's (members scope), or the row's own participants (other scopes).
  const ownerOf = (candidate: Candidate) => scope.kind === "members" ? memberSet : new Set([candidate.source, candidate.destination]);
  const ownership = (copy: Copy, owners: Set<string>): "owned" | "mixed" | "foreign" => {
    const sessions = copy.sessions.filter((session): session is string => session !== null);
    const owned = sessions.filter((session) => owners.has(session)).length;
    return owned === sessions.length ? "owned" : owned > 0 ? "mixed" : "foreign";
  };
  // Stream actions and dispositions this run deletes, so the unlinked pass plans on the same references either way.
  const plannedActions: string[] = [];
  const plannedDispositions: string[] = [];
  const eventSeqs = new Set<number>();
  const unreadable = new Map<number, Set<string>>();
  const noteUnreadable = (found: Array<{ seq: number; qitemIds: string[] }>) => {
    for (const { seq, qitemIds } of found) {
      const ids = unreadable.get(seq) ?? new Set<string>();
      for (const id of qitemIds) ids.add(id);
      unreadable.set(seq, ids);
    }
    report.unreadableEvents = [...unreadable.entries()].sort(([a], [b]) => a - b).map(([seq, ids]) => ({ seq, qitemIds: [...ids].sort() }));
  };
  // Batches whose lines were written; each records its id in its own transaction, which is the commit's proof.
  const written = new Set<string>();
  const ledger = (rows: Array<{ qitemId: string; action: EraseAction }>, batch: string | null) => {
    if (!opts.ledgerPath || batch === null || rows.length === 0) return;
    appendFileSync(opts.ledgerPath, rows.map((row) => JSON.stringify({ qitemId: row.qitemId, action: row.action,
      reason: ledgerReason(row.action), erasedAt: opts.nowIso, batch })).join("\n") + "\n");
    st.get("INSERT OR IGNORE INTO queue_erasure_batches (batch_id, committed_at) VALUES (?, ?)").run(batch, opts.nowIso);
    written.add(batch);
  };
  const mark = (batch: string, committed: boolean) => {
    appendFileSync(opts.ledgerPath!, JSON.stringify({ batch, committed, at: opts.nowIso }) + "\n");
  };
  // One batch's work: in a dry run, read only; applied, one transaction. With a ledger, a commit line follows the
  // commit and an abort line a rollback. A commit line that can't be written stops the run once the committed batch is
  // reported; the next run writes the line from the record. An abort line is best effort: without it, the batch stays
  // unresolved and is never replayed.
  let commitLineError: unknown = null;
  const afterBatch = () => {
    if (commitLineError === null) return;
    stage = "ledger";
    throw commitLineError;
  };
  const inBatch = <T>(work: (batch: string | null) => T): T => {
    if (!opts.apply) return work(null);
    const batch = opts.ledgerPath ? randomUUID() : null;
    let result: T;
    try {
      result = db.transaction(() => work(batch))();
    } catch (err) {
      if (batch !== null && written.has(batch)) {
        try {
          mark(batch, false);
        } catch { /* left unresolved */ }
      }
      throw err;
    }
    if (batch !== null && written.has(batch)) {
      try {
        mark(batch, true);
        st.get("UPDATE queue_erasure_batches SET line_at = ? WHERE batch_id = ?").run(opts.nowIso, batch);
      } catch (err) {
        commitLineError = err;
      }
    }
    return result;
  };

  let stage: Stage = "ledger";
  try {
    // 0. A ledger that can't be written stops the run before anything changes. Batches missing their commit line are
    //    settled from this database's record where it has one.
    if (opts.apply && opts.ledgerPath) {
      appendFileSync(opts.ledgerPath, "");
      endLedgerLine(opts.ledgerPath);
      report.ledger = reconcileLedger(st, opts.ledgerPath, opts.nowIso);
    }

    // 1. Select every candidate, writing nothing.
    stage = "select";
    const candidates: Candidate[] = [];
    let after = "";
    let offset = 0;
    for (let batch = 0; ; batch += 1) {
      if (batch >= maxBatches) {
        report.complete = false;
        break;
      }
      const { rows, last, seen } = page(after, offset);
      if (seen === 0) break;
      const referenced = workflowReferenced(st, rows.map((row) => row.qitemId));
      for (const id of referenced) report.gaps.push({ code: "workflow-reference", qitemId: id });
      candidates.push(...rows.filter((row) => !referenced.has(row.qitemId)));
      if (last !== null) after = last;
      offset += seen;
      if (seen < batchSize) break;
      await yieldToLoop();
    }

    // 2. Where the candidates' events are: one read-only walk over the table.
    stage = "events";
    const events = await walkEvents(db, new Set(candidates.map((row) => row.qitemId)), opts.eventsWindow ?? DEFAULT_EVENTS_WINDOW);
    noteUnreadable(events.unreadable);
    const eventsAt = st.get(`SELECT seq, payload FROM events WHERE seq IN (SELECT value FROM json_each(@seqs))
        UNION ALL SELECT seq, payload FROM events WHERE seq > @top AND ${NAMES_A_ROW}`);
    const rewriteEvent = db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
    const removeEvent = db.prepare("DELETE FROM events WHERE seq = ?");

    // One batch, read at the moment it's erased: each row is rechecked, since anything may have changed it after
    // selection (a reopen makes it open work again; a workflow may have taken it up), then its copies and events.
    const unreadableAtWalk = new Set(events.unreadable.flatMap((event) => event.qitemIds));
    const planBatch = (chunk: Candidate[]): BatchPlan => {
      const chunkIds = chunk.map((row) => row.qitemId);
      const current = new Map((st.get(`SELECT qitem_id AS qitemId, state, ts_updated AS tsUpdated, content_erased_at AS erasedAt,
          source_session AS source, destination_session AS destination FROM queue_items WHERE qitem_id IN ${IDS}`)
        .all({ ids: JSON.stringify(chunkIds) }) as Current[]).map((row) => [row.qitemId, row]));
      const referenced = workflowReferenced(st, chunkIds);
      const plan: BatchPlan = { rows: [], absent: [], dropped: [], owned: { scrub: [], delete: [] }, kept: [],
        counts: { transitions: 0, archivedTransitions: 0, missionControl: 0 }, events: { rewrite: [], remove: [], seqs: [] }, unreadable: [] };
      for (const candidate of chunk) {
        const now = current.get(candidate.qitemId);
        if (now === undefined) {
          // Gone since selection: a delete still writes its marker; a scrub has nothing to scrub.
          if (candidate.action === "delete") plan.absent.push(candidate.qitemId);
          else plan.dropped.push({ code: "changed-during-run", qitemId: candidate.qitemId });
        } else if (referenced.has(candidate.qitemId)) {
          plan.dropped.push({ code: "workflow-reference", qitemId: candidate.qitemId });
        } else if (scope.kind === "members" && !(memberSet.has(now.source) && memberSet.has(now.destination))) {
          // Rerouted since selection (a fallback, say): no longer the account's own row.
          plan.dropped.push({ code: "changed-during-run", qitemId: candidate.qitemId });
        } else if (scope.kind === "routine" && routineAction(now) !== candidate.action) {
          plan.dropped.push({ code: "changed-during-run", qitemId: candidate.qitemId });
        } else {
          // The current endpoints decide whose the row's copies are.
          plan.rows.push({ ...candidate, state: now.state, source: now.source, destination: now.destination });
        }
      }
      if (plan.rows.length === 0) return plan;
      // The walk's events for these rows, plus any written since it began. A row an unreadable event names is kept:
      // what that event holds can't be inspected, and keeping the row means every rerun finds the event and reports
      // it until it's resolved.
      const seqs = [...new Set(plan.rows.flatMap((row) => events.seqs.get(row.qitemId) ?? []))];
      const fetched = new Map<number, string>();
      for (const event of eventsAt.all({ seqs: JSON.stringify(seqs), top: events.top }) as Array<{ seq: number; payload: string }>) {
        fetched.set(event.seq, event.payload);
      }
      const blocked = new Set(plan.rows.map((row) => row.qitemId).filter((id) => unreadableAtWalk.has(id)));
      const readable: Array<[number, EventPayload]> = [];
      for (const [seq, text] of fetched) {
        const payload = parsePayload(text);
        if (payload !== null) {
          readable.push([seq, payload]);
          continue;
        }
        const named = plan.rows.map((row) => row.qitemId).filter((id) => text.includes(id));
        if (named.length === 0) continue;
        plan.unreadable.push({ seq, qitemIds: named });
        for (const id of named) blocked.add(id);
      }
      if (blocked.size > 0) {
        plan.dropped.push(...[...blocked].sort().map((qitemId) => ({ code: "unreadable-event" as const, qitemId })));
        plan.rows = plan.rows.filter((row) => !blocked.has(row.qitemId));
      }
      const ids = plan.rows.map((row) => row.qitemId);
      if (ids.length === 0) return plan;
      const byId = new Map(plan.rows.map((row) => [row.qitemId, row]));
      for (const copy of linkedCopies(st, ids)) {
        const candidate = byId.get(copy.qitemId)!;
        const whose = ownership(copy, ownerOf(candidate));
        if (whose === "owned") plan.owned[candidate.action].push(copy);
        else plan.kept.push({ table: copy.table, id: copy.id, qitemId: copy.qitemId, ownership: whose });
      }
      const params = { ids: JSON.stringify(ids) };
      plan.counts = {
        transitions: st.count(`SELECT COUNT(*) AS n FROM queue_transitions WHERE qitem_id IN ${IDS}`, params),
        archivedTransitions: st.count(`SELECT COUNT(*) AS n FROM queue_transitions_archive WHERE qitem_id IN ${IDS}`, params),
        missionControl: st.count(`SELECT COUNT(*) AS n FROM mission_control_actions WHERE qitem_id IN ${IDS}`, params),
      };
      // An event naming two rows is deleted if either is deleted; one naming rows of a later batch is changed again
      // there.
      for (const [seq, payload] of readable) {
        const actions = namedIds(payload).map((id) => byId.get(id)?.action).filter((action): action is EraseAction => action !== undefined);
        if (actions.length === 0) continue;
        plan.events.seqs.push(seq);
        if (actions.includes("delete")) {
          plan.events.remove.push(seq);
        } else {
          for (const key of EVENT_CONTENT_KEYS) delete payload[key];
          if (!keepsClosureTarget(payload.closureReason, payload.closureTarget)) delete payload.closureTarget;
          payload.contentErased = true;
          plan.events.rewrite.push([JSON.stringify(payload), seq]);
        }
      }
      return plan;
    };

    // 3. The rows, their events and their other copies, a batch per transaction. A row is listed once its batch has
    //    committed; its ledger lines are written in the transaction, before anything in it changes.
    stage = "rows";
    const perTransaction = Math.min(batchSize, ROWS_PER_TRANSACTION);
    for (let start = 0; start < candidates.length; start += perTransaction) {
      const chunk = candidates.slice(start, start + perTransaction);
      const plan = inBatch((batch) => {
        const planned = planBatch(chunk);
        if (!opts.apply) return planned;
        ledger([...planned.rows, ...planned.absent.map((qitemId) => ({ qitemId, action: "delete" as const }))], batch);
        for (const [payload, seq] of planned.events.rewrite) rewriteEvent.run(payload, seq);
        for (const seq of planned.events.remove) removeEvent.run(seq);
        eraseCopies(st, planned.owned.scrub, "scrub");
        eraseCopies(st, planned.owned.delete, "delete");
        const scrub = planned.rows.filter((row) => row.action === "scrub").map((row) => row.qitemId);
        const remove = [...planned.rows.filter((row) => row.action === "delete").map((row) => row.qitemId), ...planned.absent];
        if (scrub.length > 0) scrubRows(st, scrub, opts.nowIso);
        if (remove.length > 0) deleteRows(st, remove, opts.nowIso, reason);
        return planned;
      });
      const all = [...plan.owned.scrub, ...plan.owned.delete];
      report.linked.transitions += plan.counts.transitions;
      report.linked.archivedTransitions += plan.counts.archivedTransitions;
      report.linked.missionControl += plan.counts.missionControl;
      report.linked.outbox += all.filter((copy) => copy.table === "outbox_entries").length;
      report.linked.inbox += all.filter((copy) => copy.table === "inbox_entries").length;
      report.linked.streamActions += all.filter((copy) => copy.table === "stream_reader_actions" || copy.table === "stream_dispositions").length;
      for (const seq of plan.events.seqs) eventSeqs.add(seq);
      report.linked.events = eventSeqs.size;
      noteUnreadable(plan.unreadable);
      plannedActions.push(...plan.owned.delete.filter((copy) => copy.table === "stream_reader_actions").map((copy) => copy.id));
      plannedDispositions.push(...plan.owned.delete.filter((copy) => copy.table === "stream_dispositions").map((copy) => copy.id));
      report.keptCopies.push(...plan.kept);
      report.gaps.push(...plan.dropped);
      report.alreadyAbsent.push(...plan.absent);
      report.qitems.push(...plan.rows.map(({ qitemId, action, state }) => ({ qitemId, action, state })));
      afterBatch();
      await yieldToLoop();
    }
    if (absentAtSelect.length > 0) {
      // Rechecked as the markers are written: an id created since selection is live work, never certified absent.
      const certify = (batch: string | null) => {
        const present = new Set((st.get(`SELECT qitem_id AS id FROM queue_items WHERE qitem_id IN ${IDS}`)
          .all({ ids: JSON.stringify(absentAtSelect) }) as Array<{ id: string }>).map((row) => row.id));
        const absent = absentAtSelect.filter((id) => !present.has(id));
        if (opts.apply && absent.length > 0) {
          ledger(absent.map((qitemId) => ({ qitemId, action: "delete" as const })), batch);
          st.get(`INSERT OR IGNORE INTO queue_erased_ids (qitem_id, erased_at, reason) SELECT value, @now, @reason FROM json_each(@ids)`)
            .run({ ids: JSON.stringify(absent), now: opts.nowIso, reason });
        }
        return { absent, created: absentAtSelect.filter((id) => present.has(id)) };
      };
      const { absent, created } = inBatch(certify);
      report.gaps.push(...created.map((qitemId) => ({ code: "changed-during-run" as const, qitemId })));
      report.alreadyAbsent.push(...absent);
      afterBatch();
    }

    // 4. Account deletion's other passes, once every row is done.
    if (scope.kind === "members" && report.complete) {
      stage = "unlinked";
      report.unlinked = eraseUnlinked(db, st, {
        members, plannedActions, plannedDispositions, erasedRows: report.qitems.map((row) => row.qitemId),
      }, opts.apply);
      if (rig !== null) {
        stage = "rig";
        report.rig = { id: rig.id, found: rig.found, verified: rig.verified, erased: {}, left: {}, unknown: [] };
        await eraseRigRecords(db, st, { ...rig, members, digest: membersDigest(scope.members) }, opts.apply, opts.nowIso, report.rig);
      }
    }
  } catch (err) {
    // Everything listed so far was committed; the caller keeps those ids, and a rerun continues.
    report.complete = false;
    report.error = { stage, message: err instanceof Error ? err.message : String(err) };
  }

  const unlinkedLeft = report.unlinked ? report.unlinked.mixedEntries + report.unlinked.referencedStreamItems : 0;
  const rigLeft = report.rig ? Object.values(report.rig.left).reduce((sum, n) => sum + n, 0) + report.rig.unknown.length : 0;
  report.clean = report.complete && report.mixed.length === 0 && report.gaps.length === 0 && unlinkedLeft === 0 && rigLeft === 0
    && report.unreadableEvents.length === 0 && !report.keptCopies.some((copy) => copy.ownership === "mixed");
  return report;
}

/** Account deletion's second pass: outbox and inbox entries between two members that no queue row owns, and the
 *  members' stream items. An entry with one member endpoint, or a stream item something still references, is counted
 *  and left. Rows and references this run erases are counted as they were before it, so a dry run and an apply report
 *  the same set. */
function eraseUnlinked(db: Database.Database, st: Statements,
  plan: { members: string; plannedActions: string[]; plannedDispositions: string[]; erasedRows: string[] }, apply: boolean): NonNullable<EraseReport["unlinked"]> {
  // A row this run erased still owns its copies here: they were reported with it (keptCopies), not as unowned.
  const rows = "(SELECT qitem_id FROM queue_items UNION ALL SELECT value FROM json_each(@rows))";
  // COALESCE: an entry with no pointer is unowned, not unknown (NULL IN (...) would drop it from both counts).
  const ownedOutbox = `(COALESCE(audit_pointer, '') IN ${rows}
      OR (outbox_id LIKE 'wake-intent-%' AND substr(outbox_id, 13) IN ${rows}))`;
  const ownedInbox = `(COALESCE(absorbed_qitem_id, '') IN ${rows} OR COALESCE(audit_pointer, '') IN ${rows})`;
  const both = `sender_session IN ${MEMBERS} AND destination_session IN ${MEMBERS}`;
  const fromMember = `sender_session IN ${MEMBERS} AND destination_session NOT IN ${MEMBERS}`;
  const toMember = `destination_session IN ${MEMBERS} AND sender_session NOT IN ${MEMBERS}`;
  // The same references the stream pass keeps an item for (queue-retention pruneStreamItems), less this run's own.
  const classificationColumns = new Set((db.prepare("PRAGMA table_info(project_classifications)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  const notPlannedAction = "action_id NOT IN (SELECT value FROM json_each(@actions))";
  const references = [
    "SELECT stream_item_id FROM project_classifications WHERE stream_item_id IS NOT NULL",
    ...(classificationColumns.has("duplicate_of_stream_item_id")
      ? ["SELECT duplicate_of_stream_item_id FROM project_classifications WHERE duplicate_of_stream_item_id IS NOT NULL"] : []),
    "SELECT stream_item_id FROM classification_attempts WHERE stream_item_id IS NOT NULL",
    "SELECT stream_item_id FROM stream_dispositions WHERE stream_item_id IS NOT NULL AND stream_item_id NOT IN (SELECT value FROM json_each(@dispositions))",
    `SELECT stream_item_id FROM stream_reader_actions WHERE stream_item_id IS NOT NULL AND ${notPlannedAction}`,
    `SELECT duplicate_of FROM stream_reader_actions WHERE duplicate_of IS NOT NULL AND ${notPlannedAction}`,
  ];
  const referenced = `stream_item_id IN (${references.join(" UNION ")})`;
  const params = { members: plan.members, actions: JSON.stringify(plan.plannedActions), dispositions: JSON.stringify(plan.plannedDispositions),
    rows: JSON.stringify(plan.erasedRows) };
  const result = {
    outbox: st.count(`SELECT COUNT(*) AS n FROM outbox_entries WHERE ${both} AND NOT ${ownedOutbox}`, params),
    inbox: st.count(`SELECT COUNT(*) AS n FROM inbox_entries WHERE ${both} AND NOT ${ownedInbox}`, params),
    streamItems: st.count(`SELECT COUNT(*) AS n FROM stream_items WHERE source_session IN ${MEMBERS} AND NOT ${referenced}`, params),
    // A row's own copies are reported with that row (mixed, keptCopies); these are the entries no row owns.
    mixedEntries: [fromMember, toMember].reduce((sum, where) =>
      sum + st.count(`SELECT COUNT(*) AS n FROM outbox_entries WHERE ${where} AND NOT ${ownedOutbox}`, params)
      + st.count(`SELECT COUNT(*) AS n FROM inbox_entries WHERE ${where} AND NOT ${ownedInbox}`, params), 0),
    referencedStreamItems: st.count(`SELECT COUNT(*) AS n FROM stream_items WHERE source_session IN ${MEMBERS} AND ${referenced}`, params),
  };
  if (apply) {
    db.transaction(() => {
      st.get(`DELETE FROM outbox_entries WHERE ${both} AND NOT ${ownedOutbox}`).run(params);
      st.get(`DELETE FROM inbox_entries WHERE ${both} AND NOT ${ownedInbox}`).run(params);
      st.get(`DELETE FROM stream_items WHERE source_session IN ${MEMBERS} AND NOT ${referenced}`).run(params);
    })();
  }
  return result;
}

// The account rig's own records that outlive the rig (no cascading key to it), in delete order: dependents first.
// byRigId: keyed by the rig's id alone, so erased only for a verified id. NODES: the rig's nodes, while it has them.
const NODES = "(SELECT id FROM nodes WHERE rig_id = @rig)";
const RIG_RECORDS: Array<{ table: string; where: string; byRigId: boolean }> = [
  { table: "events", where: "rig_id = @rig", byRigId: true },
  { table: "events", where: `node_id IN ${NODES}`, byRigId: false },
  { table: "snapshots", where: "rig_id = @rig", byRigId: true },
  { table: "operation_correlations", where: "rig_id = @rig", byRigId: true },
  { table: "bootstrap_actions", where: "bootstrap_id IN (SELECT id FROM bootstrap_runs WHERE rig_id = @rig)", byRigId: true },
  { table: "bootstrap_runs", where: "rig_id = @rig", byRigId: true },
  { table: "seat_identity_verdicts", where: `node_id IN ${NODES} OR session_name IN ${MEMBERS}`, byRigId: false },
  { table: "seat_delivery_guard_changes", where: `node_id IN ${NODES}`, byRigId: false },
  { table: "environment_operations",
    where: `binding_id IN (SELECT binding_id FROM environment_bindings WHERE node_id IN ${NODES} OR seat IN ${MEMBERS})`, byRigId: false },
  { table: "environment_bindings", where: `node_id IN ${NODES} OR seat IN ${MEMBERS}`, byRigId: false },
  { table: "usage_samples", where: `node_id IN ${NODES} OR seat_session IN ${MEMBERS}`, byRigId: false },
  { table: "pi_usage_entries", where: `node_id IN ${NODES} OR seat_session IN ${MEMBERS}`, byRigId: false },
  { table: "pi_usage_charges", where: `seat_session IN ${MEMBERS}`, byRigId: false },
  { table: "watchdog_history",
    where: `delivery_target_session IN ${MEMBERS} OR job_id IN (SELECT job_id FROM watchdog_jobs WHERE target_session IN ${MEMBERS})`, byRigId: false },
  { table: "watchdog_jobs", where: `target_session IN ${MEMBERS}`, byRigId: false },
  { table: "stream_subscriptions", where: `reader_session IN ${MEMBERS}`, byRigId: false },
  { table: "thread_seat_map", where: `seat IN ${MEMBERS}`, byRigId: false },
  { table: "thread_part_map", where: `seat IN ${MEMBERS}`, byRigId: false },
];
// Records that name the account but also belong to someone or something else: counted and left. byName: matched by
// the rig's name, which an unverified removed rig doesn't have, so those are unknown rather than zero.
const RIG_RECORDS_LEFT: Array<{ table: string; where: string; byName: boolean }> = [
  { table: "watchdog_jobs", where: `registered_by_session IN ${MEMBERS} AND target_session NOT IN ${MEMBERS}`, byName: false },
  { table: "workflow_instances", where: `created_by_session IN ${MEMBERS}`, byName: false },
  { table: "workflow_instances", where: "bound_rig = @rigName", byName: true },
  { table: "workflow_specs", where: "target_rig = @rigName", byName: true },
  { table: "classifier_leases", where: `classifier_session IN ${MEMBERS} OR reclaimed_by_session IN ${MEMBERS}`, byName: false },
  { table: "views_custom", where: `registered_by_session IN ${MEMBERS}`, byName: false },
];
const RIG_RECORDS_CHUNK = 1_000;

/** The account rig's records, counted into `out` as each chunk commits, so a pass that stops partway still reports
 *  what it erased. */
async function eraseRigRecords(db: Database.Database, st: Statements,
  rig: { id: string; name: string | null; found: boolean; verified: boolean; completedAt: string | null; members: string; digest: string },
  apply: boolean, nowIso: string, out: NonNullable<EraseReport["rig"]>): Promise<void> {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name));
  const params = { rig: rig.id, rigName: rig.name ?? "", members: rig.members };
  const add = (into: Record<string, number>, table: string, n: number) => {
    into[table] = (into[table] ?? 0) + n;
  };
  for (const { table, where, byRigId } of RIG_RECORDS) {
    if (!tables.has(table)) continue;
    if (byRigId && !rig.verified) {
      // An unverified id: its records are counted and left, never erased on a guess.
      add(out.left, table, st.count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params));
      continue;
    }
    if (!apply) {
      add(out.erased, table, st.count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params));
      continue;
    }
    add(out.erased, table, 0);
    // In chunks by rowid (every one of these tables has one; a declared key can be NULL), so a large table (events)
    // never holds the daemon in one statement.
    const chunk = st.get(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${RIG_RECORDS_CHUNK})`);
    for (let changes = chunk.run(params).changes; changes > 0; changes = chunk.run(params).changes) {
      add(out.erased, table, changes);
      await yieldToLoop();
    }
  }
  const unknown = new Set<string>();
  for (const { table, where, byName } of RIG_RECORDS_LEFT) {
    if (!tables.has(table)) continue;
    if (byName && rig.name === null) {
      // No name to count by. After a completed erasure that's expected: these were empty when it completed.
      if (rig.completedAt === null) unknown.add(table);
    } else {
      add(out.left, table, st.count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params));
    }
  }
  out.unknown = [...unknown];
  const leftTotal = Object.values(out.left).reduce((sum, n) => sum + n, 0);
  if (rig.completedAt !== null) out.completedAt = rig.completedAt;
  if (apply && rig.verified) {
    if (rig.found) {
      // While the rig exists, its id and name are kept with this membership, so the run after its removal is verified.
      db.prepare(`INSERT INTO queue_erased_rigs (rig_id, rig_name, members_digest, verified_at, completed_at) VALUES (?, ?, ?, ?, NULL)
          ON CONFLICT(rig_id) DO UPDATE SET rig_name = excluded.rig_name, members_digest = excluded.members_digest,
          verified_at = excluded.verified_at, completed_at = NULL`).run(rig.id, rig.name, rig.digest, nowIso);
    } else if (leftTotal === 0 && unknown.size === 0 && rig.completedAt === null) {
      // After the removal, once nothing of the rig is left, the record becomes a completion receipt: the name goes,
      // and the id, membership digest and time stay, so an identical rerun (say, after a lost response) still
      // verifies and reports the same clean result.
      db.prepare("UPDATE queue_erased_rigs SET rig_name = '', completed_at = ? WHERE rig_id = ?").run(nowIso, rig.id);
      out.completedAt = nowIso;
    }
  }
}
