import type { RigRepository } from "./rig-repository.js";
import type { Edge, NodeWithBinding } from "./types.js";
import { VALID_EDGE_KINDS } from "./rigspec-schema.js";

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
    const added = repo.addEdge(input.rigId, from.id, to.id, input.kind);
    return {
      ok: true, rigId: input.rigId, outcome: "added", edge: { ...edge, id: added.id },
      rollback: `rig edge remove ${input.rigId} ${added.id}`,
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
    repo.removeEdge(input.rigId, edge.id);
    return { ok: true, rigId: input.rigId, outcome: "removed", edge: receipt };
  });
  return input.plan ? transaction() : transaction.immediate();
}
