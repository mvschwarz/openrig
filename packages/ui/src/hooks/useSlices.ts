// Slice Story View v0 — UI hooks for the list + detail endpoints.
//
// Wraps GET /api/slices?filter=... and GET /api/slices/:name. Both
// queries surface the daemon's "slices_root_not_configured" 503 path
// as a structured error object so the UI can render a setup hint
// instead of the raw 503.

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

export type SliceStatus = "active" | "done" | "blocked" | "draft";
export type SliceFilter = "all" | "active" | "done" | "blocked";

export interface SliceListEntry {
  name: string;
  missionId: string | null;
  displayName: string;
  railItem: string | null;
  status: SliceStatus;
  rawStatus: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
  /** PL-007: absolute filesystem path of the slice folder, used by the UI
   *  to resolve workspace kind against the rig's RigSpec.workspace block. */
  slicePath?: string;
}

export interface SliceListResponse {
  slices: SliceListEntry[];
  totalCount: number;
  filter: SliceFilter;
  // Workflows in Spec Library v0 — present only when boundToWorkflow filter applied.
  boundToWorkflow?: {
    specName: string;
    specVersion: string;
    matched: number;
    total: number;
  };
}

export interface SlicesUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

export interface BoundToWorkflowFilter {
  specName: string;
  specVersion: string;
}

async function fetchSlicesList(
  filter: SliceFilter,
  boundToWorkflow: BoundToWorkflowFilter | null,
): Promise<SliceListResponse | SlicesUnavailable> {
  const params = new URLSearchParams({ filter });
  if (boundToWorkflow) {
    params.set("boundToWorkflow", `${boundToWorkflow.specName}:${boundToWorkflow.specVersion}`);
  }
  const res = await fetch(`/api/slices?${params.toString()}`);
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as Partial<SlicesUnavailable> & { error?: string; hint?: string };
    return {
      unavailable: true,
      error: body.error ?? "slices_indexer_unavailable",
      hint: body.hint,
    };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SliceListResponse;
}

export function useSlices(filter: SliceFilter, boundToWorkflow: BoundToWorkflowFilter | null = null) {
  return useQuery({
    queryKey: [
      "slices",
      "list",
      filter,
      boundToWorkflow ? `${boundToWorkflow.specName}:${boundToWorkflow.specVersion}` : "all",
    ],
    queryFn: () => fetchSlicesList(filter, boundToWorkflow),
    staleTime: 30_000,
  });
}

// --- per-slice detail ---

