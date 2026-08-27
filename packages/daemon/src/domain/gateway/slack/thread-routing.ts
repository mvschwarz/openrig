// S10 — deterministic thread ROUTING over the thread↔seat map. The four enumerated classes
// (proof contract), each a pure lookup — zero inference:
//   1. NEW conversation      — outbound-only: a fresh root posts un-threaded, then the map
//                              opens (thread_ts = the posted root's ts). Inbound never mints.
//   2. EXISTING thread       — reply carries thread_ts, map hit (open) → EXACTLY the mapped seat.
//   3. CLOSED thread         — map hit (closed) → STILL exactly the mapped seat (closure is
//                              conversation state, never a routing black hole).
//   4. UNMAPPED / human-initiated — thread_ts with no mapping, or a top-level channel message
//                              (no thread_ts): the ORCHESTRATOR's unrouted-signal row — the
//                              configured inbound destination with the unrouted-signal tag.
//                              Never dropped, never guessed at a seat.

import type { SlackEvent } from "./inbound.js";
import type { ThreadSeatMap } from "./thread-seat-map.js";

export interface InboundRoute {
  destination: string;
  tags: string[];
  /** The routing class that fired — receipts per class ride the row tags + logs. */
  routeClass: "existing-thread" | "closed-thread" | "unmapped-thread" | "human-initiated";
}

const BASE_TAGS = ["founder-slack", "inbound"];

export function makeThreadRouteResolver(opts: {
  map: ThreadSeatMap;
  /** The orchestrator slot for unrouted signals (first-class config: inboundDestination). */
  unroutedDestination: string;
  log?: (msg: string) => void;
}): (ev: SlackEvent & { thread_ts?: string }) => InboundRoute {
  const log = opts.log ?? (() => {});
  return (ev) => {
    const threadTs = (ev as { thread_ts?: string }).thread_ts;
    if (threadTs) {
      const mapping = opts.map.resolveByThread(threadTs);
      if (mapping) {
        // FOUNDER ROOT INVARIANT (2026-08-27): the map stores the bare local seat because the
        // queue row's source_session is bare inside one instance — the seat routes as stored.
        // (The interim self-host localizer from the L2 first pass was deleted with the root
        // stamping; historical triple rows are the operator adoption's one-time cleanup.)
        const routeClass = mapping.state === "closed" ? "closed-thread" : "existing-thread";
        log(`inbound routed thread_ts=${threadTs} -> ${mapping.seat} (${routeClass})`);
        return { destination: mapping.seat, tags: [...BASE_TAGS, "thread"], routeClass };
      }
      log(`inbound UNMAPPED thread_ts=${threadTs} -> unrouted-signal to ${opts.unroutedDestination} (never dropped, never guessed)`);
      return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "unmapped-thread" };
    }
    log(`inbound human-initiated (no thread_ts) -> unrouted-signal to ${opts.unroutedDestination}`);
    return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "human-initiated" };
  };
}
