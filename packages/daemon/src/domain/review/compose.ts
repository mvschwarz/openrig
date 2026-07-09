// Living Notes — the deterministic composer (OPR.0.4.4.20, rebuilt per the
// CORRECTIVE REDESIGN of 2026-07-05).
//
// PURE: `(gathered inputs) -> composed doc`. Same inputs (including the
// caller-supplied view-time facts nowIso/mainTip/git facts) -> byte-identical
// output. Every section has a named SSOT and a degrade value; a missing
// source renders its degrade, never invented content. The gatherer that
// assembles inputs from disk/queue/git lives beside this file; keeping the
// core pure is what makes the idempotence AC hold by construction.
//
// CORRECTIVE §3.1 — the composer builds ONE renderable structure per slice:
// the INTENT → PLAN → DELIVERED stack. It no longer emits `sections`,
// `acceptance`, `compare`, `join`, or a coequal `green` field. The
// recorded-verdict rigor behind the old green lives on in two places only:
// the per-deliverable `verified` signal (§11) and the mission ledger's
// completion green (FR-7 — a mission-altitude fact, not a slice structure).

import YAML from "yaml";
import * as posixPath from "node:path/posix";
import { renderBriefSpine } from "./brief-spine.js";
import {
  C1_ARTIFACT_TYPES,
  C1_VERDICTS,
  GATE_ROLES,
  PHASE_LANE_LABELS,
  type AgentRow,
  type AgentsBand,
  type AgentsScope,
  type BoardSlot,
  type C1ArtifactType,
  type C1Verdict,
  type ComposedMissionReview,
  type ComposedRigAgents,
  type ComposedSliceReview,
  type DeliveredItem,
  type DerivedException,
  type GateRole,
  type LedgerRow,
  type LockState,
  type LockedArtifact,
  type NeedsYouBand,
  type NeedsYouItem,
  type WorkflowRowRef,
  type ProofArtifact,
  type ReviewMedia,
  type ReviewPhase,
  type SettledRow,
  type VerdictCell,
  type VerdictTone,
  type VerifyLineage,
} from "./types.js";

// --- Fixed, visible v1 thresholds (markdown-steered tuning is a named fast-follow) ---
export const IDLE_WITH_WORK_THRESHOLD_MIN = 30;

// ---------------------------------------------------------------------------
// Media refs (shared shape helpers — pure string work, no filesystem)
// ---------------------------------------------------------------------------

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v"]);

function extOf(ref: string): string {
  const clean = ref.split(/[?#]/)[0]!;
  const i = clean.lastIndexOf(".");
  return i === -1 ? "" : clean.slice(i).toLowerCase();
}

export function mediaKind(ref: string): ReviewMedia["kind"] | null {
  const ext = extOf(ref);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

/** Markdown/HTML media refs in a source string (http(s) refs excluded —
 *  media is co-located slice content, FR-5). */
export function extractMediaRefs(markdown: string | null): string[] {
  if (!markdown) return [];
  const refs: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)|<(?:video|img|source)[^>]*\ssrc="([^"]+)"/g;
  for (const m of markdown.matchAll(re)) {
    const ref = (m[1] ?? m[2] ?? "").trim();
    if (ref && !ref.startsWith("http")) refs.push(ref);
  }
  return refs;
}

/** Normalizes a media ref written relative to `baseDir` (slice-relative "")
 *  into a slice-relative path. Returns null when the ref is absolute or
 *  escapes the slice dir — the caller records the defect (FR-5), never a
 *  silent drop. */
