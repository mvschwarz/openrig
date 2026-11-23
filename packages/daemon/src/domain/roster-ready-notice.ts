import { createHash } from "node:crypto";
import { OPENRIG_SENDER } from "../lib/pane-envelope.js";
import type { QueueRepository } from "./queue-repository.js";

export function rosterReadyNoticeId(rigId: string, session: string): string {
  const key = createHash("sha256").update(`${rigId}\0${session}`).digest("hex").slice(0, 20);
  return `qitem-roster-ready-${key}`;
}

/** One durable notice per seat in this newly built rig. A failed notice does not change launch status. */
export async function noticeRosterReady(queue: Pick<QueueRepository, "create">, rigId: string, sessions: string[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const session of sessions) {
    try {
      await queue.create({
        qitemId: rosterReadyNoticeId(rigId, session),
        sourceSession: OPENRIG_SENDER,
        destinationSession: session,
        wakeTrigger: "openrig",
        summary: "Team roster is ready",
        body: "The team's seats and edges have been recorded. Run `rig whoami` again to see your current peers and routes.",
        tags: ["roster-ready", `rig:${rigId}`],
      });
    } catch (error) {
      warnings.push(`Roster-ready notice to ${session} is unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return warnings;
}
