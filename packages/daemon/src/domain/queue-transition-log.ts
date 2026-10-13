import type Database from "better-sqlite3";
import type { ClosureReason } from "./hot-potato-enforcer.js";
import { archiveWhereClause } from "./rig-repository.js";
import { isHumanSeatSessionRef, parseSessionName } from "./session-name.js";

export const OWNER_NOTIFICATION_LEVELS = ["RECORD", "NOTICE", "ALERT"] as const;
export type OwnerNotificationLevel = (typeof OWNER_NOTIFICATION_LEVELS)[number];

export function ownerNotificationLevelAtLeast(
  level: OwnerNotificationLevel,
  minimum: OwnerNotificationLevel,
): boolean {
  return OWNER_NOTIFICATION_LEVELS.indexOf(level) >= OWNER_NOTIFICATION_LEVELS.indexOf(minimum);
}

export interface QueueTransition {
  transitionId: number;
  qitemId: string;
  ts: string;
  state: string;
  transitionNote: string | null;
  actorSession: string;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
  /** P21 §4 era-stamp: how actorSession was established. `transport:v1` = derived from the
   *  transport chokepoint; null/absent = claimed-era (pre-verification), never re-labeled. */
  identityProvenance: string | null;
  ownerNotificationKind: string | null;
  ownerNotificationLevel: OwnerNotificationLevel;
}

export interface QueueTransitionInput {
  qitemId: string;
  state: string;
  actorSession: string;
  transitionNote?: string;
  closureReason?: ClosureReason;
  closureTarget?: string;
  /** P21 §4 era-stamp: the route passes `transport:v1` when actorSession came from the transport
   *  header chokepoint; omit (null) for system/claimed-era transitions — absence is the marker. */
  identityProvenance?: string | null;
  ownerNotificationKind?: string | null;
  ownerNotificationLevel?: OwnerNotificationLevel | null;
}

export type RecentQueueTransitionTargetKind = "qitem" | "slice" | "mission";
export type RecentQueueTransitionScope = { kind: "instance" } | { kind: "rig"; rig: string };

/** A compact product event derived only from typed queue state and closure fields.
 * The authored queue summary is presentation only; it never participates in
 * event normalization. transition_note and body remain excluded so prose cannot
 * silently become event semantics. */
export interface RecentQueueTransition {
  transitionId: number;
  qitemId: string;
  ts: string;
  actorSession: string;
  change: string;
  summary: string | null;
  rig: string;
  targetKind: RecentQueueTransitionTargetKind;
  target: string;
}

interface QueueTransitionRow {
  transition_id: number;
  qitem_id: string;
  ts: string;
  state: string;
  transition_note: string | null;
  actor_session: string;
  closure_reason: string | null;
  closure_target: string | null;
  identity_provenance?: string | null;
  owner_notification_kind?: string | null;
  owner_notification_level?: string | null;
}

interface RecentQueueTransitionRow {
  transition_id: number;
  qitem_id: string;
  ts: string;
  state: string;
  actor_session: string;
  closure_reason: string | null;
  closure_target: string | null;
  tags: string | null;
  summary: string | null;
  previous_state: string | null;
  destination_session: string;
  source_session: string;
}

function sessionRig(session: string, knownRigs: ReadonlySet<string>): string | null {
  if (isHumanSeatSessionRef(session)) return null;
  const parsed = parseSessionName(session);
  return parsed.kind === "canonical" && knownRigs.has(parsed.rig) ? parsed.rig : null;
}

function recentTarget(row: RecentQueueTransitionRow): Pick<RecentQueueTransition, "targetKind" | "target"> {
  let tags: string[] = [];
  try {
    const parsed = row.tags ? JSON.parse(row.tags) : [];
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    // An invalid legacy tag field cannot turn prose into a target; retain qitem identity.
  }
  const slice = tags.find((tag) => tag.startsWith("slice:"))?.slice("slice:".length).trim();
  if (slice) return { targetKind: "slice", target: slice };
  const mission = tags.find((tag) => tag.startsWith("mission:"))?.slice("mission:".length).trim();
  if (mission) return { targetKind: "mission", target: mission };
  return { targetKind: "qitem", target: row.qitem_id };
}

