// S10 — the thread↔seat MAP (FROM-SCRATCH §4.4): deterministic thread routing state.
// One row per Slack thread root: (thread_ts, channel, human, seat, conversation_id, state).
// Zero LLM inference anywhere near routing — a reply routes by exact thread_ts lookup or it is
// UNMAPPED (and unmapped is a first-class outcome routed to the orchestrator's unrouted-signal
// row, never dropped, never guessed).
//
// Rebuildability: every posted root ALSO stamps its queue row with a structured transition note
// (`slack-posted thread_ts=… message_ts=… channel=… human=… seat=…` — see stampFormat/parse
// below). rebuildFromStamps() re-derives the table from those stamps, so the map is a cache of
// queue-row truth, not a second source that can silently diverge.

import type Database from "better-sqlite3";

export interface ThreadMapping {
  threadTs: string;
  channel: string;
  human: string;
  seat: string;
  conversationId: string;
  state: "open" | "closed";
  openedAt: string;
  closedAt?: string | null;
}

export const SLACK_POSTED_STAMP_PREFIX = "slack-posted";

/** The structured queue-row stamp for a posted thread root (the rebuild source). */
export function formatPostedStamp(m: { threadTs: string; messageTs: string; channel: string; human: string; seat: string; conversationId: string }): string {
  return `${SLACK_POSTED_STAMP_PREFIX} thread_ts=${m.threadTs} message_ts=${m.messageTs} channel=${m.channel} human=${m.human} seat=${m.seat} conversation=${m.conversationId}`;
}

/** Parse a posted stamp (null when the note is not one). Field order is not significant. */
export function parsePostedStamp(note: string): { threadTs: string; messageTs: string; channel: string; human: string; seat: string; conversationId: string } | null {
  if (!note.startsWith(SLACK_POSTED_STAMP_PREFIX + " ")) return null;
  const fields = new Map<string, string>();
  for (const token of note.slice(SLACK_POSTED_STAMP_PREFIX.length + 1).split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const threadTs = fields.get("thread_ts");
  const messageTs = fields.get("message_ts");
  const channel = fields.get("channel");
  const human = fields.get("human");
  const seat = fields.get("seat");
  const conversationId = fields.get("conversation");
  if (!threadTs || !messageTs || !channel || !human || !seat || !conversationId) return null;
  return { threadTs, messageTs, channel, human, seat, conversationId };
}

export class ThreadSeatMap {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Record a NEW thread root (idempotent on thread_ts — a replayed root keeps one row). */
  open(m: { threadTs: string; channel: string; human: string; seat: string; conversationId: string }): void {
    this.db
      .prepare(
        `INSERT INTO thread_seat_map (thread_ts, channel, human, seat, conversation_id, state, opened_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)
         ON CONFLICT(thread_ts) DO NOTHING`,
      )
      .run(m.threadTs, m.channel, m.human, m.seat, m.conversationId, this.now().toISOString());
  }

  /** Deterministic inbound lookup: the mapping for a thread root, open OR closed (a closed
   *  thread still routes to exactly its mapped seat — the class receipt), or null = UNMAPPED. */
  resolveByThread(threadTs: string): ThreadMapping | null {
    const row = this.db.prepare(`SELECT * FROM thread_seat_map WHERE thread_ts = ?`).get(threadTs) as
      | Record<string, unknown>
      | undefined;
    return row ? project(row) : null;
  }

  /** Outbound thread reuse: the OPEN conversation for (human, seat), newest first. */
  resolveOpenForPair(human: string, seat: string): ThreadMapping | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_seat_map WHERE human = ? AND seat = ? AND state = 'open' ORDER BY opened_at DESC LIMIT 1`)
      .get(human, seat) as Record<string, unknown> | undefined;
    return row ? project(row) : null;
  }

  close(threadTs: string): void {
    this.db
      .prepare(`UPDATE thread_seat_map SET state = 'closed', closed_at = ? WHERE thread_ts = ?`)
      .run(this.now().toISOString(), threadTs);
  }

  /** Rebuild the table from queue-row stamps (the durable source): INSERT-only, never
   *  overwriting a live row — the map converges toward the stamps without destroying state. */
  rebuildFromStamps(stamps: string[]): { inserted: number; skipped: number } {
    let inserted = 0;
    let skipped = 0;
    for (const note of stamps) {
      const m = parsePostedStamp(note);
      if (!m) { skipped++; continue; }
      const before = this.db.prepare(`SELECT 1 FROM thread_seat_map WHERE thread_ts = ?`).get(m.threadTs);
      if (before) { skipped++; continue; }
      this.open({ threadTs: m.threadTs, channel: m.channel, human: m.human, seat: m.seat, conversationId: m.conversationId });
      inserted++;
    }
    return { inserted, skipped };
  }
}

function project(row: Record<string, unknown>): ThreadMapping {
  return {
    threadTs: String(row.thread_ts),
    channel: String(row.channel),
    human: String(row.human),
    seat: String(row.seat),
    conversationId: String(row.conversation_id),
    state: row.state === "closed" ? "closed" : "open",
    openedAt: String(row.opened_at),
    closedAt: (row.closed_at as string | null) ?? null,
  };
}
