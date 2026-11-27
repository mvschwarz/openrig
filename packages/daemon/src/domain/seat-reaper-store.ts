import type Database from "better-sqlite3";
import { z } from "zod";

export type ReapClockIdentity = {
  readonly nodeId: string; readonly sessionId: string; readonly generation: string; readonly activitySeq: number;
};
const rowSchema = z.object({ session_id: z.string(), generation: z.string(), activity_seq: z.number(),
  idle_first_seen_ms: z.number().nullable(), attention_required: z.number() });

export class SeatReaperStore {
  constructor(private readonly db: Database.Database) {}

  resetClocks(): void { this.db.exec("UPDATE seat_reap_state SET idle_first_seen_ms = NULL"); }
  reset(nodeId: string): void { this.db.prepare("UPDATE seat_reap_state SET idle_first_seen_ms = NULL WHERE node_id = ?").run(nodeId); }

  observe(identity: ReapClockIdentity, now: number): number | null {
    const raw = this.db.prepare("SELECT * FROM seat_reap_state WHERE node_id = ?").get(identity.nodeId);
    const row = raw === undefined ? null : rowSchema.parse(raw);
    if (row?.attention_required) return null;
    const same = row?.session_id === identity.sessionId && row.generation === identity.generation && row.activity_seq === identity.activitySeq;
    const since = same ? row.idle_first_seen_ms ?? now : now;
    this.db.prepare(`INSERT INTO seat_reap_state(node_id, session_id, generation, activity_seq, idle_first_seen_ms)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET session_id=excluded.session_id,
      generation=excluded.generation, activity_seq=excluded.activity_seq, idle_first_seen_ms=excluded.idle_first_seen_ms`)
      .run(identity.nodeId, identity.sessionId, identity.generation, identity.activitySeq, since);
    return since;
  }

  attention(nodeId: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE seat_reap_state SET attention_required=1, idle_first_seen_ms=NULL WHERE node_id=?").run(nodeId);
      this.db.prepare(`UPDATE sessions SET startup_status='attention_required' WHERE id IN
        (SELECT session_id FROM seat_reap_state WHERE node_id=?)`).run(nodeId);
    })();
  }
  terminalReason(): string | null {
    return z.object({ terminal_reason: z.string().nullable() }).parse(
      this.db.prepare("SELECT terminal_reason FROM seat_reaper_control WHERE singleton=1").get()).terminal_reason;
  }
  terminate(reason: string): void {
    this.db.prepare("UPDATE seat_reaper_control SET terminal_reason=? WHERE singleton=1").run(reason);
    this.resetClocks();
  }
  recentEffects(now: number): number {
    return z.object({ count: z.number() }).parse(this.db.prepare(`SELECT count(*) AS count FROM events
      WHERE type='seat.reaped' AND json_extract(payload,'$.phase')='effect'
      AND json_extract(payload,'$.budgetConsumed')=1 AND json_extract(payload,'$.timestampMs') >= ?`)
      .get(now - 86_400_000)).count;
  }
}
