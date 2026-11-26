import type Database from "better-sqlite3";
import { z } from "zod";

export function isPoolAgent(db: Database.Database, nodeId: string): boolean {
  return db.prepare("SELECT 1 FROM seat_pool_slots WHERE node_id = ? LIMIT 1").get(nodeId) !== undefined;
}

/** Attributed to a confirmed stop of the exact latest session, never to a reusable address. */
export function readStandbyStop(db: Database.Database, nodeId: string) {
  const row = db.prepare(`SELECT s.id AS sessionId, s.session_name AS session, b.tmux_pane AS pane,
      json_extract(e.payload, '$.standbyPane') AS identity
    FROM sessions s JOIN bindings b ON b.node_id = s.node_id AND b.tmux_session = s.session_name
    JOIN events e ON e.seq = (SELECT MAX(seq) FROM events WHERE node_id = s.node_id AND type = 'session.stopped')
    WHERE s.id = (SELECT id FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1)
      AND s.status = 'exited' AND s.intentionally_stopped = 1 AND s.stop_attempt IS NULL
      AND b.attachment_type = 'tmux' AND json_valid(e.payload)
      AND json_extract(e.payload, '$.sessionId') = s.id
      AND json_extract(e.payload, '$.operator') = 'daemon:seat-reaper'
      AND json_extract(e.payload, '$.reason') = 'idle_reap'`).get(nodeId);
  const result = z.object({ sessionId: z.string(), session: z.string(), pane: z.string(),
    identity: z.string().regex(/^\$\d+\|\d+\|\d+\|%\d+$/) }).safeParse(row);
  return result.success && result.data.identity.endsWith(`|${result.data.pane}`) ? { ...result.data, nodeId } : null;
}

export type StandbyStop = NonNullable<ReturnType<typeof readStandbyStop>>;
