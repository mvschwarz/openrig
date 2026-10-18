// S10 — the thread↔seat MAP (FROM-SCRATCH §4.4): deterministic thread routing state.
// One row per Slack thread root, keyed by (channel, thread_ts) (115): (thread_ts, channel, human, seat,
// conversation_id, state, origin). `origin` is 'posted' for a root OpenRig posted, 'person' for one minted
// from a person's own top-level message (which is its answer's root, not an ask).
// Zero LLM inference anywhere near routing — a reply routes by exact thread_ts lookup or it is
// UNMAPPED (and unmapped is a first-class outcome routed to the orchestrator's unrouted-signal
// row, never dropped, never guessed).
//
// Rebuildability: every root ALSO stamps its queue row with a structured transition note
// (`slack-posted thread_ts=… message_ts=… channel=… human=… seat=…`, plus `origin=person` for a minted
// root — see stampFormat/parse below). rebuildFromStamps() re-derives the table from those stamps, so the map is a cache of
// queue-row truth, not a second source that can silently diverge.
//
// #899 — every message OpenRig posts into a thread for an ask lives in thread_part_map with its own
// ask and seat (the thread's root may belong to another ask), so a reaction on it can find its ask. Its
// stamp names its own message_ts and the thread's thread_ts; the root queries below never see these.

import type Database from "better-sqlite3";

// Newest root = Slack's own post time (thread_ts), never opened_at: a rebuild re-stamps
// opened_at with rebuild time, so an older root re-read later would look newer, and roots
// rebuilt in one burst tie. The text tie-break settles equal floats.
const NEWEST_ROOT_FIRST = "CAST(thread_ts AS REAL) DESC, thread_ts DESC";

export interface ThreadMapping {
  threadTs: string;
  channel: string;
  human: string;
  seat: string;
  conversationId: string;
  state: "open" | "closed";
  openedAt: string;
  closedAt?: string | null;
  origin: ThreadRootOrigin;
}

/** Who started a thread root: OpenRig's own post, or a person's top-level message. */
export type ThreadRootOrigin = "posted" | "person";

export const SLACK_POSTED_STAMP_PREFIX = "slack-posted";

/** The structured queue-row stamp for a thread root (the rebuild source). A posted root's stamp is
 *  unchanged; a person's minted root adds `origin=person`. */
export function formatPostedStamp(m: { threadTs: string; messageTs: string; channel: string; human: string; seat: string; conversationId: string; origin?: ThreadRootOrigin }): string {
  const stamp = `${SLACK_POSTED_STAMP_PREFIX} thread_ts=${m.threadTs} message_ts=${m.messageTs} channel=${m.channel} human=${m.human} seat=${m.seat} conversation=${m.conversationId}`;
  return m.origin === "person" ? `${stamp} origin=person` : stamp;
}

/** Parse a posted stamp (null when the note is not one). Field order is not significant. */
export function parsePostedStamp(note: string): { threadTs: string; messageTs: string; channel: string; human: string; seat: string; conversationId: string; origin: ThreadRootOrigin } | null {
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
  return { threadTs, messageTs, channel, human, seat, conversationId, origin: fields.get("origin") === "person" ? "person" : "posted" };
}

export class ThreadSeatMap {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Record a NEW thread root (idempotent on channel and thread_ts — a replayed root keeps one row). */
  open(m: { threadTs: string; channel: string; human: string; seat: string; conversationId: string; origin?: ThreadRootOrigin }): void {
    this.db
      .prepare(
        `INSERT INTO thread_seat_map (thread_ts, channel, human, seat, conversation_id, state, opened_at, origin)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
         ON CONFLICT(channel, thread_ts) DO NOTHING`,
      )
      .run(m.threadTs, m.channel, m.human, m.seat, m.conversationId, this.now().toISOString(), m.origin ?? "posted");
  }

  /** Deterministic inbound lookup: the mapping for a thread root in `channel`, open OR closed (a
   *  closed thread still routes to exactly its mapped seat — the class receipt), or null = UNMAPPED.
   *  Without a channel, the newest root with that ts. */
  resolveByThread(threadTs: string, channel?: string): ThreadMapping | null {
    const row = (channel === undefined
      ? this.db.prepare(`SELECT * FROM thread_seat_map WHERE thread_ts = ? ORDER BY opened_at DESC LIMIT 1`).get(threadTs)
      : this.db.prepare(`SELECT * FROM thread_seat_map WHERE thread_ts = ? AND channel = ?`).get(threadTs, channel)) as
      | Record<string, unknown>
      | undefined;
    return row ? project(row) : null;
  }

