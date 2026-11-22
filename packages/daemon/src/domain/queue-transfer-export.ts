import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDaemonVersion } from "./daemon-version.js";
import { SelfHostIdentityStore } from "./seat-identity-store.js";
import {
  canonicalQueueJson, checkQueueTransferSize, QUEUE_TRANSFER_FORMAT, QUEUE_TRANSFER_MAX_BYTES,
  QueueTransferError, sealQueueTransfer, type QueueTransferObject,
} from "./queue-transfer-format.js";

export type QueueExportSelection = { readonly kind: "host" } | {
  readonly kind: "rig" | "mission" | "slice" | "qitems";
  readonly names: readonly string[];
};

// Explicit projections are a disclosure boundary. SQLite TEXT, including JSON text, is copied verbatim.
export const QUEUE_TRANSFER_COLUMNS = {
  queue_items: [
    // 024:23–45
    "qitem_id", "ts_created", "ts_updated", "source_session", "destination_session", "state", "priority", "tier", "tags",
    "blocked_on", "handed_off_to", "handed_off_from", "expires_at", "chain_of_record", "body", "closure_reason",
    "closure_target", "closure_required_at", "claimed_at", "last_nudge_attempt", "last_nudge_result", "last_heartbeat", "resolution",
    // 039:19, 044:24, 048:21, 063:27–28, 081:6–7, 090:7, 091:7–8, 116:8, 123:9, 155:15, 172:9–10
    "target_repo", "summary", "evidence_ref", "minting_generation_uuid", "claimed_by_generation_uuid", "human_intent",
    "human_detail", "reply_to", "human_questions", "human_answers", "last_nudge_input_box", "delegated_decision",
    "content_erased_at", "return_route", "return_route_basis",
  ],
  // 025:17–24, 067:15, 140:15, 076:11–12. Archive base and archived_at 054:38–46; additions 082:7, 140:16, 076:13–14.
  queue_transitions: ["transition_id", "qitem_id", "ts", "state", "transition_note", "actor_session", "closure_reason",
    "closure_target", "identity_provenance", "identity_principal", "owner_notification_kind", "owner_notification_level"],
  // 073:10–15
  queue_transition_wakes: ["transition_id", "qitem_id", "phase", "wake_kind", "wake_ref", "delivery_status"],
  // 037:59–71, 065:18
  mission_control_actions: ["action_id", "action_verb", "qitem_id", "actor_session", "acted_at", "before_state_json",
    "after_state_json", "reason", "annotation", "notify_attempted", "notify_result", "audit_notes_json", "identity_provenance"],
  // 155:17–19,22–26
  queue_erased_ids: ["qitem_id", "erased_at", "reason"],
  queue_erased_rigs: ["rig_id", "rig_name", "members_digest", "verified_at", "completed_at"],
} as const;

type SqlRow = Record<string, string | number | null>;
type ExportRow = QueueTransferObject & {
  readonly qitemId: string;
  readonly transitions: readonly QueueTransferObject[];
  readonly wakeEvidence: readonly QueueTransferObject[];
  readonly missionControlActions: readonly QueueTransferObject[];
};
function wireRow(row: SqlRow): QueueTransferObject {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]));
}

function scrubClosureTarget(row: SqlRow): void {
  const target = row.closure_target;
  if ((row.closure_reason !== "superseded" && row.closure_reason !== "handed_off_to") ||
      typeof target !== "string" || target.length > 256 ||
      !/^(?:qitem-[\w.-]+(?:@[\w.-]+)?|[a-zA-Z0-9][\w.-]*@[\w.-]+(?:@[\w.-]+)?)$/.test(target)) {
    row.closure_target = null;
  }
}

