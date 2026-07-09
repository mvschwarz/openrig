// Living Notes Packet 2 — UI mirror of the composed-review read contract
// (OPR.0.4.4.20). ONE contract, all consumers: the slice Review tab, the
// mission board's U5 row expansion, and the For-You expansion read these
// same hooks; the agents projection is scope-parameterized
// (slice:<id> | mission:<id> | rig) on one endpoint.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

// --- Contract mirror (subset of packages/daemon/src/domain/review/types.ts) ---

export type ReviewPhase = "intent" | "spec" | "building" | "review" | "locked";
export type C1Verdict = "CLEAR" | "BLOCKING" | "CONCERNING" | "PASS" | "NOT-CLEAR";

export interface VerdictCell {
  role: "guard" | "qa" | "rev1-r1" | "rev1-r2";
  recordedToken: C1Verdict | null;
  tone: "pass" | "fail" | "unknown";
  state: "passing" | "non-passing" | "missing";
  source: string | null;
}

export interface VerifyLineage {
  candidateSha: string | null;
  mergeSha: string | null;
  mainTip: string;
  freshness: "fresh" | "stale" | "unknown";
  staleBehind: number | null;
  gateCells: VerdictCell[];
}

// CORRECTIVE REDESIGN 2026-07-05 §3.1 — the FOUR parallel structures
// (sections / acceptance / join / compare) collapse to ONE: the vertical
// INTENT → PLAN → DELIVERED stack. GreenState is REMOVED (§11: its
// recorded-verdict rigor becomes the source of per-deliverable `verified`).

/** Inline media (curated proof, planned mockups). */
export interface ReviewMedia {
  kind: "image" | "video";
  src: string;
  poster?: string;
  caption: string;
}

/** One of the two deliberate stamps (§4): plan-lock · proof-lock. */
export interface LockState {
  by: string;
  at: string;
  auditVerified: boolean;
}

/** §3.1 delivered.items[] — the redesigned join: one planned deliverable
 *  paired with its CURATED proof and QA's recorded comparison signal.
 *  `verified` requires a recorded QA comparison verdict, never mere artifact
 *  presence (the two-regime rigor, per-item). Fail-open: unverified/missing
 *  render as visibly incomplete, they never block. */
export interface DeliveredItem {
  promised: { text: string; plannedRef?: ReviewMedia };
  proof: ReviewMedia[];
  verified: "verified" | "unverified" | "missing";
  note?: string;
}

export interface DerivedException {
  // OPR.0.4.6.WF4 Q6 — re-synced with the daemon (review/types.ts): the WF-5
  // kinds workflow-failed | awareness | anomaly were missing from this mirror.
  kind: "stuck" | "overdue" | "insufficient-proof" | "stale-after-change" | "workflow-failed" | "awareness" | "anomaly";
  evidence: string;
  threshold: string;
}

/** OPR.0.4.6.WF4 Q6 — UI mirror of the daemon WorkflowRowRef (review/types.ts):
 *  the ONE structured workflow-identity join. The UI consumes ONLY this pointer
 *  for workflow routing/deep-links — never prose from identity/evidenceRef/
 *  summary. Present only on workflow-sourced rows (omit-when-absent). */
export interface WorkflowRowRef {
  instanceId: string;
  workflowName: string;
  stepId?: string;
}

export interface NeedsYouItem {
  source: "agent" | "derived";
  /** OPR.0.4.6.WF4 Q6 — present ONLY on workflow-sourced rows (omit-when-absent). */
  workflow?: WorkflowRowRef;
  identity: string;
  summary: string;
  leg: string;
  where: string;
  ageIso: string | null;
  priority: string | null;
  tier: string | null;
  evidenceRef: string | null;
  unblocks: string | null;
  qitemId: string | null;
  destinationSession: string | null;
  derived: DerivedException | null;
}

export interface NeedsYouBand {
  items: NeedsYouItem[];
  provenance: string;
}

export type AgentsScope = `slice:${string}` | `mission:${string}` | "rig";

export interface AgentRow {
  agentName: string;
  runtime: string;
  stateGlyph: "active" | "parked" | "idle" | "unknown";
  doing: string | null;
  holdsCount: number;
  lastTransitionIso: string | null;
  exception: DerivedException | null;
  sessionName: string;
  slices: string[];
}

export interface AgentsBand {
  scope: AgentsScope;
  rows: AgentRow[];
  provenance: string;
  coordinationHealth: string | null;
}

