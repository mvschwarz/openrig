// Operator Surface Reconciliation v0 — steering hook + types.
//
// Wraps GET /api/steering. Surfaces the daemon's
// "steering_workspace_not_configured" 503 path as a structured
// `unavailable` sentinel so the UI can render a setup hint instead
// of crashing on an undefined payload.

import { useQuery } from "@tanstack/react-query";

export interface PriorityStackPayload {
  content: string;
  absolutePath: string;
  mtime: string;
  byteCount: number;
}

export interface RoadmapRailItem {
  line: number;
  text: string;
  done: boolean;
  railItemCode: string | null;
  isNextUnchecked: boolean;
}

export interface RoadmapRailPayload {
  absolutePath: string;
  mtime: string;
  items: RoadmapRailItem[];
  counts: { total: number; done: number; nextUncheckedLine: number | null };
}

export interface LaneRailItem {
  line: number;
  text: string;
  status: "active" | "done" | "blocked" | "unknown";
  isNextPull: boolean;
}

export interface LaneRailPayload {
  laneId: string;
  absolutePath: string;
  mtime: string;
  topItems: LaneRailItem[];
  healthBadges: { active: number; blocked: number; done: number; total: number };
  nextPullLine: number | null;
}

export interface SteeringPayload {
  priorityStack: PriorityStackPayload | null;
  roadmapRail: RoadmapRailPayload | null;
  laneRails: LaneRailPayload[];
  unavailableSources: Array<{ section: string; reason: string; envVar?: string }>;
}

export interface SteeringUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

async function fetchSteering(): Promise<SteeringPayload | SteeringUnavailable> {
  const res = await fetch("/api/steering");
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    return { unavailable: true, error: body.error ?? "steering_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SteeringPayload;
}

export function useSteering() {
  return useQuery({
    queryKey: ["steering"],
    queryFn: fetchSteering,
    staleTime: 30_000,
  });
}

// --- health summary ---

export interface NodeHealthSummary {
  total: number;
  bySessionStatus: Record<string, number>;
  byLifecycle: Record<string, number>;
  attentionRequired: number;
}

export interface ContextHealthSummary {
  total: number;
  byUrgency: Record<string, number>;
  byFreshness: Record<string, number>;
  critical: number;
  warning: number;
  stale: number;
}

async function fetchNodeHealth(): Promise<NodeHealthSummary> {
  const res = await fetch("/api/health-summary/nodes");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NodeHealthSummary;
}

async function fetchContextHealth(): Promise<ContextHealthSummary> {
  const res = await fetch("/api/health-summary/context");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ContextHealthSummary;
}

export function useNodeHealth() {
  return useQuery({
    queryKey: ["health-summary", "nodes"],
    queryFn: fetchNodeHealth,
    staleTime: 30_000,
  });
}

export function useContextHealth() {
  return useQuery({
    queryKey: ["health-summary", "context"],
    queryFn: fetchContextHealth,
    staleTime: 30_000,
  });
}

// --- spec review hook (item 3) ---

export interface SpecReviewError {
  field?: string;
  message: string;
  severity?: "error" | "warning";
}

export interface SpecReviewResponse {
  ok?: boolean;
  errors?: SpecReviewError[];
  warnings?: SpecReviewError[];
  /** Daemon may include extra metadata (sourceState, ...) — pass-through. */
  [k: string]: unknown;
}

async function fetchSpecReview(kind: "rig" | "agent", yaml: string): Promise<SpecReviewResponse> {
  const res = await fetch(`/api/specs/review/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml }),
  });
  // Daemon returns 200 with errors[] for both valid + invalid specs
  // (per spec-review.ts contract — the SpecReviewError throw path
  // surfaces as 400). Treat both as "got a review back".
  if (res.status === 400) {
    return (await res.json()) as SpecReviewResponse;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SpecReviewResponse;
}

export function useSpecReview(kind: "rig" | "agent" | null, yaml: string | null) {
  return useQuery({
    queryKey: ["spec-review", kind, yaml ? yaml.length : 0, yaml ? yaml.slice(0, 64) : ""],
    queryFn: () => fetchSpecReview(kind!, yaml!),
    enabled: !!kind && !!yaml,
    staleTime: 60_000,
  });
}
