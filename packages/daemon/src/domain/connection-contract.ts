// The shared words for what happened to a piece of work and what a member can do. Today each part of OpenRig names
// these for itself (the transport, the outbox, the queue's wake record, the hosted ring, the watchdog), and the names
// drift: a result one reader doesn't recognise reads as fine to it and as a failure to another. This module is where
// the words live, so a consumer asks it instead of matching raw strings.
//
// It translates what is already stored; it never renames it. Activity stays in activity-taxonomy.ts, which this module
// doesn't redefine. An unrecognised word always reads `unknown`, never success and never failure.

/** The two contracts' identifiers, in the daemon's existing `<name>.v<N>` form (`operation-correlation.v1`). N changes
 *  only when a word's meaning changes incompatibly; new jobs and capabilities are advertised, not versioned. */
export const TEAM_OPERATIONS_CONTRACT = "team-operations.v1";
export const MEMBER_CONNECTION_CONTRACT = "member-connection.v1";

/** Whether a member or a daemon supports something. A client reads an absent answer as `unknown`, never as
 *  `not-supported`. */
export type Support = "supported" | "not-supported" | "unknown";

/** Who established a fact: OpenRig observing it directly, OpenRig's own adapter reporting what it read from the
 *  program, or an outside adapter. A member's own claim never makes a fact observed. */
export type Reporter = "openrig-observed" | "openrig-adapter" | "outside-adapter";

/** What a delivery route says happened to one attempt. None of them means the member read the work or did it: pickup
 *  is a claim on the row, and nothing else. */
export type DeliveryFact =
  /** The route took it: text typed and submitted, a trigger answered 2xx. */
  | "accepted"
  /** Queued inside the program; no start seen yet. */
  | "queued-not-started"
  /** A turn start correlated to this attempt. */
  | "turn-started"
  /** Proven that nothing reached the member: no input was written, or the route refused before sending. */
  | "not-delivered"
  /** Held on purpose by a guard or a setting; nothing was written. */
  | "held"
  | "unknown";

export interface ReportedFact<F extends string> {
  fact: F;
  reporter: Reporter;
}

/** The route a wake took. `none` means no route can carry it (a pull-only member, an address nothing holds). */
export type WakeRoute = "terminal" | "gateway" | "hosted-trigger" | "none";

/** One wake attempt's outcome, read from the queue's recorded nudge result. */
export interface WakeOutcome extends ReportedFact<DeliveryFact> {
  /** Null when the recorded text names no route this reader knows. */
  route: WakeRoute | null;
  /** A terminal wake whose submission was seen rendered, not only sent. */
  renderVerified?: true;
  /** Which guard held it: the seat's hold or interruption level (retrying is held again), or the draft-aware check
   *  (a draft or unreadable input, which can clear on its own). */
  heldBy?: "typing-guard" | "draft-aware";
  /** The recorded text, unchanged. */
  recorded: string;
}

/** Read a queue row's recorded nudge result (`last_nudge_result`) as a delivery fact. Every form a producer writes
 *  today is listed; anything else reads `unknown` with no route, so a consumer can tell "the wake's outcome can't be
 *  read" from every known outcome. Null when no attempt was recorded. */
export function readWakeOutcome(recorded: string | null | undefined): WakeOutcome | null {
  if (recorded === null || recorded === undefined) return null;
  const at = (fact: DeliveryFact, route: WakeRoute | null, extra: Partial<WakeOutcome> = {}): WakeOutcome =>
    ({ fact, reporter: "openrig-observed", route, recorded, ...extra });
  if (recorded === "verified") return at("accepted", "terminal", { renderVerified: true });
  // Sent and submitted without render verification: the route took it, nothing more.
  if (recorded === "delivered-ack-pending") return at("accepted", "terminal");
  if (recorded === "retained:typing_guard") return at("held", "terminal", { heldBy: "typing-guard" });
  if (recorded.startsWith("retained:")) return at("held", "terminal", { heldBy: "draft-aware" });
  // A hosted member's trigger answered: the ring was taken, not the work.
  if (recorded.startsWith("wake-accepted:webhook")) return at("accepted", "hosted-trigger");
  if (recorded.startsWith("indeterminate:webhook")) return at("unknown", "hosted-trigger");
  if (recorded.startsWith("failed:webhook")) return at("not-delivered", "hosted-trigger");
  // The gateway's own ledger records whether the person was posted to; this attempt's own outcome is unknown.
  if (recorded.startsWith("gateway-owned:")) return at("unknown", "gateway");
  if (recorded.startsWith("unroutable:")) return at("not-delivered", "none");
  // `indeterminate:` covers input that may have been written (a paste, an unconfirmed Enter) and timeouts.
  if (recorded.startsWith("indeterminate:")) return at("unknown", "terminal");
  // `failed:` is written only when no input could have reached the seat.
  if (recorded.startsWith("failed:")) return at("not-delivered", "terminal");
  return at("unknown", null);
}
