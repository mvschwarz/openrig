// The seat boundary. A seat's kind comes from its binding's `attachment_type`, the key the seat-kinds facade in #1429
// proposed (by rlch, credited). This first boundary covers today's kinds only: tmux, which is also the column's default
// and what a legacy row with no value means, and external_cli. Each seat's three responsibilities stay where they are:
// the runtime that keeps the process alive (RuntimeAdapter), the session that carries messages and turns to the agent
// (SessionTransport, which asks this resolver), and the view a person watches and types into (TerminalProvider).

/** Today's seat kinds. */
export type SeatKind = "tmux" | "external_cli";

/** A binding's kind as stored. `unknown` names a stored value that isn't one of today's kinds, and is never read as tmux. */
export type ResolvedSeatKind = { kind: SeatKind } | { kind: "unknown"; stored: string };

export function resolveSeatKind(stored: string | null | undefined): ResolvedSeatKind {
  if (stored === null || stored === undefined || stored === "tmux") return { kind: "tmux" };
  if (stored === "external_cli") return { kind: "external_cli" };
  return { kind: "unknown", stored };
}

/** How OpenRig's inbound transport (send, capture and the activity probe) reaches a seat of this kind. An external CLI
 *  seat runs inside someone else's program, so OpenRig can't type into it or read it: `none`. An unknown stored kind
 *  keeps the path it takes today, the tmux one, so nothing changes for it here; whether it should is an open question
 *  for its owner, not something this boundary settles. */
export function seatInboundTransport(seat: ResolvedSeatKind): "tmux" | "none" {
  return seat.kind === "external_cli" ? "none" : "tmux";
}

/** Who runs a seat's process, which decides whether OpenRig's lifecycle (restore, fresh launch, teardown) acts on it. An
 *  external CLI seat joined with `rig attach` runs in someone else's program: OpenRig neither launches nor stops it, and
 *  leaves it attached. An unknown stored kind keeps the path it takes today, OpenRig's own; as for the inbound transport,
 *  whether it should is a question for its owner. */
export function seatProcessOwner(seat: ResolvedSeatKind): "openrig" | "external" {
  return seat.kind === "external_cli" ? "external" : "openrig";
}
