import type Database from "better-sqlite3";

/**
 * Queue erasure: the maintained way to remove queue content, for closed-work retention and account deletion on a
 * daemon that serves several accounts. Two actions on a queue row:
 * - scrub: the row's content is removed and the row stays, content-free, with its id, endpoints, state and times
 *   (`content_erased_at` set). The create path's retry identity still finds it, so a retried create makes no new work.
 * - delete: the row and everything linked to it go. Only its id is kept, in `queue_erased_ids` (no endpoints, no
 *   content), and the create path refuses that id (`qitem_erased`).
 * Linked copies follow the row: its transitions, live and archived; outbox entries that point at it or wake for it;
 * the inbox entry it was absorbed from; stream dispositions and reader actions naming it; events whose payload names
 * it; and its mission-control audit rows.
 *
 * Scope is exact. Account deletion takes the account's recorded membership (exact session names): a row whose two
 * endpoints are both members is deleted, whatever its state; a row with one member endpoint is reported as mixed and
 * left untouched. Named with the account's rig, it also removes the rig's own records that outlive the rig: its events,
 * snapshots and node and seat records. Routine retention touches only closed rows (done, canceled, denied, handed-off; never failed or
 * open work), aged from the start of their final closed state. A row a workflow still references is reported, never
 * erased. Each batch is one transaction, so a run that stops leaves whole rows done; a rerun picks up the rest.
 */

/** The closed states routine retention may erase. `failed` stays out: account deletion covers it. */
export const CLOSED_QUEUE_STATES = ["done", "canceled", "denied", "handed-off"] as const;

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
  /** a run stops after this many batches and reports complete: false; a rerun continues */
  maxBatches?: number;
}

export interface EraseReport {
  ok: true;
  applied: boolean;
  scope: EraseScope["kind"];
  /** false when the run stopped at maxBatches; rerun to continue */
  complete: boolean;
  /** complete, and nothing was left: no mixed rows, gaps, or left-over entries or rig records */
  clean: boolean;
  /** rows erased (applied) or that would be (dry run) */
  qitems: Array<{ qitemId: string; action: EraseAction; state: string }>;
  /** members scope: rows with exactly one member endpoint, left untouched */
  mixed: Array<{ qitemId: string; memberEndpoint: "source" | "destination" }>;
  /** rows not erased, and why: a workflow references them, or (ids scope) no such row to scrub */
  gaps: Array<{ code: "workflow-reference" | "not-found"; qitemId: string }>;
  /** ids scope, delete: rows already gone whose id marker is (re)written */
  alreadyAbsent: string[];
  /** copies erased with the rows, or that would be */
  linked: { transitions: number; archivedTransitions: number; outbox: number; inbox: number; events: number; streamActions: number; missionControl: number };
  /** members scope: entries between members that no queue row owns; mixed ones are counted and left */
  unlinked?: { outbox: number; inbox: number; streamItems: number; mixedEntries: number; referencedStreamItems: number };
  /** members scope with rig: the rig's records erased per table, and the ones left (another seat's, or a workflow's) */
  rig?: { id: string; found: boolean; erased: Record<string, number>; left: Record<string, number> };
  routine?: { contentDays: number; metadataDays: number };
}

const DEFAULT_BATCH = 500;
const DEFAULT_MAX_BATCHES = 10_000;

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
// Queue events name their row in qitemId; inbox, workflow and mission-control events use these other keys.
const EVENT_LINK = `json_valid(payload) AND (json_extract(payload, '$.qitemId') IN ${IDS}
  OR json_extract(payload, '$.promotedQitemId') IN ${IDS} OR json_extract(payload, '$.priorQitemId') IN ${IDS}
  OR json_extract(payload, '$.nextQitemId') IN ${IDS})`;
