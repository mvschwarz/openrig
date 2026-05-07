import type { Edge, Node } from "@xyflow/react";
import type { AgentActivitySummary, CurrentQitemSummary } from "../hooks/useNodeInventory.js";
import { HYBRID_CROSS_RIG_STROKE_DASH } from "./hybrid-layout.js";

const SESSION_PAIR_DELIMITER = "\u0000";

export const TOPOLOGY_NODE_ACTIVITY_TTL_MS = 10_000;
export const TOPOLOGY_RIG_ACTIVITY_TTL_MS = 4_000;
export const HOT_POTATO_WITHIN_RIG_DURATION_MS = 1_100;
export const HOT_POTATO_CROSS_RIG_DURATION_MS = 1_600;
export const HOT_POTATO_TRAIL_TTL_MS = 3_000;
export const HOT_POTATO_SOURCE_FLASH_MS = 650;
export const HOT_POTATO_TARGET_FLASH_MS = 900;

export type ActivityRingState = "active" | "needs_input" | "blocked" | "idle";
export type ActivityFlash = "source" | "target" | null;

export interface TopologyActivityBaseline {
  agentActivity?: AgentActivitySummary | null;
  currentQitems?: CurrentQitemSummary[] | null;
  startupStatus?: string | null;
}

export interface TopologyActivityVisual {
  state: ActivityRingState;
  flash: ActivityFlash;
  recent: boolean;
}

export interface TopologySessionIndexEntry extends TopologyActivityBaseline {
  nodeId: string;
  rigId?: string | null;
  rigName?: string | null;
  logicalId?: string | null;
  canonicalSessionName?: string | null;
}

export interface TopologyResolvedSession extends TopologySessionIndexEntry {
  session: string;
}

export interface TopologySessionIndex {
  byNodeId: Map<string, TopologySessionIndexEntry>;
  bySession: Map<string, TopologySessionIndexEntry | null>;
}

export interface ParsedTopologyEvent {
  type: string;
  qitemId?: string | null;
  packet?: {
    sourceSession: string;
    targetSession: string;
  };
  sessions: Array<{
    session: string;
    state: ActivityRingState;
    flash?: ActivityFlash;
  }>;
}

export interface TopologyRecentNodeActivity {
  state: ActivityRingState;
  lastActiveAt: number;
  sourceFlashAt?: number;
  targetFlashAt?: number;
}

export interface HotPotatoPacket {
  id: string;
  eventType: string;
  qitemId?: string | null;
  sourceSession: string;
  targetSession: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRigId?: string | null;
  targetRigId?: string | null;
  crossRig: boolean;
  createdAt: number;
  durationMs: number;
}

export interface HotPotatoEdgeData {
  hotPotatoPacket?: HotPotatoPacket | null;
  hotPotatoRecent?: boolean;
  hotPotatoCrossRig?: boolean;
  hotPotatoReducedMotion?: boolean;
}

export function buildTopologySessionIndex(entries: readonly TopologySessionIndexEntry[]): TopologySessionIndex {
  const byNodeId = new Map<string, TopologySessionIndexEntry>();
  const bySession = new Map<string, TopologySessionIndexEntry | null>();

  const addKey = (key: string | null | undefined, entry: TopologySessionIndexEntry) => {
    const clean = key?.trim();
    if (!clean) return;
    for (const candidate of [clean, clean.toLowerCase()]) {
      const existing = bySession.get(candidate);
      if (existing && existing.nodeId !== entry.nodeId) {
        bySession.set(candidate, null);
      } else if (!bySession.has(candidate)) {
        bySession.set(candidate, entry);
      }
    }
  };

  for (const entry of entries) {
    byNodeId.set(entry.nodeId, entry);
    const localId = localNodeId(entry.nodeId);
    addKey(entry.nodeId, entry);
    addKey(localId, entry);
    addKey(entry.logicalId, entry);
    addKey(entry.canonicalSessionName, entry);
    for (const rigToken of [entry.rigName, entry.rigId]) {
      if (!rigToken) continue;
      addKey(`${entry.logicalId ?? localId}@${rigToken}`, entry);
      if (entry.canonicalSessionName?.includes("@")) {
        const [sessionLocal] = entry.canonicalSessionName.split("@");
        addKey(`${sessionLocal}@${rigToken}`, entry);
      }
    }
  }

  return { byNodeId, bySession };
}

export function resolveTopologySession(
  index: TopologySessionIndex,
  session: string | null | undefined,
): TopologyResolvedSession | null {
  const clean = session?.trim();
  if (!clean) return null;
  const direct = index.bySession.get(clean) ?? index.bySession.get(clean.toLowerCase());
  if (direct) return { ...direct, session: clean };
  if (direct === null) return null;

  const at = clean.lastIndexOf("@");
  if (at < 0) return null;
  const local = clean.slice(0, at);
  const rigToken = clean.slice(at + 1);
  for (const entry of index.byNodeId.values()) {
    const entryLocal = entry.logicalId ?? localNodeId(entry.nodeId);
    const canonicalLocal = entry.canonicalSessionName?.split("@")[0] ?? null;
    const localMatches = entryLocal === local || canonicalLocal === local || localNodeId(entry.nodeId) === local;
    const rigMatches = entry.rigName === rigToken || entry.rigId === rigToken;
    if (localMatches && rigMatches) return { ...entry, session: clean };
  }
  return null;
}

