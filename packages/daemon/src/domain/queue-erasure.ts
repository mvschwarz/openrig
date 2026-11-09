import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
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
 * A run selects everything first, then walks the events table once in seq windows (no index serves a payload match,
 * and one statement over a large table would hold the daemon), then erases rows batch by batch, one transaction each
 * (better-sqlite3 commits a transaction on return and rolls it back on a throw), yielding between steps. With a
 * ledger path, each batch's ids and actions are appended there before the batch commits. A run that stops, by its
 * batch limit or an error, returns only what it committed; a rerun picks up the rest.
 */

/** The closed states routine retention may erase. `failed` stays out: account deletion covers it. */
export const CLOSED_QUEUE_STATES = ["done", "canceled", "denied", "handed-off"] as const;
/** The closure reasons whose closure_target is an id (a successor); for the others it can be a reason or note. */
const ID_CLOSURE_REASONS = ["handed_off_to", "superseded"] as const;

export type EraseAction = "scrub" | "delete";
export type EraseScope =
  | { kind: "members"; members: readonly string[]; rig?: string }
  | { kind: "ids"; entries: ReadonlyArray<{ qitemId: string; action: EraseAction }> }
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
  /** append each erased row's {qitemId, action, reason, erasedAt} here, one JSON line each, before its batch commits */
  ledgerPath?: string;
}

type Stage = "select" | "events" | "rows" | "unlinked" | "rig";
type CopyTable = "outbox_entries" | "inbox_entries" | "stream_reader_actions" | "stream_dispositions";

export interface EraseReport {
  ok: true;
  applied: boolean;
  scope: EraseScope["kind"];
  /** false when the run stopped at maxBatches or on an error; rerun to continue */
  complete: boolean;
  /** complete, and nothing was left: no mixed rows or copies, gaps, unknowns, or left-over entries or rig records */
  clean: boolean;
  /** why the run stopped early, and where; everything listed in qitems was committed before it */
  error?: { stage: Stage; message: string };
  /** rows erased (applied, committed) or that would be (dry run) */
  qitems: Array<{ qitemId: string; action: EraseAction; state: string }>;
  /** members scope: rows with exactly one member endpoint, left untouched */
  mixed: Array<{ qitemId: string; memberEndpoint: "source" | "destination" }>;
  /** rows not erased, and why: a workflow references them, or (ids scope) no such row to scrub */
  gaps: Array<{ code: "workflow-reference" | "not-found"; qitemId: string }>;
  /** ids scope, delete: rows already gone whose id marker is (re)written */
  alreadyAbsent: string[];
  /** an erased row's copies held with someone else: mixed (one of their sessions is the owner's) or foreign (none) */
  keptCopies: Array<{ table: CopyTable; id: string; qitemId: string; ownership: "mixed" | "foreign" }>;
  /** copies erased with the rows, or that would be */
  linked: { transitions: number; archivedTransitions: number; outbox: number; inbox: number; events: number; streamActions: number; missionControl: number };
  /** members scope: entries between members that no queue row owns; mixed ones are counted and left */
  unlinked?: { outbox: number; inbox: number; streamItems: number; mixedEntries: number; referencedStreamItems: number };
  /** members scope with rig: whether the rig was found and verified, its records erased and left per table, and the
   *  tables whose records can't be counted (an unverified removed rig) */
  rig?: { id: string; found: boolean; verified: boolean; erased: Record<string, number>; left: Record<string, number>; unknown: string[] };
  routine?: { contentDays: number; metadataDays: number };
}

const DEFAULT_BATCH = 500;
const DEFAULT_MAX_BATCHES = 10_000;
const DEFAULT_EVENTS_WINDOW = 1_000;

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
const ID_CLOSURES = ID_CLOSURE_REASONS.map((reason) => `'${reason}'`).join(", ");
/** The payload keys a row-naming event uses: queue events name it in qitemId; inbox, workflow and mission-control
 *  events use these others. */
const EVENT_ID_KEYS = ["qitemId", "promotedQitemId", "priorQitemId", "nextQitemId"] as const;
/** The content keys of row-naming events; a scrubbed event keeps its type and ids. closureTarget goes too, unless the
 *  closure names a successor. */
