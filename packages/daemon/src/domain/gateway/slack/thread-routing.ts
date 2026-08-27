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
  routeClass: "existing-thread" | "closed-thread" | "unmapped-thread" | "human-initiated" | "remote-mapped-seat";
}

const BASE_TAGS = ["founder-slack", "inbound"];

/** L2 fix — the ROUTE-ADDRESS seam: the map may hold a 51-09 self-host-stamped source triple
 *  (`member@rig@host-…`, exactly what the outbound row's stamped sourceSession carries). The
 *  local queue accepts only the canonical bare `member@rig`, so a mapped seat resolves here:
 *    - suffix == THIS daemon's selfHostId → the canonical bare local session (queue-accepted);
 *    - suffix is a FOREIGN host → NOT blindly stripped: remote routing semantics do not exist
 *      on this path yet, so the reply routes honestly as an unrouted signal (never dropped,
 *      never guessed);
 *    - selfHostId UNKNOWN (null) → a triple is never guessed local — same honest refusal.
 *  Read-side by design: existing map rows written before this fix (the live event's row
 *  included) resolve correctly without any data migration. */
function resolveMappedSeat(seat: string, selfHostId: string | null | undefined):
  | { kind: "local"; session: string }
  | { kind: "remote"; seat: string } {
  const parts = seat.split("@");
  if (parts.length <= 2) return { kind: "local", session: seat };
  const host = parts.slice(2).join("@");
  if (selfHostId && host === selfHostId) return { kind: "local", session: `${parts[0]}@${parts[1]}` };
  return { kind: "remote", seat };
}

export function makeThreadRouteResolver(opts: {
  map: ThreadSeatMap;
  /** The orchestrator slot for unrouted signals (first-class config: inboundDestination). */
  unroutedDestination: string;
  /** This daemon's own durable self-host id (51-09) — the discriminator between a stamped
   *  LOCAL seat and a genuinely remote one. null = unknown → never guess. */
  selfHostId?: string | null;
  log?: (msg: string) => void;
}): (ev: SlackEvent & { thread_ts?: string }) => InboundRoute {
  const log = opts.log ?? (() => {});
  return (ev) => {
    const threadTs = (ev as { thread_ts?: string }).thread_ts;
    if (threadTs) {
      const mapping = opts.map.resolveByThread(threadTs);
      if (mapping) {
        const resolved = resolveMappedSeat(mapping.seat, opts.selfHostId);
        if (resolved.kind === "remote") {
          log(`inbound thread_ts=${threadTs} maps to REMOTE/unverifiable seat ${mapping.seat} — remote routing is not implemented on this path; unrouted-signal to ${opts.unroutedDestination} (never dropped, never guessed)`);
          return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "remote-mapped-seat" };
        }
        const routeClass = mapping.state === "closed" ? "closed-thread" : "existing-thread";
        log(`inbound routed thread_ts=${threadTs} -> ${resolved.session} (${routeClass})`);
        return { destination: resolved.session, tags: [...BASE_TAGS, "thread"], routeClass };
      }
      log(`inbound UNMAPPED thread_ts=${threadTs} -> unrouted-signal to ${opts.unroutedDestination} (never dropped, never guessed)`);
      return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "unmapped-thread" };
    }
    log(`inbound human-initiated (no thread_ts) -> unrouted-signal to ${opts.unroutedDestination}`);
    return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "human-initiated" };
  };
}
