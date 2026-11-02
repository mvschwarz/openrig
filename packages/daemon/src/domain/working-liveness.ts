/**
 * The runner contract's working beat (section 4): `active` / `liveness` says only that a runner's accepted prompt is
 * still outstanding and its agent alive, so a long, quiet turn keeps reading working past the 15 s a bare working post
 * decides for. It isn't progress, and it never starts or extends a turn, clears attention or stands in for a `Stop`.
 *
 * A beat counts only when it carries the seat's live occupant generation, for that generation's latest accepted turn
 * that hasn't ended, with a sequence above every earlier counted post's, and while the activity service shows no
 * attention outstanding. Attention is read from the service itself, so any post that clears it there (the runner's
 * `active` / `permission_resolved` after delivering an answer, another counted working or idle post, an operator's
 * clear) lets that turn's beats count again. The gate orders posts as the service orders a runner's durable
 * boundaries, so an older post arriving late changes neither. Anything else is ignored, which is how the seat reads
 * without beats.
 *
 * The gate keeps what it saw in memory. After a daemon restart beats are ignored until the runner's next accepted
 * prompt, so the seat reads as it would without them.
 */

import { hookPrecedes } from "./agent-activity-store.js";

export const WORKING_LIVENESS_DEFAULT_SECONDS = 30;
export const WORKING_LIVENESS_MIN_SECONDS = 5;
export const WORKING_LIVENESS_MAX_SECONDS = 60;

export type WorkingLivenessIgnored =
  | "no_turn" | "stale_generation" | "turn_ended" | "wrong_turn" | "no_sequence" | "out_of_order" | "attention_outstanding";

export function isWorkingLivenessBeat(hookEvent: unknown, subtype: unknown): boolean {
  return hookEvent === "active" && subtype === "liveness";
}

/** How long one beat counts as working: the beat's own livenessSeconds clamped to 5-60 s, or 30 s without one. A value
 *  out of range still gives bounded evidence; it's never a refusal. */
export function workingLivenessSeconds(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return WORKING_LIVENESS_DEFAULT_SECONDS;
  return Math.min(WORKING_LIVENESS_MAX_SECONDS, Math.max(WORKING_LIVENESS_MIN_SECONDS, Math.round(raw)));
}

/** A counted post that isn't a beat, as the gate needs it. */
export interface WorkingLivenessPost {
  generation: string | null;
  hookEvent: string;
  subtype: string | null;
  turnId: string | null;
  sequence: number | null;
  /** When it happened, as the activity service orders it. */
  eventAt: string | null;
  /** The runner's report that its agent process ended. */
  exit: boolean;
}

interface SeatTurn {
  generation: string | null;
  /** The latest accepted turn, with the generation its prompt was accepted under. */
  turn: { id: string; generation: string | null } | null;
  open: boolean;
  sequence: number | null;
  latest: { eventAt: string | null; sourceSequence: number | null } | null;
}

export class WorkingLivenessGate {
  private readonly seats = new Map<string, SeatTurn>();

  /** Every post the activity service counts for a seat, other than beats. A new generation starts the seat over; a post
   *  older than the latest one changes nothing, as the service drops it. */
  observe(nodeId: string, post: WorkingLivenessPost): void {
    let seat = this.seats.get(nodeId);
    if (!seat || (post.generation && seat.generation && post.generation !== seat.generation)) {
      seat = { generation: post.generation, turn: null, open: false, sequence: null, latest: null };
      this.seats.set(nodeId, seat);
    }
    const at = { eventAt: post.eventAt, sourceSequence: post.sequence };
    if (seat.latest && hookPrecedes(at, seat.latest)) return;
    seat.latest = at;
    if (post.generation) seat.generation = post.generation;
    if (post.sequence !== null) seat.sequence = Math.max(seat.sequence ?? 0, post.sequence);
    if (post.hookEvent === "UserPromptSubmit" && post.subtype === "accepted" && post.turnId) {
      seat.turn = { id: post.turnId, generation: post.generation };
      seat.open = true;
    }
    if (post.hookEvent === "Stop" || post.exit) seat.open = false;
  }

  /** Whether a beat counts. `liveGeneration` is the seat's current occupant's, and `attention` whether the activity
   *  service shows the seat waiting on a person. It changes nothing: `count` does, once the beat is recorded. */
  admit(nodeId: string, beat: { generation: string | null; liveGeneration: string | null; turnId: string | null;
    sequence: number | null; eventAt: string | null; attention: boolean }):
    { ok: true } | { ok: false; reason: WorkingLivenessIgnored } {
    const seat = this.seats.get(nodeId);
    if (!seat?.turn) return { ok: false, reason: "no_turn" };
    if (!beat.generation || beat.generation !== beat.liveGeneration || beat.generation !== seat.turn.generation) {
      return { ok: false, reason: "stale_generation" };
    }
    if (!seat.open) return { ok: false, reason: "turn_ended" };
    if (beat.turnId !== seat.turn.id) return { ok: false, reason: "wrong_turn" };
    if (beat.sequence === null) return { ok: false, reason: "no_sequence" };
    const at = { eventAt: beat.eventAt, sourceSequence: beat.sequence };
    if (seat.sequence === null || beat.sequence <= seat.sequence || (seat.latest && hookPrecedes(at, seat.latest))) {
      return { ok: false, reason: "out_of_order" };
    }
    if (beat.attention) return { ok: false, reason: "attention_outstanding" };
    return { ok: true };
  }

  /** A beat that was admitted and recorded, at the time the store recorded for it (its `occurredAt`, or when it arrived).
   *  One older than the latest counted post is dropped, as `observe` and the activity service drop it. Otherwise it
   *  raises the seat's sequence, so a delayed or repeated beat doesn't count again, and later posts are ordered against
   *  its time. */
  count(nodeId: string, beat: { sequence: number | null; eventAt: string | null }): void {
    const seat = this.seats.get(nodeId);
    if (!seat || beat.sequence === null) return;
    const at = { eventAt: beat.eventAt, sourceSequence: beat.sequence };
    if (seat.latest && hookPrecedes(at, seat.latest)) return;
    seat.sequence = Math.max(seat.sequence ?? 0, beat.sequence);
    seat.latest = at;
  }
}
