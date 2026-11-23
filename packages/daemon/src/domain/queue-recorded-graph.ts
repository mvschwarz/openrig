import type { QueueItem, QueueRepository } from "./queue-repository.js";

type Relation = "reply-to" | "handed-off-from" | "blocked-on";
export const QUEUE_GRAPH_LIMITS = { nodes: 100, related: 100, handoffHops: 20 } as const;

/** The app result's recorded graph, also usable without an app request. No seat/time inference or remote reads. */
export function recordedQueueGraph(queue: Pick<QueueRepository, "getById" | "relatedTo">, rootId: string,
  options: { capturedWorkIds?: readonly string[]; includeAncestors?: boolean } = {}) {
  const nodes = new Map<string, QueueItem>();
  const edges: Array<{ from: string; to: string; relation: string; sourceQitemId: string; captured?: true }> = [];
  const reasons = new Set<string>();
  const unresolved: Array<{ reference: string; reason: string }> = [];
  const partial = (reason: string, reference?: string) => {
    reasons.add(reason);
    if (reference && !unresolved.some(item => item.reference === reference && item.reason === reason)) unresolved.push({ reference, reason });
  };
  const result = () => ({ nodes, edges, partial: reasons.size > 0, partialReasons: [...reasons], unresolved, limits: QUEUE_GRAPH_LIMITS });
  const root = queue.getById(rootId);
  if (!root || root.contentErasedAt) { partial(root ? "content-unavailable" : "not-recorded-locally", rootId); return result(); }
  const pending: Array<{ id: string; hops: number }> = [{ id: rootId, hops: 0 }];
  const addEdge = (from: string, to: string, relation: string, captured = false) => {
    if (!edges.some(edge => edge.from === from && edge.to === to && edge.relation === relation)) {
      edges.push({ from, to, relation, sourceQitemId: to, ...(captured ? { captured: true as const } : {}) });
    }
  };
  for (const id of options.capturedWorkIds ?? []) {
    addEdge(rootId, id, "blocked-on", true); pending.push({ id, hops: 0 });
  }
  while (pending.length) {
    const next = pending.shift()!;
    if (nodes.has(next.id)) continue;
    if (nodes.size >= QUEUE_GRAPH_LIMITS.nodes) { partial("node-limit", next.id); continue; }
    if (next.hops > QUEUE_GRAPH_LIMITS.handoffHops) { partial("handoff-limit", next.id); continue; }
    const item = queue.getById(next.id);
    if (!item || item.contentErasedAt) { partial(item ? "content-unavailable" : "not-recorded-locally", next.id); continue; }
    nodes.set(item.qitemId, item);
    const related = queue.relatedTo(item.qitemId);
    if (related.length >= QUEUE_GRAPH_LIMITS.related + 1) partial("related-limit", item.qitemId);
    for (const edge of related.slice(0, QUEUE_GRAPH_LIMITS.related)) {
      addEdge(item.qitemId, edge.item.qitemId, edge.relation);
      pending.push({ id: edge.item.qitemId, hops: next.hops + (edge.relation === "handed-off-from" ? 1 : 0) });
    }
    if (options.includeAncestors) {
      const parents: Array<[Relation, string | null | undefined]> = [["reply-to", item.replyTo], ["handed-off-from", item.handedOffFrom], ["blocked-on", item.blockedOn]];
      for (const [relation, id] of parents) {
        if (!id) continue;
        addEdge(id, item.qitemId, relation);
        pending.push({ id, hops: next.hops + (relation === "handed-off-from" ? 1 : 0) });
      }
    }
    // A handed-to address is not an item ID. Only a recorded successor's handedOffFrom can resolve it.
    if (item.handedOffTo && !related.some(edge => edge.relation === "handed-off-from" && edge.item.destinationSession === item.handedOffTo)) {
      partial("unresolved-successor", item.handedOffTo);
    }
  }
  const active = new Set<string>(), visited = new Set<string>();
  const cycle = (id: string): boolean => {
    if (active.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id); active.add(id);
    const found = edges.some(edge => edge.from === id && cycle(edge.to)); active.delete(id); return found;
  };
  if (options.includeAncestors ? [...nodes.keys()].some(cycle) : cycle(rootId)) partial("cycle");
  return result();
}