export function readQueueTransfer(db: Database.Database, selection: QueueExportSelection, maxBytes = QUEUE_TRANSFER_MAX_BYTES) {
  const names = selection.kind === "host" ? [] : [...new Set(selection.names)].sort();
  if (selection.kind !== "host" && (!names.length || names.some(name => !name || name.trim() !== name))) {
    throw new QueueTransferError("selection_invalid", "name a non-empty set of exact scope values");
  }
  const createdAt = new Date().toISOString();
  return db.transaction(() => {
    const host = new SelfHostIdentityStore(db).get();
    if (!host?.hostId || !host.mintedAt || !host.reconciledAt) {
      throw new QueueTransferError("origin_identity_missing", "no reconciled self-host identity in the source store");
    }
    const scopeValues = `(SELECT value FROM json_each(@names))`;
    const rigEndpoint = (column: string) => `EXISTS (SELECT 1 FROM json_each(@names)
      WHERE substr(${column}, instr(${column}, '@') + 1) IN (value, value || '@' || @host)) AND instr(${column}, '@') > 0`;
    const predicate = {
      host: "1", qitems: `qitem_id IN ${scopeValues}`, rig: `(${rigEndpoint("source_session")}) OR (${rigEndpoint("destination_session")})`,
      mission: "EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN (SELECT 'mission:' || value FROM json_each(@names)))",
      slice: "EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN (SELECT 'slice:' || value FROM json_each(@names)))",
    }[selection.kind];
    const params = { names: JSON.stringify(names), host: host.hostId };
    const statement = (sql: string) => db.prepare<unknown[], SqlRow>(sql);
    let bytes = 0;
    const read = (row: SqlRow) => {
      const value = wireRow(row);
      bytes += Buffer.byteLength(canonicalQueueJson(value)) + 1;
      checkQueueTransferSize(bytes, maxBytes);
      return value;
    };
    const collect = (sql: string, bind: unknown, scrub?: (row: SqlRow) => void) => {
      const rows: QueueTransferObject[] = [];
      for (const row of statement(sql).iterate(bind)) {
        scrub?.(row);
        rows.push(read(row));
      }
      return rows;
    };
    const columns = QUEUE_TRANSFER_COLUMNS;
    const transitions = columns.queue_transitions.join(",");
    const rows: ExportRow[] = [];
    const ids: string[] = [];
    for (const item of statement(`SELECT ${columns.queue_items.join(",")} FROM queue_items WHERE ${predicate} ORDER BY qitem_id`).iterate(params)) {
      const id = item.qitem_id;
      if (typeof id !== "string") throw new QueueTransferError("selection_invalid", "source row has no qitem id");
      ids.push(id);
      const scrubbed = item.content_erased_at !== null;
      if (scrubbed) {
        item.body = "";
        for (const key of ["summary", "resolution", "tags", "blocked_on", "chain_of_record", "evidence_ref", "human_detail",
          "human_questions", "human_answers", "delegated_decision", "last_nudge_input_box"]) item[key] = null;
        scrubClosureTarget(item);
      }
      const row = read(item);
      const history = collect(`SELECT ${transitions}, NULL AS archived_at FROM queue_transitions WHERE qitem_id = @id
        UNION ALL SELECT ${transitions}, archived_at FROM queue_transitions_archive WHERE qitem_id = @id ORDER BY ts, transition_id`, { id },
      scrubbed ? transition => { transition.transition_note = null; transition.identity_principal = null; scrubClosureTarget(transition); } : undefined);
      const wakeEvidence = collect(`SELECT ${columns.queue_transition_wakes.join(",")} FROM queue_transition_wakes
        WHERE qitem_id = ? ORDER BY transition_id`, id);
      const missionControlActions = collect(`SELECT ${columns.mission_control_actions.join(",")} FROM mission_control_actions
        WHERE qitem_id = ? ORDER BY acted_at, action_id`, id, scrubbed ? action => {
        for (const key of ["before_state_json", "after_state_json", "reason", "annotation", "notify_result", "audit_notes_json"]) action[key] = null;
      } : undefined);
      rows.push({ ...row, qitemId: id, transitions: history, wakeEvidence, missionControlActions });
    }
    const erasedIds = selection.kind === "qitems" ? collect(`SELECT ${columns.queue_erased_ids.join(",")} FROM queue_erased_ids
      WHERE qitem_id IN ${scopeValues} ORDER BY qitem_id`, params) : [];
    const erasedRigs = selection.kind === "rig" ? collect(`SELECT ${columns.queue_erased_rigs.join(",")} FROM queue_erased_rigs
      WHERE rig_id IN ${scopeValues} OR rig_name IN ${scopeValues} ORDER BY rig_id`, params) : [];
    const selectedIds = [...ids, ...erasedIds.map(row => String(row.qitemId))].sort();
    if (selection.kind === "qitems") {
      const found = new Set(selectedIds);
      const missing = names.filter(name => !found.has(name));
      if (missing.length) throw new QueueTransferError("selection_not_found", `unknown qitem ids: ${missing.join(", ")}`);
    }
    const scope = { kind: selection.kind, rigs: selection.kind === "rig" ? names : [],
      missions: selection.kind === "mission" ? names : [], slices: selection.kind === "slice" ? names : [],
      qitemIds: selectedIds, includeClosed: true, selectionShownAt: createdAt };
    const migration = statement("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1").get();
    return { format: QUEUE_TRANSFER_FORMAT, transferId: `xfer-${randomUUID()}`, createdAt,
      origin: { hostId: host.hostId, mintedAt: host.mintedAt, openrigVersion: getDaemonVersion(), schemaMigration: migration?.name ?? null },
      scope, rows, erasedIds, erasedRigs };
  })();
}

export function buildQueueTransfer(db: Database.Database, selection: QueueExportSelection) {
  const snapshot = readQueueTransfer(db, selection);
  const archive = sealQueueTransfer(snapshot, QUEUE_TRANSFER_MAX_BYTES);
  return { archive, scope: snapshot.scope, origin: snapshot.origin,
    rows: snapshot.rows.map(row => ({ qitemId: row.qitemId, state: row.state, transitions: row.transitions.length,
      wakeEvidence: row.wakeEvidence.length, missionControlActions: row.missionControlActions.length })),
    erasedIds: snapshot.erasedIds, erasedRigs: snapshot.erasedRigs };
}
