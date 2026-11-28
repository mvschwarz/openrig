import { createHash } from "node:crypto";
import { OPENRIG_SENDER } from "../lib/pane-envelope.js";
import type { QueueRepository } from "./queue-repository.js";

export function rosterReadyNoticeId(rigId: string, session: string): string {
  const key = createHash("sha256").update(`${rigId}\0${session}`).digest("hex").slice(0, 20);
  return `qitem-roster-ready-${key}`;
}

/** Notice IDs retain their rig generation; session names can be reused by a replacement. */
export function isRosterReadyNotice(row: { qitem_id: string; source_session: string }): boolean {
  return row.source_session === OPENRIG_SENDER && /^qitem-roster-ready-[a-f0-9]{20}$/.test(row.qitem_id);
}

/** One durable notice per seat in this newly built rig. A failed notice does not change launch status. It's information
 *  only: keep it available for the seat's next natural turn, without spending a turn to announce it. */
export async function noticeRosterReady(queue: Pick<QueueRepository, "create">, rigId: string, sessions: string[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const session of sessions) {
    try {
      await queue.create({
        qitemId: rosterReadyNoticeId(rigId, session),
        sourceSession: OPENRIG_SENDER,
        destinationSession: session,
        wakeTrigger: "openrig",
        nudge: false,
        summary: "Team seats and edges recorded (information only)",
        body: "Information only; there's nothing to do for this row. Your team's seats and edges are now recorded, "
          + "so `rig whoami` shows your current peers and routes whenever you next need them. "
          + "It needs no claim, file or follow-up: close it or leave it, and carry on with your own work.",
        tags: ["roster-ready", `rig:${rigId}`],
      });
    } catch (error) {
      warnings.push(`Roster-ready notice to ${session} is unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings;
}
