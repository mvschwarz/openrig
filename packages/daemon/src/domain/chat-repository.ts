import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export interface ChatMessage {
  id: string;
  rigId: string;
  sender: string;
  kind: string;
  body: string;
  topic: string | null;
  createdAt: string;
}

interface ChatMessageRow {
  id: string;
  rig_id: string;
  sender: string;
  kind: string;
  body: string;
  topic: string | null;
  created_at: string;
}

export interface HistoryOptions {
  topic?: string;
  limit?: number;
  after?: string;
  since?: string;
  sender?: string;
}

export class ChatRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  send(rigId: string, sender: string, body: string): ChatMessage {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO chat_messages (id, rig_id, sender, kind, body) VALUES (?, ?, ?, 'message', ?)"
      )
      .run(id, rigId, sender, body);

    return this.rowToMessage(
      this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow
    );
  }

  sendTopic(rigId: string, sender: string, topic: string, body?: string): ChatMessage {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO chat_messages (id, rig_id, sender, kind, body, topic) VALUES (?, ?, ?, 'topic', ?, ?)"
      )
      .run(id, rigId, sender, body ?? "", topic);

    return this.rowToMessage(
      this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow
    );
  }

  history(rigId: string, opts?: HistoryOptions): ChatMessage[] {
    const limit = opts?.limit ?? 100;
    const after = opts?.after;
    const topic = opts?.topic;
    const since = opts?.since;
    const sender = opts?.sender;

    // Build composable WHERE clauses
    const conditions: string[] = ["rig_id = ?"];
    const params: unknown[] = [rigId];

    // Topic windowing: find the topic marker and constrain to its window
    if (topic) {
      const topicMarker = this.db
        .prepare(
          "SELECT id FROM chat_messages WHERE rig_id = ? AND kind = 'topic' AND topic = ? ORDER BY id DESC LIMIT 1"
        )
        .get(rigId, topic) as { id: string } | undefined;

      if (!topicMarker) return [];

      const nextMarker = this.db
        .prepare(
          "SELECT id FROM chat_messages WHERE rig_id = ? AND kind = 'topic' AND id > ? ORDER BY id ASC LIMIT 1"
        )
        .get(rigId, topicMarker.id) as { id: string } | undefined;

      conditions.push("id >= ?");
      params.push(topicMarker.id);

      if (nextMarker) {
        conditions.push("id < ?");
        params.push(nextMarker.id);
      }
    }

    // Cursor-based pagination
    if (after) {
      conditions.push("id > ?");
      params.push(after);
    }

    // Timestamp filter
    if (since) {
      conditions.push("created_at >= ?");
      params.push(since);
    }

    // Sender filter
    if (sender) {
      conditions.push("sender = ?");
      params.push(sender);
    }

    params.push(limit);
    const sql = `SELECT * FROM chat_messages WHERE ${conditions.join(" AND ")} ORDER BY id ASC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params) as ChatMessageRow[];
    return rows.map((r) => this.rowToMessage(r));
  }

  latest(rigId: string, count: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM chat_messages WHERE rig_id = ? ORDER BY id DESC LIMIT ?"
      )
      .all(rigId, count) as ChatMessageRow[];

    // Reverse to return chronological order
    return rows.reverse().map((r) => this.rowToMessage(r));
  }

  searchChat(rigId: string, pattern: string): ChatMessage[] {
    // Split pipe-joined keywords into OR conditions for SQL LIKE
    const keywords = pattern.split("|").map((k) => k.trim()).filter(Boolean);
    if (keywords.length === 0) return [];

    const conditions = keywords.map(() => "body LIKE ?").join(" OR ");
    const params = [rigId, ...keywords.map((k) => `%${k}%`)];

    const rows = this.db
      .prepare(
        `SELECT * FROM chat_messages WHERE rig_id = ? AND (${conditions}) ORDER BY id ASC LIMIT 50`
      )
      .all(...params) as ChatMessageRow[];

    return rows.map((r) => this.rowToMessage(r));
  }

  clear(rigId: string): { deleted: number } {
    const result = this.db
      .prepare("DELETE FROM chat_messages WHERE rig_id = ?")
      .run(rigId);
    return { deleted: result.changes };
  }

  private rowToMessage(row: ChatMessageRow): ChatMessage {
    return {
      id: row.id,
      rigId: row.rig_id,
      sender: row.sender,
      kind: row.kind,
      body: row.body,
      topic: row.topic,
      createdAt: row.created_at,
    };
  }
}
