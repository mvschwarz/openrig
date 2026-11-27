import type { DraftHeldPassEnd } from "./outbox-handler.js";
import type { AgentActivity } from "./types.js";

/** The daemon's wiring (startup): the structural sweep drives the offer, the queue repository runs each pass at the seat's
 *  current activity, and the sweep's own window listing says when a pane last changed. */
export function attachDraftHeldReoffer(
  structural: { attachSweepCompleted(listener: () => void): void; paneActivity(sessionName: string): number | undefined },
  repo: { draftHeldSeats(): Array<{ session: string; newest: string }>;
    deliverDraftHeldMessagesOnIdle(sessionName: string, state: AgentActivity["state"] | undefined): Promise<DraftHeldPassEnd> },
  stateOf: (sessionName: string) => AgentActivity["state"] | undefined,
  opts: Pick<DraftHeldReofferDeps, "now" | "intervalMs" | "onError"> = {},
): void {
  structural.attachSweepCompleted(createDraftHeldReoffer({ ...opts,
    heldSeats: () => repo.draftHeldSeats(),
    deliver: sessionName => repo.deliverDraftHeldMessagesOnIdle(sessionName, stateOf(sessionName)),
    paneActivity: sessionName => structural.paneActivity(sessionName),
  }));
}

/** The shortest wait before a held message is offered again after a try that left it held: the guard's quiet window for
 *  recent client activity (3 s), tmux's whole-second activity time (up to 999 ms) and its paste settle (300 ms). */
export const DRAFT_HELD_REOFFER_MS = 4_500;

export interface DraftHeldReofferDeps {
  /** Seats with draft-held messages, with each one's newest dispatch time (OutboxHandler.draftHeldSeats). */
  heldSeats: () => Array<{ session: string; newest: string }>;
  /** One draft-held pass for the seat, at its current activity (QueueRepository.deliverDraftHeldMessagesOnIdle). */
  deliver: (session: string) => Promise<DraftHeldPassEnd>;
  /** tmux's last write time for the seat's pane, as the sweep read it (SeatStructuralActivityService.paneActivity); it
   *  changes only when the pane does. Undefined when not known, which counts as changed. */
  paneActivity: (session: string) => number | undefined;
  now?: () => number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

interface Offer { at: number; end: DraftHeldPassEnd; pane: number | undefined; newest: string; drafts: number }

/** The draft-held pass (#3991) runs when a seat's activity changes, and a change is the only thing that calls it. A
 *  first try after the person clears the draft can meet their recent typing (the guard's quiet window), a drain or a
 *  restore; once that passes, an unchanged idle screen gives no new change, and the message would stay held. This offer
 *  runs at the end of each structural sweep (the existing per-tick observation; no capture of its own) and gives each seat
 *  with draft-held messages another pass, at most once per `intervalMs`:
 *  - at once for a message held since the last offer, and for a seat not offered yet (after a restart, too);
 *  - after the interval when the last try was paused (drain, restore, mode) or held by the draft;
 *  - a draft still there after two tries waits for the pane to change, so a sitting draft isn't re-read every interval.
 *  A pass that leaves nothing eligible forgets the seat. Each pass keeps every guard and outcome rule of the pass itself. */
export function createDraftHeldReoffer(deps: DraftHeldReofferDeps): () => void {
  const interval = deps.intervalMs ?? DRAFT_HELD_REOFFER_MS;
  const now = deps.now ?? Date.now;
  const offers = new Map<string, Offer>();
  const running = new Set<string>();
  return () => {
    let seats: Array<{ session: string; newest: string }>;
    try { seats = deps.heldSeats(); } catch (error) { deps.onError?.(error); return; }
    const held = new Set(seats.map(seat => seat.session));
    for (const session of Array.from(offers.keys())) if (!held.has(session)) offers.delete(session);
    for (const { session, newest } of seats) {
      if (running.has(session)) continue;
      const last = offers.get(session);
      const pane = deps.paneActivity(session);
      // An unknown pane time counts as changed, so missing information never leaves a message waiting.
      const samePane = pane !== undefined && pane === last?.pane;
      const newHold = !last || newest > last.newest;
      if (!newHold && now() - last!.at < interval) continue;
      if (!newHold && last!.end === "draft" && last!.drafts >= 2 && samePane) continue;
      running.add(session);
      void deps.deliver(session).then(end => {
        if (end === "done") { offers.delete(session); return; }
        const drafts = end !== "draft" ? 0 : last?.end === "draft" && samePane ? last.drafts + 1 : 1;
        offers.set(session, { at: now(), end, pane, newest, drafts });
      }, error => { offers.set(session, { at: now(), end: "paused", pane, newest, drafts: 0 }); deps.onError?.(error); })
        .finally(() => running.delete(session));
    }
  };
}
