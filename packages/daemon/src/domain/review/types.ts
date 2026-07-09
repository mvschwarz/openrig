// Living Notes — the composed-review read contract (OPR.0.4.4.20, rebuilt
// per the CORRECTIVE REDESIGN of 2026-07-05).
//
// ONE contract, all consumers: the slice Review tab, the mission board's
// U5 row expansion, and the For-You expansion all read these shapes; the
// agents projection is scope-parameterized (slice:<id> | mission:<id> | rig)
// on the same contract — never a second endpoint.
//
// CORRECTIVE §3.1 — a slice review is ONE vertical stack of three sections:
// INTENT → PLAN → DELIVERED. The four parallel renderable structures the
// original build carried (sections / acceptance / join / compare) are
// DELETED, not demoted; the separate two-regime `green` field is REMOVED
// (§11) — its recorded-verdict rigor is the source of the per-deliverable
// `verified` signal.
//
// The composer that fills these shapes is PURE: same inputs (including the
// caller-supplied view-time facts like `nowIso` and `mainTip`) produce a
// byte-identical output. Every section names its SSOT and degrades to a
// declared value — never invented content.

// --- C1 header (ratified closed sets — Packet 1 FR-8; extending them is a
// convention change, not a code decision) ---

export const C1_ARTIFACT_TYPES = ["guard", "qa", "rev1-r1", "rev1-r2", "adjudication"] as const;
export type C1ArtifactType = (typeof C1_ARTIFACT_TYPES)[number];

export const C1_VERDICTS = ["CLEAR", "BLOCKING", "CONCERNING", "PASS", "NOT-CLEAR"] as const;
export type C1Verdict = (typeof C1_VERDICTS)[number];

export interface ProofArtifact {
  /** Path relative to the slice dir (proof/<file>.md). */
  relPath: string;
  slice: string | null;
  candidateSha: string | null;
  artifactType: C1ArtifactType | null;
  /** The RECORDED token, verbatim. null = missing/out-of-set (counts as MISSING). */
  verdict: C1Verdict | null;
  moneyEvidence: string | null;
  /** D2 attestation (optional C1 fields). */
  evidences: string[];
  selfCheck: string | null;
  /** Media refs found in the artifact body (proof-dir-relative as written);
   *  the composer curates them into `delivered.items[].proof` (§3.4). */
  mediaRefs: string[];
  /** File mtime ISO — the latest-wins tiebreaker within (slice, candidate_sha, artifact_type). */
  droppedAt: string;
}

// --- FR-2: recorded verdicts + verify-lineage (KEEP — gate chips render
// recorded tokens verbatim; the separate green readout is gone, §11) ---

/** Derived TONE for coloring only — the chip TEXT is always the recorded token verbatim (G1). */
export type VerdictTone = "pass" | "fail" | "unknown";

export type GateRole = "guard" | "qa" | "rev1-r1" | "rev1-r2";
export const GATE_ROLES: GateRole[] = ["guard", "qa", "rev1-r1", "rev1-r2"];

export interface VerdictCell {
  role: GateRole;
  /** Verbatim recorded token; null when the artifact is missing or carries no valid verdict. */
  recordedToken: C1Verdict | null;
  tone: VerdictTone;
  /** "passing" per the pinned mapping; "missing" covers absent artifact AND present-but-no-verdict. */
  state: "passing" | "non-passing" | "missing";
  /** proof/<file> relPath of the winning (latest) artifact, or null. */
  source: string | null;
}

export interface VerifyLineage {
  /** N1: the three view-time facts — always all rendered; the label derives from them. */
  candidateSha: string | null;
  /** null = UNMERGED (an explicit lineage fact, never a precondition at slice altitude). */
  mergeSha: string | null;
  mainTip: string;
  /** Derived from the three facts per the N1 rule; never renders without them. */
  freshness: "fresh" | "stale" | "unknown";
  /** Commits behind tip when pre-merge stale; null otherwise. */
  staleBehind: number | null;
  gateCells: VerdictCell[];
}

// --- CORRECTIVE §3.1 — the ONE structure's building blocks ---

/** Inline media (curated proof, planned mockups). `src` is a slice-relative
 *  path on the daemon contract (the UI builds the asset URL); the twin's
 *  fixtures inline data: URIs against the same shape. */
export interface ReviewMedia {
  kind: "image" | "video";
  src: string;
  poster?: string;
  caption: string;
}

