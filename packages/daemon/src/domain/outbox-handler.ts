import type Database from "better-sqlite3";

// W1 (transactional closure): `indeterminate` is the ambiguous-delivery outcome —
// a send that landed on the wire but whose render could not be CONFIRMED (transport
// res.ok && !verified). It is never silently promoted to `delivered` (unconfirmed)
// nor demoted to `failed` (it may have landed); the CAS transitions gate on 'pending',
// so an indeterminate row is TERMINAL-BY-CAS (reconciliation is an out-of-scope
// follow-on, not a W1 transition).
export const OUTBOX_DELIVERY_STATES = ["pending", "delivered", "failed", "indeterminate"] as const;
export type OutboxDeliveryState = (typeof OUTBOX_DELIVERY_STATES)[number];

/**
 * Validate a raw `delivery_state` cell against the closed union before it is typed
 * as an {@link OutboxDeliveryState}. Replaces the prior unchecked `as` cast: a cast
 * never fails, so a stray DB value (corruption, a newer daemon's state read by an
 * older one) would silently masquerade as a typed value and make every downstream
 * narrowing unsound. We control every writer, so an unknown value is a real defect —
 * fail loud rather than fabricate a type.
 */
export function parseDeliveryState(raw: string): OutboxDeliveryState {
  if ((OUTBOX_DELIVERY_STATES as readonly string[]).includes(raw)) {
    return raw as OutboxDeliveryState;
  }
  throw new OutboxHandlerError(
    "invalid_delivery_state",
    `outbox row has unknown delivery_state ${JSON.stringify(raw)} (expected one of ${OUTBOX_DELIVERY_STATES.join(", ")})`,
  );
}

export interface OutboxEntry {
  outboxId: string;
  senderSession: string;
  destinationSession: string;
  body: string;
  tags: string[] | null;
  urgency: string;
  tsDispatched: string;
  deliveryState: OutboxDeliveryState;
  deliveredAt: string | null;
  auditPointer: string | null;
}

interface OutboxEntryRow {
  outbox_id: string;
  sender_session: string;
  destination_session: string;
  body: string;
  tags: string | null;
  urgency: string;
  ts_dispatched: string;
  delivery_state: string;
  delivered_at: string | null;
  audit_pointer: string | null;
}

export interface OutboxRecordInput {
  outboxId?: string;
  senderSession: string;
  destinationSession: string;
  body: string;
  tags?: string[];
  urgency?: string;
  auditPointer?: string;
  /** P21 §4 era-stamp: the route passes `transport:v1` (senderSession derived from the transport
   *  header chokepoint). Written onto the outbox row; absence = claimed-era. */
  identityProvenance?: string | null;
}

export class OutboxHandlerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function newOutboxId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `outbox-${ts}-${hex}`;
}

/**
 * Sender-side outbox. Symmetric to InboxHandler. Records what a sender
 * dispatched independent of receiver behavior. Idempotent on outbox_id.
 *
 * No event-bus events emitted in Phase A — outbox is pure audit. If a future
 * phase wants delivery-tracking events, add them through this surface.
 */
export class OutboxHandler {
  readonly db: Database.Database;
  /** P21 §4: detected once — a curated-migration test DB (or a pre-067 daemon) may lack the
   *  era-stamp column, so the writer degrades (omits it) instead of throwing. */
  private readonly hasIdentityProvenanceColumn: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>
    ).some((col) => col.name === "identity_provenance");
  }

  record(input: OutboxRecordInput): OutboxEntry {
    const id = input.outboxId ?? newOutboxId();
    const existing = this.getByIdRaw(id);
    if (existing) return this.rowToEntry(existing);

    const ts = new Date().toISOString();
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const urgency = input.urgency ?? "routine";

    if (this.hasIdentityProvenanceColumn) {
      this.db
        .prepare(
          `INSERT INTO outbox_entries (
            outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched, audit_pointer, identity_provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.senderSession,
          input.destinationSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null,
          input.identityProvenance ?? null
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO outbox_entries (
            outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched, audit_pointer
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.senderSession,
          input.destinationSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null
        );
    }

    return this.getByIdOrThrow(id);
  }

  markDelivered(outboxId: string): OutboxEntry {
    const ts = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'delivered', delivered_at = ?
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(ts, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  markFailed(outboxId: string): OutboxEntry {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'failed'
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  /**
   * W1 (transactional closure): record an AMBIGUOUS delivery outcome — the send
   * landed but its render could not be confirmed (transport res.ok && !verified).
   * Same compare-and-set shape as markFailed/markDelivered (guards on 'pending'),
   * so it is idempotent and NEVER clobbers a row that already resolved. An
   * indeterminate row is terminal-by-CAS: it is never silently promoted to
   * delivered nor demoted to failed by the drain.
   */
  markIndeterminate(outboxId: string): OutboxEntry {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'indeterminate'
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  getById(outboxId: string): OutboxEntry | null {
    const row = this.getByIdRaw(outboxId);
    return row ? this.rowToEntry(row) : null;
  }

  listForSender(senderSession: string, limit = 100): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries WHERE sender_session = ? ORDER BY ts_dispatched DESC, rowid DESC LIMIT ?`
      )
      .all(senderSession, limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * W1 (transactional closure): list still-`pending` rows whose outbox_id begins
   * with `idPrefix`, oldest first. The drain uses this to recover intents a crash
   * left committed-but-undelivered. `idPrefix` is a trusted compile-time constant
   * (e.g. "wake-intent-") with no LIKE wildcards. Oldest-first + bounded `limit`
   * so a caller can page and terminate on a served short batch (never a silent cap).
   */
  listPending(idPrefix: string, limit = 200): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries
          WHERE delivery_state = 'pending' AND outbox_id LIKE ?
          ORDER BY ts_dispatched ASC, rowid ASC LIMIT ?`
      )
      .all(idPrefix + "%", limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  private getByIdRaw(outboxId: string): OutboxEntryRow | undefined {
    return this.db
      .prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as OutboxEntryRow | undefined;
  }

  private getByIdOrThrow(outboxId: string): OutboxEntry {
    const entry = this.getById(outboxId);
    if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found after write`);
    return entry;
  }

  private rowToEntry(row: OutboxEntryRow): OutboxEntry {
    return {
      outboxId: row.outbox_id,
      senderSession: row.sender_session,
      destinationSession: row.destination_session,
      body: row.body,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      urgency: row.urgency,
      tsDispatched: row.ts_dispatched,
      deliveryState: parseDeliveryState(row.delivery_state),
      deliveredAt: row.delivered_at,
      auditPointer: row.audit_pointer,
    };
  }
}
