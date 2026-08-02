// Snapshot hydrator: maps the §4.A daemon reads (via DaemonClient, the one
// HTTP module) into FleetSnapshot for the renderer. Mapping discipline
// (PIN 2/PIN 3, planner Phase-2 reminders):
//   - STATUS and Needs-You content are carried VERBATIM from the served
//     projections — no synthesis, no staleness "improvement", no client-side
//     thresholds. The idle-with-work threshold reaches us already serialized
//     inside the served evidence/threshold strings, so this module needs no
//     threshold constant at all (nothing is recomputed — the honest form of
//     "don't re-hardcode IDLE_WITH_WORK_THRESHOLD_MIN").
//   - The two `stuck` legs (idle-with-work vs too-long-in-state) stay distinct
//     by construction: identity/summary/evidence/threshold render verbatim.
//   - host/rig-down composes BESIDE the items (hostsDown), never into them.
//   - A failed read leaves its portion honest-empty and records a NAMED error.
import { DaemonClient } from "./daemon-client.js";
import type { AgentRow, FleetSnapshot, HostNode, NeedsItem, PodNode, SpecEntry } from "./types.js";

// Narrow read-shapes: just the served fields this module consumes (names match
// the daemon's serialized output — see the Phase-2 endpoint-shape survey).
interface RigSummaryRead {
  id: string;
  name: string;
}
interface NodeInventoryRead {
  logicalId: string;
  podNamespace?: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  lifecycleState: string;
  canonicalSessionName: string | null;
  resolvedSpecName: string | null;
  contextUsage?: {
    availability: "known" | "unknown";
    usedPercentage: number | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
  };
}
interface SpecLibraryRead {
  kind: "rig" | "agent" | "workflow";
  name: string;
}
interface RigSpecJsonRead {
  name?: string;
  pods?: Array<{ members?: Array<{ agentRef?: string }> }>;
}
interface NeedsYouItemRead {
  source: "agent" | "derived";
  identity: string;
  summary: string;
  leg: string;
  where: string;
  destinationSession: string | null;
  derived: { kind: string; evidence: string; threshold: string } | null;
}
interface ReviewRigRead {
  needsYou?: { items?: NeedsYouItemRead[] };
}
interface AttentionAggregateRead {
  hosts?: Array<{ hostId: string; status: string; error?: string }>;
}
interface StreamItemRead {
  tsEmitted: string;
  sourceSession: string;
  body: string;
}

function fmtTokens(input: number | null, output: number | null): string | null {
  if (input == null && output == null) return null;
  const total = (input ?? 0) + (output ?? 0);
  return total >= 1000 ? `${Math.round(total / 1000)}k` : String(total);
}

function toAgentRow(node: NodeInventoryRead): AgentRow {
  const ctx = node.contextUsage;
  const known = ctx?.availability === "known";
  return {
    name: node.logicalId,
    runtime: node.runtime ?? "unknown",
    spec: node.resolvedSpecName ?? "",
    // honest-unknown: no value in the projection → null → renders "—"
    context: known && ctx.usedPercentage != null ? Math.round(ctx.usedPercentage) : null,
    tokens: known ? fmtTokens(ctx.totalInputTokens, ctx.totalOutputTokens) : null,
    // PIN 2: the maintained projection's lifecycleState VERBATIM
    status: node.lifecycleState,
    session: node.canonicalSessionName,
  };
}

function groupPods(nodes: NodeInventoryRead[]): PodNode[] {
  const pods = new Map<string, AgentRow[]>();
  for (const node of nodes) {
    if (node.nodeKind !== "agent") continue;
    const pod = node.podNamespace ?? "(no pod)";
    const list = pods.get(pod) ?? [];
    list.push(toAgentRow(node));
    pods.set(pod, list);
  }
  return [...pods.entries()].map(([name, agents]) => ({ name, agents }));
}

function toNeedsItem(item: NeedsYouItemRead): NeedsItem {
  // verbatim carry: served kind + summary/evidence; the target is the
  // session/where the daemon already names (identity prefix for derived rows)
  const target = item.source === "derived" ? (item.identity.split("|")[0] ?? item.where) : (item.destinationSession ?? item.where);
  const detail = item.derived ? `${item.summary} — ${item.derived.evidence}` : item.summary;
  return { kind: item.derived?.kind ?? item.leg, target, detail };
}