  /** Outbound thread reuse: the OPEN conversation for (human, seat), newest first. */
  resolveOpenForPair(human: string, seat: string): ThreadMapping | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_seat_map WHERE human = ? AND seat = ? AND state = 'open' ORDER BY ${NEWEST_ROOT_FIRST} LIMIT 1`)
      .get(human, seat) as Record<string, unknown> | undefined;
    return row ? project(row) : null;
  }

  /** Outbound reply correlation is qitem-scoped. Reuse a thread only for another
   * notification episode of the SAME durable conversation; a different human
   * gate gets a fresh root so its reply cannot resolve an older/newer qitem. */
  resolveOpenForConversation(human: string, seat: string, conversationId: string): ThreadMapping | null {
    const row = this.db
      .prepare(
        `SELECT * FROM thread_seat_map
          WHERE human = ? AND seat = ? AND conversation_id = ? AND state = 'open'
          ORDER BY ${NEWEST_ROOT_FIRST} LIMIT 1`,
      )
      .get(human, seat, conversationId) as Record<string, unknown> | undefined;
    return row ? project(row) : null;
  }

  /** #96: the root a conversation opened, open OR closed (the caller decides whether a
   *  closed root may be reused), newest first; null = the conversation never posted a root. */
  resolveByConversation(conversationId: string): ThreadMapping | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_seat_map WHERE conversation_id = ? ORDER BY ${NEWEST_ROOT_FIRST} LIMIT 1`)
      .get(conversationId) as Record<string, unknown> | undefined;
    return row ? project(row) : null;
  }

  /** #96: the channels where this conversation posted into a thread with this ts (its recorded parts),
   *  i.e. which root of that ts its post actually took. Empty when no such post is recorded. */
  partChannels(conversationId: string, threadTs: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT channel FROM thread_part_map WHERE conversation_id = ? AND thread_ts = ?`)
      .all(conversationId, threadTs) as Array<{ channel: string }>;
    return rows.map((r) => r.channel);
  }

  /** #899 — record a message OpenRig posted into a thread for an ask, with that ask and its seat (idempotent). */
  recordPart(m: { messageTs: string; channel: string; threadTs: string; seat: string; conversationId: string }): void {
    this.db
      .prepare(`INSERT INTO thread_part_map (message_ts, channel, thread_ts, seat, conversation_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel, message_ts) DO NOTHING`)
      .run(m.messageTs, m.channel, m.threadTs, m.seat, m.conversationId);
  }

  /** #899 — the ask and seat of a message OpenRig posted into a thread in this channel; null for any other message. */
  partOf(messageTs: string, channel: string): { threadTs: string; seat: string; conversationId: string } | null {
    const row = this.db.prepare(`SELECT thread_ts, seat, conversation_id FROM thread_part_map WHERE message_ts = ? AND channel = ?`)
      .get(messageTs, channel) as { thread_ts: string; seat: string; conversation_id: string } | undefined;
    return row ? { threadTs: row.thread_ts, seat: row.seat, conversationId: row.conversation_id } : null;
  }

  close(threadTs: string, channel?: string): void {
    const at = this.now().toISOString();
    if (channel === undefined) this.db.prepare(`UPDATE thread_seat_map SET state = 'closed', closed_at = ? WHERE thread_ts = ?`).run(at, threadTs);
    else this.db.prepare(`UPDATE thread_seat_map SET state = 'closed', closed_at = ? WHERE thread_ts = ? AND channel = ?`).run(at, threadTs, channel);
  }

  /** Rebuild the table from queue-row stamps (the durable source): INSERT-only, never
   *  overwriting a live row — the map converges toward the stamps without destroying state. */
  rebuildFromStamps(stamps: string[]): { inserted: number; skipped: number } {
    let inserted = 0;
    let skipped = 0;
    for (const note of stamps) {
      const m = parsePostedStamp(note);
      if (!m) { skipped++; continue; }
      if (m.messageTs !== m.threadTs) {
        // #899 — a reply's stamp maps the message to its own ask and seat; it never opens a thread.
        if (this.partOf(m.messageTs, m.channel)) { skipped++; continue; }
        this.recordPart({ messageTs: m.messageTs, channel: m.channel, threadTs: m.threadTs, seat: m.seat, conversationId: m.conversationId });
        inserted++;
        continue;
      }
      const before = this.db.prepare(`SELECT 1 FROM thread_seat_map WHERE thread_ts = ? AND channel = ?`).get(m.threadTs, m.channel);
      if (before) { skipped++; continue; }
      this.open({ threadTs: m.threadTs, channel: m.channel, human: m.human, seat: m.seat, conversationId: m.conversationId, origin: m.origin });
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
    origin: row.origin === "person" ? "person" : "posted",
  };
}