const EVENT_CONTENT_KEYS = ["summary", "reason", "error"] as const;

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
  st.get(`UPDATE queue_items SET body = '', summary = NULL, resolution = NULL, tags = NULL, blocked_on = NULL,
      chain_of_record = NULL, evidence_ref = NULL, human_detail = NULL, human_questions = NULL, human_answers = NULL,
      delegated_decision = NULL, last_nudge_input_box = NULL,
      closure_target = CASE WHEN closure_reason IN (${ID_CLOSURES}) THEN closure_target ELSE NULL END,
      content_erased_at = @now WHERE qitem_id IN ${IDS}`).run({ ...params, now: nowIso });
  for (const table of ["queue_transitions", "queue_transitions_archive"]) {
    st.get(`UPDATE ${table} SET transition_note = NULL, identity_principal = NULL,
        closure_target = CASE WHEN closure_reason IN (${ID_CLOSURES}) THEN closure_target ELSE NULL END
        WHERE qitem_id IN ${IDS}`).run(params);
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

/** One pass over events in seq windows: each event naming a target row is scrubbed or deleted with it (a delete wins
 *  when an event names two). Returns the number matched. */
async function walkEvents(db: Database.Database, targets: Map<string, EraseAction>, apply: boolean, window: number): Promise<number> {
  if (targets.size === 0) return 0;
  const top = (db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null }).seq ?? 0;
  // instr is a cheap prefilter: every id key ends in "temId" (qitemId, promotedQitemId, ...).
  const read = db.prepare("SELECT seq, payload FROM events WHERE seq > ? AND seq <= ? AND instr(payload, 'temId') > 0");
  const rewrite = db.prepare("UPDATE events SET payload = ? WHERE seq = ?");
  const remove = db.prepare("DELETE FROM events WHERE seq = ?");
  let matched = 0;
  for (let lo = 0; lo < top; lo += window) {
    const scrub: Array<[string, number]> = [];
    const drop: number[] = [];
    for (const row of read.all(lo, lo + window) as Array<{ seq: number; payload: string }>) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const actions = EVENT_ID_KEYS.map((key) => payload[key]).filter((id): id is string => typeof id === "string")
        .map((id) => targets.get(id)).filter((action): action is EraseAction => action !== undefined);
      if (actions.length === 0) continue;
      matched += 1;
      if (actions.includes("delete")) {
        drop.push(row.seq);
      } else {
        for (const key of EVENT_CONTENT_KEYS) delete payload[key];
        if (!ID_CLOSURE_REASONS.includes(payload.closureReason as (typeof ID_CLOSURE_REASONS)[number])) delete payload.closureTarget;
        payload.contentErased = true;
        scrub.push([JSON.stringify(payload), row.seq]);
      }
    }
    if (apply && (scrub.length > 0 || drop.length > 0)) {
      db.transaction(() => {
        for (const [payload, seq] of scrub) rewrite.run(payload, seq);
        for (const seq of drop) remove.run(seq);
      })();
    }
    await yieldToLoop();
  }
  return matched;
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