export interface StoryEvent {
  ts: string;
  /** Spec-defined step.id when bound to a workflow_instance + the
   *  event's qitem maps to a step trail; null when untagged (no
   *  binding, no trail mapping, or non-qitem event). v1 removed the v0
   *  hardcoded RSI-v2 phase enum. */
  phase: string | null;
  kind: string;
  actorSession: string | null;
  qitemId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface PhaseDefinition {
  id: string;
  label: string;
  role: string;
}

export interface CurrentStepPayload {
  stepId: string;
  role: string;
  objective: string | null;
  allowedExits: string[];
  allowedNextSteps: Array<{ stepId: string; role: string; reason: "next_hop" }>;
  hopCount: number;
  instanceStatus: string;
}

export interface SpecGraphNode {
  stepId: string;
  label: string;
  role: string;
  preferredTarget: string | null;
  isEntry: boolean;
  isCurrent: boolean;
  isTerminal: boolean;
}

export interface SpecGraphEdge {
  fromStepId: string;
  toStepId: string;
  routingType: "direct";
  isLoopBack: boolean;
}

export interface SpecGraphPayload {
  specName: string;
  specVersion: string;
  nodes: SpecGraphNode[];
  edges: SpecGraphEdge[];
}

export interface WorkflowBindingPayload {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  status: string;
  currentStepId: string | null;
  currentFrontier: string[];
  hopCount: number;
  createdAt: string;
  completedAt: string | null;
  additionalInstanceIds: string[];
}

export interface AcceptanceItem {
  text: string;
  done: boolean;
  source: { file: string; line: number };
}

export interface DecisionRow {
  actionId: string;
  ts: string;
  actor: string;
  verb: string;
  qitemId: string;
  reason: string | null;
  beforeState: string | null;
  afterState: string | null;
}

export interface DocsTreeEntry {
  name: string;
  type: "file" | "dir";
  size: number | null;
  mtime: string | null;
  relPath: string;
}

export interface ProofPacketRendered {
  dirName: string;
  primaryMarkdown: { relPath: string; content: string } | null;
  additionalMarkdown: Array<{ relPath: string; content: string }>;
  screenshots: string[];
  videos: string[];
  traces: string[];
  passFailBadge: "pass" | "fail" | "partial" | "unknown";
}

export interface TopologyRigEntry {
  rigId: string;
  rigName: string;
  sessionNames: string[];
}

export interface SliceDetail {
  name: string;
  missionId: string | null;
  slicePath: string;
  displayName: string;
  railItem: string | null;
  status: string;
  rawStatus: string | null;
  qitemIds: string[];
  commitRefs: string[];
  lastActivityAt: string | null;
  /** v1: bound workflow_instance metadata; null when no instance touches
   *  any of this slice's qitems (UI falls back to v0 behavior). */
  workflowBinding: WorkflowBindingPayload | null;
  story: {
    events: StoryEvent[];
    /** v1: spec-declared phase definitions; null when no instance bound. */
    phaseDefinitions: PhaseDefinition[] | null;
  };
  acceptance: {
    totalItems: number;
    doneItems: number;
    percentage: number;
    items: AcceptanceItem[];
    closureCallout: string | null;
    /** v1: bound instance's current step + allowed next steps; null
     *  when no instance bound. */
    currentStep: CurrentStepPayload | null;
  };
  decisions: { rows: DecisionRow[] };
  docs: { tree: DocsTreeEntry[] };
  tests: { proofPackets: ProofPacketRendered[]; aggregate: { passCount: number; failCount: number } };
  topology: {
    affectedRigs: TopologyRigEntry[];
    totalSeats: number;
    /** v1: spec graph (nodes + edges) derived from the bound instance's
     *  workflow_spec; null when unbound (UI falls back to per-rig
     *  session listing). */
    specGraph: SpecGraphPayload | null;
  };
}

async function fetchSliceDetail(name: string): Promise<SliceDetail> {
  const res = await fetch(`/api/slices/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SliceDetail;
}

export function useSliceDetail(name: string | null) {
  return useQuery({
    queryKey: ["slices", "detail", name],
    queryFn: () => fetchSliceDetail(name!),
    enabled: !!name,
    staleTime: 30_000,
  });
}

export interface SliceDetailsMapResult {
  itemsByName: Map<string, SliceDetail>;
  isFetching: boolean;
  missingNames: string[];
}

export function useSliceDetails(names: string[]): SliceDetailsMapResult {
  const uniqueNames = useMemo(
    () => Array.from(new Set(names.filter((name) => name.length > 0))).sort(),
    [names],
  );
  const queries = useQueries({
    queries: uniqueNames.map((name) => ({
      queryKey: ["slices", "detail", name],
      queryFn: () => fetchSliceDetail(name),
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const itemsByName = new Map<string, SliceDetail>();
    const missingNames: string[] = [];
    uniqueNames.forEach((name, idx) => {
      const item = queries[idx]?.data;
      if (item) {
        itemsByName.set(name, item);
      } else if (queries[idx]?.isError) {
        missingNames.push(name);
      }
    });
    return {
      itemsByName,
      isFetching: queries.some((query) => query.isFetching),
      missingNames,
    };
  }, [queries, uniqueNames]);
}

// --- doc body fetcher (Docs tab; lazy on click) ---

export interface SliceDocResponse {
  relPath: string;
  content: string;
}

async function fetchSliceDoc(name: string, relPath: string): Promise<SliceDocResponse> {
  const res = await fetch(`/api/slices/${encodeURIComponent(name)}/doc/${encodeURI(relPath)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SliceDocResponse;
}

export function useSliceDoc(name: string | null, relPath: string | null) {
  return useQuery({
    queryKey: ["slices", "doc", name, relPath],
    queryFn: () => fetchSliceDoc(name!, relPath!),
    enabled: !!name && !!relPath,
    staleTime: 60_000,
  });
}

export function proofAssetUrl(sliceName: string, relPath: string): string {
  return `/api/slices/${encodeURIComponent(sliceName)}/proof-asset/${encodeURI(relPath)}`;
}

export interface QueueItemDetail {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string[] | null;
  body: string;
}

export interface QueueItemMapResult {
  itemsById: Map<string, QueueItemDetail>;
  isFetching: boolean;
  missingIds: string[];
}

async function fetchQueueItem(qitemId: string): Promise<QueueItemDetail | null> {
  const res = await fetch(`/api/queue/${encodeURIComponent(qitemId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as QueueItemDetail;
}

export function useQueueItemMap(qitemIds: string[]): QueueItemMapResult {
  const uniqueIds = useMemo(
    () => Array.from(new Set(qitemIds.filter((id) => id.length > 0))).sort(),
    [qitemIds],
  );
  const queries = useQueries({
    queries: uniqueIds.map((qitemId) => ({
      queryKey: ["queue", "item", qitemId],
      queryFn: () => fetchQueueItem(qitemId),
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const itemsById = new Map<string, QueueItemDetail>();
    const missingIds: string[] = [];
    uniqueIds.forEach((qitemId, idx) => {
      const item = queries[idx]?.data;
      if (item) {
        itemsById.set(qitemId, item);
      } else if (queries[idx]?.status === "success") {
        missingIds.push(qitemId);
      }
    });
    return {
      itemsById,
      isFetching: queries.some((query) => query.isFetching),
      missingIds,
    };
  }, [queries, uniqueIds]);
}
