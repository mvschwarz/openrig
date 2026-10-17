/** What restore knows about one saved seat when it reads the seat's restore policy. */
export interface RestoreSeatFacts {
  /** The runtime the snapshot saved the seat with. */
  savedRuntime: string | null | undefined;
  /** The runtime the seat has now (the live node's, else the saved one). */
  currentRuntime: string | null | undefined;
  /** Every session the snapshot recorded for the seat, whatever its status. */
  recordedSessions: ReadonlyArray<{ resumeToken?: string | null }>;
}

/** A terminal seat restore may relaunch without asking: the saved and the current runtime are both terminal and none
 *  of the seat's recorded sessions carries a resume token, by whichever route it was written. A seat with a
 *  recorded token has history, and a seat whose runtime changed has a saved identity that no longer matches its
 *  label: neither is ordinary, and both keep the stop-and-ask result. */
export function isOrdinaryTerminalSeat(seat: RestoreSeatFacts): boolean {
  return seat.savedRuntime === "terminal"
    && seat.currentRuntime === "terminal"
    && !seat.recordedSessions.some((session) => !!session.resumeToken?.trim());
}

/** The restore policy restore acts on for one saved seat.
 *
 *  A terminal has no conversation to resume. Its session rows still read `resume_if_possible`, the
 *  column default every session a relaunch creates takes (migration 006), and restore stops a
 *  `resume_if_possible` seat that has no token and asks for `--fresh`. Left alone, a terminal seat
 *  would wait for a decision on every restore after its first. So `resume_if_possible` means
 *  `relaunch_fresh` for an ordinary terminal seat (see isOrdinaryTerminalSeat); any other policy, and
 *  any other seat, is read as saved. */
export function effectiveRestorePolicy(seat: RestoreSeatFacts, policy: string | null | undefined): string {
  const saved = policy ?? "resume_if_possible";
  return saved === "resume_if_possible" && isOrdinaryTerminalSeat(seat) ? "relaunch_fresh" : saved;
}
