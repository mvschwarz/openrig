// OPR.0.5.5.19 AM-R18 — the TUI's oracle SUBSCRIPTION path: an SSE connection to the
// daemon's GET /api/activity/events. Pushes are CHANGE NOTIFICATIONS ONLY (seat + seq) —
// the open view re-renders by rehydrating the same /api/ps projection, so no second
// activity derivation exists anywhere on this path (desk-accepted shape, ruling row
// qitem-20260827001530). NO IDLE POLLING: onEvent fires only on pushed changes; the
// only timer here is connection-maintenance backoff after a DROP, never a data poll.
//
// S19 AM-R18 RED: unwired.

export interface ActivityEventsSubscription {
  close: () => void;
}

export interface SubscribeActivityEventsOpts {
  baseUrl: string;
  /** One pushed oracle change (parsed SSE data line). The consumer refreshes; it never
   *  reads activity fields from the push. */
  onEvent: (event: { type: string; seatNodeId?: string; seq?: number }) => void;
  /** Connection lifecycle notes (drop/reconnect) — surfaced, never fatal. */
  onStatus?: (status: "connected" | "dropped" | "reconnecting") => void;
  /** Reconnect backoff (ms) after a drop. Connection maintenance, not data polling. */
  reconnectDelayMs?: number;
}

export function subscribeActivityEvents(_opts: SubscribeActivityEventsOpts): ActivityEventsSubscription {
  throw new Error("not implemented (S19 AM-R18 RED)");
}
