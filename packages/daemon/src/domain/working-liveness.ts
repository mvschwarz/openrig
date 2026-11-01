/**
 * The runner contract's working beat (section 4): `active` / `liveness` says only that a runner's accepted prompt is
 * still outstanding and its agent alive, so a long, quiet turn keeps reading working past the 15 s a bare working post
 * decides for. It isn't progress, and it never starts or extends a turn, clears attention or stands in for a `Stop`.
 *
 * A beat counts only for the live generation's latest accepted turn that hasn't ended, with a sequence above every
 * earlier counted post's, and while no attention is outstanding. OpenRig's own permission prompt carries no runner
 * sequence, so attention is checked by state: the runner's `active` / `permission_resolved`, after it delivers an
 * answer, is the boundary after which that turn's beats count again. Anything else is ignored, which is how the seat
 * reads without beats.
 *
 * The gate keeps what it saw in memory. After a daemon restart beats are ignored until the runner's next accepted
 * prompt, so the seat reads as it would without them.
 */

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
  /** What the post says about the seat: needs input sets attention, working or idle clears it. */
  state: "running" | "idle" | "needs_input" | "unknown";
  /** The runner's report that its agent process ended. */
  exit: boolean;
}

interface SeatTurn {
  generation: string | null;
  turnId: string | null;
  open: boolean;
  sequence: number | null;
  attention: boolean;
}

export class WorkingLivenessGate {
  private readonly seats = new Map<string, SeatTurn>();

  /** Every post the activity service counts for a seat, other than beats. A new generation starts the seat over. */
  observe(nodeId: string, post: WorkingLivenessPost): void {
    let seat = this.seats.get(nodeId);
    if (!seat || (post.generation && seat.generation && post.generation !== seat.generation)) {
      seat = { generation: post.generation, turnId: null, open: false, sequence: null, attention: false };
      this.seats.set(nodeId, seat);
    }
    if (post.generation) seat.generation = post.generation;
    if (post.sequence !== null) seat.sequence = Math.max(seat.sequence ?? 0, post.sequence);
    if (post.hookEvent === "UserPromptSubmit" && post.subtype === "accepted" && post.turnId) {
      seat.turnId = post.turnId;
      seat.open = true;
    }
    if (post.hookEvent === "Stop" || post.exit) seat.open = false;
    if (post.state === "needs_input") seat.attention = true;
    else if (post.state === "running" || post.state === "idle" || post.exit) seat.attention = false;
  }

  /** Whether a beat counts. A counted beat raises the seat's sequence, so a delayed or repeated one doesn't count again. */
  admit(nodeId: string, beat: { generation: string | null; turnId: string | null; sequence: number | null }):
    { ok: true } | { ok: false; reason: WorkingLivenessIgnored } {
    const seat = this.seats.get(nodeId);
    if (!seat?.turnId) return { ok: false, reason: "no_turn" };
    if (beat.generation && seat.generation && beat.generation !== seat.generation) return { ok: false, reason: "stale_generation" };
    if (!seat.open) return { ok: false, reason: "turn_ended" };
    if (beat.turnId !== seat.turnId) return { ok: false, reason: "wrong_turn" };
    if (beat.sequence === null) return { ok: false, reason: "no_sequence" };
    if (seat.sequence === null || beat.sequence <= seat.sequence) return { ok: false, reason: "out_of_order" };
    if (seat.attention) return { ok: false, reason: "attention_outstanding" };
    seat.sequence = beat.sequence;
    return { ok: true };
  }
}
