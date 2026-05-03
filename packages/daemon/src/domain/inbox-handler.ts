import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import { QueueRepository } from "./queue-repository.js";

export const INBOX_STATES = ["pending", "absorbed", "denied"] as const;
export type InboxState = (typeof INBOX_STATES)[number];

export interface InboxEntry {
  inboxId: string;
  destinationSession: string;
  senderSession: string;
  body: string;
  tags: string[] | null;
  urgency: string;
  tsDropped: string;
  state: InboxState;
  absorbedAt: string | null;
  absorbedQitemId: string | null;
  deniedAt: string | null;
  deniedReason: string | null;
  auditPointer: string | null;
}

interface InboxEntryRow {
  inbox_id: string;
  destination_session: string;
  sender_session: string;
  body: string;
  tags: string | null;
  urgency: string;
  ts_dropped: string;
  state: string;
  absorbed_at: string | null;
  absorbed_qitem_id: string | null;
  denied_at: string | null;
  denied_reason: string | null;
  audit_pointer: string | null;
}

export interface InboxDropInput {
  inboxId?: string;
  destinationSession: string;
  senderSession: string;
  body: string;
  tags?: string[];
  urgency?: string;
  auditPointer?: string;
}

export class InboxHandlerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function newInboxId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `inbox-${ts}-${hex}`;
}

/**
 * Inbox mailbox handler. Authenticated drop-and-go path.
 * Receiver chooses absorb (promote to queue_item) or deny (record reason).
 *
 * `authenticate` is the contract surface that lets routes plug in identity
 * verification. Default is permissive (accept any sender_session); routes
 * SHOULD verify against the calling principal.
 */
export class InboxHandler {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  private readonly authenticate: (sender: string, claimed: string) => boolean;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    queueRepo: QueueRepository,
    opts?: { authenticate?: (sender: string, claimed: string) => boolean }
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.queueRepo = queueRepo;
    this.authenticate = opts?.authenticate ?? (() => true);
  }

  drop(input: InboxDropInput, authenticatedSender?: string): InboxEntry {
    if (authenticatedSender !== undefined && !this.authenticate(authenticatedSender, input.senderSession)) {
      throw new InboxHandlerError(
        "auth_failed",
        `authenticated principal ${authenticatedSender} cannot send as ${input.senderSession}`
      );
    }

    const id = input.inboxId ?? newInboxId();
    const existing = this.getByIdRaw(id);
    if (existing) return this.rowToEntry(existing);

    const ts = new Date().toISOString();
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const urgency = input.urgency ?? "routine";

    this.db
      .prepare(
        `INSERT INTO inbox_entries (
          inbox_id, destination_session, sender_session, body, tags, urgency, ts_dropped, audit_pointer
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.destinationSession,
        input.senderSession,
        input.body,
        tags,
        urgency,
        ts,
        input.auditPointer ?? null
      );

    return this.getByIdOrThrow(id);
  }

  /**
   * Receiver absorbs a pending inbox entry into their main queue.
   * Idempotent on inbox_id: if already absorbed, returns the existing
   * `absorbed_qitem_id` rather than creating a duplicate.
   */
  absorb(inboxId: string, receiverSession: string): { entry: InboxEntry; qitemId: string } {
    const entry = this.getById(inboxId);
    if (!entry) {
      throw new InboxHandlerError("inbox_not_found", `inbox ${inboxId} not found`);
    }
    if (entry.destinationSession !== receiverSession) {
      throw new InboxHandlerError(
        "absorb_destination_mismatch",
        `inbox ${inboxId} is destined for ${entry.destinationSession}, not ${receiverSession}`
      );
    }
    if (entry.state === "absorbed") {
      return { entry, qitemId: entry.absorbedQitemId! };
    }
    if (entry.state === "denied") {
      throw new InboxHandlerError(
        "inbox_already_denied",
        `inbox ${inboxId} was denied; cannot absorb`
      );
    }

    const qitem = this.queueRepo.create({
      sourceSession: entry.senderSession,
      destinationSession: entry.destinationSession,
      body: entry.body,
      tags: entry.tags ?? undefined,
      priority: entry.urgency === "critical" ? "critical" : entry.urgency === "urgent" ? "urgent" : "routine",
    });

    const ts = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE inbox_entries
             SET state = 'absorbed', absorbed_at = ?, absorbed_qitem_id = ?
           WHERE inbox_id = ?`
        )
        .run(ts, qitem.qitemId, inboxId);

      return this.eventBus.persistWithinTransaction({
        type: "inbox.absorbed",
        inboxId,
        destinationSession: entry.destinationSession,
        senderSession: entry.senderSession,
        promotedQitemId: qitem.qitemId,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);

    return { entry: this.getByIdOrThrow(inboxId), qitemId: qitem.qitemId };
  }

  deny(inboxId: string, receiverSession: string, reason: string): InboxEntry {
    const entry = this.getById(inboxId);
    if (!entry) {
      throw new InboxHandlerError("inbox_not_found", `inbox ${inboxId} not found`);
    }
    if (entry.destinationSession !== receiverSession) {
      throw new InboxHandlerError(
        "deny_destination_mismatch",
        `inbox ${inboxId} is destined for ${entry.destinationSession}, not ${receiverSession}`
      );
    }
    if (entry.state !== "pending") {
      throw new InboxHandlerError(
        "inbox_not_pending",
        `inbox ${inboxId} is in state ${entry.state}; only pending entries can be denied`
      );
    }
    const ts = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE inbox_entries
             SET state = 'denied', denied_at = ?, denied_reason = ?
           WHERE inbox_id = ?`
        )
        .run(ts, reason, inboxId);

      return this.eventBus.persistWithinTransaction({
        type: "inbox.denied",
        inboxId,
        destinationSession: entry.destinationSession,
        senderSession: entry.senderSession,
        reason,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);

    return this.getByIdOrThrow(inboxId);
  }

  getById(inboxId: string): InboxEntry | null {
    const row = this.getByIdRaw(inboxId);
    return row ? this.rowToEntry(row) : null;
  }

  listPending(destinationSession: string): InboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox_entries
          WHERE destination_session = ? AND state = 'pending'
          ORDER BY ts_dropped ASC`
      )
      .all(destinationSession) as InboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  listForDestination(destinationSession: string, limit = 100): InboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox_entries WHERE destination_session = ? ORDER BY ts_dropped DESC, rowid DESC LIMIT ?`
      )
      .all(destinationSession, limit) as InboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  private getByIdRaw(inboxId: string): InboxEntryRow | undefined {
    return this.db
      .prepare("SELECT * FROM inbox_entries WHERE inbox_id = ?")
      .get(inboxId) as InboxEntryRow | undefined;
  }

  private getByIdOrThrow(inboxId: string): InboxEntry {
    const entry = this.getById(inboxId);
    if (!entry) throw new InboxHandlerError("inbox_not_found", `inbox ${inboxId} not found after write`);
    return entry;
  }

  private rowToEntry(row: InboxEntryRow): InboxEntry {
    return {
      inboxId: row.inbox_id,
      destinationSession: row.destination_session,
      senderSession: row.sender_session,
      body: row.body,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      urgency: row.urgency,
      tsDropped: row.ts_dropped,
      state: row.state as InboxState,
      absorbedAt: row.absorbed_at,
      absorbedQitemId: row.absorbed_qitem_id,
      deniedAt: row.denied_at,
      deniedReason: row.denied_reason,
      auditPointer: row.audit_pointer,
    };
  }
}
