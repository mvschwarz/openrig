import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { RigEvent, PersistedEvent } from "./types.js";

type Subscriber = (event: PersistedEvent) => void;

declare const notifyTokenBrand: unique symbol;
export type NotifyToken = PersistedEvent & { readonly [notifyTokenBrand]: true };
export type NotifyRegister = (token: PersistedEvent) => void;

export interface NotifyDrainStatus {
  state: "healthy" | "unparseable";
  watermark: number;
  lastPoison: { seq: number; error: string; payloadSha: string } | null;
}

export class NotifyEnvelopeError extends Error {
  readonly code: "notify_registration_mismatch" | "nested_notify_envelope";

  constructor(code: NotifyEnvelopeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface ActiveEnvelope {
  persisted: Set<PersistedEvent>;
}

export class EventBus {
  private subscribers = new Set<Subscriber>();
  private activeEnvelope: ActiveEnvelope | null = null;
  private drainingNotifyRows = false;
  private notifyEnvelopeRuns = 0;
  private notifyDrainStatus: NotifyDrainStatus;
  readonly db: Database.Database;

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  constructor(db: Database.Database) {
    this.db = db;
    this.notifyDrainStatus = {
      state: "healthy",
      watermark: this.maxSeq(),
      lastPoison: null,
    };
  }

  /**
   * Persist an event and notify subscribers. Use this for standalone emit
   * outside of a caller-managed transaction.
   */
  emit(event: RigEvent): PersistedEvent {
    const persisted = this.persistWithinTransaction(event);
    this.notifySubscribers(persisted);
    return persisted;
  }

  /**
   * Insert an event row into the events table and return a PersistedEvent.
   * Call this inside a caller-managed db.transaction() so the event insert
   * is atomic with other writes (e.g., session + binding + event in one txn).
   * Does NOT notify subscribers. A notify envelope drains after commit;
   * legacy single-event callers retain their explicit post-commit notify.
   */
  persistWithinTransaction(event: RigEvent): NotifyToken {
    const rigId = "rigId" in event ? (event as { rigId: string }).rigId : null;
    const nodeId = "nodeId" in event ? event.nodeId : null;

    const result = this.db
      .prepare(
        "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
      )
      .run(rigId, nodeId, event.type, JSON.stringify(event));

    const seq = Number(result.lastInsertRowid);

    const row = this.db
      .prepare("SELECT created_at FROM events WHERE seq = ?")
      .get(seq) as { created_at: string };

    const token = {
      ...event,
      seq,
      createdAt: row.created_at,
    } as NotifyToken;
    this.activeEnvelope?.persisted.add(token);
    return token;
  }

  /**
   * Run one caller-owned synchronous transaction under the W2b notification
   * envelope. Every token persisted through EventBus during the callback must
   * be registered before it returns. The exact object-identity sets are
   * compared before commit; committed rows are then delivered from the log.
   */
  withNotifyEnvelope<T>(callback: (register: NotifyRegister) => T): T {
    if (this.activeEnvelope) {
      throw new NotifyEnvelopeError(
        "nested_notify_envelope",
        "notify envelope cannot be nested",
      );
    }

    const envelope: ActiveEnvelope = { persisted: new Set() };
    const registered = new Set<PersistedEvent>();
    const register: NotifyRegister = (token) => {
      registered.add(token);
    };
    this.notifyEnvelopeRuns += 1;

    const txn = this.db.transaction(() => {
      this.activeEnvelope = envelope;
      try {
        const result = callback(register);
        if (!setsEqual(envelope.persisted, registered)) {
          throw new NotifyEnvelopeError(
            "notify_registration_mismatch",
            `notify envelope persisted ${envelope.persisted.size} token(s) but registered ${registered.size} exact token(s)`,
          );
        }
        return result;
      } finally {
        this.activeEnvelope = null;
      }
    });

    const result = txn();
    this.drainNotifyRowsToQuiescence(this.notifyDrainStatus.watermark);
    return result;
  }

  getNotifyDrainStatus(): NotifyDrainStatus {
    return {
      ...this.notifyDrainStatus,
      lastPoison: this.notifyDrainStatus.lastPoison
        ? { ...this.notifyDrainStatus.lastPoison }
        : null,
    };
  }

  assertNotifyEnvelopeExercised(): void {
    if (this.notifyEnvelopeRuns === 0) {
      throw new Error("zero notify envelope transactions examined");
    }
  }

  /**
   * Fan out a persisted event to in-memory subscribers.
   * Does NOT insert into DB. Subscriber errors are isolated.
   */
  notifySubscribers(event: PersistedEvent): void {
    const nestedRowsStartAfter = this.maxSeq();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        console.error("EventBus subscriber error:", err);
      }
    }
    this.notifyDrainStatus.watermark = Math.max(this.notifyDrainStatus.watermark, event.seq);
    if (!this.drainingNotifyRows) {
      this.drainNotifyRowsToQuiescence(nestedRowsStartAfter);
    }
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  replaySince(seq: number, rigId: string): PersistedEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, rig_id, node_id, type, payload, created_at FROM events WHERE rig_id = ? AND seq > ? ORDER BY seq"
      )
      .all(rigId, seq) as EventRow[];

    return rows.map((row) => this.rowToPersistedEvent(row));
  }

  replayAll(seq: number): PersistedEvent[] {
    const rows = this.rowsAfter(seq);

    return rows.map((row) => this.rowToPersistedEvent(row));
  }

  private drainNotifyRowsToQuiescence(startAfter: number): void {
    if (this.drainingNotifyRows) return;
    this.drainingNotifyRows = true;
    let cursor = startAfter;
    try {
      for (;;) {
        const rows = this.rowsAfter(cursor);
        if (rows.length === 0) return;
        for (const row of rows) {
          let event: PersistedEvent;
          try {
            event = this.rowToPersistedEvent(row);
          } catch (caught) {
            const error = caught instanceof SyntaxError
              ? "invalid event payload JSON"
              : "invalid event payload shape";
            const payloadSha = createHash("sha256").update(row.payload).digest("hex");
            this.persistWithinTransaction({
              type: "event.delivery_poisoned",
              poisonedSeq: row.seq,
              error,
              payloadSha,
            });
            this.notifyDrainStatus = {
              state: "unparseable",
              watermark: row.seq,
              lastPoison: { seq: row.seq, error, payloadSha },
            };
            cursor = row.seq;
            continue;
          }
          this.notifySubscribers(event);
          cursor = row.seq;
        }
      }
    } finally {
      this.drainingNotifyRows = false;
    }
  }

  private maxSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  private rowsAfter(seq: number): EventRow[] {
    return this.db
      .prepare(
        "SELECT seq, rig_id, node_id, type, payload, created_at FROM events WHERE seq > ? ORDER BY seq",
      )
      .all(seq) as EventRow[];
  }

  private rowToPersistedEvent(row: EventRow): PersistedEvent {
    const parsed = JSON.parse(row.payload) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { type?: unknown }).type !== "string" ||
      (parsed as { type: string }).type.length === 0
    ) {
      throw new Error("invalid event payload shape");
    }
    const event = parsed as RigEvent;
    return {
      ...event,
      seq: row.seq,
      createdAt: row.created_at,
    };
  }
}

interface EventRow {
  seq: number;
  rig_id: string | null;
  node_id: string | null;
  type: string;
  payload: string;
  created_at: string;
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
