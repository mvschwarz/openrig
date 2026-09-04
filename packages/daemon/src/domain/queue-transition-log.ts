import type Database from "better-sqlite3";
import type { ClosureReason } from "./hot-potato-enforcer.js";
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
 * It deliberately carries neither transition_note nor body: prose cannot silently
 * become event semantics. */
export interface RecentQueueTransition {
  transitionId: number;
  qitemId: string;
  ts: string;
  actorSession: string;
  change: string;
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
export class QueueTransitionLog {
  readonly db: Database.Database;
  /** P21 §4: detected once — a curated-migration test DB (or a pre-067 daemon) may lack the
   *  era-stamp column, so the writer degrades (omits it) instead of throwing. */
  private readonly hasIdentityProvenanceColumn: boolean;
  private readonly hasOwnerNotificationColumns: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>
    ).some((c) => c.name === "identity_provenance");
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    this.hasOwnerNotificationColumns = columns.has("owner_notification_kind") && columns.has("owner_notification_level");
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
        "SELECT * FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id ASC"
      )
      .all(qitemId) as QueueTransitionRow[];
    return rows.map((r) => this.rowToTransition(r));
  }

  listForActor(actorSession: string, limit = 100): QueueTransition[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM queue_transitions WHERE actor_session = ? ORDER BY transition_id DESC LIMIT ?"
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
    const rigNames = scope.kind === "rig"
      ? [scope.rig]
      : (this.db.prepare("SELECT name FROM rigs ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    if (rigNames.length === 0) return [];
    const knownRigs = new Set(rigNames);
    const sessionPatterns = rigNames.map((rig) => `%@${rig.replace(/%/g, "\\%").replace(/_/g, "\\_")}`);
    const scopeSql = sessionPatterns.map(() => "(q.destination_session LIKE ? ESCAPE '\\' OR q.source_session LIKE ? ESCAPE '\\')").join(" OR ");
    const scopeParams = sessionPatterns.flatMap((pattern) => [pattern, pattern]);
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
          q.tags,
          q.destination_session,
          q.source_session,
          LAG(t.state) OVER (
            PARTITION BY t.qitem_id
            ORDER BY t.transition_id
          ) AS previous_state
        FROM queue_transitions t
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
      )
      SELECT transition_id, qitem_id, ts, state, actor_session,
             closure_reason, closure_target, tags, previous_state,
             destination_session, source_session
      FROM qualifying
      ORDER BY ts DESC, transition_id DESC
      LIMIT ?
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
        `SELECT * FROM queue_transitions
          WHERE qitem_id = ? AND owner_notification_level IS NOT NULL
          ORDER BY transition_id DESC LIMIT 1`,
      )
      .get(qitemId) as QueueTransitionRow | undefined;
    return row ? this.rowToTransition(row) : null;
  }

  hasOwnerNotificationReceipt(qitemId: string, notificationKey: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT transition_note FROM queue_transitions
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