export function sliceRelativeMediaPath(ref: string, baseDir: string): string | null {
  if (ref.startsWith("/")) return null;
  const joined = baseDir ? posixPath.join(baseDir, ref) : ref;
  const normalized = posixPath.normalize(joined);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function toReviewMedia(ref: string, baseDir: string): ReviewMedia | null {
  const kind = mediaKind(ref);
  if (!kind) return null;
  const src = sliceRelativeMediaPath(ref, baseDir);
  if (!src) return null;
  return { kind, src, caption: ref };
}

function dedupMedia(media: ReviewMedia[]): ReviewMedia[] {
  const seen = new Set<string>();
  return media.filter((m) => {
    if (seen.has(m.src)) return false;
    seen.add(m.src);
    return true;
  });
}

// ---------------------------------------------------------------------------
// C1 header parsing
// ---------------------------------------------------------------------------

/** Parses a proof artifact's YAML frontmatter into a ProofArtifact.
 *  Out-of-set / missing verdicts become null (a present artifact is not a
 *  verdict — FR-2); the parse never throws on malformed input. Body media
 *  refs are captured for the §3.4 curated-proof projection. */
export function parseC1Header(content: string, relPath: string, droppedAtIso: string): ProofArtifact {
  const out: ProofArtifact = {
    relPath,
    slice: null,
    candidateSha: null,
    artifactType: null,
    verdict: null,
    moneyEvidence: null,
    evidences: [],
    selfCheck: null,
    mediaRefs: [],
    droppedAt: droppedAtIso,
  };
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  out.mediaRefs = extractMediaRefs(m ? content.slice(m[0].length) : content);
  if (!m) return out;
  let fm: Record<string, unknown>;
  try {
    fm = (YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  } catch {
    return out;
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : v != null && typeof v !== "object" ? String(v) : null);
  out.slice = str(fm["slice"]);
  out.candidateSha = str(fm["candidate_sha"]);
  const at = str(fm["artifact_type"]);
  out.artifactType = at && (C1_ARTIFACT_TYPES as readonly string[]).includes(at) ? (at as C1ArtifactType) : null;
  const v = str(fm["verdict"]);
  out.verdict = v && (C1_VERDICTS as readonly string[]).includes(v) ? (v as C1Verdict) : null;
  out.moneyEvidence = str(fm["money_evidence"]);
  out.selfCheck = str(fm["self_check"]);
  const ev = fm["evidences"];
  if (Array.isArray(ev)) out.evidences = ev.map((e) => String(e)).filter((e) => e.trim().length > 0);
  return out;
}

// ---------------------------------------------------------------------------
// FR-2 — verdict selection, pass-mapping, lineage (KEEP)
// ---------------------------------------------------------------------------

/** The pinned pass-mapping ("passing" is never left to interpretation). */
export function isPassing(artifactType: C1ArtifactType, verdict: C1Verdict | null): boolean {
  if (verdict === null) return false;
  if (artifactType === "qa") return verdict === "PASS";
  if (artifactType === "adjudication") return verdict === "CLEAR" || verdict === "PASS";
  // guard, rev1-r1, rev1-r2
  return verdict === "CLEAR";
}

function toneFor(artifactType: C1ArtifactType, verdict: C1Verdict | null): VerdictTone {
  if (verdict === null) return "unknown";
  return isPassing(artifactType, verdict) ? "pass" : "fail";
}

/** Latest-wins per (candidate_sha, artifact_type) — the ratified C1 selection
 *  rule. A non-passing verdict is superseded only by a LATER artifact of the
 *  SAME tuple, never by adjacent artifacts, presence, or approval. */
export function selectWinning(
  artifacts: ProofArtifact[],
  candidateSha: string | null,
): Map<C1ArtifactType, ProofArtifact> {
  const winning = new Map<C1ArtifactType, ProofArtifact>();
  for (const a of artifacts) {
    if (!a.artifactType) continue;
    if (candidateSha !== null && a.candidateSha !== candidateSha) continue;
    const prev = winning.get(a.artifactType);
    if (!prev || a.droppedAt > prev.droppedAt || (a.droppedAt === prev.droppedAt && a.relPath > prev.relPath)) {
      winning.set(a.artifactType, a);
    }
  }
  return winning;
}

/** The candidate under judgment: the candidate_sha of the latest-dropped gate
 *  artifact (deterministic; ties broken by relPath). Null when no artifact
 *  carries one. */
export function deriveCandidateSha(artifacts: ProofArtifact[]): string | null {
  let best: ProofArtifact | null = null;
  for (const a of artifacts) {
    if (!a.candidateSha || !a.artifactType || a.artifactType === "adjudication") continue;
    if (!best || a.droppedAt > best.droppedAt || (a.droppedAt === best.droppedAt && a.relPath > best.relPath)) best = a;
  }
  return best?.candidateSha ?? null;
}

export function deriveGateCells(artifacts: ProofArtifact[], candidateSha: string | null): VerdictCell[] {
  const winning = selectWinning(artifacts, candidateSha);
  return GATE_ROLES.map((role: GateRole): VerdictCell => {
    const a = winning.get(role);
    if (!a || a.verdict === null) {
      return { role, recordedToken: null, tone: "unknown", state: "missing", source: a?.relPath ?? null };
    }
    return {
      role,
      recordedToken: a.verdict,
      tone: toneFor(role, a.verdict),
      state: isPassing(role, a.verdict) ? "passing" : "non-passing",
      source: a.relPath,
    };
  });
}

export interface GitFacts {
  mainTip: string;
  /** Parsed from `Merge OPR.<id>` subjects; null = unmerged. */
  mergeSha: string | null;
  /** Post-merge: is the merge an ancestor of tip? */
  mergeIsAncestorOfTip: boolean | null;
  /** Pre-merge: commits the candidate's merge-base is behind tip; null = unknown. */
  candidateBehindTip: number | null;
}

/** Near-tip tolerance for the pre-merge fresh label. */
const FRESH_BEHIND_TOLERANCE = 3;

export function composeLineage(
  candidateSha: string | null,
  git: GitFacts,
  gateCells: VerdictCell[],
): VerifyLineage {
  let freshness: VerifyLineage["freshness"] = "unknown";
  let staleBehind: number | null = null;
  if (git.mergeSha !== null) {
    if (git.mergeIsAncestorOfTip !== null) freshness = git.mergeIsAncestorOfTip ? "fresh" : "stale";
  } else if (candidateSha !== null && git.candidateBehindTip !== null) {
    if (git.candidateBehindTip <= FRESH_BEHIND_TOLERANCE) {
      freshness = "fresh";
    } else {
      freshness = "stale";
      staleBehind = git.candidateBehindTip;
    }
  }
  return { candidateSha, mergeSha: git.mergeSha, mainTip: git.mainTip, freshness, staleBehind, gateCells };
}

// ---------------------------------------------------------------------------
// §4 — the two locks (the SHIPPED staged-approval stamps, arch F-A)
// ---------------------------------------------------------------------------

export interface ApprovalStampFacts {
  by: string;
  at: string;
  /** One-query cross-check against the pinned scope-approval audit shape. */
  auditRowPresent: boolean;
}

export interface ApprovalFacts {
  /** `--scope spec` stamp (approved-spec-by/at) → plan.lock. */
  spec: ApprovalStampFacts | null;
  /** `--scope delivery` stamp (approved-by/at) → delivered.lock. */
  delivery: ApprovalStampFacts | null;
}

export function lockFrom(stamp: ApprovalStampFacts | null): LockState | null {
  if (!stamp) return null;
  return { by: stamp.by, at: stamp.at, auditVerified: stamp.auditRowPresent };
}

// ---------------------------------------------------------------------------
// Mission-ledger green (FR-7). NOT a slice-review structure: the slice
// contract's coequal `green` field is REMOVED (§11); this recorded-verdict
// computation feeds the mission completion ledger + the regime-2
// confirm-faithful trigger only. Approval NEVER colors it (BR-6).
// ---------------------------------------------------------------------------

export interface RecordedGreen {
  green: boolean;
  /** 1 = full gate-verdict set; 2 = adjudicated confirm-faithful; null when not green. */
  regime: 1 | 2 | null;
}

export function computeRecordedGreen(
  gateCells: VerdictCell[],
  artifacts: ProofArtifact[],
  candidateSha: string | null,
): RecordedGreen {
  if (gateCells.every((c) => c.state === "passing")) return { green: true, regime: 1 };
  const adjudication = selectWinning(artifacts, candidateSha).get("adjudication");
  if (adjudication && isPassing("adjudication", adjudication.verdict)) return { green: true, regime: 2 };
  return { green: false, regime: null };
}

/** Convenience for the mission gatherer: derive the ledger green straight
 *  from a slice's artifacts (candidate + gate cells derived internally). */
export function composeRecordedGreenForSlice(artifacts: ProofArtifact[]): RecordedGreen {
  const candidateSha = deriveCandidateSha(artifacts);
  return computeRecordedGreen(deriveGateCells(artifacts, candidateSha), artifacts, candidateSha);
}

// ---------------------------------------------------------------------------
// FR-1 — markdown structure extraction (KEEP the extractors; the sections/
// acceptance/compare structures they used to feed are gone)
// ---------------------------------------------------------------------------

/** Extracts a `## <heading>` section body, verbatim (character-identical). */
export function extractSection(markdown: string | null, heading: string): string | null {
  if (!markdown) return null;
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const m = re.exec(markdown);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^##?\s/m);
  const body = next === -1 ? rest : rest.slice(0, next);
  return body.replace(/^\n+/, "").replace(/\s+$/, "");
}

/** The pinned mini-requirements tier at the PRD top (plan.concise.text). */
export function extractMiniReqs(prd: string | null): string | null {
  return extractSection(prd, "Mini-requirements(?:[^\\n]*)?");
}

/** One promised deliverable from the D2 `## Proof contract` (§3.1): the item
 *  text plus an optional planned-mockup ref written as a markdown image on
 *  the same checkbox line (`- [ ] drawer opens right ![mockup](mockups/x.png)`). */
export interface PromisedItem {
  text: string;
  plannedRef: string | null;
}

export function extractProofContract(prd: string | null): PromisedItem[] {
  const body = extractSection(prd, "Proof contract");
  if (!body) return [];
  const items: PromisedItem[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-?\s*\[(?:\s|x|X)\]\s+(.+)$/);
    if (!m) continue;
    let text = m[1]!.trim();
    let plannedRef: string | null = null;
    const img = text.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (img) {
      plannedRef = img[1]!.trim();
      text = text.replace(img[0], "").replace(/\s{2,}/g, " ").trim();
    }
    items.push({ text, plannedRef });
  }
  return items;
}

// ---------------------------------------------------------------------------
// FR-3 — derived phase (five-way, top-down precedence — KEEP)
// ---------------------------------------------------------------------------

export interface PhaseSignals {
  prdPresent: boolean;
  /** ANY delivery signal: a proof artifact OR a claimed/in-progress slice-tagged qitem. */
  proofArtifactPresent: boolean;
  activeQitemPresent: boolean;
  /** Evidence/verdict set present (any recorded verdict OR a claimed PROOF.md + media set). */
  verdictOrEvidenceSetPresent: boolean;
  /** The delivery approval stamp. */
  approved: boolean;
}

/** Top-down by precedence — locked > review > building > spec > intent —
 *  stated explicitly because one signal can satisfy two lanes. */
export function derivePhase(s: PhaseSignals): ReviewPhase {
  if (s.approved) return "locked";
  if (s.verdictOrEvidenceSetPresent) return "review";
  if (s.proofArtifactPresent || s.activeQitemPresent) return "building";
  if (s.prdPresent) return "spec";
  return "intent";
}

// ---------------------------------------------------------------------------
// §3.1 DELIVERED — the redesigned join: planned ↔ curated proof ↔ verified
// ---------------------------------------------------------------------------

/** An `evidences:` ref matches a promised item by exact text or 1-based index. */
function refMatches(ref: string, promised: PromisedItem[], index: number): boolean {
  const trimmed = ref.trim();
  return trimmed === promised[index]!.text || trimmed === String(index + 1);
}

export interface ComposedDelivered {
  items: DeliveredItem[];
  extraProof: ReviewMedia[];
  /** Feeds ▲ insufficient-proof (FR-4) and the board's building-cell n/m (FR-7). */
  missingCount: number;
  /** Artifact media refs that escape the slice dir (FR-5 defect findings). */
  escapingRefs: string[];
}

/**
 * `delivered.items` IS the join, reframed (§3.1): each `## Proof contract`
 * deliverable pairs with the CURATED proof media of the artifacts covering it
 * and QA's recorded comparison signal.
 *
 * `verified` binds to the SHIPPED C1 fields (arch F3), never presence:
 *   verified   — a covering qa|adjudication artifact records the comparison
 *                (self_check) AND its recorded verdict is passing;
 *   unverified — some covering artifact exists but no passing recorded QA
 *                comparison (QA's why-kicked-back note still surfaces);
 *   missing    — promised, nothing delivered.
 * Fail-open by construction: these are render states, never blocks.
 */
export function composeDelivered(promised: PromisedItem[], artifacts: ProofArtifact[]): ComposedDelivered {
  const escaping = new Set<string>();
  const mediaOf = (a: ProofArtifact): ReviewMedia[] => {
    const out: ReviewMedia[] = [];
    for (const ref of a.mediaRefs) {
      const m = toReviewMedia(ref, "proof");
      if (m) out.push(m);
      else if (mediaKind(ref)) escaping.add(ref);
    }
    return out;
  };
  const byLatest = (a: ProofArtifact, b: ProofArtifact) =>
    a.droppedAt < b.droppedAt ? 1 : a.droppedAt > b.droppedAt ? -1 : a.relPath.localeCompare(b.relPath);

  const covered = new Set<string>();
  const items: DeliveredItem[] = promised.map((p, i) => {
    const covering = artifacts.filter((a) => a.evidences.some((ref) => refMatches(ref, promised, i))).sort(byLatest);
    covering.forEach((a) => covered.add(a.relPath));
    const qaCovering = covering.filter((a) => a.artifactType === "qa" || a.artifactType === "adjudication");
    const verifiedBy = qaCovering.find((a) => a.selfCheck !== null && a.artifactType !== null && isPassing(a.artifactType, a.verdict));
    const noteSource = qaCovering.find((a) => a.selfCheck !== null) ?? covering.find((a) => a.selfCheck !== null);
    const plannedRef = p.plannedRef ? toReviewMedia(p.plannedRef, "") : null;
    if (p.plannedRef && !plannedRef && mediaKind(p.plannedRef)) escaping.add(p.plannedRef);
    const item: DeliveredItem = {
      promised: plannedRef ? { text: p.text, plannedRef } : { text: p.text },
      proof: dedupMedia(covering.flatMap(mediaOf)),
      verified: verifiedBy ? "verified" : covering.length > 0 ? "unverified" : "missing",
    };
    const note = noteSource?.selfCheck ?? null;
    if (note) item.note = note;
    return item;
  });

  // Helpful-but-unmapped artifacts (§6): their media renders bounded under
  // the extraProof label — visible, never dropped, never a primary-view pile.
  const extraProof = dedupMedia(
    artifacts
      .filter((a) => !covered.has(a.relPath))
      .sort(byLatest)
      .flatMap(mediaOf),
  );

  return {
    items,
    extraProof,
    missingCount: items.filter((it) => it.verified === "missing").length,
    escapingRefs: [...escaping].sort(),
  };
}

// ---------------------------------------------------------------------------
// FR-4 — NEEDS YOU (two sources, one queue) + AGENTS (KEEP)
// ---------------------------------------------------------------------------

export interface AttentionInput {
  qitemId: string;
  summary: string | null;
  leg: string;
  where: string;
  createdAtIso: string | null;
  priority: string | null;
  tier: string | null;
  evidenceRef: string | null;
  unblocks: string | null;
  destinationSession: string | null;
  closureRequiredAtIso: string | null;
  /** OPR.0.4.6.WF4 Q6 — set by the gatherer when the item carries an
   *  `instance:<id>` workflow-exception tag; carried verbatim to the row. */
  workflow?: WorkflowRowRef;
}

export interface AgentInput {
  agentName: string;
  sessionName: string;
  runtime: AgentRow["runtime"];
  /** Queue-proven park target (human/qitem/etc.); null means no parked row state. */
  parkedOn: string | null;
  /** null = telemetry down (honest-unknown). */
  idle: boolean | null;
  idleSinceIso: string | null;
  doing: string | null;
  holdsCount: number;
  lastTransitionIso: string | null;
  slices: string[];
}

function minutesBetween(aIso: string, bIso: string): number {
  return Math.floor((Date.parse(bIso) - Date.parse(aIso)) / 60_000);
}

/** The delivered-completeness facts the ▲ insufficient-proof rule reads
 *  (was the old join's counts; §3.1 re-bind — the signal is the
 *  delivered.items MISSING count). */
export interface DeliveredCounts {
  promisedCount: number;
  missingCount: number;
}

/** The four ▲ exception rules over captured signals. Every row carries its
 *  evidence + crossed threshold; no evidence -> no exception (never a bare
 *  accusation). A ▲ is information for the human, invisible to the flagged
 *  agent's workflow. */
export function deriveExceptions(
  agents: AgentInput[],
  attention: AttentionInput[],
  delivered: DeliveredCounts,
  scopeLabel: string,
  nowIso: string,
  latestArtifactIso: string | null,
  governingStampIso: string | null,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const push = (identity: string, summary: string, d: DerivedException) => {
    items.push({
      source: "derived",
      identity,
      summary,
      leg: d.kind,
      where: scopeLabel,
      ageIso: null,
      priority: null,
      tier: null,
      evidenceRef: null,
      unblocks: null,
      qitemId: null,
      destinationSession: null,
      derived: d,
    });
  };

  for (const a of agents) {
    if (a.idle === true && a.holdsCount > 0 && a.idleSinceIso) {
      const idleMin = minutesBetween(a.idleSinceIso, nowIso);
      if (idleMin >= IDLE_WITH_WORK_THRESHOLD_MIN) {
        push(
          `${a.sessionName}|stuck|${a.idleSinceIso}`,
          `${a.agentName} looks stuck`,
          {
            kind: "stuck",
            evidence: `idle ${idleMin}m >= ${IDLE_WITH_WORK_THRESHOLD_MIN}m default · holds ${a.holdsCount}`,
            threshold: `idle-with-work >= ${IDLE_WITH_WORK_THRESHOLD_MIN}m`,
          },
        );
      }
    }
  }
  for (const q of attention) {
    if (q.closureRequiredAtIso && q.closureRequiredAtIso < nowIso) {
      push(
        `${q.qitemId}|overdue|${q.closureRequiredAtIso}`,
        `${q.summary ?? q.qitemId} is overdue`,
        {
          kind: "overdue",
          evidence: `closure required at ${q.closureRequiredAtIso} · now ${nowIso}`,
          threshold: "past closure_required_at",
        },
      );
    }
  }
  if (delivered.promisedCount > 0 && delivered.missingCount > 0) {
    push(
      `${scopeLabel}|insufficient-proof|${delivered.missingCount}`,
      `insufficient proof: ${delivered.missingCount}/${delivered.promisedCount} promised items missing`,
      {
        kind: "insufficient-proof",
        evidence: `${delivered.missingCount} of ${delivered.promisedCount} promised deliverables have no delivered evidence`,
        threshold: "delivered.items MISSING count > 0",
      },
    );
  }
  if (latestArtifactIso && governingStampIso && latestArtifactIso > governingStampIso) {
    push(
      `${scopeLabel}|stale-after-change|${latestArtifactIso}`,
      "artifacts changed after the governing stamp",
      {
        kind: "stale-after-change",
        evidence: `artifact at ${latestArtifactIso} is newer than the stamp at ${governingStampIso}`,
        threshold: "artifact newer than governing stamp",
      },
    );
  }
  return items;
}

export function composeNeedsYou(
  attention: AttentionInput[],
  derived: NeedsYouItem[],
  confirmFaithful: NeedsYouItem[],
  computedOver: string,
  nowIso: string,
): NeedsYouBand {
  const agentItems: NeedsYouItem[] = attention.map((q) => ({
    source: "agent",
    // OPR.0.4.6.WF4 Q6 — carry the gatherer's pointer verbatim; OMITTED for
    // non-workflow items (byte-identity-by-omission).
    ...(q.workflow ? { workflow: q.workflow } : {}),
    identity: q.qitemId,
    summary: q.summary ?? q.qitemId,
    leg: q.leg,
    where: q.where,
    ageIso: q.createdAtIso,
    priority: q.priority,
    tier: q.tier,
    evidenceRef: q.evidenceRef,
    unblocks: q.unblocks,
    qitemId: q.qitemId,
    destinationSession: q.destinationSession,
    derived: null,
  }));
  // One-count identity rule: distinct identities within this scope only.
  const seen = new Set<string>();
  const all = [...agentItems, ...confirmFaithful, ...derived].filter((i) => {
    if (seen.has(i.identity)) return false;
    seen.add(i.identity);
    return true;
  });
  // Priority-ordered, most-consequential-first: explicit priority rank, then age.
  const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  all.sort((a, b) => {
    const ra = rank[a.priority ?? "normal"] ?? 2;
    const rb = rank[b.priority ?? "normal"] ?? 2;
    if (ra !== rb) return ra - rb;
    return (a.ageIso ?? "9999") < (b.ageIso ?? "9999") ? -1 : 1;
  });
  return {
    items: all,
    provenance:
      all.length === 0
        ? `0 attention items · 0 parks · 0 unconfirmed proofs — computed from ${computedOver} at ${nowIso}`
        : `computed from ${computedOver} at ${nowIso}`,
  };
}

// --- OPR.0.4.4.22 (slice 22): agent-scope exceptions + the rig read root (KEEP) ---

/** OPR.0.4.6.WF5 FR-3 — one recorded workflow-instance view for the ▲
 *  band. The GATHERER assembles these from recorded state only
 *  (workflow_instances + queue rows + the WF-1 evaluator verdict + the
 *  open exception item by tag query); this module derives rows PURELY. */
export interface WorkflowExceptionInput {
  instanceId: string;
  workflowName: string;
  status: string;
  currentStepId: string | null;
  /** The WF-1 evaluator's verdict state for the frontier ("healthy" or
   *  the overdue states) + its evidence line, precomposed by the
   *  gatherer. Never recomputed here (one-threshold-home). */
  deadlineState: string;
  deadlineEvidence: string | null;
  /** True when a frontier id resolves to a NON-OPEN packet (the
   *  out-of-band corruption state — WF-3 FR-6's guard is the
   *  prevention; this row is the detection backstop). */
  frontierRefsNonOpenPacket: boolean;
  /** The OPEN exception item for this instance (tag query), if any. */
  openItem: {
    qitemId: string;
    destinationSession: string;
    humanRouted: boolean;
    createdAtIso: string | null;
    summary: string | null;
  } | null;
}

/**
 * OPR.0.4.6.WF5 FR-3 — the workflow_instances ▲ source + THE AWARENESS
 * CHANNEL. One-count across channels (BR-3): an exception with a live
 * HUMAN-routed ● item renders NOTHING here (the item IS the human's
 * row); an ORCHESTRATOR-routed ● item renders exactly ONE awareness row
 * (same identity, second projection — the human KNOWS at altitude); a
 * failed instance with NO item renders the ▲ backstop naming BOTH the
 * exception AND the missing-item anomaly (the backstop firing is itself
 * evidence of a bug). Healthy instances render zero rows (the band's
 * zero-noise negative). Durable-by-derivation: recomputed from recorded
 * state on every composition; rows clear on state-exit (recomposition,
 * never hand-clearing).
 */
export function deriveWorkflowExceptions(
  workflows: WorkflowExceptionInput[],
  scopeLabel: string,
  nowIso: string,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const push = (
    identity: string,
    summary: string,
    d: DerivedException,
    evidenceRef: string | null,
    workflow: WorkflowRowRef,
  ) => {
    items.push({
      source: "derived",
      // OPR.0.4.6.WF4 Q6 — every derived workflow row carries the pointer.
      workflow,
      identity,
      summary,
      leg: d.kind,
      where: scopeLabel,
      ageIso: null,
      priority: null,
      tier: null,
      evidenceRef,
      unblocks: null,
      qitemId: null,
      destinationSession: null,
      derived: d,
    });
  };
  for (const w of workflows) {
    const trace = `rig workflow trace ${w.instanceId}`;
    // OPR.0.4.6.WF4 Q6 — the pointer for every row this instance emits;
    // identity derived exactly once, here (never from prose downstream).
    const wref: WorkflowRowRef = {
      instanceId: w.instanceId,
      workflowName: w.workflowName,
      ...(w.currentStepId ? { stepId: w.currentStepId } : {}),
    };
    // The anomaly backstop fires regardless of item state — the
    // corruption is orthogonal to exception routing.
    if (w.frontierRefsNonOpenPacket) {
      push(
        `${w.instanceId}|anomaly|frontier-non-open`,
        `${w.workflowName} instance frontier references a closed packet`,
        {
          kind: "anomaly",
          evidence: `instance ${w.instanceId} frontier points at a non-open packet — out-of-band closure got past the WF-3 close-path guard`,
          threshold: "frontier packet must be open",
        },
        trace,
        wref,
      );
    }
    const exceptional =
      w.status === "failed" || (w.deadlineState !== "healthy" && w.deadlineEvidence !== null);
    if (!exceptional) continue;
    const kindLabel = w.status === "failed" ? "failed" : w.deadlineState;
    if (w.openItem && w.openItem.humanRouted) {
      // The ● item already sits in the human attention legs — a row
      // here would double-render (one-count).
      continue;
    }
    if (w.openItem) {
      // ORCHESTRATOR-routed: the awareness row — holder + age +
      // evidence; awareness, not assignment. Same recorded identity as
      // the ● item, projected into the human band.
      const ageMin = w.openItem.createdAtIso ? minutesBetween(w.openItem.createdAtIso, nowIso) : null;
      push(
        `${w.instanceId}|awareness|${w.openItem.qitemId}`,
        `awareness: ${w.workflowName} ${kindLabel} — held by ${w.openItem.destinationSession}`,
        {
          kind: "awareness",
          evidence: `exception item ${w.openItem.qitemId} on ${w.openItem.destinationSession}${ageMin !== null ? ` for ${ageMin}m` : ""}${w.openItem.summary ? ` — ${w.openItem.summary}` : ""}`,
          threshold: "awareness (orchestrator acting; step in any time)",
        },
        trace,
        wref,
      );
      continue;
    }
    // NO item: the ▲ backstop — names the exception AND the anomaly of
    // the missing item.
    push(
      `${w.instanceId}|workflow-${kindLabel}|no-item`,
      `${w.workflowName} instance ${kindLabel} with NO exception item`,
      {
        kind: w.status === "failed" ? "workflow-failed" : "stuck",
        evidence: `${w.deadlineEvidence ?? `instance ${w.instanceId} is ${kindLabel} at step ${w.currentStepId ?? "?"}`} · MISSING-ITEM ANOMALY: the never-lost channel produced no item (itself a bug — report it)`,
        threshold: w.status === "failed" ? "failed instances carry an exception item" : "past the WF-1 deadline evaluator threshold",
      },
      trace,
      wref,
    );
  }
  return items;
}

/** The third NAMED ▲ heuristic's visible v1 default (slice-22 FR-3:
 *  too-long-in-state — no transition beyond threshold). Lives HERE because
 *  compose.ts is the single threshold home (P2 arch note N2): changes land
 *  once and every altitude inherits. Same markdown-steered tuning
 *  fast-follow as IDLE_WITH_WORK_THRESHOLD_MIN. */
export const TOO_LONG_IN_STATE_THRESHOLD_MIN = 120;

/**
 * Slice-22 FR-3 — the agent-scope ▲ set: exactly the three NAMED heuristics
 * (idle-with-assigned-work, overdue handoff, too-long-in-state). The first
 * two REUSE deriveExceptions' rules (called with zero delivered counts and
 * no artifact/stamp facts, so the slice-only insufficient-proof /
 * stale-after-change rules cannot fire); too-long-in-state is added here —
 * additively, so slice-scope composition is byte-unchanged. No evidence →
 * no exception (unknown is not idle; unknown lastTransition is not
 * too-long).
 */
export function deriveAgentScopeExceptions(
  agents: AgentInput[],
  attention: AttentionInput[],
  scopeLabel: string,
  nowIso: string,
): NeedsYouItem[] {
  const items = deriveExceptions(agents, attention, { promisedCount: 0, missingCount: 0 }, scopeLabel, nowIso, null, null);
  for (const a of agents) {
    if (a.holdsCount > 0 && a.lastTransitionIso) {
      const sinceMin = minutesBetween(a.lastTransitionIso, nowIso);
      if (sinceMin >= TOO_LONG_IN_STATE_THRESHOLD_MIN) {
        items.push({
          source: "derived",
          identity: `${a.sessionName}|too-long-in-state|${a.lastTransitionIso}`,
          summary: `${a.agentName} has not transitioned in ${sinceMin}m`,
          leg: "stuck",
          where: scopeLabel,
          ageIso: null,
          priority: null,
          tier: null,
          evidenceRef: null,
          unblocks: null,
          qitemId: null,
          destinationSession: null,
          derived: {
            kind: "stuck",
            evidence: `no transition for ${sinceMin}m >= ${TOO_LONG_IN_STATE_THRESHOLD_MIN}m default · holds ${a.holdsCount}`,
            threshold: `too-long-in-state >= ${TOO_LONG_IN_STATE_THRESHOLD_MIN}m`,
          },
        });
      }
    }
  }
  return items;
}

export interface RigComposeInputs {
  agents: AgentInput[];
  overdue: AttentionInput[];
  attention: AttentionInput[];
  settled: SettledRow[];
  handoffsToday: number;
  overdueCount: number;
  /** The FR-1 roster display window, named on-surface in provenance
   *  (plan-review ruling: "computed from queue+ps · window: today"). */
  rosterWindow: string;
  /** OPR.0.4.6.WF5 FR-3: recorded workflow-instance views (optional). */
  workflows?: WorkflowExceptionInput[];
  nowIso: string;
}

/** Slice-22 FR-1..FR-4 — the rig-scope composition root. PURE: same inputs,
 *  byte-identical output (idempotence is a money proof). */
export function composeRigAgents(inputs: RigComposeInputs): ComposedRigAgents {
  const { nowIso } = inputs;
  const scopeLabel = "rig";
  const derived = [
    ...deriveAgentScopeExceptions(inputs.agents, inputs.overdue, scopeLabel, nowIso),
    ...deriveWorkflowExceptions(inputs.workflows ?? [], scopeLabel, nowIso),
  ];
  const needsYou = composeNeedsYou(
    inputs.attention,
    derived,
    [],
    `queue+ps (rig scope) · window: ${inputs.rosterWindow}`,
    nowIso,
  );
  const band = composeAgentsBand(inputs.agents, "rig", derived, nowIso);
  return {
    scope: "rig",
    needsYou,
    agents: {
      ...band,
      provenance:
        band.rows.length === 0
          ? `no agents holding or recently holding work — computed from queue+ps · window: ${inputs.rosterWindow} · at ${nowIso}`
          : `computed from queue+ps · window: ${inputs.rosterWindow} · at ${nowIso}`,
      // FR-4: one health line per scope, from the transitions log.
      coordinationHealth: `${inputs.handoffsToday} handoffs today · ${inputs.overdueCount} overdue`,
    },
    settled: inputs.settled,
    settledProvenance:
      inputs.settled.length === 0
        ? `0 handoffs today — computed from queue transitions · window: today · at ${nowIso}`
        : `computed from queue transitions · window: today · at ${nowIso}`,
    composedAt: nowIso,
  };
}

/** Region membership derives from work-on-THIS-scope, never rig co-residency. */
export function composeAgentsBand(
  agents: AgentInput[],
  scope: AgentsScope,
  exceptions: NeedsYouItem[],
  nowIso: string,
): AgentsBand {
  const rows: AgentRow[] = agents.map((a) => {
    const ex = exceptions.find((e) => e.derived && e.identity.startsWith(`${a.sessionName}|`));
    return {
      agentName: a.agentName,
      runtime: a.runtime,
      stateGlyph: a.parkedOn ? "parked" : a.idle === null ? "unknown" : a.idle ? "idle" : "active",
      doing: a.doing,
      holdsCount: a.holdsCount,
      lastTransitionIso: a.lastTransitionIso,
      exception: ex?.derived ?? null,
      sessionName: a.sessionName,
      slices: a.slices,
    };
  });
  return {
    scope,
    rows,
    provenance:
      rows.length === 0
        ? `no agents holding or recently holding work — computed from queue at ${nowIso}`
        : `computed from queue at ${nowIso}`,
    coordinationHealth: null,
  };
}

// ---------------------------------------------------------------------------
// The slice composition root — the ONE structure (§3.1)
// ---------------------------------------------------------------------------

export interface SliceComposeInputs {
  slice: { name: string; id: string | null; title: string; missionId: string | null };
  /** Raw file contents (null = absent). */
  readme: string | null;
  prd: string | null;
  proofMd: string | null;
  artifacts: ProofArtifact[];
  /** The pinned plan set — a frontmatter READ (`locked-artifacts:` on the slice README). */
  lockedArtifacts: LockedArtifact[];
  /** Media refs found in composed sources; absolute/escaping paths are defect findings (FR-5). */
  mediaRefs: string[];
  /** True when the slice's proof/ dir exists (the "see all proof" drill-in target). */
  proofDirExists: boolean;
  attention: AttentionInput[];
  agents: AgentInput[];
  /** OPR.0.4.6.WF5 FR-3: recorded workflow-instance views (optional —
   *  absent renders byte-identically to pre-WF-5). */
  workflows?: WorkflowExceptionInput[];
  activeQitemPresent: boolean;
  git: GitFacts;
  approval: ApprovalFacts;
  nowIso: string;
}

/** A self-asserted PASS in the slice's own PROOF.md (never a verdict). */
export function proofClaimsPass(proofMd: string | null): boolean {
  if (!proofMd) return false;
  return proofMd
    .split(/\r?\n/)
    .some((line) => /^\s*(?:Closed by:.*\bVerdict:|Verdict:|Result:)\s*PASS\b/i.test(line));
}

function sectionMedia(sectionBody: string | null, escaping: Set<string>): ReviewMedia[] {
  const out: ReviewMedia[] = [];
  for (const ref of extractMediaRefs(sectionBody)) {
    const m = toReviewMedia(ref, "");
    if (m) out.push(m);
    else if (mediaKind(ref)) escaping.add(ref);
  }
  return out;
}

export function composeSliceReview(inputs: SliceComposeInputs): ComposedSliceReview {
  const { slice, nowIso } = inputs;
  const sliceRef = `${slice.missionId ?? "?"}/slices/${slice.name}`;

  const candidateSha = deriveCandidateSha(inputs.artifacts);
  const gateCells = deriveGateCells(inputs.artifacts, candidateSha);
  const lineage = composeLineage(candidateSha, inputs.git, gateCells);
  const planLock = lockFrom(inputs.approval.spec);
  const deliveredLock = lockFrom(inputs.approval.delivery);

  const escaping = new Set<string>();
  const intentText = extractSection(inputs.readme, "Intent");
  const intentMedia = sectionMedia(intentText, escaping);
  const miniReqs = extractMiniReqs(inputs.prd);
  const planMedia = dedupMedia([
    ...sectionMedia(miniReqs, escaping),
    ...inputs.lockedArtifacts
      .map((a): ReviewMedia | null => (mediaKind(a.path) ? toReviewMedia(a.path, "") : null))
      .filter((m): m is ReviewMedia => m !== null),
  ]);

  const promised = extractProofContract(inputs.prd);
  const delivered = composeDelivered(promised, inputs.artifacts);
  delivered.escapingRefs.forEach((r) => escaping.add(r));

  const claimedPass = proofClaimsPass(inputs.proofMd);
  const anyRecordedVerdict = gateCells.some((c) => c.state !== "missing");
  const evidencePresent = inputs.artifacts.length > 0 || claimedPass;

  const phase = derivePhase({
    prdPresent: inputs.prd !== null,
    proofArtifactPresent: inputs.artifacts.length > 0 || inputs.proofMd !== null,
    activeQitemPresent: inputs.activeQitemPresent,
    verdictOrEvidenceSetPresent: anyRecordedVerdict || claimedPass,
    approved: deliveredLock !== null,
  });

  // Regime 2: evidence present, NO recorded passing state -> confirm-faithful.
  const recordedGreen = computeRecordedGreen(gateCells, inputs.artifacts, candidateSha);
  const confirmFaithful: NeedsYouItem[] = [];
  if (!recordedGreen.green && evidencePresent && claimedPass) {
    confirmFaithful.push({
      source: "agent",
      identity: `${slice.name}|confirm-faithful|${candidateSha ?? "no-sha"}`,
      summary: "confirm this proof is faithful",
      leg: "confirm-faithful",
      where: sliceRef,
      ageIso: null,
      priority: "high",
      tier: null,
      evidenceRef: `${sliceRef}/PROOF.md`,
      unblocks: `${slice.name} green (regime 2)`,
      qitemId: null,
      destinationSession: null,
      derived: null,
    });
  }

  const latestArtifactIso = inputs.artifacts.reduce<string | null>(
    (acc, a) => (acc === null || a.droppedAt > acc ? a.droppedAt : acc),
    null,
  );
  const derived = deriveExceptions(
    inputs.agents,
    inputs.attention,
    { promisedCount: promised.length, missingCount: delivered.missingCount },
    sliceRef,
    nowIso,
    latestArtifactIso,
    inputs.approval.delivery?.at ?? null,
  );
  const workflowDerived = deriveWorkflowExceptions(inputs.workflows ?? [], sliceRef, nowIso);
  const needsYou = composeNeedsYou(inputs.attention, [...derived, ...workflowDerived], confirmFaithful, "queue+artifacts", nowIso);
  const agents = composeAgentsBand(inputs.agents, `slice:${slice.name}`, derived, nowIso);

  // FR-5: an out-of-slice media ref = a defect finding, never a silent
  // no-render. Absolute paths AND ../ traversal segments both escape the
  // co-located contract (rev1 fixback at d6135921 — slice-19 containment class).
  const defects = [
    ...inputs.mediaRefs
      .filter((r) => r.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(r))
      .map((r) =>
        r.startsWith("/")
          ? `absolute media path (must be slice-relative): ${r}`
          : `media ref escapes the slice dir (must be co-located): ${r}`,
      ),
    ...[...escaping]
      .sort()
      .map((r) =>
        r.startsWith("/")
          ? `absolute media path (must be slice-relative): ${r}`
          : `media ref escapes the slice dir (must be co-located): ${r}`,
      ),
  ];

  return {
    slice: slice.name,
    sliceId: slice.id,
    title: slice.title,
    missionId: slice.missionId,
    phase,
    laneLabel: PHASE_LANE_LABELS[phase],
    intent: {
      text: intentText,
      media: intentMedia,
      ssotPath: inputs.readme !== null ? `${sliceRef}/README.md` : null,
      degrade: intentText === null ? "no intent recorded" : null,
    },
    plan: {
      concise: { text: miniReqs, media: planMedia },
      lockedArtifacts: inputs.lockedArtifacts,
      lock: planLock,
      ssotPath: inputs.prd !== null ? `${sliceRef}/IMPLEMENTATION-PRD.md` : null,
    },
    delivered: {
      items: delivered.items,
      extraProof: delivered.extraProof,
      lock: deliveredLock,
      proofDirPath: inputs.proofDirExists ? `${sliceRef}/proof` : null,
    },
    needsYou,
    agents,
    lineage,
    defects,
    composedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// FR-7 — mission composition (board + ledger + union bands — KEEP; the
// ledger's green is the recorded-verdict completion fact at mission altitude)
// ---------------------------------------------------------------------------

export interface MissionSliceEntry {
  review: ComposedSliceReview;
  /** Recorded-verdict green for the completion ledger (computeRecordedGreen
   *  over the slice's artifacts — supplied by the gatherer, which holds them). */
  green: boolean;
}

export interface MissionComposeInputs {
  mission: { name: string; id: string | null; title: string; intent?: string | null };
  slices: MissionSliceEntry[];
  missionAttention: AttentionInput[];
  agents: AgentInput[];
  nowIso: string;
}

export function composeMissionReview(inputs: MissionComposeInputs): ComposedMissionReview {
  const { nowIso } = inputs;

  const board: BoardSlot[] = inputs.slices.map(({ review: s, green }) => {
    let stageCell: string;
    switch (s.phase) {
      case "spec":
        stageCell = s.plan.lock ? `spec-approved ${s.plan.lock.at}` : "spec unstamped";
        break;
      case "building":
        stageCell =
          s.delivered.items.length > 0
            ? `${s.delivered.items.filter((it) => it.verified !== "missing").length}/${s.delivered.items.length} proofs`
            : "building";
        break;
      case "review":
        stageCell = `${green ? "GREEN" : "not green"} · ${s.lineage.mergeSha ?? "UNMERGED"}`;
        break;
      case "locked":
        stageCell = `stamped ${s.delivered.lock?.at ?? "?"}`;
        break;
      default:
        stageCell = "intent";
    }
    const changedSinceStamp = s.needsYou.items.some((i) => i.derived?.kind === "stale-after-change");
    return {
      slice: s.slice,
      title: s.title,
      phase: s.phase,
      laneLabel: s.laneLabel,
      agentsCount: s.agents.rows.length,
      stageCell,
      changedSinceStamp,
      attentionWorthy: s.needsYou.items.length > 0 || changedSinceStamp,
    };
  });

  // The completion ledger — a query over the mission's slice set, never an
  // authored list (omission-proof by construction).
  const ledger: LedgerRow[] = inputs.slices.map(({ review: s, green }) => ({
    slice: s.slice,
    candidateSha: s.lineage.candidateSha,
    gateCells: s.lineage.gateCells,
    mergeSha: s.lineage.mergeSha,
    needsHumanCount: s.needsYou.items.length,
    green,
  }));

  // Cut-complete: TRUE only when EVERY in-cut slice is (a) green, (b) merged,
  // (c) zero open needs-human items — never asserted from a status field.
  const incomplete = ledger.filter((r) => !(r.green && r.mergeSha !== null && r.needsHumanCount === 0));
  const cutComplete = ledger.length > 0 && incomplete.length === 0;

  // Mission NEEDS YOU = the union query (slice ∪ mission ∪ ▲), distinct
  // identities — an item at N altitudes is one item seen from N heights.
  const seen = new Set<string>();
  const unionItems: NeedsYouItem[] = [];
  for (const { review: s } of inputs.slices) {
    for (const i of s.needsYou.items) {
      if (!seen.has(i.identity)) {
        seen.add(i.identity);
        unionItems.push(i);
      }
    }
  }
  const missionBand = composeNeedsYou(inputs.missionAttention, [], [], "mission queue+slice unions", nowIso);
  for (const i of missionBand.items) {
    if (!seen.has(i.identity)) {
      seen.add(i.identity);
      unionItems.push(i);
    }
  }

  const agents = composeAgentsBand(inputs.agents, `mission:${inputs.mission.name}`, [], nowIso);

  const composed: ComposedMissionReview = {
    mission: inputs.mission.name,
    missionId: inputs.mission.id,
    title: inputs.mission.title,
    intent: inputs.mission.intent ?? null,
    briefSpine: { building: "", progress: "", proven: "", needsYou: "" },
    board,
    ledger,
    cutComplete,
    cutCompleteBasis: cutComplete
      ? `all ${ledger.length} in-cut slices green + merged + zero needs-human · computed at ${nowIso}`
      : `${incomplete.length} of ${ledger.length} slices not cut-complete (${incomplete.map((r) => r.slice).join(", ") || "none"}) · computed at ${nowIso}`,
    needsYou: {
      items: unionItems,
      provenance:
        unionItems.length === 0
          ? `0 attention items across ${inputs.slices.length} slices — computed from queue+artifacts at ${nowIso}`
          : `union of ${inputs.slices.length} slice scopes + mission scope · computed at ${nowIso}`,
    },
    agents,
    composedAt: nowIso,
  };
  composed.briefSpine = renderBriefSpine(composed);
  return composed;
}
