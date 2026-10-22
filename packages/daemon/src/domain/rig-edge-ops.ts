import type { RigRepository } from "./rig-repository.js";
import type { Edge, NodeWithBinding } from "./types.js";
import { VALID_EDGE_KINDS } from "./rigspec-schema.js";
import { defaultResolveOrchestrator, resolveRigRepresentative } from "./queue-owner.js";

/** Edge-only mutations: no node, binding, session or snapshot writes. */
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);
type EdgeArc = Pick<Edge, "sourceId" | "targetId" | "kind">;

export interface EdgeInput {
  from: string;
  to: string;
  kind: string;
}

export interface EdgeEnd {
  logicalId: string;
  nodeId: string;
}

export interface EdgeReceipt {
  id?: string;
  kind: string;
  from: EdgeEnd;
  to: EdgeEnd;
}

export interface EdgeOpSuccess {
  ok: true;
  rigId: string;
  outcome: "would_add" | "added" | "present" | "would_remove" | "removed";
  edge: EdgeReceipt;
  /** On "added": the command that removes exactly this edge. */
  rollback?: string;
  /** On "added" or "removed": who work now routes to, present only when that moved. */
  routing?: RoutingChange;
}

/** What a delegates_to change moved, as the queue's own resolvers read it before and after. */
export interface RoutingChange {
  /** The target seat's orchestrator: where its stuck-row findings and recovery go. */
  orchestrator?: { seat: string; from: string | null; to: string | null };
  /** The rig's representative: where a person's Slack message in the rig's mapped channel goes, unless that channel
   *  names an inbound seat. Null is none. */
  representative?: { from: string | null; to: string | null };
}

interface EdgeOpError {
  ok: false;
  code: "rig_not_found" | "node_not_found" | "invalid_kind" | "edge_cycle" | "edge_not_found" | "unavailable";
  message: string;
}

export type EdgeOpOutcome = EdgeOpSuccess | EdgeOpError;

function end(node: NodeWithBinding): EdgeEnd {
  return { logicalId: node.logicalId, nodeId: node.id };
}

function launchArc(edge: EdgeArc): [first: string, then: string] {
  return edge.kind === "delegates_to" ? [edge.sourceId, edge.targetId] : [edge.targetId, edge.sourceId];
}

/** A new dependency may not make launch or restore's ordering cyclic. */
function createsLaunchCycle(edges: EdgeArc[], candidate: EdgeArc): boolean {
  const [first, then] = launchArc(candidate);
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (!LAUNCH_DEPENDENCY_KINDS.has(edge.kind)) continue;
    const [a, b] = launchArc(edge);
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const seen = new Set<string>();
  const queue = [then];
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (node === first) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    queue.push(...(next.get(node) ?? []));
  }
  return false;
}

type RoutingView = { seat: string | null; orchestrator: string | null; representative: string | null };

/** The routing a delegates_to edge into `targetNodeId` can decide: that seat's orchestrator and the rig's representative. */
function routingView(repo: RigRepository, rigName: string, targetNodeId: string): RoutingView {
  const seat = (repo.db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
    .get(targetNodeId) as { session_name: string } | undefined)?.session_name ?? null;
  return {
    seat,
    orchestrator: seat ? defaultResolveOrchestrator(repo.db, seat) : null,
    representative: resolveRigRepresentative(repo.db, rigName),
  };
}

function routingChange(before: RoutingView, after: RoutingView): RoutingChange | undefined {
  const change: RoutingChange = {};
  if (after.seat && before.orchestrator !== after.orchestrator) {
    change.orchestrator = { seat: after.seat, from: before.orchestrator, to: after.orchestrator };
  }
  if (before.representative !== after.representative) {
    change.representative = { from: before.representative, to: after.representative };
  }
  return change.orchestrator || change.representative ? change : undefined;
}

export function addRigEdge(
  repo: RigRepository,
  input: EdgeInput & { rigId: string; plan?: boolean },
): EdgeOpOutcome {
  const transaction = repo.db.transaction((): EdgeOpOutcome => {
    const rig = repo.getRig(input.rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `rig ${input.rigId} not found` };
    if (!VALID_EDGE_KINDS.has(input.kind)) {
      return { ok: false, code: "invalid_kind", message: `kind must be one of ${[...VALID_EDGE_KINDS].join(", ")} (got "${input.kind}")` };
    }
    const from = rig.nodes.find((node) => node.logicalId === input.from);
    const to = rig.nodes.find((node) => node.logicalId === input.to);
    if (!from || !to) {
      const missing = [...new Set([from ? null : input.from, to ? null : input.to].filter((id): id is string => id !== null))];
      return { ok: false, code: "node_not_found", message: `no seat with logical id ${missing.map((id) => `'${id}'`).join(" or ")} in rig ${input.rigId}` };
    }
    const edge: EdgeReceipt = { kind: input.kind, from: end(from), to: end(to) };
    const existing = rig.edges.find((e) => e.sourceId === from.id && e.targetId === to.id && e.kind === input.kind);
    if (existing) return { ok: true, rigId: input.rigId, outcome: "present", edge: { ...edge, id: existing.id } };
    const candidate = { sourceId: from.id, targetId: to.id, kind: input.kind };
    if (LAUNCH_DEPENDENCY_KINDS.has(input.kind) && createsLaunchCycle(rig.edges, candidate)) {
      return {
        ok: false, code: "edge_cycle",
        message: `a ${input.kind} edge from ${input.from} to ${input.to} would make launch order cycle, and launch and restore refuse a cycle`,
      };
    }
    if (input.plan) return { ok: true, rigId: input.rigId, outcome: "would_add", edge };
    const before = input.kind === "delegates_to" ? routingView(repo, rig.rig.name, to.id) : undefined;
    const added = repo.addEdge(input.rigId, from.id, to.id, input.kind);
    const routing = before && routingChange(before, routingView(repo, rig.rig.name, to.id));
    return {
      ok: true, rigId: input.rigId, outcome: "added", edge: { ...edge, id: added.id },
      rollback: `rig edge remove ${input.rigId} ${added.id}`,
      ...(routing ? { routing } : {}),
    };
  });
  // Reserve the writer before reading the graph, so another connection cannot
  // insert the same triple between the existence check and the insert.
  return input.plan ? transaction() : transaction.immediate();
}

export function removeRigEdge(
  repo: RigRepository,
  input: { rigId: string; edgeId: string; plan?: boolean },
): EdgeOpOutcome {
  const transaction = repo.db.transaction((): EdgeOpOutcome => {
    const rig = repo.getRig(input.rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `rig ${input.rigId} not found` };
    const edge = rig.edges.find((e) => e.id === input.edgeId);
    if (!edge) return { ok: false, code: "edge_not_found", message: `no edge ${input.edgeId} in rig ${input.rigId}` };
    const node = (id: string) => rig.nodes.find((n) => n.id === id)!;
    const receipt: EdgeReceipt = { id: edge.id, kind: edge.kind, from: end(node(edge.sourceId)), to: end(node(edge.targetId)) };
    if (input.plan) return { ok: true, rigId: input.rigId, outcome: "would_remove", edge: receipt };
    const before = edge.kind === "delegates_to" ? routingView(repo, rig.rig.name, edge.targetId) : undefined;
    repo.removeEdge(input.rigId, edge.id);
    const routing = before && routingChange(before, routingView(repo, rig.rig.name, edge.targetId));
    return { ok: true, rigId: input.rigId, outcome: "removed", edge: receipt, ...(routing ? { routing } : {}) };
  });
  return input.plan ? transaction() : transaction.immediate();
}