const OUTBOX_LINK = `audit_pointer IN ${IDS} OR outbox_id IN (SELECT 'wake-intent-' || value FROM json_each(@ids))`;
const INBOX_LINK = `absorbed_qitem_id IN ${IDS} OR audit_pointer IN ${IDS}`;
const DISPOSITION_LINK = `work_qitem_id IN ${IDS} OR effect_qitem_id IN ${IDS}`;
const READER_ACTION_LINK = `work_qitem_id IN ${IDS}`;

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

function countLinked(st: Statements, ids: string[]): EraseReport["linked"] {
  const params = { ids: JSON.stringify(ids) };
  return {
    transitions: st.count(`SELECT COUNT(*) AS n FROM queue_transitions WHERE qitem_id IN ${IDS}`, params),
    archivedTransitions: st.count(`SELECT COUNT(*) AS n FROM queue_transitions_archive WHERE qitem_id IN ${IDS}`, params),
    outbox: st.count(`SELECT COUNT(*) AS n FROM outbox_entries WHERE ${OUTBOX_LINK}`, params),
    inbox: st.count(`SELECT COUNT(*) AS n FROM inbox_entries WHERE ${INBOX_LINK}`, params),
    events: st.count(`SELECT COUNT(*) AS n FROM events WHERE ${EVENT_LINK}`, params),
    streamActions: st.count(`SELECT COUNT(*) AS n FROM stream_dispositions WHERE ${DISPOSITION_LINK}`, params)
      + st.count(`SELECT COUNT(*) AS n FROM stream_reader_actions WHERE ${READER_ACTION_LINK}`, params),
    missionControl: st.count(`SELECT COUNT(*) AS n FROM mission_control_actions WHERE qitem_id IN ${IDS}`, params),
  };
}

function scrubRows(st: Statements, ids: string[], nowIso: string): void {
  const params = { ids: JSON.stringify(ids) };
  st.get(`UPDATE queue_items SET body = '', summary = NULL, resolution = NULL, tags = NULL, blocked_on = NULL,
      chain_of_record = NULL, evidence_ref = NULL, human_detail = NULL, human_questions = NULL, human_answers = NULL,
      delegated_decision = NULL, content_erased_at = @now WHERE qitem_id IN ${IDS}`).run({ ...params, now: nowIso });
  for (const table of ["queue_transitions", "queue_transitions_archive"]) {
    st.get(`UPDATE ${table} SET transition_note = NULL, identity_principal = NULL WHERE qitem_id IN ${IDS}`).run(params);
  }
  st.get(`UPDATE outbox_entries SET body = '', tags = NULL WHERE ${OUTBOX_LINK}`).run(params);
  st.get(`UPDATE inbox_entries SET body = '', tags = NULL, denied_reason = NULL WHERE ${INBOX_LINK}`).run(params);
  // The event stays readable as its type and row; its summary, reason and error text go.
  st.get(`UPDATE events SET payload = json_set(json_remove(payload, '$.summary', '$.reason', '$.error'),
      '$.contentErased', json('true')) WHERE ${EVENT_LINK}`).run(params);
  st.get(`UPDATE stream_dispositions SET template_text = '', request_json = '{}', provenance_json = '{}', reason = NULL,
      result_json = NULL, applied_json = NULL WHERE ${DISPOSITION_LINK}`).run(params);
  st.get(`UPDATE stream_reader_actions SET reason = NULL WHERE ${READER_ACTION_LINK}`).run(params);
  st.get(`UPDATE mission_control_actions SET before_state_json = NULL, after_state_json = NULL, reason = NULL,
      annotation = NULL, notify_result = NULL, audit_notes_json = NULL WHERE qitem_id IN ${IDS}`).run(params);
}