/** One of the two deliberate stamps (§4): plan-lock = the shipped
 *  `--scope spec` staged-approval stamp; proof-lock = the `--scope delivery`
 *  stamp (scope.ts staged approval — frontmatter stamp + audit row).
 *  `auditVerified: false` renders the UNVERIFIED-stamp state loudly. */
export interface LockState {
  by: string;
  at: string;
  auditVerified: boolean;
}

/** One pinned plan artifact ("this set gets built") — a frontmatter READ
 *  (`locked-artifacts:` on the slice README), never new write machinery. */
export interface LockedArtifact {
  name: string;
  path: string;
  kind: string;
}

/** §3.1 delivered.items[] — the redesigned join: one planned deliverable
 *  paired with its CURATED proof and QA's recorded comparison signal.
 *  `verified` binds to the SHIPPED C1 fields (artifact_type qa|adjudication
 *  + evidences/self_check + a passing recorded verdict) — never mere
 *  artifact presence. Fail-open: unverified/missing render as visibly
 *  incomplete, they never block. */
export interface DeliveredItem {
  promised: { text: string; plannedRef?: ReviewMedia };
  proof: ReviewMedia[];
  verified: "verified" | "unverified" | "missing";
  note?: string;
}

// --- FR-3: derived phase (five-way, top-down precedence — KEEP) ---

export const REVIEW_PHASES = ["locked", "review", "building", "spec", "intent"] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

/** BR-10 render vocabulary (SS14). Derivation names map 1:1; only the label differs. */
export const PHASE_LANE_LABELS: Record<ReviewPhase, string> = {
  intent: "INTENT",
  spec: "PLAN",
  building: "BUILD",
  review: "REVIEW",
  locked: "LOCKED",
};

// --- FR-4: NEEDS YOU + AGENTS (KEEP — orthogonal, already sound) ---

export interface DerivedException {
  /** OPR.0.4.6.WF5 FR-3 adds the workflow-sourced kinds: "workflow-failed"
   *  (the ▲ backstop for an item-less failed instance — itself evidence of
   *  a bug), "awareness" (the human-KNOWS row for an ORCHESTRATOR-routed
   *  exception: holder + age, distinct from a to-do, derived never
   *  minted), "anomaly" (frontier references a non-open packet — the
   *  detection backstop behind WF-3 FR-6's prevention guard). */
  kind: "stuck" | "overdue" | "insufficient-proof" | "stale-after-change" | "workflow-failed" | "awareness" | "anomaly";
  /** The inline evidence — never a bare accusation ("idle 47m >= 30m default · holds 2"). */
  evidence: string;
  /** The visible v1 threshold it crossed. */
  threshold: string;
}

/** OPR.0.4.6.WF4 Q6 (arch-ruled) — the ONE structured workflow-identity join
 *  for every attention row that belongs to a workflow instance. Stamped
 *  daemon-side exactly once; the UI consumes ONLY this pointer for workflow
 *  routing (never prose from identity/evidenceRef/summary). Pointer-only:
 *  the three identity keys, NO status/deadline/class (those live on the
 *  instance payload). OMITTED when the row is not workflow-sourced
 *  (byte-identity-by-omission). */
export interface WorkflowRowRef {
  instanceId: string;
  workflowName: string;
  stepId?: string;
}

export interface NeedsYouItem {
  /** "agent" = ● (agent-initiated leg); "derived" = ▲ (composer exception). Equal rank. */
  source: "agent" | "derived";
  /** OPR.0.4.6.WF4 Q6 — present ONLY on workflow-sourced rows (omit-when-absent). */
  workflow?: WorkflowRowRef;
  /** One-count identity: qitem id, or the ▲ tuple key "seat-or-slice|kind|since". */
  identity: string;
  summary: string;
  leg: string;
  where: string;
  ageIso: string | null;
  priority: string | null;
  tier: string | null;
  evidenceRef: string | null;
  /** Computed what-it-unblocks (the park relation), or null. */
  unblocks: string | null;
  /** #6 read-contract members: the actionable qitem's real destination/actor identity. */
  qitemId: string | null;
  destinationSession: string | null;
  derived: DerivedException | null;
}

export interface NeedsYouBand {
  items: NeedsYouItem[];
  /** U4: the proven-empty/computed-from provenance line — always present. */
  provenance: string;
}