function resolveAgentRef(ref: string, agentSpecNames: Set<string>): string {
  if (agentSpecNames.has(ref)) return ref;
  const basename = ref.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.(?:ya?ml|json)$/, "");
  return basename && agentSpecNames.has(basename) ? basename : ref;
}

export async function hydrateSnapshot(client: DaemonClient): Promise<FleetSnapshot> {
  const readErrors: string[] = [];
  async function safe<T>(label: string, fn: () => Promise<unknown>): Promise<T | null> {
    try {
      return (await fn()) as T;
    } catch (err) {
      readErrors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  const [agg, summaries, library, review, streamItems] = await Promise.all([
    safe<AttentionAggregateRead>("attention-aggregate", () => client.attentionAggregate()),
    safe<RigSummaryRead[]>("rigs-summary", () => client.rigsSummary()),
    safe<SpecLibraryRead[]>("specs-library", () => client.specsLibrary()),
    safe<ReviewRigRead>("review-rig", () => client.reviewRig()),
    safe<StreamItemRead[]>("stream-list", () => client.streamList()),
  ]);

  const agentSpecNames = new Set((library ?? []).filter((entry) => entry.kind === "agent").map((entry) => entry.name));

  // Topology: the local host expands to the daemon's rigs; remote hosts come
  // from the aggregate with reachability only (per-rig start; the all-rigs
  // level is deliberately under-designed — founder capture).
  const rigs = [];
  const rigSpecRefs = new Map<string, string[]>(); // rig-spec name → agentRefs
  for (const rig of summaries ?? []) {
    const nodes = await safe<NodeInventoryRead[]>(`nodes(${rig.name})`, () => client.rigNodes(rig.id));
    rigs.push({ name: rig.name, pods: nodes ? groupPods(nodes) : [] });
    const spec = await safe<RigSpecJsonRead>(`rig-spec(${rig.name})`, () => client.rigSpec(rig.id));
    if (spec?.pods) {
      const refs = spec.pods.flatMap((p) =>
        (p.members ?? [])
          .map((m) => m.agentRef)
          .filter((r): r is string => !!r)
          .map((ref) => resolveAgentRef(ref, agentSpecNames)),
      );
      if (spec.name) rigSpecRefs.set(spec.name, refs);
    }
  }
  const aggHosts = agg?.hosts ?? [];
  const localHost: HostNode = {
    name: aggHosts.find((h) => h.hostId === "local")?.hostId ?? "local",
    reachable: true,
    rigs,
  };
  const remoteHosts: HostNode[] = aggHosts
    .filter((h) => h.hostId !== "local")
    .map((h) => ({ name: h.hostId, reachable: h.status === "ok", rigs: [] }));

  // Specs: library entries (RIG + AGENT land well, WORKFLOW basics; other
  // kinds are ABSENT from the library read itself). Rig-spec agentRefs from
  // spec.json; agent-spec usedByRigs joined from those same refs.
  const specs: SpecEntry[] = (library ?? []).map((entry) => {
    if (entry.kind === "rig") return { name: entry.name, kind: "rig", agentRefs: rigSpecRefs.get(entry.name) ?? [] };
    if (entry.kind === "agent") {
      const usedByRigs = [...rigSpecRefs.entries()].filter(([, refs]) => refs.includes(entry.name)).map(([rig]) => rig);
      return { name: entry.name, kind: "agent", usedByRigs };
    }
    return { name: entry.name, kind: "workflow" };
  });

  // Needs-You: composeNeedsYou verbatim; host-down BESIDE.
  const items = review?.needsYou?.items ?? [];
  const needs = items.filter((i) => i.source === "derived").map(toNeedsItem);
  const humanQueue = items.filter((i) => i.source === "agent").map(toNeedsItem);
  const hostsDown = aggHosts
    .filter((h) => h.status !== "ok")
    .map((h) => ({ hostId: h.hostId, status: h.status, ...(h.error ? { error: h.error } : {}) }));

  return {
    hosts: [localHost, ...remoteHosts],
    specs,
    needs,
    humanQueueProbed: review != null,
    humanQueue,
    hostsDown,
    stream: (streamItems ?? []).map((s) => ({ tsEmitted: s.tsEmitted, sourceSession: s.sourceSession, body: s.body })),
    readErrors,
  };
}