function deleteRows(st: Statements, ids: string[], nowIso: string, reason: string): void {
  const params = { ids: JSON.stringify(ids) };
  st.get(`DELETE FROM events WHERE ${EVENT_LINK}`).run(params);
  st.get(`DELETE FROM outbox_entries WHERE ${OUTBOX_LINK}`).run(params);
  st.get(`DELETE FROM inbox_entries WHERE ${INBOX_LINK}`).run(params);
  st.get(`DELETE FROM stream_reader_actions WHERE ${READER_ACTION_LINK}`).run(params);
  st.get(`DELETE FROM stream_dispositions WHERE ${DISPOSITION_LINK}`).run(params);
  // mission_control_actions references queue_items by key, so it goes before the row.
  st.get(`DELETE FROM mission_control_actions WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`DELETE FROM queue_transition_wakes WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`DELETE FROM queue_transitions WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`DELETE FROM queue_transitions_archive WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`DELETE FROM queue_items WHERE qitem_id IN ${IDS}`).run(params);
  st.get(`INSERT OR IGNORE INTO queue_erased_ids (qitem_id, erased_at, reason) SELECT value, @now, @reason FROM json_each(@ids)`)
    .run({ ...params, now: nowIso, reason });
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

function addLinked(total: EraseReport["linked"], batch: EraseReport["linked"]): void {
  for (const key of Object.keys(total) as Array<keyof EraseReport["linked"]>) total[key] += batch[key];
}

type Candidate = { qitemId: string; state: string; action: EraseAction };

/** Erase queue rows in one scope. With apply false it reports exactly what an apply would erase and writes nothing. */
export async function eraseQueue(db: Database.Database, opts: EraseOptions): Promise<EraseReport> {
  const st = new Statements(db);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  const { scope } = opts;
  // A rig named with the members must be theirs: every member session belongs to it. A rig already removed can't be
  // checked; its id is exact, so its leftover records are erased by id (found: false).
  let rigName: string | null = null;
  if (scope.kind === "members" && scope.rig !== undefined) {
    rigName = (db.prepare("SELECT name FROM rigs WHERE id = ?").get(scope.rig) as { name: string } | undefined)?.name ?? null;
    const outside = rigName === null ? [] : scope.members.filter((member) => member.split("@")[1] !== rigName);
    if (outside.length > 0) {
      throw new EraseRefusal("erase_rig_mismatch", `These members aren't sessions of rig ${rigName}: ${outside.join(", ")}.`);
    }
  }
  const report: EraseReport = {
    ok: true, applied: opts.apply, scope: scope.kind, complete: true, clean: false, qitems: [], mixed: [], gaps: [], alreadyAbsent: [],
    linked: { transitions: 0, archivedTransitions: 0, outbox: 0, inbox: 0, events: 0, streamActions: 0, missionControl: 0 },
  };
  if (scope.kind === "routine") report.routine = { contentDays: scope.contentDays, metadataDays: scope.metadataDays };
  const reason = scope.kind === "members" ? "account-deletion" : scope.kind === "routine" ? "retention-metadata" : "erase-by-id";
  const members = scope.kind === "members" ? JSON.stringify([...new Set(scope.members)]) : "[]";
  const entries = scope.kind === "ids"
    ? [...new Map(scope.entries.map((entry) => [entry.qitemId, entry.action])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
  const contentCutoff = scope.kind === "routine" && scope.contentDays > 0 ? cutoffIso(opts.nowIso, scope.contentDays) : null;
  const metadataCutoff = scope.kind === "routine" && scope.metadataDays > 0 ? cutoffIso(opts.nowIso, scope.metadataDays) : null;

  // One page of candidate rows, keyed on qitem_id so a dry run (which changes nothing) still moves forward.
  const page = (after: string, offset: number): { rows: Candidate[]; last: string | null; seen: number } => {
    if (scope.kind === "ids") {
      const slice = entries.slice(offset, offset + batchSize);
      const found = new Map((st.get(`SELECT qitem_id AS qitemId, state FROM queue_items WHERE qitem_id IN ${IDS}`)
        .all({ ids: JSON.stringify(slice.map(([id]) => id)) }) as Array<{ qitemId: string; state: string }>).map((row) => [row.qitemId, row.state]));
      const rows: Candidate[] = [];
      for (const [id, action] of slice) {
        const state = found.get(id);
        if (state !== undefined) rows.push({ qitemId: id, state, action });
        else if (action === "delete") report.alreadyAbsent.push(id);
        else report.gaps.push({ code: "not-found", qitemId: id });
      }
      return { rows, last: null, seen: slice.length };
    }
    if (scope.kind === "members") {
      const found = st.get(`SELECT qitem_id AS qitemId, state, source_session IN ${MEMBERS} AS fromMember,
          destination_session IN ${MEMBERS} AS toMember FROM queue_items
          WHERE qitem_id > @after AND (source_session IN ${MEMBERS} OR destination_session IN ${MEMBERS})
          ORDER BY qitem_id LIMIT @limit`).all({ members, after, limit: batchSize }) as
        Array<{ qitemId: string; state: string; fromMember: number; toMember: number }>;
      const rows: Candidate[] = [];
      for (const row of found) {
        if (row.fromMember && row.toMember) rows.push({ qitemId: row.qitemId, state: row.state, action: "delete" });
        else report.mixed.push({ qitemId: row.qitemId, memberEndpoint: row.fromMember ? "source" : "destination" });
      }
      return { rows, last: found.at(-1)?.qitemId ?? null, seen: found.length };
    }
    const closed = CLOSED_QUEUE_STATES.map((state) => `'${state}'`).join(", ");
    const found = st.get(`SELECT qitem_id AS qitemId, state, ts_updated AS tsUpdated, content_erased_at AS erasedAt
        FROM queue_items WHERE qitem_id > @after AND state IN (${closed}) ORDER BY qitem_id LIMIT @limit`)
      .all({ after, limit: batchSize }) as Array<{ qitemId: string; state: string; tsUpdated: string; erasedAt: string | null }>;
    const rows: Candidate[] = [];
    for (const row of found) {
      const since = closedSince(st, row.qitemId, row.state, row.tsUpdated);
      if (metadataCutoff && since < metadataCutoff) rows.push({ qitemId: row.qitemId, state: row.state, action: "delete" });
      else if (contentCutoff && since < contentCutoff && !row.erasedAt) rows.push({ qitemId: row.qitemId, state: row.state, action: "scrub" });
    }
    return { rows, last: found.at(-1)?.qitemId ?? null, seen: found.length };
  };

  const eraseBatch = db.transaction((rows: Candidate[]) => {
    const scrub = rows.filter((row) => row.action === "scrub").map((row) => row.qitemId);
    const remove = rows.filter((row) => row.action === "delete").map((row) => row.qitemId);
    if (scrub.length > 0) scrubRows(st, scrub, opts.nowIso);
    if (remove.length > 0) deleteRows(st, remove, opts.nowIso, reason);
  });
  const markAbsent = db.transaction((absent: string[]) => {
    st.get(`INSERT OR IGNORE INTO queue_erased_ids (qitem_id, erased_at, reason) SELECT value, @now, @reason FROM json_each(@ids)`)
      .run({ ids: JSON.stringify(absent), now: opts.nowIso, reason });
  });

  let after = "";
  let offset = 0;
  for (let batch = 0; ; batch += 1) {
    if (batch >= maxBatches) {
      report.complete = false;
      break;
    }
    const absentBefore = report.alreadyAbsent.length;
    const { rows, last, seen } = page(after, offset);
    if (seen === 0) break;
    const referenced = workflowReferenced(st, rows.map((row) => row.qitemId));
    const eligible = rows.filter((row) => !referenced.has(row.qitemId));
    for (const id of referenced) report.gaps.push({ code: "workflow-reference", qitemId: id });
    if (eligible.length > 0) {
      addLinked(report.linked, countLinked(st, eligible.map((row) => row.qitemId)));
      report.qitems.push(...eligible.map(({ qitemId, action, state }) => ({ qitemId, action, state })));
      if (opts.apply) eraseBatch(eligible);
    }
    if (opts.apply && report.alreadyAbsent.length > absentBefore) markAbsent(report.alreadyAbsent.slice(absentBefore));
    if (last !== null) after = last;
    offset += seen;
    if (seen < batchSize) break;
    await yieldToLoop();
  }

  if (scope.kind === "members" && report.complete) {
    report.unlinked = eraseUnlinked(db, st, members, opts.apply);
    if (scope.rig !== undefined) report.rig = eraseRigRecords(db, st, scope.rig, rigName, members, opts.apply);
  }
  const unlinkedLeft = report.unlinked ? report.unlinked.mixedEntries + report.unlinked.referencedStreamItems : 0;
  const rigLeft = report.rig ? Object.values(report.rig.left).reduce((sum, n) => sum + n, 0) : 0;
  report.clean = report.complete && report.mixed.length === 0 && report.gaps.length === 0 && unlinkedLeft === 0 && rigLeft === 0;
  return report;
}

// The account rig's own records that outlive the rig (no cascading key to it), in delete order: dependents first.
// NODES: the rig's nodes, while it still has them. MEMBERS: the account's sessions.
const NODES = "(SELECT id FROM nodes WHERE rig_id = @rig)";
const RIG_RECORDS: Array<[table: string, where: string]> = [
  ["events", `rig_id = @rig OR node_id IN ${NODES}`],
  ["snapshots", "rig_id = @rig"],
  ["operation_correlations", "rig_id = @rig"],
  ["bootstrap_actions", "bootstrap_id IN (SELECT id FROM bootstrap_runs WHERE rig_id = @rig)"],
  ["bootstrap_runs", "rig_id = @rig"],
  ["seat_identity_verdicts", `node_id IN ${NODES} OR session_name IN ${MEMBERS}`],
  ["seat_delivery_guard_changes", `node_id IN ${NODES}`],
  ["environment_operations", `binding_id IN (SELECT binding_id FROM environment_bindings WHERE node_id IN ${NODES} OR seat IN ${MEMBERS})`],
  ["environment_bindings", `node_id IN ${NODES} OR seat IN ${MEMBERS}`],
  ["usage_samples", `node_id IN ${NODES} OR seat_session IN ${MEMBERS}`],
  ["pi_usage_entries", `node_id IN ${NODES} OR seat_session IN ${MEMBERS}`],
  ["pi_usage_charges", `seat_session IN ${MEMBERS}`],
  ["watchdog_history", `delivery_target_session IN ${MEMBERS} OR job_id IN (SELECT job_id FROM watchdog_jobs WHERE target_session IN ${MEMBERS})`],
  ["watchdog_jobs", `target_session IN ${MEMBERS}`],
  ["stream_subscriptions", `reader_session IN ${MEMBERS}`],
  ["thread_seat_map", `seat IN ${MEMBERS}`],
  ["thread_part_map", `seat IN ${MEMBERS}`],
];
// Records that name the account but also belong to someone or something else: counted and left.
const RIG_RECORDS_LEFT: Array<[table: string, where: string]> = [
  ["watchdog_jobs", `registered_by_session IN ${MEMBERS} AND target_session NOT IN ${MEMBERS}`],
  ["workflow_instances", `created_by_session IN ${MEMBERS} OR bound_rig = @rigName`],
  ["workflow_specs", "target_rig = @rigName"],
  ["classifier_leases", `classifier_session IN ${MEMBERS} OR reclaimed_by_session IN ${MEMBERS}`],
  ["views_custom", `registered_by_session IN ${MEMBERS}`],
];

function eraseRigRecords(db: Database.Database, st: Statements, rig: string, rigName: string | null, members: string,
  apply: boolean): NonNullable<EraseReport["rig"]> {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name));
  const params = { rig, rigName: rigName ?? "", members };
  const erased: Record<string, number> = {};
  const left: Record<string, number> = {};
  const present = (list: Array<[string, string]>) => list.filter(([table]) => tables.has(table));
  for (const [table, where] of present(RIG_RECORDS)) erased[table] = st.count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
  for (const [table, where] of present(RIG_RECORDS_LEFT)) {
    // Without the rig's name (already removed), name-matched records can't be counted; @rigName '' matches nothing.
    left[table] = (left[table] ?? 0) + st.count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params);
  }
  if (apply) {
    db.transaction(() => {
      for (const [table, where] of present(RIG_RECORDS)) st.get(`DELETE FROM ${table} WHERE ${where}`).run(params);
    })();
  }
  return { id: rig, found: rigName !== null, erased, left };
}