/** Erase queue rows in one scope. With apply false it reports exactly what an apply would erase and writes nothing. */
export async function eraseQueue(db: Database.Database, opts: EraseOptions): Promise<EraseReport> {
  const st = new Statements(db);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  const { scope } = opts;

  // A rig named with the members must be theirs, both ways: every member is one of its sessions, and every session of
  // it is a member. A rig already removed is verified only by the record an earlier run kept with this membership.
  let rig: { id: string; name: string | null; found: boolean; verified: boolean } | null = null;
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
      rig = { id: scope.rig, name, found: true, verified: true };
    } else {
      const kept = db.prepare("SELECT rig_name AS name, members_digest AS digest FROM queue_erased_rigs WHERE rig_id = ?")
        .get(scope.rig) as { name: string; digest: string } | undefined;
      const verified = kept?.digest === membersDigest(scope.members);
      rig = { id: scope.rig, name: verified ? kept!.name : null, found: false, verified };
    }
  }

  const report: EraseReport = {
    ok: true, applied: opts.apply, scope: scope.kind, complete: true, clean: false, qitems: [], mixed: [], gaps: [],
    alreadyAbsent: [], keptCopies: [],
    linked: { transitions: 0, archivedTransitions: 0, outbox: 0, inbox: 0, events: 0, streamActions: 0, missionControl: 0 },
  };
  if (scope.kind === "routine") report.routine = { contentDays: scope.contentDays, metadataDays: scope.metadataDays };
  const reason = scope.kind === "members" ? "account-deletion" : scope.kind === "routine" ? "retention-metadata" : "erase-by-id";
  const memberSet = new Set(scope.kind === "members" ? scope.members : []);
  const members = JSON.stringify([...memberSet]);
  const entries = scope.kind === "ids"
    ? [...new Map(scope.entries.map((entry) => [entry.qitemId, entry.action])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
  const contentCutoff = scope.kind === "routine" && scope.contentDays > 0 ? cutoffIso(opts.nowIso, scope.contentDays) : null;
  const metadataCutoff = scope.kind === "routine" && scope.metadataDays > 0 ? cutoffIso(opts.nowIso, scope.metadataDays) : null;

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
        else if (action === "delete") report.alreadyAbsent.push(id);
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
      const since = closedSince(st, row.qitemId, row.state, tsUpdated);
      // A scrubbed row written to since (a note or summary appends a transition without touching ts_updated; a reclose
      // moves both) has content again.
      const hasContent = !erasedAt || tsUpdated > erasedAt
        || st.get("SELECT 1 FROM queue_transitions WHERE qitem_id = @q AND ts > @since LIMIT 1").get({ q: row.qitemId, since: erasedAt }) !== undefined;
      if (metadataCutoff && since < metadataCutoff) rows.push({ ...row, action: "delete" });
      else if (contentCutoff && since < contentCutoff && hasContent) rows.push({ ...row, action: "scrub" });
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
  const ledger = (rows: Array<{ qitemId: string; action: EraseAction }>) => {
    if (!opts.apply || !opts.ledgerPath || rows.length === 0) return;
    appendFileSync(opts.ledgerPath, rows.map((row) => JSON.stringify({ qitemId: row.qitemId, action: row.action, reason, erasedAt: opts.nowIso })).join("\n") + "\n");
  };

  let stage: Stage = "select";
  try {
    // 1. Select every candidate, writing nothing.
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

    // 2. Events naming a candidate: one walk over the table, before the rows go.
    stage = "events";
    report.linked.events = await walkEvents(db, new Map(candidates.map((row) => [row.qitemId, row.action])), opts.apply,
      opts.eventsWindow ?? DEFAULT_EVENTS_WINDOW);

    // 3. The rows and their other copies, a batch per transaction. A row is listed once its batch has committed.
    stage = "rows";
    for (let start = 0; start < candidates.length; start += batchSize) {
      const chunk = candidates.slice(start, start + batchSize);
      const ids = chunk.map((row) => row.qitemId);
      const byId = new Map(chunk.map((row) => [row.qitemId, row]));
      const owned: Record<EraseAction, Copy[]> = { scrub: [], delete: [] };
      const kept: EraseReport["keptCopies"] = [];
      for (const copy of linkedCopies(st, ids)) {
        const candidate = byId.get(copy.qitemId)!;
        const whose = ownership(copy, ownerOf(candidate));
        if (whose === "owned") owned[candidate.action].push(copy);
        else kept.push({ table: copy.table, id: copy.id, qitemId: copy.qitemId, ownership: whose });
      }
      const params = { ids: JSON.stringify(ids) };
      const counts = {
        transitions: st.count(`SELECT COUNT(*) AS n FROM queue_transitions WHERE qitem_id IN ${IDS}`, params),
        archivedTransitions: st.count(`SELECT COUNT(*) AS n FROM queue_transitions_archive WHERE qitem_id IN ${IDS}`, params),
        missionControl: st.count(`SELECT COUNT(*) AS n FROM mission_control_actions WHERE qitem_id IN ${IDS}`, params),
      };
      if (opts.apply) {
        ledger(chunk);
        db.transaction(() => {
          const scrub = chunk.filter((row) => row.action === "scrub").map((row) => row.qitemId);
          const remove = chunk.filter((row) => row.action === "delete").map((row) => row.qitemId);
          eraseCopies(st, owned.scrub, "scrub");
          eraseCopies(st, owned.delete, "delete");
          if (scrub.length > 0) scrubRows(st, scrub, opts.nowIso);
          if (remove.length > 0) deleteRows(st, remove, opts.nowIso, reason);
        })();
      }
      const all = [...owned.scrub, ...owned.delete];
      report.linked.transitions += counts.transitions;
      report.linked.archivedTransitions += counts.archivedTransitions;
      report.linked.missionControl += counts.missionControl;
      report.linked.outbox += all.filter((copy) => copy.table === "outbox_entries").length;
      report.linked.inbox += all.filter((copy) => copy.table === "inbox_entries").length;
      report.linked.streamActions += all.filter((copy) => copy.table === "stream_reader_actions" || copy.table === "stream_dispositions").length;
      plannedActions.push(...owned.delete.filter((copy) => copy.table === "stream_reader_actions").map((copy) => copy.id));
      plannedDispositions.push(...owned.delete.filter((copy) => copy.table === "stream_dispositions").map((copy) => copy.id));
      report.keptCopies.push(...kept);
      report.qitems.push(...chunk.map(({ qitemId, action, state }) => ({ qitemId, action, state })));
      await yieldToLoop();
    }
    if (opts.apply && report.alreadyAbsent.length > 0) {
      ledger(report.alreadyAbsent.map((qitemId) => ({ qitemId, action: "delete" as const })));
      db.transaction(() => {
        st.get(`INSERT OR IGNORE INTO queue_erased_ids (qitem_id, erased_at, reason) SELECT value, @now, @reason FROM json_each(@ids)`)
          .run({ ids: JSON.stringify(report.alreadyAbsent), now: opts.nowIso, reason });
      })();
    }

    // 4. Account deletion's other passes, once every row is done.
    if (scope.kind === "members" && report.complete) {
      stage = "unlinked";
      report.unlinked = eraseUnlinked(db, st, { members, plannedActions, plannedDispositions }, opts.apply);
      if (rig !== null) {
        stage = "rig";
        report.rig = await eraseRigRecords(db, st, { ...rig, members, digest: membersDigest(scope.members) }, opts.apply, opts.nowIso);
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
    && !report.keptCopies.some((copy) => copy.ownership === "mixed");
  return report;
}

/** Account deletion's second pass: outbox and inbox entries between two members that no queue row owns, and the
 *  members' stream items. An entry with one member endpoint, or a stream item something still references, is counted
 *  and left. References this run deletes are left out in a dry run too, so both report the same set. */
function eraseUnlinked(db: Database.Database, st: Statements,
  plan: { members: string; plannedActions: string[]; plannedDispositions: string[] }, apply: boolean): NonNullable<EraseReport["unlinked"]> {
  // COALESCE: an entry with no pointer is unowned, not unknown (NULL IN (...) would drop it from both counts).
  const ownedOutbox = `(COALESCE(audit_pointer, '') IN (SELECT qitem_id FROM queue_items)
      OR (outbox_id LIKE 'wake-intent-%' AND substr(outbox_id, 13) IN (SELECT qitem_id FROM queue_items)))`;
  const ownedInbox = `(COALESCE(absorbed_qitem_id, '') IN (SELECT qitem_id FROM queue_items)
      OR COALESCE(audit_pointer, '') IN (SELECT qitem_id FROM queue_items))`;
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
  const params = { members: plan.members, actions: JSON.stringify(plan.plannedActions), dispositions: JSON.stringify(plan.plannedDispositions) };
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

async function eraseRigRecords(db: Database.Database, st: Statements,
  rig: { id: string; name: string | null; found: boolean; verified: boolean; members: string; digest: string }, apply: boolean,
  nowIso: string): Promise<NonNullable<EraseReport["rig"]>> {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name));
  const params = { rig: rig.id, rigName: rig.name ?? "", members: rig.members };
  const erased: Record<string, number> = {};
  const left: Record<string, number> = {};
  const unknown = new Set<string>();
  const add = (into: Record<string, number>, table: string, n: number) => {
    into[table] = (into[table] ?? 0) + n;
  };
  for (const { table, where, byRigId } of RIG_RECORDS) {
    if (!tables.has(table)) continue;
    const n = st.count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
    if (byRigId && !rig.verified) {
      // An unverified id: its records are counted and left, never erased on a guess.
      add(left, table, n);
      continue;
    }
    add(erased, table, n);
    if (!apply || n === 0) continue;
    // In chunks by rowid (every one of these tables has one; a declared key can be NULL), so a large table (events)
    // never holds the daemon in one statement.
    const chunk = st.get(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${RIG_RECORDS_CHUNK})`);
    while (chunk.run(params).changes > 0) await yieldToLoop();
  }
  for (const { table, where, byName } of RIG_RECORDS_LEFT) {
    if (!tables.has(table)) continue;
    if (byName && rig.name === null) unknown.add(table);
    else add(left, table, st.count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params));
  }
  const leftTotal = Object.values(left).reduce((sum, n) => sum + n, 0);
  if (apply && rig.verified) {
    if (rig.found) {
      // While the rig exists, its id and name are kept with this membership, so the run after its removal is verified.
      db.prepare(`INSERT INTO queue_erased_rigs (rig_id, rig_name, members_digest, verified_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(rig_id) DO UPDATE SET rig_name = excluded.rig_name, members_digest = excluded.members_digest,
          verified_at = excluded.verified_at`).run(rig.id, rig.name, rig.digest, nowIso);
    } else if (leftTotal === 0) {
      // After the removal, once nothing of the rig is left, the record goes too.
      db.prepare("DELETE FROM queue_erased_rigs WHERE rig_id = ?").run(rig.id);
    }
  }
  return { id: rig.id, found: rig.found, verified: rig.verified, erased, left, unknown: [...unknown] };
}