// --- FR-4 SSOT: the shared agent-row anatomy (both scopes render exactly this) ---

export type AgentsScope = `slice:${string}` | `mission:${string}` | "rig";

export interface AgentRow {
  agentName: string;
  runtime: "claude-code" | "codex" | "terminal" | "unknown";
  /** Honest-unknown when telemetry is down — never guessed. Parked is queue-proven. */
  stateGlyph: "active" | "parked" | "idle" | "unknown";
  /** The C6 plain-language "doing" line. */
  doing: string | null;
  holdsCount: number;
  lastTransitionIso: string | null;
  /** ▲ mark with inline evidence when a derived exception targets this agent. */
  exception: DerivedException | null;
  sessionName: string;
  /** Slice ids grouping this row at mission scope. */
  slices: string[];
}

export interface AgentsBand {
  scope: AgentsScope;
  rows: AgentRow[];
  /** BR-11 provenance (proven-empty carries it too — never a blank region). */
  provenance: string;
  coordinationHealth: string | null;
}

// --- OPR.0.4.4.22 (slice 22): the RIG-scope standalone altitude root (KEEP) ---
// Same contract family as ComposedSliceReview / ComposedMissionReview — the
// agent-scope query members the slice-22 PRD adds; never a second family.

/** One settled handoff (the record band): today's closed handoffs, one line
 *  each, in C6 summaries (BR-10 — plain language first). */
export interface SettledRow {
  fromSession: string;
  toSession: string;
  /** The qitem's C6 summary; null degrades to the qitem id at render. */
  summary: string | null;
  closedAtIso: string;
  qitemId: string;
}

/** The composed rig-agents read root (slice 22 FR-1..FR-4): NEEDS YOU +
 *  AGENTS (with coordination health) + SETTLED at rig scope. Pure
 *  projection over queue + ps — agents author nothing for it. */
export interface ComposedRigAgents {
  scope: "rig";
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  settled: SettledRow[];
  /** BR-11: proven-empty carries provenance too — never a blank region. */
  settledProvenance: string;
  composedAt: string;
}

// --- OPR.0.4.6.MH5: the FLEET aggregate contract (arch Q2 — a SIBLING
// aggregate surface ABOVE the per-host ladder, never a fourth AgentsScope
// value; AgentsScope stays exactly 3-valued). The contract HOME is here
// beside ComposedRigAgents (plan D-3 — the twin's fixture module was the
// mock stand-in). The fleet root only UNIONS + HOST-DIMENSIONS + COUNTS
// each host's own composed set (arch Q1 — each host is authoritative for
// its own time-derived ▲; the fleet never recomputes exception truth). ---

import type { PerHostStatus } from "../hosts/fanout-contract.js";

/** One fleet NEEDS-YOU row: the per-host row carried VERBATIM (kind-agnostic
 *  — whatever DerivedException the host composed flows through; the WF-4 Q6
 *  `workflow` pointer passes through untouched, omit-when-absent) plus the
 *  host dimension and the one-count provenance. */
export interface FleetNeedsYouItem extends NeedsYouItem {
  hostId: string;
  /** The Q4 one-count key `${hostId}|${identity}` — the fleet Set's key,
   *  rendered VERBATIM on the expanded drawer (the inspectable identity). */
  fleetKey: string;
  /** FR-3 provenance: the altitude scopes this identity was visible from on
   *  its host — recorded from what the fan-out actually READ (v1 reads each
   *  host's rig root, D-1), so the one-count is INSPECTABLE, not asserted. */
  seenFrom: string[];
}

/** Per-host rollup for the HOSTS band. The count fields are PRESENT ONLY
 *  when this host's composed set was read (status.status === "ok") — an
 *  unreachable host's items are ABSENT from the glance, NOT ZERO (the
 *  k9s-stale-header anti-pattern designed against). `status` is the shipped
 *  CLOSED per-host reachability contract, untouched (per-item exceptions
 *  are the separate DerivedException axis — never conflated). */
export interface FleetHostRollup {
  hostId: string;
  kind: "local" | "remote";
  status: PerHostStatus;
  /** Counts computed FROM this host's deduped fleet rows (union math only). */
  needsYouCount?: number;
  /** ▲ counts grouped by the row's own kind string (kind-agnostic carry). */
  exceptionsByKind?: Array<{ kind: string; count: number }>;
  /** From the host's own composed agents band. */
  seatCount?: number;
  /** Distinct rig names across the host's agent rows (the BR-1 member@rig
   *  session grammar — a structured parse, never prose). */
  rigCount?: number;
  /** The worst line — what you'd say out loud about this factory; derived
   *  deterministically from the host's deduped rows ("quiet" at zero). */
  topLine?: string;
}

