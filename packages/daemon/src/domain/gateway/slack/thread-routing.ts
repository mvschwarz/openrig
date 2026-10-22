// S10 — deterministic thread ROUTING over the thread↔seat map. The four enumerated classes
// (proof contract), each a pure lookup — zero inference:
//   1. NEW conversation      — a fresh root posts un-threaded, then the map opens (thread_ts =
//                              the posted root's ts). A person's top-level message also opens
//                              one, its own ts as the root (inbound.ts), so the reply and later
//                              updates land under it.
//   2. EXISTING thread       — reply carries thread_ts, map hit (open) → EXACTLY the mapped seat.
//   3. CLOSED thread         — map hit (closed) → STILL exactly the mapped seat (closure is
//                              conversation state, never a routing black hole).
//   4. UNMAPPED / human-initiated — thread_ts with no mapping, or a top-level channel message
//                              (no thread_ts): the ORCHESTRATOR's unrouted-signal row — the
//                              configured inbound destination with the unrouted-signal tag.
//                              Never dropped, never guessed at a seat. A top-level message in a
//                              channel the channel map routes (an `inbound` seat or a rig's
//                              representative) goes there instead, tagged channel-routed.

import type { SlackEvent } from "./inbound.js";
import type { ThreadSeatMap } from "./thread-seat-map.js";

export interface InboundRoute {
  destination: string;
  tags: string[];
  /** Exact human-gate qitem this thread was opened for. Absent on unmapped traffic. */
  correlationQitemId?: string;
  /** The routing class that fired — receipts per class ride the row tags + logs. */
  routeClass: "existing-thread" | "closed-thread" | "unmapped-thread" | "human-initiated";
}

const BASE_TAGS = ["founder-slack", "inbound"];

export function makeThreadRouteResolver(opts: {
  map: ThreadSeatMap;
  /** The orchestrator slot for unrouted signals (first-class config: inboundDestination). */
  unroutedDestination: string;
  /** Where a person's top-level message in this channel goes, or null for the orchestrator slot
   *  (channel-map.ts resolveInboundChannelDestination). Absent: every such message goes there. */
  resolveChannelDestination?: (channel: string | undefined) => string | null;
  log?: (msg: string) => void;
}): (ev: SlackEvent & { thread_ts?: string }) => InboundRoute {
  const log = opts.log ?? (() => {});
  return (ev) => {
    const threadTs = (ev as { thread_ts?: string }).thread_ts;
    if (threadTs) {
      // A root is its channel's: a ts is unique only within a channel.
      const mapping = opts.map.resolveByThread(threadTs, ev.channel);
      // #899 — a reaction names its message by channel and timestamp, and a timestamp is unique only
      // within a channel, so a reaction on another channel's message is not on this ask. A root minted
      // from a person's own message is no ask OpenRig posted, so a reaction on it isn't one either.
      const sameMessage = ev.type !== "reaction_added" || (mapping !== null && mapping.channel === ev.channel && mapping.origin !== "person");
      if (ev.type === "reaction_added" && !(mapping && sameMessage)) {
        // #899 — a reaction on a message OpenRig posted into a thread for an ask (a long ask's reply
        // part, a later notification, an ask posted into another thread) reaches that ask's own seat.
        // A person's reply in the thread was not posted by OpenRig, so a reaction on it stays ignored.
        const part = opts.map.partOf(threadTs, ev.channel ?? "");
        if (part) {
          log(`inbound reaction on ts=${threadTs} (posted for ${part.conversationId}) -> ${part.seat}`);
          return {
            destination: part.seat,
            tags: [...BASE_TAGS, "thread", `reply-to:${part.conversationId}`],
            correlationQitemId: part.conversationId,
            routeClass: "existing-thread",
          };
        }
      }
      if (mapping && sameMessage) {
        // FOUNDER ROOT INVARIANT (2026-08-27): the map stores the bare local seat because the
        // queue row's source_session is bare inside one instance — the seat routes as stored.
        // (The interim self-host localizer from the L2 first pass was deleted with the root
        // stamping; historical triple rows are the operator adoption's one-time cleanup.)
        const routeClass = mapping.state === "closed" ? "closed-thread" : "existing-thread";
        // #96: once an update shares a root, its owner's next decision posts a fresh root. A reply
        // still arriving in the OLDER root lands on the seat as a message but answers nothing:
        // only the conversation's newest root correlates to its current human gate.
        const newest = opts.map.resolveByConversation(mapping.conversationId);
        const current = !newest || (newest.threadTs === threadTs && newest.channel === mapping.channel);
        log(`inbound routed thread_ts=${threadTs} -> ${mapping.seat} (${routeClass}${current ? "" : ", superseded root: no gate correlation"})`);
        return {
          destination: mapping.seat,
          tags: [...BASE_TAGS, "thread", `reply-to:${mapping.conversationId}`],
          ...(current ? { correlationQitemId: mapping.conversationId } : {}),
          routeClass,
        };
      }
      // #899 — a reaction on a message that isn't an ask is ignored by its caller, not sent here.
      if (ev.type !== "reaction_added") log(`inbound UNMAPPED thread_ts=${threadTs} -> unrouted-signal to ${opts.unroutedDestination} (never dropped, never guessed)`);
      return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "unmapped-thread" };
    }
    const channelDestination = opts.resolveChannelDestination?.(ev.channel) ?? null;
    if (channelDestination) {
      log(`inbound human-initiated in channel ${ev.channel} -> channel-routed to ${channelDestination}`);
      return { destination: channelDestination, tags: [...BASE_TAGS, "channel-routed"], routeClass: "human-initiated" };
    }
    log(`inbound human-initiated (no thread_ts) -> unrouted-signal to ${opts.unroutedDestination}`);
    return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "human-initiated" };
  };
}
