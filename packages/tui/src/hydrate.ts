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
import { parse as parseYaml } from "yaml";
import type { AgentRow, FleetSnapshot, HostNode, NeedsItem, PodNode, SpecEntry } from "./types.js";

// Narrow read-shapes: just the served fields this module consumes (names match
// the daemon's serialized output — see the Phase-2 endpoint-shape survey).
interface RigSummaryRead {
  id: string;
  name: string;
  lifecycleState?: string;
}
interface RigStatusRead {
  status?: string;
  seatsTotal?: number;
  seatsRunning?: number;
}
interface NodeInventoryRead {
  logicalId: string;
  podNamespace?: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  lifecycleState: string;
  canonicalSessionName: string | null;
  tmuxAttachCommand?: string | null;
  resolvedSpecName: string | null;
  contextUsage?: {
    availability: "known" | "unknown";
    usedPercentage: number | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
  };
}
interface SpecLibraryRead {
  id: string;
  kind: "rig" | "agent" | "workflow";
  name: string;
  version?: string;
  sourcePath?: string;
  sourceType?: "builtin" | "user_file";
  relativePath?: string;
  updatedAt?: string;
}
interface AgentSpecReviewRead {
  sourceState?: "draft" | "file_preview" | "library_item";
  kind: "agent";
  description?: string;
  profiles?: Array<{ name: string }>;
  resources?: { skills?: string[]; guidance?: string[]; plugins?: string[]; subagents?: string[] };
  startup?: { files?: Array<{ path: string; required: boolean }> };
  raw?: string;
}
interface RigSpecReviewRead {
  sourceState?: "draft" | "file_preview" | "library_item";
  kind: "rig";
  format?: "pod_aware" | "legacy";
  pods?: Array<{
    id: string;
    namespace?: string;
    label?: string;
    members: Array<{ id: string; agentRef: string; runtime: string; profile?: string }>;
    edges: Array<{ from: string; to: string; kind: string }>;
  }>;
  nodes?: Array<{ id: string; runtime: string; role?: string; model?: string }>;
  edges?: Array<{ from: string; to: string; kind: string }>;
  graph?: {
    nodes: Array<{ id: string; label: string; pod?: string; runtime: string; kind: "agent" | "infrastructure" }>;
    edges: Array<{ source: string; target: string; kind: string }>;
  };
  raw?: string;
}
type SpecLibraryReviewRead = AgentSpecReviewRead | RigSpecReviewRead;
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
    attach: node.tmuxAttachCommand ?? null,
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

function agentNamespace(relativePath?: string): string | undefined {
  if (!relativePath) return undefined;
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  const agentsAt = dirs.lastIndexOf("agents");
  const candidates = agentsAt >= 0 ? dirs.slice(agentsAt + 1) : dirs;
  if (parts.at(-1) === "agent.yaml" || parts.at(-1) === "agent.yml") candidates.pop();
  return candidates.length > 0 ? candidates.join("/") : undefined;
}

function agentSpecTruth(raw?: string): { runtime?: string; skills: string[] } {
  if (!raw) return { skills: [] };
  try {
    const spec = parseYaml(raw) as Record<string, unknown> | null;
    if (!spec || typeof spec !== "object") return { skills: [] };
    const defaults = spec["defaults"] as Record<string, unknown> | undefined;
    const profiles = spec["profiles"] as Record<string, unknown> | undefined;
    const profile = (profiles?.["default"] ?? Object.values(profiles ?? {})[0]) as Record<string, unknown> | undefined;
    const uses = profile?.["uses"] as Record<string, unknown> | undefined;
    const skills = Array.isArray(uses?.["skills"])
      ? uses["skills"].filter((skill): skill is string => typeof skill === "string")
      : [];
    return {
      ...(typeof defaults?.["runtime"] === "string" ? { runtime: defaults["runtime"] } : {}),
      skills,
    };
  } catch {
    return { skills: [] };
  }
}

/** Cross-cycle memo for spec-detail reviews, keyed by `${id}@${updatedAt}` —
 * avoids re-reading every spec every refresh; the key rolls when the library
 * entry's updatedAt changes. Owned by the caller (instance-scoped, no module state). */
export type SpecReviewCache = Map<string, SpecLibraryReviewRead>;

