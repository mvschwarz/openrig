// OPR.0.3.2.20 — For You priority windowing.
//
// useAttentionItems wraps the daemon attention read — the durable source
// of truth — so the For You Action-required + Approval lenses don't
// depend on the lossy ephemeral client event FIFO at
// `useActivityFeed.MAX_ACTIVITY_EVENTS=100`.
//
// OPR.0.4.4.15: when the operator has ≥1 remote host subscription enabled
// the hook polls GET /api/queue/attention-aggregate (the shared P4
// contract: items stamped with origin hostId + a per-host structured
// status array) — aggregation is DAEMON-SIDE; this hook still only ever
// talks to the local daemon (no bearer, no cross-origin — the FR-1
// negative AC). Zero-config keeps TODAY'S endpoint and wire untouched;
// the hook normalizes both paths to {items, hosts} (hosts empty on the
// legacy path).
//
// HG-8 freshness: react-query refetchOnWindowFocus is set to the
// string variant 'always' (NOT boolean `true`). With a non-trivial
// staleTime, boolean `true` is gated by the staleness predicate and
// can skip refetches inside the stale window (banked
// feedback_refetchOnWindowFocus_staleness_gated_use_always_string).
// 'always' bypasses the gate so the attention surface refreshes on
// every focus.

import { useQuery } from "@tanstack/react-query";

export interface AttentionQueueItem {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string[] | null;
  blockedOn: string | null;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  body: string;
  /** Plain-language title (queue summary column) when present. */
  summary?: string | null;
  /** OPR.0.4.4.20 FR-9 win #2 (Packet-1 C3): the judge-this pointer.
   *  Optional/defensive — absent on pre-P1 daemons. */
  evidenceRef?: string | null;
  /** OPR.0.4.4.15: origin host id on aggregated items ('local' or a
   *  registered host id). Absent on the legacy single-host path. */
  hostId?: string;
}

/** Mirror of the daemon fanout-contract PerHostStatus (closed enum). */
export interface AttentionHostStatus {
  hostId: string;
  status: "ok" | "unreachable" | "unsupported-transport" | "auth-failed";
  error?: string;
  failedStep?: string;
}

export interface AttentionData {
  items: AttentionQueueItem[];
  hosts: AttentionHostStatus[];
}

async function fetchAttentionItems(limit?: number): Promise<AttentionQueueItem[]> {
  const params = new URLSearchParams({ attention: "1" });
  if (limit !== undefined) params.set("limit", String(limit));
  const res = await fetch(`/api/queue/list?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AttentionQueueItem[];
}

async function fetchAggregatedAttention(limit?: number): Promise<AttentionData> {
  const res = await fetch("/api/queue/attention-aggregate");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as Partial<AttentionData>;
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    items: limit !== undefined ? items.slice(0, limit) : items,
    hosts: Array.isArray(payload.hosts) ? payload.hosts : [],
  };
}

/**
 * Open attention-class qitems (tier="human-gate" OR destination is
 * human-CLASS via isHumanSeatSessionRef — human-seat
 * /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/ OR the A2 virtual-domain
 * leg <local>@external). State default
 * is pending|in-progress|blocked — closed/done items are NOT surfaced.
 *
 * `limit` (optional, default 50) caps the rendered set so a
 * pathological backlog can't unbounded-render. The attention set is
 * small by nature.
 *
 * `aggregated` (OPR.0.4.4.15): poll the consolidated multi-host read
 * instead of the single-host list. Callers pass true ONLY when a remote
 * host subscription is enabled — zero-config stays on the legacy wire.
 */
export function useAttentionItems(limit: number = 50, aggregated: boolean = false) {
  return useQuery<AttentionData>({
    queryKey: ["attention-items", limit, aggregated],
    queryFn: aggregated
      ? () => fetchAggregatedAttention(limit)
      : async () => ({ items: await fetchAttentionItems(limit), hosts: [] }),
    staleTime: 15_000,
    // HG-8: 'always' (not `true`) — see file header comment.
    refetchOnWindowFocus: "always",
  });
}