function recentChange(row: RecentQueueTransitionRow): string | null {
  if (row.closure_reason === "handed_off_to") {
    return row.closure_target ? `handed off to ${row.closure_target}` : "handed off";
  }
  if (["failed", "denied", "canceled"].includes(row.state)) return row.state;
  if (["denied", "canceled", "escalation"].includes(row.closure_reason ?? "")) return row.closure_reason;
  if (row.state === "done" && row.closure_reason === "no-follow-on") return "completed";
  if (row.state === "in-progress" && row.previous_state === "blocked") return "resumed";
  if (row.state === "in-progress" && row.previous_state === "pending") return "claimed";
  if (row.state === "blocked" && row.previous_state != null && row.previous_state !== "blocked") {
    return row.closure_target ? `blocked on ${row.closure_target}` : "blocked";
  }
  return null;
}

/**
 * Append-only transition log. Domain code MUST NOT update or delete rows here.
 * This log is the authoritative audit trail for queue state evolution.
 */
/** The prefix `rig queue block --continuation` writes on the park transition, matched exactly. */
const CONTINUATION_MARKER = "continuation: ";

export class QueueTransitionLog {
  readonly db: Database.Database;
  /** P21 §4: detected once — a curated-migration test DB (or a pre-067 daemon) may lack the
   *  era-stamp column, so the writer degrades (omits it) instead of throwing. */
  private readonly hasIdentityProvenanceColumn: boolean;
  private readonly hasOwnerNotificationColumns: boolean;
  private readonly historySource: string;

