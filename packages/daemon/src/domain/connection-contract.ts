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
  /** The route reported a failure after the attempt may already have reached the member (an error answer, a dropped
   *  connection): failed, with its effect unknown. */
  | "failed-effect-unknown"
  /** Held on purpose by a guard or a setting; nothing was written. */
  | "held"
  | "unknown";

export interface ReportedFact<F extends string> {
  fact: F;
  reporter: Reporter;
}

/** Whether a member outside any terminal is checking its queue. It's a status, never a refusal: work addressed to the
 *  member queues and is rung exactly as before, a check-in isn't pickup (pickup is a claim), and no check-in isn't
 *  idle, failure or safe. */
export type CheckInStatus =
  /** Its last check-in is no older than twice its stated cadence (`CHECK_IN_OVERDUE_CADENCES`). */
  | "checking-in"
  /** Its last check-in is older than twice its stated cadence: its schedule may be off or waiting for an approval. */
  | "check-in-overdue"
  /** No check-in recorded for it. */
  | "no-check-in-yet"
  /** Its setup says it checks its queue when a person asks it (`check_in_on_request`), not on a schedule. */
  | "on-request"
  /** Its connection was revoked or removed, as recorded. Never inferred from silence. Nothing records a revocation yet,
   *  so nothing emits it: a revoked member stops checking in and reads overdue. */
  | "disconnected"
  /** Its setup states no cadence, its stated one can't be used, or its check-ins couldn't be read (the reason says
   *  which). Never idle and never overdue: with no stated cadence, OpenRig assumes none. */
  | "unknown";

/** How each check-in status reads to a person. */
export const CHECK_IN_DISPLAY: Readonly<Record<CheckInStatus, string>> = {
  "checking-in": "checking in",
  "check-in-overdue": "overdue",
  "no-check-in-yet": "no check-in yet",
  "on-request": "on request",
  "disconnected": "disconnected",
  "unknown": "unknown",
};

/** The one rule for a stated cadence: a last check-in no older than this many cadences reads checking in, and an older
 *  one overdue. One missed run, plus its schedule's own jitter, isn't overdue. A cadence is its person's statement, so
 *  neither reading proves a vendor schedule or a pickup. */
export const CHECK_IN_OVERDUE_CADENCES = 2;

export interface MemberCheckIn {
  status: CheckInStatus;
  /** Its own latest read of its pending inbox, as OpenRig observed it. */
  lastCheckInAt: string | null;
  /** The cadence its person stated at setup; null when none was. */
  expectedMinutes: number | null;
  /** Its setup says it checks in when a person asks it. */
  onRequest: boolean;
  reporter: Reporter;
  /** Why the status is unknown, when it is. */
  reason?: string;
}

/** A connected assistant's check-in status from what its setup states (a cadence, or on request) and its last observed
 *  check-in (`seen`, `never`, or `unknown` when the record can't be read). First match wins: disconnected, unknown (an
 *  unusable statement or an unreadable record), no check-in yet, on request, then checking in or overdue by its cadence,
 *  else unknown because it states none. Nothing passes `revokedAt` yet, so nothing reads disconnected. */
export function memberCheckInStatus(input: {
  checkInMinutes: number | null | undefined;
  /** Its setup says it checks in on request rather than on a schedule. */
  onRequest?: boolean;
  /** Why the stated cadence can't be used, from the roster. */
  cadenceProblem?: string | null;
  checkIn: { state: "seen"; at: string } | { state: "never" } | { state: "unknown" };
  revokedAt?: string | null;
  now: Date;
}): MemberCheckIn {
  const expectedMinutes = input.checkInMinutes ?? null;
  const lastCheckInAt = input.checkIn.state === "seen" ? input.checkIn.at : null;
  const onRequest = input.onRequest === true;
  const unknown = (reason: string): MemberCheckIn => ({ status: "unknown", lastCheckInAt, expectedMinutes, onRequest, reporter: "openrig-observed", reason });
  const known = (status: CheckInStatus): MemberCheckIn => ({ status, lastCheckInAt, expectedMinutes, onRequest, reporter: "openrig-observed" });
  if (input.revokedAt) return known("disconnected");
  if (input.cadenceProblem) return unknown(input.cadenceProblem);
  if (input.checkIn.state === "unknown") return unknown("its check-ins couldn't be read");
  if (input.checkIn.state === "never") return known("no-check-in-yet");
  if (onRequest) return known("on-request");
  if (expectedMinutes === null) return unknown(NO_CADENCE_STATED);
  const age = input.now.getTime() - Date.parse(input.checkIn.at);
  if (!Number.isFinite(age)) return unknown("its last check-in's time couldn't be read");
  return known(age <= expectedMinutes * CHECK_IN_OVERDUE_CADENCES * 60_000 ? "checking-in" : "check-in-overdue");
}

/** Why a connected assistant whose setup states neither a cadence nor on request reads unknown. */
export const NO_CADENCE_STATED = "no check-in cadence declared";

/** A connected assistant's check-in in one line for a person, with its evidence: "overdue: last check-in 13:05,
 *  expected every 60 min; its schedule may be off or waiting for an approval". */
export function describeCheckIn(c: Pick<MemberCheckIn, "status" | "lastCheckInAt" | "expectedMinutes" | "onRequest" | "reason">): string {
  const last = c.lastCheckInAt ? `last check-in ${c.lastCheckInAt}` : null;
  const expected = c.expectedMinutes !== null ? `expected every ${c.expectedMinutes} min`
    : c.onRequest ? "checks in when a person asks it" : NO_CADENCE_STATED;
  switch (c.status) {
    case "checking-in": return `checking in: ${last}, ${expected}`;
    case "check-in-overdue": return `overdue: ${last}, ${expected}; its schedule may be off or waiting for an approval`;
    case "no-check-in-yet": return `no check-in yet; ${expected}`;
    case "on-request": return `on request: it checks its queue when a person asks it${last ? `; ${last}` : ""}`;
    case "disconnected": return "disconnected: its connection was revoked or removed";
    case "unknown": return `unknown (${c.reason ?? "its check-in status couldn't be read"})${last ? `; ${last}` : ""}`;
  }
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
  // A ring that never left: no URL, no Authorization value, an invalid URL.
  if (/^failed:webhook \([^)]*\) (isn't set:|not rung:)/.test(recorded)) return at("not-delivered", "hosted-trigger");
  // Any other webhook failure came after the POST was sent. The trigger's own error answer is its report; a network
  // error is what OpenRig saw. Either way the member may have the ring.
  if (/^failed:webhook \([^)]*\) answered /.test(recorded)) {
    return at("failed-effect-unknown", "hosted-trigger", { reporter: "outside-adapter" });
  }
  if (recorded.startsWith("failed:webhook")) return at("failed-effect-unknown", "hosted-trigger");
  // The gateway's own ledger records whether the person was posted to; this attempt's own outcome is unknown.
  if (recorded.startsWith("gateway-owned:")) return at("unknown", "gateway");
  if (recorded.startsWith("unroutable:")) return at("not-delivered", "none");
  // `indeterminate:` covers input that may have been written (a paste, an unconfirmed Enter) and timeouts.
  if (recorded.startsWith("indeterminate:")) return at("unknown", "terminal");
  // `failed:` is written only when no input could have reached the seat.
  if (recorded.startsWith("failed:")) return at("not-delivered", "terminal");
  return at("unknown", null);
}
