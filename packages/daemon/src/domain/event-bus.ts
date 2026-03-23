import type Database from "better-sqlite3";
import type { RigEvent, PersistedEvent } from "./types.js";

type Subscriber = (event: PersistedEvent) => void;

export class EventBus {
  private subscribers = new Set<Subscriber>();

  constructor(private db: Database.Database) {}

  emit(event: RigEvent): PersistedEvent {
    // Extract nodeId if present on the event (varies by type)
    const nodeId = "nodeId" in event ? event.nodeId : null;

    // Persist first — subscribers must see a DB-committed event
    const result = this.db
      .prepare(
        "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
      )
      .run(event.rigId, nodeId, event.type, JSON.stringify(event));

    const seq = Number(result.lastInsertRowid);

    const row = this.db
      .prepare("SELECT created_at FROM events WHERE seq = ?")
      .get(seq) as { created_at: string };

    const persisted: PersistedEvent = {
      ...event,
      seq,
      createdAt: row.created_at,
    };

    // Notify subscribers — errors are isolated
    for (const subscriber of this.subscribers) {
      try {
        subscriber(persisted);
      } catch (err) {
        console.error("EventBus subscriber error:", err);
      }
    }

    return persisted;
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