/** §3.1 — the ONE structure. A projection of on-disk artifacts: every section
 *  always composes, degrading to a muted "—" line when its source is absent —
 *  never invented, never blocking. */
export interface ComposedSliceReview {
  slice: string;
  sliceId: string | null;
  title: string;
  missionId: string | null;
  phase: ReviewPhase;
  laneLabel: string;
  /** §1 — recorded intent, verbatim, usually text. */
  intent: {
    text: string | null;
    media: ReviewMedia[];
    ssotPath: string | null;
    degrade: string | null;
  };
  /** §2 — mini-reqs + planned mockup(s); the PINNED locked set; plan-lock. */
  plan: {
    concise: { text: string | null; media: ReviewMedia[] };
    lockedArtifacts: { name: string; path: string; kind: string }[];
    lock: LockState | null;
    ssotPath: string | null;
  };
  /** §3 — the redesigned join: planned ↔ curated proof ↔ QA-verified. */
  delivered: {
    items: DeliveredItem[];
    /** Helpful artifacts not tied to one deliverable — bounded (§6). */
    extraProof: ReviewMedia[];
    lock: LockState | null;
    /** Drill-in target for "see all proof" (the full fix-loop history). */
    proofDirPath: string | null;
  };
  // KEEP (orthogonal, already sound): attention + coordination + freshness.
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  lineage: VerifyLineage;
  defects: string[];
  composedAt: string;
}

export interface BoardSlot {
  slice: string;
  title: string;
  phase: ReviewPhase;
  laneLabel: string;
  agentsCount: number;
  stageCell: string;
  changedSinceStamp: boolean;
  attentionWorthy: boolean;
}

export interface LedgerRow {
  slice: string;
  candidateSha: string | null;
  gateCells: VerdictCell[];
  mergeSha: string | null;
  needsHumanCount: number;
  green: boolean;
}

export interface ComposedMissionReview {
  mission: string;
  missionId: string | null;
  title: string;
  /** The brief's "What & why", projected verbatim (FR-8). */
  intent: string | null;
  /** Generated status-spine bodies — the always-fresh in-tab render (FR-8). */
  briefSpine: { building: string; progress: string; proven: string; needsYou: string };
  board: BoardSlot[];
  ledger: LedgerRow[];
  cutComplete: boolean;
  cutCompleteBasis: string;
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  composedAt: string;
}

// --- OPR.0.4.4.22: the rig-scope standalone altitude root (same family) ---

export interface SettledRow {
  fromSession: string;
  toSession: string;
  summary: string | null;
  closedAtIso: string;
  qitemId: string;
}

export interface ComposedRigAgents {
  scope: "rig";
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  settled: SettledRow[];
  settledProvenance: string;
  composedAt: string;
}

// --- Hooks ---

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function useSliceReview(name: string | null) {
  return useQuery({
    queryKey: ["review", "slice", name],
    queryFn: () => fetchJson<ComposedSliceReview>(`/api/review/slice/${encodeURIComponent(name!)}`),
    enabled: !!name,
    // Refresh-after-action rides invalidation (useInvalidateReview), not
    // window focus; keep a short staleTime so recompositions surface.
    staleTime: 15_000,
  });
}

export function useMissionReview(name: string | null) {
  return useQuery({
    queryKey: ["review", "mission", name],
    queryFn: () => fetchJson<ComposedMissionReview>(`/api/review/mission/${encodeURIComponent(name!)}`),
    enabled: !!name,
    staleTime: 15_000,
  });
}

export function useReviewAgents(scope: AgentsScope | null) {
  return useQuery({
    queryKey: ["review", "agents", scope],
    queryFn: () => fetchJson<AgentsBand>(`/api/review/agents?scope=${encodeURIComponent(scope!)}`),
    enabled: !!scope,
    staleTime: 15_000,
  });
}

/** OPR.0.4.4.22 — the composed rig-agents root (FR-1..FR-4). Standing cost
 *  is queue+ps only; transcript drill-in fetches ride separate on-demand
 *  requests, never this query. */
export function useRigAgents() {
  return useQuery({
    queryKey: ["review", "rig-agents"],
    queryFn: () => fetchJson<ComposedRigAgents>("/api/review/rig"),
    staleTime: 15_000,
  });
}

/** Refresh-after-action: every surface action invalidates the review queries
 *  so rows actually LEAVE NEEDS YOU after a durable write (FR-4). */
export function useInvalidateReview() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["review"] });
  }, [qc]);
}