/** The header rollup math, computed FROM the deduped fleet rows (the twin's
 *  header-math-checkable-against-bands property). */
export interface ComposedFleetRollup {
  /** ● rows (source: "agent") across the deduped fleet union. */
  needsYouCount: number;
  /** ▲ rows (source: "derived") across the deduped fleet union. */
  exceptionCount: number;
  exceptionsByKind: Array<{ kind: string; count: number }>;
  /** Every fleet member in the payload (local + every registered host). */
  hostCount: number;
  /** Hosts whose status is not "ok" (their items are absent, not zero). */
  unreachableCount: number;
}

/** SETTLED at fleet altitude — minimal per the placement-lock ride-item
 *  default (D-5), host-chipped. */
export interface FleetSettledRow extends SettledRow {
  hostId: string;
}

/** The composed fleet read root (`GET /api/review/fleet`) — ONE aggregate,
 *  BOTH founder-locked surfaces (the /fleet route page and the FLEET band)
 *  render it. Read + surface only (FR-5): acting rides MH-3/MH-4. */
export interface ComposedFleet {
  rollup: ComposedFleetRollup;
  needsYou: { items: FleetNeedsYouItem[]; provenance: string };
  /** One entry per fleet member — local first, then registry order. EVERY
   *  member appears with its status (omission-proof, the AggregatedPayload
   *  convention); counts present only on "ok" rows (absent-not-zero). */
  hosts: FleetHostRollup[];
  settled: FleetSettledRow[];
  settledProvenance: string;
  /** Present ONLY when the host registry exists but failed to load/parse —
   *  surfaced honestly (never a silently-local-only fleet). Omitted when
   *  the registry is absent (a single-host operator) or loads cleanly. */
  registryError?: string;
  composedAt: string;
}

// --- The composed slice review (the read contract root — CORRECTIVE §3.1) ---

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
    lockedArtifacts: LockedArtifact[];
    lock: LockState | null;
    ssotPath: string | null;
  };
  /** §3 — the redesigned join: planned ↔ curated proof ↔ QA-verified. */
  delivered: {
    items: DeliveredItem[];
    /** Helpful artifacts not tied to one deliverable — bounded at render (§6). */
    extraProof: ReviewMedia[];
    lock: LockState | null;
    /** Drill-in target for "see all proof" (the full fix-loop history). */
    proofDirPath: string | null;
  };
  // KEEP (orthogonal, already sound): attention + coordination + freshness.
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  lineage: VerifyLineage;
  /** Absolute/escaping media-path findings etc. — surfaced, never silently dropped (FR-5). */
  defects: string[];
  /** View-time input echoed back (an INPUT to the pure composer — idempotence holds). */
  composedAt: string;
}

// --- FR-7: mission altitude (KEEP — the completion ledger's recorded-verdict
// green is a mission-ledger fact, not a slice-review structure) ---

export interface BoardSlot {
  slice: string;
  title: string;
  phase: ReviewPhase;
  laneLabel: string;
  agentsCount: number;
  /** The stage-specific cell (spec-stamp state / n-of-m / green+merged pair / stamp). */
  stageCell: string;
  changedSinceStamp: boolean;
  /** Deterministic attention-worthiness: needs-you ∪ ▲ ∪ stage-changed-today. */
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
  /** The brief's "What & why" — projected VERBATIM as the mission intent opener (FR-8). */
  intent: string | null;
  /** FR-8: the generated status-spine bodies — ONE computation path; the tab
   *  renders these always-fresh and the SAME strings land in MISSION_BRIEF.md
   *  only at freeze moments. */
  briefSpine: { building: string; progress: string; proven: string; needsYou: string };
  board: BoardSlot[];
  /** SETTLED: the completion ledger — a query over the mission's slice set, never an authored list. */
  ledger: LedgerRow[];
  /** TRUE only when EVERY in-cut slice is green AND merged AND has zero open needs-human items. */
  cutComplete: boolean;
  cutCompleteBasis: string;
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  composedAt: string;
}