export function getBaselineActivityState(input: TopologyActivityBaseline | null | undefined): ActivityRingState {
  if (!input) return "idle";
  if (input.startupStatus === "failed") return "blocked";
  if (input.startupStatus === "attention_required") return "needs_input";
  if (input.agentActivity?.state === "needs_input") return "needs_input";
  if (input.agentActivity?.state === "running") return "active";
  if ((input.currentQitems?.length ?? 0) > 0) return "active";
  return "idle";
}

export function computeActivityVisual(input: {
  baseline?: TopologyActivityBaseline | null;
  recent?: TopologyRecentNodeActivity | null;
  nowMs: number;
}): TopologyActivityVisual {
  const baseline = getBaselineActivityState(input.baseline);
  const recent = input.recent;
  const recentLive = recent && input.nowMs - recent.lastActiveAt <= TOPOLOGY_NODE_ACTIVITY_TTL_MS
    ? recent
    : null;
  const state = recentLive ? strongestActivityState(baseline, recentLive.state) : baseline;
  const sourceFlash = recentLive?.sourceFlashAt && input.nowMs - recentLive.sourceFlashAt <= HOT_POTATO_SOURCE_FLASH_MS;
  const targetFlash = recentLive?.targetFlashAt && input.nowMs - recentLive.targetFlashAt <= HOT_POTATO_TARGET_FLASH_MS;
  return {
    state,
    flash: targetFlash ? "target" : sourceFlash ? "source" : null,
    recent: Boolean(recentLive),
  };
}

export function isRigRecentlyActive(lastActiveAt: number | null | undefined, nowMs: number): boolean {
  return typeof lastActiveAt === "number" && nowMs - lastActiveAt <= TOPOLOGY_RIG_ACTIVITY_TTL_MS;
}

export function parseTopologyActivityEvent(raw: unknown): ParsedTopologyEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  const type = stringField(event, "type");
  if (!type) return null;
  const qitemId = stringField(event, "qitemId");
  const active = (session: string | null, state: ActivityRingState = "active", flash: ActivityFlash = null) =>
    session ? { session, state, flash } : null;

  if (type === "agent.activity") {
    const session = stringField(event, "sessionName");
    const activity = event["activity"] && typeof event["activity"] === "object"
      ? event["activity"] as { state?: string }
      : null;
    const state = activity?.state === "needs_input"
      ? "needs_input"
      : activity?.state === "running"
        ? "active"
        : "idle";
    return {
      type,
      qitemId,
      sessions: [active(session, state)].filter(isPresent),
    };
  }

  if (type === "queue.created") {
    const sourceSession = stringField(event, "sourceSession");
    const targetSession = stringField(event, "destinationSession");
    if (!sourceSession || !targetSession) return null;
    return {
      type,
      qitemId,
      packet: { sourceSession, targetSession },
      sessions: [
        active(sourceSession, "active", "source"),
        active(targetSession, "active", "target"),
      ].filter(isPresent),
    };
  }

  if (type === "queue.handed_off") {
    const sourceSession = stringField(event, "fromSession");
    const targetSession = stringField(event, "toSession");
    if (!sourceSession || !targetSession) return null;
    return {
      type,
      qitemId,
      packet: { sourceSession, targetSession },
      sessions: [
        active(sourceSession, "active", "source"),
        active(targetSession, "active", "target"),
      ].filter(isPresent),
    };
  }

  if (type === "queue.claimed") {
    const destination = stringField(event, "destinationSession");
    return {
      type,
      qitemId,
      sessions: [active(destination, "active", "target")].filter(isPresent),
    };
  }

  if (type === "queue.updated") {
    const actor = stringField(event, "actorSession");
    const closureTarget = stringField(event, "closureTarget");
    const toState = stringField(event, "toState");
    const state: ActivityRingState = toState === "blocked" ? "blocked" : "active";
    return {
      type,
      qitemId,
      packet: actor && closureTarget ? { sourceSession: actor, targetSession: closureTarget } : undefined,
      sessions: [
        active(actor, state, "source"),
        active(closureTarget, state, "target"),
      ].filter(isPresent),
    };
  }

  if (type === "queue.unclaimed") {
    return {
      type,
      qitemId,
      sessions: [active(stringField(event, "destinationSession"), "active")].filter(isPresent),
    };
  }

  if (type === "qitem.fallback_routed") {
    return {
      type,
      qitemId,
      sessions: [
        active(stringField(event, "originalDestination"), "active", "source"),
        active(stringField(event, "rerouteDestination"), "active", "target"),
      ].filter(isPresent),
    };
  }

  if (type === "qitem.closure_overdue") {
    return {
      type,
      qitemId,
      sessions: [active(stringField(event, "destinationSession"), "blocked", "target")].filter(isPresent),
    };
  }

  if (type === "inbox.absorbed" || type === "inbox.denied") {
    return {
      type,
      qitemId,
      sessions: [
        active(stringField(event, "senderSession"), "active", "source"),
        active(stringField(event, "destinationSession"), "needs_input", "target"),
      ].filter(isPresent),
    };
  }

  return null;
}

