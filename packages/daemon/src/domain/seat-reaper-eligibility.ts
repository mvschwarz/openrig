import type Database from "better-sqlite3";
import { z } from "zod";
import type { NodeInventoryEntry } from "./types.js";
import type { SeatActivityService } from "./seat-activity-service.js";
import { isPoolAgent } from "./seat-standby.js";

export type ReaperActivity = Pick<NonNullable<ReturnType<SeatActivityService["getSeatStateBySession"]>>,
  "activity" | "needsInput" | "backgroundWork" | "seq">;
export type ReapEligibility = ReturnType<typeof reapEligibility>;

export function reapEligibility(db: Database.Database, seat: NodeInventoryEntry, activity: ReaperActivity | null) {
  const inbox = z.object({ count: z.number() }).parse(db.prepare(`SELECT count(*) AS count FROM queue_items
    WHERE destination_session = ? AND state IN ('pending','blocked','in-progress')`).get(seat.canonicalSessionName)).count;
  const session = z.object({ id: z.string(), origin: z.string(), status: z.string(), resume_token: z.string().nullable() }).nullable()
    .parse(db.prepare("SELECT id,origin,status,resume_token FROM sessions WHERE node_id=? ORDER BY id DESC LIMIT 1").get(seat.nodeId) ?? null);
  const generation = z.object({ generation_uuid: z.string() }).nullable().parse(db.prepare(
    "SELECT generation_uuid FROM occupant_tenures WHERE node_id=? ORDER BY generation_ordinal DESC LIMIT 1").get(seat.nodeId) ?? null);
  const snapshot = {
    activity: activity?.activity ?? "unknown", needsInput: activity?.needsInput.count ?? null,
    backgroundWork: activity?.backgroundWork ?? null, inbox,
    restoreOutcome: seat.restoreOutcome, startupStatus: seat.startupStatus, runtime: seat.runtime,
    restorePolicy: seat.restorePolicy, lifecycleState: seat.lifecycleState, sessionStatus: session?.status ?? null,
    origin: session?.origin ?? null, generation: generation?.generation_uuid ?? null,
  };
  const eligible = activity?.activity === "idle-at-prompt" && activity.needsInput.count === 0 && !activity.backgroundWork
    && inbox === 0 && seat.runtime !== "terminal" && seat.nodeKind === "agent"
    && seat.restoreOutcome !== "awaiting-decision" && seat.startupStatus === "ready" && seat.lifecycleState === "running"
    && session?.origin === "launched" && session.status === "running" && !!generation && !!seat.canonicalSessionName
    && !isPoolAgent(db, seat.nodeId);
  return { eligible, snapshot, session, generation: generation?.generation_uuid ?? null, activitySeq: activity?.seq ?? 0 };
}
