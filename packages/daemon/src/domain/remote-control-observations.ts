// #3513: what a Claude seat's own hooks last reported about its Remote Control session, for the node read. Claude Code
// sets `CLAUDE_CODE_BRIDGE_SESSION_ID` in its hook subprocesses while Remote Control is connected (documented from
// v2.1.199); the activity relay reports it on the events it already posts. This is an observation, not connection
// health: an idle seat's value ages, and a disconnect or a replaced session is learned on the next delivered hook.
//
// Observed absent is kept apart from never observed. A hook that saw no variable proves nothing by itself (an older
// Claude doesn't set it), so absence is recorded only for an occupant and conversation that earlier reported a session:
// that report shows its Claude supports the variable.
import type Database from "better-sqlite3";

/** What the node read shows: the session last seen and when. `sessionId: null` is a seen disconnect. */
export interface RemoteControlObservation {
  sessionId: string | null;
  observedAt: string;
}

/** One hook's report, parsed at the boundary. */
export type RemoteControlReport = { kind: "present"; sessionId: string } | { kind: "absent" };

const BRIDGE_SESSION_ID = /^session_[A-Za-z0-9]{1,128}$/;

/** The relay's `remoteControlSessionId`: a well-formed id is present, an explicit null is absent, anything else (the
 *  key missing, another runtime, a malformed value) makes no claim. */
export function parseRemoteControlReport(body: Record<string, unknown>): RemoteControlReport | null {
  if (!Object.prototype.hasOwnProperty.call(body, "remoteControlSessionId")) return null;
  const value = body.remoteControlSessionId;
  if (value === null) return { kind: "absent" };
  return typeof value === "string" && BRIDGE_SESSION_ID.test(value) ? { kind: "present", sessionId: value } : null;
}

interface Row {
  occupant_generation: string;
  conversation_id: string;
  session_id: string | null;
  observed_at: string;
}

export type RecordOutcome = "recorded" | "ignored";

export class RemoteControlObservationStore {
  constructor(private readonly db: Database.Database) {}

  /** The seat's own Claude conversation: its current resume token, as the activity store reads it (#99). */
  currentConversation(nodeId: string): string | null {
    const row = this.db.prepare("SELECT resume_type, resume_token FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
      .get(nodeId) as { resume_type: string | null; resume_token: string | null } | undefined;
    const token = row?.resume_type === "claude_id" ? row.resume_token?.trim() : "";
    return token ? token : null;
  }

  /**
   * Record one report from a generation that is still the seat's occupant (`isCurrentOccupant`: the current one, or
   * one followed only by no-launch adoptions, whose hooks keep their launch generation;
   * SessionRegistry.isOccupantContinuedByAdoption, the rule the node read uses too) in the seat's own conversation.
   * One row per node:
   * - the same occupant and conversation: a report no older than the row replaces its session (present or absent);
   * - another occupant or conversation: only a present report replaces the row, so absence is never inferred for a
   *   conversation that hasn't shown it supports the variable;
   * - no row: only a present report creates one.
   */
  record(input: { nodeId: string; generation: string; conversationId: string; report: RemoteControlReport; observedAt: string;
    isCurrentOccupant: (generation: string) => boolean }): RecordOutcome {
    if (!input.isCurrentOccupant(input.generation)) return "ignored";
    if (input.conversationId !== this.currentConversation(input.nodeId)) return "ignored";
    const write = this.db.transaction((): RecordOutcome => {
      const row = this.db.prepare(
        "SELECT occupant_generation, conversation_id, session_id, observed_at FROM remote_control_observations WHERE node_id = ?",
      ).get(input.nodeId) as Row | undefined;
      // One occupant, not one generation: a launch generation and the adoption generations after it both pass
      // isCurrentOccupant, and two that both pass have no launch between them (Helios FAIL on 52f5af2), so ordering
      // and an observed disconnect carry across them. The conversation must still be the same.
      const samePair = row !== undefined && input.isCurrentOccupant(row.occupant_generation)
        && row.conversation_id === input.conversationId;
      if (samePair && input.observedAt < row.observed_at) return "ignored";
      if (!samePair && input.report.kind === "absent") return "ignored";
      this.db.prepare(`INSERT INTO remote_control_observations (node_id, occupant_generation, conversation_id, session_id, observed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET occupant_generation = excluded.occupant_generation,
          conversation_id = excluded.conversation_id, session_id = excluded.session_id, observed_at = excluded.observed_at`)
        .run(input.nodeId, input.generation, input.conversationId,
          input.report.kind === "present" ? input.report.sessionId : null, input.observedAt);
      return "recorded";
    });
    return write();
  }

  /** The observation for the seat's current occupant and conversation, or null when none applies (never observed, or
   *  recorded for an earlier occupant or conversation: an earlier occupant's link is never shown as current).
   *  `isCurrentOccupant` says whether the row's generation is still the seat's: the current one, or one followed only
   *  by no-launch adoptions (SessionRegistry.isOccupantContinuedByAdoption, the rule the write uses too). */
  current(input: { nodeId: string; isCurrentOccupant: (generation: string) => boolean }): RemoteControlObservation | null {
    const row = this.db.prepare(
      "SELECT occupant_generation, conversation_id, session_id, observed_at FROM remote_control_observations WHERE node_id = ?",
    ).get(input.nodeId) as Row | undefined;
    if (!row || !input.isCurrentOccupant(row.occupant_generation)
      || row.conversation_id !== this.currentConversation(input.nodeId)) {
      return null;
    }
    return { sessionId: row.session_id, observedAt: row.observed_at };
  }
}