export async function hydrateSnapshot(client: DaemonClient, reviewCache?: SpecReviewCache): Promise<FleetSnapshot> {
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
  const rigsDown: FleetSnapshot["hostsDown"] = [];
  const rigSpecRefs = new Map<string, string[]>(); // rig-spec name → agentRefs
  for (const rig of summaries ?? []) {
    const nodes = await safe<NodeInventoryRead[]>(`nodes(${rig.name})`, () => client.rigNodes(rig.id));
    rigs.push({
      id: rig.id,
      name: rig.name,
      pods: nodes ? groupPods(nodes) : [],
      ...(rig.lifecycleState ? { lifecycleState: rig.lifecycleState } : {}),
    });
    if (rig.lifecycleState && rig.lifecycleState !== "running") {
      // rig-down leg (§4.A): summary lifecycleState verbatim, enriched by the
      // rig-status projection where it answers — composed BESIDE the items.
      const st = await safe<RigStatusRead>(`rig-status(${rig.name})`, () => client.rigStatus(rig.id));
      const seatDetail = st && st.seatsTotal != null ? `${st.seatsRunning ?? 0}/${st.seatsTotal} seats running` : undefined;
      rigsDown.push({
        hostId: `rig:${rig.name}`,
        status: st?.status ? `${rig.lifecycleState} (${st.status})` : rig.lifecycleState,
        ...(seatDetail ? { error: seatDetail } : {}),
      });
    }
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

  // Specs: RIG + AGENT land well by consuming the existing structured review
  // for BOTH kinds. WORKFLOW remains basics. Reviews are memoized by updatedAt.
  async function specReview(entry: SpecLibraryRead): Promise<SpecLibraryReviewRead | null> {
    const key = `${entry.id}@${entry.updatedAt ?? ""}`;
    const cached = reviewCache?.get(key);
    if (cached) return cached;
    const review = await safe<SpecLibraryReviewRead>(`spec-review(${entry.name})`, () => client.specLibraryReview(entry.id));
    if (review && reviewCache) reviewCache.set(key, review);
    return review;
  }

  const reviewed = new Map<string, SpecLibraryReviewRead>();
  await Promise.all(
    (library ?? []).filter((entry) => entry.kind !== "workflow").map(async (entry) => {
      const detail = await specReview(entry);
      if (detail) reviewed.set(entry.id, detail);
    }),
  );

  const reviewedRigRefs = new Map<string, string[]>();
  for (const entry of library ?? []) {
    const detail = reviewed.get(entry.id);
    if (entry.kind !== "rig" || detail?.kind !== "rig" || detail.format !== "pod_aware") continue;
    const refs: string[] = [];
    for (const pod of detail.pods ?? []) {
      for (const member of pod.members) {
        const ref = resolveAgentRef(member.agentRef, agentSpecNames);
        refs.push(ref);
      }
    }
    reviewedRigRefs.set(entry.name, refs);
  }
  const allRigRefs = new Map([...rigSpecRefs, ...reviewedRigRefs]);

  const specs: SpecEntry[] = await Promise.all(
    (library ?? []).map(async (entry): Promise<SpecEntry> => {
      const base = {
        name: entry.name,
        version: entry.version,
        sourcePath: entry.sourcePath,
        sourceType: entry.sourceType,
        relativePath: entry.relativePath,
      };
      const detail = reviewed.get(entry.id);
      if (entry.kind === "rig") {
        if (detail?.kind !== "rig") return { ...base, kind: "rig", agentRefs: allRigRefs.get(entry.name) ?? [] };
        const pods = detail.format === "pod_aware"
          ? (detail.pods ?? []).map((pod) => ({
              ...pod,
              members: pod.members.map((member) => ({
                ...member,
                agentRef: resolveAgentRef(member.agentRef, agentSpecNames),
              })),
            }))
          : undefined;
        return {
          ...base,
          kind: "rig",
          sourceState: detail.sourceState,
          format: detail.format,
          agentRefs: allRigRefs.get(entry.name) ?? [],
          ...(pods ? { pods } : {}),
          ...(detail.edges ? { edges: detail.edges } : {}),
          ...(detail.graph ? { graph: detail.graph } : {}),
          ...(detail.raw ? { raw: detail.raw } : {}),
          ...(detail.kind === "rig" && detail.format === "legacy" && detail.nodes ? { legacyNodes: detail.nodes } : {}),
        };
      }
      if (entry.kind === "agent") {
        const usedByRigs = [...allRigRefs.entries()].filter(([, refs]) => refs.includes(entry.name)).map(([rig]) => rig);
        const review = detail?.kind === "agent" ? detail : null;
        const truth = agentSpecTruth(review?.raw);
        const resources = {
          skills: review?.resources?.skills ?? [],
          guidance: review?.resources?.guidance ?? [],
          plugins: review?.resources?.plugins ?? [],
          subagents: review?.resources?.subagents ?? [],
        };
        return {
          ...base,
          kind: "agent",
          usedByRigs,
          namespace: agentNamespace(entry.relativePath),
          sourceState: review?.sourceState,
          runtime: truth.runtime,
          ...(review?.description ? { description: review.description } : {}),
          skills: truth.skills.length > 0 ? truth.skills : resources.skills,
          hasGuidance: resources.guidance.length > 0,
          profiles: review?.profiles?.map((profile) => profile.name) ?? [],
          resources,
          ...(review?.startup?.files ? { startupFiles: review.startup.files } : {}),
          ...(review?.raw ? { raw: review.raw } : {}),
        };
      }
      return { ...base, kind: "workflow" };
    }),
  );

  // Needs-You: composeNeedsYou verbatim; host-down BESIDE.
  const items = review?.needsYou?.items ?? [];
  const needs = items.filter((i) => i.source === "derived").map(toNeedsItem);
  const humanQueue = items.filter((i) => i.source === "agent").map(toNeedsItem);
  const hostsDown = [
    ...aggHosts
      .filter((h) => h.status !== "ok")
      .map((h) => ({ hostId: h.hostId, status: h.status, ...(h.error ? { error: h.error } : {}) })),
    ...rigsDown,
  ];

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