/** Account deletion's second pass: outbox and inbox entries between two members that no queue row owns, and the
 *  members' stream items. An entry with one member endpoint, or a stream item something still references, is counted
 *  and left. */
function eraseUnlinked(db: Database.Database, st: Statements, members: string, apply: boolean): NonNullable<EraseReport["unlinked"]> {
  // COALESCE: an entry with no pointer is unowned, not unknown (NULL IN (...) would drop it from both counts).
  const ownedOutbox = `(COALESCE(audit_pointer, '') IN (SELECT qitem_id FROM queue_items)
      OR (outbox_id LIKE 'wake-intent-%' AND substr(outbox_id, 13) IN (SELECT qitem_id FROM queue_items)))`;
  const ownedInbox = `(COALESCE(absorbed_qitem_id, '') IN (SELECT qitem_id FROM queue_items)
      OR COALESCE(audit_pointer, '') IN (SELECT qitem_id FROM queue_items))`;
  const both = `sender_session IN ${MEMBERS} AND destination_session IN ${MEMBERS}`;
  const one = `(sender_session IN ${MEMBERS}) != (destination_session IN ${MEMBERS})`;
  // The same references the stream pass keeps an item for (queue-retention pruneStreamItems).
  const classificationColumns = new Set((db.prepare("PRAGMA table_info(project_classifications)").all() as Array<{ name: string }>)
    .map((column) => column.name));
  const references = [
    "SELECT stream_item_id FROM project_classifications WHERE stream_item_id IS NOT NULL",
    ...(classificationColumns.has("duplicate_of_stream_item_id")
      ? ["SELECT duplicate_of_stream_item_id FROM project_classifications WHERE duplicate_of_stream_item_id IS NOT NULL"] : []),
    "SELECT stream_item_id FROM classification_attempts WHERE stream_item_id IS NOT NULL",
    "SELECT stream_item_id FROM stream_dispositions WHERE stream_item_id IS NOT NULL",
    "SELECT stream_item_id FROM stream_reader_actions WHERE stream_item_id IS NOT NULL",
    "SELECT duplicate_of FROM stream_reader_actions WHERE duplicate_of IS NOT NULL",
  ];
  const referenced = `stream_item_id IN (${references.join(" UNION ")})`;
  const params = { members };
  const result = {
    outbox: st.count(`SELECT COUNT(*) AS n FROM outbox_entries WHERE ${both} AND NOT ${ownedOutbox}`, params),
    inbox: st.count(`SELECT COUNT(*) AS n FROM inbox_entries WHERE ${both} AND NOT ${ownedInbox}`, params),
    streamItems: st.count(`SELECT COUNT(*) AS n FROM stream_items WHERE source_session IN ${MEMBERS} AND NOT ${referenced}`, params),
    // A mixed row's own copies are already reported with that row (mixed); these are the entries no row owns.
    mixedEntries: st.count(`SELECT COUNT(*) AS n FROM outbox_entries WHERE ${one} AND NOT ${ownedOutbox}`, params)
      + st.count(`SELECT COUNT(*) AS n FROM inbox_entries WHERE ${one} AND NOT ${ownedInbox}`, params),
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
