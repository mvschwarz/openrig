// #331: what OpenRig already knows about a seat, for a stall finding to name: the messages its delivery guard holds for it
// (what `rig seat held-messages` lists) and its latest context sample. Observations for the reader, never a diagnosis.
import type Database from "better-sqlite3";
import { OutboxHandler } from "./outbox-handler.js";
import { physicalSessionName } from "./session-registry.js";
import type { ContextUsage } from "./types.js";

export interface SeatEvidence {
  /** Messages the seat's delivery guard holds for it; null when they couldn't be read. */
  heldMessages: number | null;
  /** Its latest context sample, checked against its current session and occupant; null when it couldn't be read. */
  context: ContextUsage | null;
}

/** A reader for the seat behind a session name. Null for a name that isn't a seat on this host (a person, a conversation). */
export function seatEvidenceReader(db: Database.Database,
  context?: { getForNode(nodeId: string, currentSessionName: string | null): ContextUsage }): (session: string) => SeatEvidence | null {
  return (session) => {
    let nodeId: string | undefined;
    try {
      nodeId = (db.prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(physicalSessionName(db, session)) as { node_id: string } | undefined)?.node_id;
    } catch { return null; }
    if (!nodeId) return null;
    let heldMessages: number | null = null;
    try { heldMessages = new OutboxHandler(db).heldCount(nodeId); } catch { /* unread: reported as unknown */ }
    let usage: ContextUsage | null = null;
    try { usage = context?.getForNode(nodeId, session) ?? null; } catch { /* unread: reported as unknown */ }
    return { heldMessages, context: usage };
  };
}
