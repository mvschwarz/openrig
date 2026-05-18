// OPR.0.3.2.20 — For You priority windowing.
//
// useAttentionItems wraps GET /api/queue/list?attention=1 — the daemon
// query that returns OPEN attention-class qitems (the durable source
// of truth) so the For You Action-required + Approval lenses don't
// depend on the lossy ephemeral client event FIFO at
// `useActivityFeed.MAX_ACTIVITY_EVENTS=100`.
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
}

async function fetchAttentionItems(limit?: number): Promise<AttentionQueueItem[]> {
  const params = new URLSearchParams({ attention: "1" });
  if (limit !== undefined) params.set("limit", String(limit));
  const res = await fetch(`/api/queue/list?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AttentionQueueItem[];
}

/**
 * Open attention-class qitems (tier="human-gate" OR destination
 * matches /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/). State default
 * is pending|in-progress|blocked — closed/done items are NOT surfaced.
 *
 * `limit` (optional, default 50) caps the rendered set so a
 * pathological backlog can't unbounded-render. The attention set is
 * small by nature.
 */
export function useAttentionItems(limit: number = 50) {
  return useQuery({
    queryKey: ["attention-items", limit],
    queryFn: () => fetchAttentionItems(limit),
    staleTime: 15_000,
    // HG-8: 'always' (not `true`) — see file header comment.
    refetchOnWindowFocus: "always",
  });
}
