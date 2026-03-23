import type Database from "better-sqlite3";
import type { RigEvent, PersistedEvent } from "./types.js";

type Subscriber = (event: PersistedEvent) => void;

export class EventBus {
  private subscribers = new Set<Subscriber>();
  readonly db: Database.Database;

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  constructor(db: Database.Database) {
    this.db = db;
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
   * Does NOT notify subscribers — call notifySubscribers() after commit.
   */
  persistWithinTransaction(event: RigEvent): PersistedEvent {
    const nodeId = "nodeId" in event ? event.nodeId : null;

    const result = this.db
      .prepare(
        "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
      )
      .run(event.rigId, nodeId, event.type, JSON.stringify(event));

    const seq = Number(result.lastInsertRowid);

    const row = this.db
      .prepare("SELECT created_at FROM events WHERE seq = ?")
      .get(seq) as { created_at: string };

    return {
      ...event,
      seq,
      createdAt: row.created_at,
    };
  }

  /**
   * Fan out a persisted event to in-memory subscribers.
   * Does NOT insert into DB. Subscriber errors are isolated.
   */
  notifySubscribers(event: PersistedEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        console.error("EventBus subscriber error:", err);
      }
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

  private rowToPersistedEvent(row: EventRow): PersistedEvent {
    const event = JSON.parse(row.payload) as RigEvent;
    return {
      ...event,
      seq: row.seq,
      createdAt: row.created_at,
    };
  }
}

interface EventRow {
  seq: number;
  rig_id: string;
  node_id: string | null;
  type: string;
  payload: string;
  created_at: string;
}
