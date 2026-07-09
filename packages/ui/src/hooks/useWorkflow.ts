// OPR.0.4.6.WF4 (C3) — workflow instance READ hooks.
//
// FR-4 parity rail: these hooks read the SAME daemon endpoints the WF-3 CLI
// reads (routes/workflow.ts — list / specs / :id / :id/trace), verbatim shapes,
// with ZERO UI-side recomputation of status/deadline/branch (BR-4). The type
// mirrors below restate the daemon read contracts field-for-field, verified
// firsthand at 56556dcf (untouched by C1/C2):
//   WorkflowInstance             domain/workflow-types.ts:177
//   withDeadline enrichment      domain/workflow-runtime.ts (deadline verdict)
//   WorkflowStepTrailEntry       domain/workflow-types.ts:224
//   WorkflowDeadlineVerdict      domain/workflow-deadline.ts
//   /api/workflow/specs rows     routes/workflow.ts:201-212 (HEADERS ONLY — the
//   workflow SHAPE rides the Library review payload, useSpecLibrary.ts)

import { useQuery } from "@tanstack/react-query";

export type WorkflowInstanceStatus = "active" | "waiting" | "completed" | "failed";
export type WorkflowExitKind = "handoff" | "waiting" | "done" | "failed";

export interface WorkflowStepDeadlineEvidence {
  instanceId: string;
  stepId: string | null;
  packetId: string;
  ownerSession: string;
  packetState: string;
  anchor: "closure_required_at" | "claimed_at" | "created_at";
  anchorAt: string;
  overdueBySeconds: number;
  ageSeconds: number;
  claimedAt: string | null;
}

export interface WorkflowDeadlineVerdict {
  state: "healthy" | "overdue-claimed" | "overdue-unclaimed";
  evidence: WorkflowStepDeadlineEvidence | null;
}

export interface WorkflowInstanceWithDeadline {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  createdBySession: string;
  createdAt: string;
  status: WorkflowInstanceStatus;
  currentFrontier: string[];
  currentStepId: string | null;
  hopCount: number;
  fallbackSynthesis: string | null;
  lastContinuationDecision: Record<string, unknown> | null;
  completedAt: string | null;
  version: number;
  resumeCount: number;
  hopsBaseline: number;
  deadline: WorkflowDeadlineVerdict;
}

export interface WorkflowStepTrailEntry {
  trailId: string;
  instanceId: string;
  stepId: string;
  stepRole: string;
  closedAt: string;
  closureReason: WorkflowExitKind;
  closureEvidence: Record<string, unknown> | null;
  actorSession: string;
  nextQitemId: string | null;
  priorQitemId: string;
}

export interface WorkflowSpecSummary {
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  coordinationTerminalTurnRule: string;
  sourcePath: string;
  cachedAt: string;
  isBuiltIn: boolean;
}

export interface WorkflowTrace {
  instance: WorkflowInstanceWithDeadline;
  trail: WorkflowStepTrailEntry[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** GET /api/workflow/list[?status=] — every instance carries the derived WF-1
 *  FR-2 deadline verdict (recomputed per read, never stored). */
export function useWorkflowInstances(status?: WorkflowInstanceStatus) {
  const qs = status ? `?status=${status}` : "";
  return useQuery({
    queryKey: ["workflow", "instances", status ?? "all"],
    queryFn: () => fetchJson<WorkflowInstanceWithDeadline[]>(`/api/workflow/list${qs}`),
    staleTime: 15_000,
  });
}

/** GET /api/workflow/:id — a single instance (show), deadline-enriched. */
export function useWorkflowInstance(instanceId: string | null) {
  return useQuery({
    queryKey: ["workflow", "instance", instanceId],
    queryFn: () => fetchJson<WorkflowInstanceWithDeadline>(`/api/workflow/${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    staleTime: 15_000,
  });
}

/** GET /api/workflow/specs — cached-spec HEADERS (never the shape). */
export function useWorkflowSpecs() {
  return useQuery({
    queryKey: ["workflow", "specs"],
    queryFn: () => fetchJson<{ specs: WorkflowSpecSummary[] }>("/api/workflow/specs"),
    staleTime: 15_000,
  });
}

/** GET /api/workflow/:id/trace — instance + full routing trail (the same read
 *  `rig workflow trace` projects; the daemon's read-only continue(), no write). */
export function useWorkflowTrace(instanceId: string | null) {
  return useQuery({
    queryKey: ["workflow", "trace", instanceId],
    queryFn: () => fetchJson<WorkflowTrace>(`/api/workflow/${encodeURIComponent(instanceId!)}/trace`),
    enabled: !!instanceId,
    staleTime: 15_000,
  });
}