  constructor(db: Database.Database) {
    this.db = db;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>
    ).some((c) => c.name === "identity_provenance");
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    this.hasOwnerNotificationColumns = columns.has("owner_notification_kind") && columns.has("owner_notification_level");
    // One explicit projection for all history readers, including old nullable schemas.
    // SELECT * cannot union the archive's extra archived_at column with the live table.
    const fields = ["transition_id", "qitem_id", "ts", "state", "transition_note", "actor_session",
      "closure_reason", "closure_target", "identity_provenance", "owner_notification_kind", "owner_notification_level"];
    const sources = ["queue_transitions", "queue_transitions_archive"].flatMap((table) => {
      const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      if (available.size === 0) return [];
      return [`SELECT ${fields.map((field) => available.has(field) ? field : `NULL AS ${field}`).join(", ")} FROM ${table}`];
    });
    this.historySource = `(${sources.join(" UNION ALL ")})`;

  }

  /**
   * Append a transition. Designed to be called inside an outer caller-managed
   * `db.transaction()` so the transition row is atomic with the queue_items
   * UPDATE that produced it.
   */
  append(input: QueueTransitionInput): QueueTransition {
    const ts = new Date().toISOString();
    const columns = ["qitem_id", "ts", "state", "transition_note", "actor_session", "closure_reason", "closure_target"];
    const values: unknown[] = [
      input.qitemId,
      ts,
      input.state,
      input.transitionNote ?? null,
      input.actorSession,
      input.closureReason ?? null,
      input.closureTarget ?? null,
    ];
    if (this.hasIdentityProvenanceColumn) {
      columns.push("identity_provenance");
      values.push(input.identityProvenance ?? null);
    }
    if (this.hasOwnerNotificationColumns) {
      columns.push("owner_notification_kind", "owner_notification_level");
      values.push(input.ownerNotificationKind ?? null, input.ownerNotificationLevel ?? null);
    }
    const result = this.db
      .prepare(`INSERT INTO queue_transitions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...values);

    const row = this.db
      .prepare("SELECT * FROM queue_transitions WHERE transition_id = ?")
      .get(Number(result.lastInsertRowid)) as QueueTransitionRow;

    return this.rowToTransition(row);
  }

  listForQitem(qitemId: string): QueueTransition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.historySource} WHERE qitem_id = ? ORDER BY transition_id ASC`
      )
      .all(qitemId) as QueueTransitionRow[];
    return rows.map((r) => this.rowToTransition(r));
  }

  /**
   * OPR.0.7.0.12 — the continuation `rig queue block --continuation` recorded for the row's
   * CURRENT park. The current park is the trailing run of `blocked` transitions: the daemon
   * appends its own later blocked transitions (e.g. "parked-owner episode closed"), so the latest
   * one is not the park, and an earlier park's plan must never resurface.
   *
   * One newest-first seek on idx_queue_transitions_qitem_id_order (migration 098) that stops at
   * the first non-blocked transition, so the work is bounded by the current park, not the row's
   * history. The marker match is exact-case, as `rig queue block` writes it. The live table
   * suffices: retention archives only terminal rows, and a parked row is not terminal.
   */
  currentParkContinuation(qitemId: string): string | null {
    const newestFirst = this.db.prepare(
      "SELECT state, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC",
    );
    // Leaving the loop early releases the statement (better-sqlite3 closes the iterator).
    for (const row of newestFirst.iterate(qitemId) as Iterable<{ state: string; transition_note: string | null }>) {
      if (row.state !== "blocked") return null;
      if (row.transition_note?.startsWith(CONTINUATION_MARKER)) return row.transition_note.slice(CONTINUATION_MARKER.length);
    }
    return null;
  }

  /** Bounded source adapter: apply the time window and limit before materializing rows. */
  listForQitemWindow(qitemId: string, startedAt: string, endedAt: string, limit: number): QueueTransition[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10001) throw new Error("Invalid transition window limit");
    const start = new Date(startedAt).toISOString();
    const end = new Date(endedAt).toISOString();
    const rows = this.db.prepare(`SELECT * FROM ${this.historySource} WHERE qitem_id = ? AND ts >= ? AND ts <= ? ORDER BY transition_id ASC LIMIT ?`)
      .all(qitemId, start, end, limit) as QueueTransitionRow[];
    return rows.map((row) => this.rowToTransition(row));
  }

  /** Follow declared handoffs only. Bound the family before materializing its
   * transitions; cycles converge through UNION, and overflow refuses explicitly. */
  listForHandoffWindow(qitemId: string, startedAt: string, endedAt: string, limit: number): QueueTransition[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10001) throw new Error("Invalid transition window limit");
    const start = new Date(startedAt).toISOString();
    const end = new Date(endedAt).toISOString();
    const family = this.db.prepare(`WITH RECURSIVE lineage(id) AS (
      SELECT ? UNION SELECT q.qitem_id FROM queue_items q JOIN lineage l ON q.handed_off_from = l.id
      WHERE q.ts_created <= ? LIMIT 1001
    ) SELECT id FROM lineage`).all(qitemId, end) as Array<{ id: string }>;
    if (family.length > 1000) throw new Error("health_checkpoint_lineage_limit");
    const rows = this.db.prepare(`SELECT * FROM ${this.historySource}
      WHERE qitem_id IN (${family.map(() => "?").join(",")}) AND ts >= ? AND ts <= ?
      ORDER BY transition_id ASC LIMIT ?`).all(...family.map((r) => r.id), start, end, limit) as QueueTransitionRow[];
    return rows.map((row) => this.rowToTransition(row));
  }

  listForActor(actorSession: string, limit = 100): QueueTransition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.historySource} WHERE actor_session = ? ORDER BY transition_id DESC LIMIT ?`
      )
      .all(actorSession, limit) as QueueTransitionRow[];
    return rows.map((r) => this.rowToTransition(r));
  }

  /** Latest high-signal transitions for one topology scope, returned chronologically with
   * newest last. The window function observes the complete per-qitem state
   * sequence before the allowlist is applied, so note-only same-state writes
   * cannot masquerade as claims, resumes, or blocks. */
  listRecent(scope: RecentQueueTransitionScope, requestedLimit = 20): RecentQueueTransition[] {
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
      : 20;
    const activeRigWhere = archiveWhereClause("archived_at");
    const rigNames = scope.kind === "rig"
      ? [scope.rig]
      : (this.db.prepare(`SELECT name FROM rigs${activeRigWhere ? ` WHERE ${activeRigWhere}` : ""} ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
    if (rigNames.length === 0) return [];
    const knownRigs = new Set(rigNames);
    const sessionPatterns = rigNames.map((rig) => `%@${rig.replace(/%/g, "\\%").replace(/_/g, "\\_")}`);
    const scopeSql = sessionPatterns.map(() => "(q.destination_session LIKE ? ESCAPE '\\' OR q.source_session LIKE ? ESCAPE '\\')").join(" OR ");
    const scopeParams = sessionPatterns.flatMap((pattern) => [pattern, pattern]);
    // Keep display metadata out of the full-history window/sort. Fetch it only
    // for the qualified window; limiting raw history would change predecessors.
    const rows = this.db.prepare(`
      WITH rig_history AS (
        SELECT
          t.transition_id,
          t.qitem_id,
          t.ts,
          t.state,
          t.actor_session,
          t.closure_reason,
          t.closure_target,
          LAG(t.state) OVER (
            PARTITION BY t.qitem_id
            ORDER BY t.transition_id
          ) AS previous_state
        FROM ${this.historySource} t
        JOIN queue_items q ON q.qitem_id = t.qitem_id
        WHERE ${scopeSql}
      ), qualifying AS (
        SELECT * FROM rig_history
        WHERE (state = 'in-progress' AND previous_state IN ('pending', 'blocked'))
           OR (state = 'blocked' AND previous_state IS NOT NULL AND previous_state <> 'blocked')
           OR closure_reason = 'handed_off_to'
           OR (state = 'done' AND closure_reason = 'no-follow-on')
           OR state IN ('failed', 'denied', 'canceled')
           OR closure_reason IN ('denied', 'canceled', 'escalation')
      ), latest AS (
        SELECT * FROM qualifying
        ORDER BY ts DESC, transition_id DESC
        LIMIT ?
      )
      SELECT t.transition_id, t.qitem_id, t.ts, t.state, t.actor_session,
             t.closure_reason, t.closure_target, q.tags, q.summary, t.previous_state,
             q.destination_session, q.source_session
      FROM latest t
      JOIN queue_items q ON q.qitem_id = t.qitem_id
      ORDER BY t.ts DESC, t.transition_id DESC
    `).all(...scopeParams, limit) as RecentQueueTransitionRow[];

    return rows.reverse().flatMap((row) => {
      const change = recentChange(row);
      if (!change) return [];
      const rig = sessionRig(row.destination_session, knownRigs)
        ?? sessionRig(row.source_session, knownRigs)
        ?? sessionRig(row.actor_session, knownRigs);
      if (!rig) return [];
      return [{
        transitionId: row.transition_id,
        qitemId: row.qitem_id,
        ts: row.ts,
        actorSession: row.actor_session,
        change,
        summary: row.summary?.trim() || null,
        rig,
        ...recentTarget(row),
      }];
    });
  }

  listRecentForRig(rig: string, requestedLimit = 20): RecentQueueTransition[] {
    return this.listRecent({ kind: "rig", rig }, requestedLimit);
  }

  latestOwnerNotificationForQitem(qitemId: string): QueueTransition | null {
    if (!this.hasOwnerNotificationColumns) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM ${this.historySource}
          WHERE qitem_id = ? AND owner_notification_level IS NOT NULL
          ORDER BY transition_id DESC LIMIT 1`,
      )
      .get(qitemId) as QueueTransitionRow | undefined;
    return row ? this.rowToTransition(row) : null;
  }

  hasOwnerNotificationReceipt(qitemId: string, notificationKey: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT transition_note FROM ${this.historySource}
          WHERE qitem_id = ? AND transition_note LIKE 'slack-owner-notification-posted %'`,
      )
      .all(qitemId) as Array<{ transition_note: string }>;
    return rows.some((row) => row.transition_note.split(/\s+/).includes(`notification_key=${notificationKey}`));
  }

  private rowToTransition(row: QueueTransitionRow): QueueTransition {
    return {
      transitionId: row.transition_id,
      qitemId: row.qitem_id,
      ts: row.ts,
      state: row.state,
      transitionNote: row.transition_note,
      actorSession: row.actor_session,
      closureReason: row.closure_reason as ClosureReason | null,
      closureTarget: row.closure_target,
      identityProvenance: row.identity_provenance ?? null,
      ownerNotificationKind: row.owner_notification_kind ?? null,
      ownerNotificationLevel: OWNER_NOTIFICATION_LEVELS.includes(row.owner_notification_level as OwnerNotificationLevel)
        ? row.owner_notification_level as OwnerNotificationLevel
        : "RECORD",
    };
  }
}
