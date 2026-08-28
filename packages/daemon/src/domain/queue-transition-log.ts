import type Database from "better-sqlite3";
import type { ClosureReason } from "./hot-potato-enforcer.js";

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
