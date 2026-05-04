// Slice Story View v0 — UI hooks for the list + detail endpoints.
//
// Wraps GET /api/slices?filter=... and GET /api/slices/:name. Both
// queries surface the daemon's "slices_root_not_configured" 503 path
// as a structured error object so the UI can render a setup hint
// instead of the raw 503.

import { useQuery } from "@tanstack/react-query";

export type SliceStatus = "active" | "done" | "blocked" | "draft";
export type SliceFilter = "all" | "active" | "done" | "blocked";

export interface SliceListEntry {
  name: string;
  displayName: string;
  railItem: string | null;
  status: SliceStatus;
  rawStatus: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
}

export interface SliceListResponse {
  slices: SliceListEntry[];
  totalCount: number;
  filter: SliceFilter;
}

export interface SlicesUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

async function fetchSlicesList(filter: SliceFilter): Promise<SliceListResponse | SlicesUnavailable> {
  const res = await fetch(`/api/slices?filter=${encodeURIComponent(filter)}`);
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

export function useSlices(filter: SliceFilter) {
  return useQuery({
    queryKey: ["slices", "list", filter],
    queryFn: () => fetchSlicesList(filter),
    staleTime: 30_000,
  });
}

// --- per-slice detail ---

export interface StoryEvent {
  ts: string;
  phase: "discovery" | "product-lab" | "delivery" | "lifecycle" | "qa" | "other";
  kind: string;
  actorSession: string | null;
  qitemId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
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
  displayName: string;
  railItem: string | null;
  status: string;
  rawStatus: string | null;
  qitemIds: string[];
  commitRefs: string[];
  lastActivityAt: string | null;
  story: { events: StoryEvent[] };
  acceptance: { totalItems: number; doneItems: number; percentage: number; items: AcceptanceItem[]; closureCallout: string | null };
  decisions: { rows: DecisionRow[] };
  docs: { tree: DocsTreeEntry[] };
  tests: { proofPackets: ProofPacketRendered[]; aggregate: { passCount: number; failCount: number } };
  topology: { affectedRigs: TopologyRigEntry[]; totalSeats: number };
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