export function makeSessionPairKey(sourceNodeId: string, targetNodeId: string): string {
  return `${sourceNodeId}${SESSION_PAIR_DELIMITER}${targetNodeId}`;
}

export function makeHotPotatoPacket(input: {
  eventType: string;
  qitemId?: string | null;
  sourceSession: TopologyResolvedSession;
  targetSession: TopologyResolvedSession;
  createdAt: number;
  sequence: number;
}): HotPotatoPacket {
  const crossRig = Boolean(
    input.sourceSession.rigId &&
    input.targetSession.rigId &&
    input.sourceSession.rigId !== input.targetSession.rigId,
  );
  return {
    id: `${input.createdAt}-${input.sequence}-${input.sourceSession.nodeId}-${input.targetSession.nodeId}`,
    eventType: input.eventType,
    qitemId: input.qitemId ?? null,
    sourceSession: input.sourceSession.session,
    targetSession: input.targetSession.session,
    sourceNodeId: input.sourceSession.nodeId,
    targetNodeId: input.targetSession.nodeId,
    sourceRigId: input.sourceSession.rigId,
    targetRigId: input.targetSession.rigId,
    crossRig,
    createdAt: input.createdAt,
    durationMs: crossRig ? HOT_POTATO_CROSS_RIG_DURATION_MS : HOT_POTATO_WITHIN_RIG_DURATION_MS,
  };
}

export function applyHotPotatoEdges(
  edges: readonly Edge[],
  packets: readonly HotPotatoPacket[],
  opts: { reducedMotion: boolean },
): Edge[] {
  const latestPacketByPair = new Map<string, HotPotatoPacket>();
  for (const packet of packets) {
    latestPacketByPair.set(makeSessionPairKey(packet.sourceNodeId, packet.targetNodeId), packet);
  }

  const matchedPairs = new Set<string>();
  const output = edges.map((edge) => {
    const key = makeSessionPairKey(edge.source, edge.target);
    const packet = latestPacketByPair.get(key) ?? null;
    if (packet) matchedPairs.add(key);
    return decorateHotPotatoEdge(edge, packet, opts.reducedMotion);
  });

  for (const packet of packets) {
    const key = makeSessionPairKey(packet.sourceNodeId, packet.targetNodeId);
    if (matchedPairs.has(key)) continue;
    output.push(decorateHotPotatoEdge({
      id: `hot-potato-${packet.id}`,
      source: packet.sourceNodeId,
      target: packet.targetNodeId,
      type: "hotPotato",
      selectable: false,
      focusable: false,
      interactionWidth: 8,
      style: hotPotatoEdgeStyle(packet.crossRig),
      data: {},
    }, packet, opts.reducedMotion));
  }

  return output;
}

function decorateHotPotatoEdge(edge: Edge, packet: HotPotatoPacket | null, reducedMotion: boolean): Edge {
  const crossRig = packet?.crossRig || (edge.style as { strokeDasharray?: string } | undefined)?.strokeDasharray === HYBRID_CROSS_RIG_STROKE_DASH;
  const data = {
    ...(edge.data ?? {}),
    hotPotatoPacket: packet,
    hotPotatoRecent: Boolean(packet),
    hotPotatoCrossRig: crossRig,
    hotPotatoReducedMotion: reducedMotion,
  } satisfies HotPotatoEdgeData & Record<string, unknown>;
  return {
    ...edge,
    type: "hotPotato",
    className: [edge.className, packet ? "hot-potato-edge-active" : ""].filter(Boolean).join(" ") || undefined,
    data,
    style: {
      ...(edge.style ?? {}),
      ...(packet ? hotPotatoEdgeStyle(packet.crossRig) : {}),
    },
  };
}

function hotPotatoEdgeStyle(crossRig: boolean): Edge["style"] {
  return {
    stroke: crossRig ? "#a8a29e" : "#047857",
    strokeWidth: crossRig ? 1.25 : 2.25,
    strokeDasharray: crossRig ? HYBRID_CROSS_RIG_STROKE_DASH : undefined,
  };
}

function strongestActivityState(a: ActivityRingState, b: ActivityRingState): ActivityRingState {
  return activityRank(b) > activityRank(a) ? b : a;
}

function activityRank(state: ActivityRingState): number {
  if (state === "blocked") return 3;
  if (state === "needs_input") return 2;
  if (state === "active") return 1;
  return 0;
}

function localNodeId(nodeId: string): string {
  const index = nodeId.indexOf("::");
  return index < 0 ? nodeId : nodeId.slice(index + 2);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

export const __test_internals = {
  strongestActivityState,
  stringField,
};
