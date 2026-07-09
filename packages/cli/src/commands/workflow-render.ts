/**
 * OPR.0.4.6.WF3 FR-2 — the glanceable human renderers for
 * trace/list/show. RENDER-SIDE ONLY (BR-2): these functions format
 * daemon payloads the CLI already receives; `--json` paths never come
 * through here and stay byte-identical to the shipped output.
 *
 * Shapes ported from in-repo precedent: the `rig ps` table mechanics
 * (fitCell/truncate) and the argo-get per-step tree bar (STEP / ACTOR
 * / EXIT / DURATION columns with status glyphs).
 *
 * Present-tolerant fields: WF-2's branch/gate additions
 * (closureEvidence.branch_taken etc.) render when the payload carries
 * them and leave no residue when absent — this module never requires
 * them (WF-3 builds against the pre-WF-2 tip; the fields land with
 * WF-2).
 */

export interface RenderInstance {
  instanceId: string;
  workflowName?: string;
  workflowVersion?: string;
  status: string;
  createdBySession?: string;
  createdAt?: string;
  currentStepId?: string | null;
  currentFrontier?: string[];
  hopCount?: number;
  /** OPR.0.4.6.FAC1: the instance's bound rig (API-carried; null/absent = unbound, renders nothing). */
  boundRig?: string | null;
  /**
   * WF-1 FR-2's API-carried classification (present since the
   * completion fixback at 384e60f1). RAIL 1 (arch ruling): the CLI
   * CONSUMES this verbatim and never recomputes a threshold or class.
   */
  deadline?: {
    state: string;
    evidence?: {
      stepId?: string | null;
      ownerSession?: string;
      overdueBySeconds?: number;
      ageSeconds?: number;
    } | null;
  };
  /** Present on waiting instances that recorded their park decision. */
  lastContinuationDecision?: { blockedOn?: string | null } | null;
}

export interface RenderTrailRow {
  stepId: string;
  stepRole?: string;
  closedAt?: string;
  closureReason: string;
  closureEvidence?: Record<string, unknown> | null;
  actorSession: string;
  nextQitemId?: string | null;
  priorQitemId?: string;
}

const STATUS_GLYPH: Record<string, string> = {
  completed: "✔",
  failed: "✖",
  active: "●",
  waiting: "◐",
};

export function statusGlyph(status: string): string {
  return STATUS_GLYPH[status] ?? "●";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fitCell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

/** Compact human duration between two ISO timestamps ("3s", "4m", "2h", "5d"). */
export function humanDuration(fromIso: string | undefined, toIso: string | undefined): string {
  if (!fromIso || !toIso) return "";
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  // Minutes render up to AND INCLUDING 120 so sub-/at-2h durations keep
  // their precision ("90m"/"120m" beat a rounded-up "2h" for judging
  // step latency). Guard prepass catch: `m < 120` excluded exactly 120.
  if (m <= 120) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Instance age relative to a supplied "now" (injectable for tests). */
export function humanAge(createdAt: string | undefined, nowIso: string): string {
  return humanDuration(createdAt, nowIso);
}

/** Compact render of a plain seconds quantity (same scale rules). */
export function humanSeconds(seconds: number): string {
  return humanDuration("1970-01-01T00:00:00.000Z", new Date(seconds * 1000).toISOString());
}

/**
 * The trace tree (mini-req 2's bar: where it is + how it got there,
 * one screen, no JSON literacy required).
 */
export function renderTraceTree(
  instance: RenderInstance,
  trail: RenderTrailRow[],
  nowIso: string = new Date().toISOString(),
): string[] {
  const lines: string[] = [];
  const name = instance.workflowName ? `${instance.workflowName}${instance.workflowVersion ? ` v${instance.workflowVersion}` : ""}` : "";
  lines.push(`${statusGlyph(instance.status)} ${instance.instanceId}  ${name}  status=${instance.status}${instance.hopCount !== undefined ? `  hops=${instance.hopCount}` : ""}${instance.boundRig ? `  rig=${instance.boundRig}` : ""}`);
  if (instance.createdAt) {
    lines.push(`  created ${instance.createdAt}${instance.createdBySession ? ` by ${instance.createdBySession}` : ""}  age ${humanAge(instance.createdAt, nowIso)}`);
  }
  lines.push("");
  lines.push(`  ${fitCell("STEP", 22)}${fitCell("ACTOR", 28)}${fitCell("EXIT", 10)}DURATION`);
  let prevClosed = instance.createdAt;
  for (let i = 0; i < trail.length; i++) {
    const row = trail[i];
    if (!row) continue;
    const glyph = row.closureReason === "failed" ? "✖" : "✔";
    const bar = i === trail.length - 1 && !instance.currentStepId ? "└─" : "├─";
    const duration = humanDuration(prevClosed, row.closedAt);
    lines.push(`  ${bar} ${glyph} ${fitCell(row.stepId, 20)}${fitCell(row.actorSession, 28)}${fitCell(row.closureReason, 10)}${duration}`);
    const branchTaken = row.closureEvidence?.["branch_taken"];
    if (typeof branchTaken === "string" && branchTaken.length > 0) {
      lines.push(`  │    ↳ branch: ${branchTaken}`);
    }
    prevClosed = row.closedAt ?? prevClosed;
  }
  if (instance.currentStepId) {
    const owner = ""; // frontier owner is a queue-side fact; the frontier packet ids are what the payload carries
    lines.push(`  └─ ▸ ${fitCell(instance.currentStepId, 20)}${fitCell(owner || "(current)", 28)}${fitCell("open", 10)}frontier=[${(instance.currentFrontier ?? []).join(", ")}]`);
  } else if (trail.length === 0) {
    lines.push(`  (no steps closed yet)`);
  }
  return lines;
}

/**
 * OPR.0.4.6.WF3 FR-3 — the attention marker for a list row (the
 * single marker home). Classes: failed · stuck (consumed VERBATIM
 * from the API-carried deadline classification — rail 1: the CLI
 * never recomputes a threshold or class) · waiting. A row shows its
 * highest-priority class; the `status` verb shows ALL classes per
 * instance (exactly-once, combined reasons).
 */
export function attentionMarker(instance: RenderInstance): string {
  if (instance.status === "failed") return "▲ failed";
  if (isStuck(instance)) return "▲ stuck";
  if (instance.status === "waiting") return "▲ waiting";
  return "";
}

/** Rail 1: stuck-ness is READ from the API field, never derived. */
function isStuck(instance: RenderInstance): boolean {
  const state = instance.deadline?.state;
  return typeof state === "string" && state.startsWith("overdue");
}

// ── FR-3 part B: the needs-attention rollup (`rig workflow status`) ──

export interface AttentionRow {
  instanceId: string;
  workflowName: string;
  /** All classes for this instance — exactly-once row, combined. */
  classes: string[];
  reasons: string[];
  /** The actionable affordance (what-to-do-next), per class priority. */
  affordance: string;
}

export interface AttentionRollup {
  counts: { total: number; active: number; waiting: number; completed: number; failed: number };
  attention: AttentionRow[];
}

/**
 * Compose the rollup from list rows. Pure arithmetic over
 * pre-classified rows (the arch ruling's boundary: counting +
 * grouping + rendering is render-side; the ONE correctness-rule
 * composition — the threshold classification — arrives ALREADY DONE
 * in instance.deadline). Per-instance dedup by instanceId (rail 2):
 * an instance with multiple attention reasons renders ONCE with all
 * of them.
 */
export function composeAttentionRollup(instances: RenderInstance[]): AttentionRollup {
  const counts = { total: instances.length, active: 0, waiting: 0, completed: 0, failed: 0 };
  const attention: AttentionRow[] = [];
  for (const inst of instances) {
    if (inst.status === "active") counts.active += 1;
    else if (inst.status === "waiting") counts.waiting += 1;
    else if (inst.status === "completed") counts.completed += 1;
    else if (inst.status === "failed") counts.failed += 1;

    const classes: string[] = [];
    const reasons: string[] = [];
    if (inst.status === "failed") {
      classes.push("failed");
      reasons.push("workflow failed");
    }
    if (isStuck(inst)) {
      classes.push("stuck");
      const ev = inst.deadline?.evidence;
      reasons.push(
        `${inst.deadline?.state}${ev?.stepId ? ` at step ${ev.stepId}` : ""}${ev?.ownerSession ? ` (owner ${ev.ownerSession})` : ""}${typeof ev?.overdueBySeconds === "number" ? `, overdue ${humanSeconds(ev.overdueBySeconds)}` : ""}`,
      );
    }
    if (inst.status === "waiting") {
      classes.push("waiting");
      const blocker = inst.lastContinuationDecision?.blockedOn;
      reasons.push(`waiting${blocker ? ` on ${blocker}` : " (blocker unrecorded)"}`);
    }
    if (classes.length === 0) continue;
    // Affordance by highest-priority class. `route` ships in this same
    // slice (commit 6) — the verbs land together at merge (BR-1 holds
    // at the shipped boundary).
    const affordance = classes.includes("failed")
      ? `inspect: rig workflow trace ${inst.instanceId}`
      : classes.includes("stuck")
        ? `re-route: rig workflow route ${inst.instanceId} --to <seat>`
        : `resolve the blocker, then the owner projects (rig workflow trace ${inst.instanceId})`;
    attention.push({
      instanceId: inst.instanceId,
      workflowName: inst.workflowName ?? "",
      classes,
      reasons,
      affordance,
    });
  }
  return { counts, attention };
}

/** Human render of the rollup — proven-empty, never blank. */
export function renderStatus(rollup: AttentionRollup): string[] {
  const c = rollup.counts;
  const lines: string[] = [];
  lines.push(
    `${c.total} instance${c.total === 1 ? "" : "s"}: ${c.active} active · ${c.waiting} waiting · ${c.completed} completed · ${c.failed} failed`,
  );
  if (rollup.attention.length === 0) {
    lines.push("No instances need attention (proven empty — every in-flight instance reads healthy).");
    return lines;
  }
  lines.push("");
  lines.push(`${fitCell("", 2)}${fitCell("INSTANCE", 30)}${fitCell("WORKFLOW", 20)}${fitCell("CLASS", 16)}REASON`);
  for (const row of rollup.attention) {
    lines.push(
      `${fitCell("▲", 2)}${fitCell(row.instanceId, 30)}${fitCell(row.workflowName, 20)}${fitCell(row.classes.join("+"), 16)}${row.reasons.join("; ")}`,
    );
    lines.push(`  ${fitCell("", 2)}└ ${row.affordance}`);
  }
  return lines;
}

/** The list table: INSTANCE · WORKFLOW · STATUS · STEP · AGE · ATTN. */
export function renderInstanceList(
  instances: RenderInstance[],
  nowIso: string = new Date().toISOString(),
): string[] {
  if (instances.length === 0) return ["No workflow instances."];
  const lines: string[] = [];
  lines.push(`${fitCell("", 2)}${fitCell("INSTANCE", 30)}${fitCell("WORKFLOW", 22)}${fitCell("STATUS", 11)}${fitCell("STEP", 20)}${fitCell("AGE", 6)}ATTN`);
  for (const inst of instances) {
    lines.push(
      `${fitCell(statusGlyph(inst.status), 2)}${fitCell(inst.instanceId, 30)}${fitCell(inst.workflowName ?? "", 22)}${fitCell(inst.status, 11)}${fitCell(inst.currentStepId ?? "-", 20)}${fitCell(humanAge(inst.createdAt, nowIso), 6)}${attentionMarker(inst)}`,
    );
  }
  return lines;
}

/** The show summary, headed by the status line. */
export function renderInstanceShow(
  instance: RenderInstance,
  nowIso: string = new Date().toISOString(),
): string[] {
  const lines: string[] = [];
  lines.push(`${statusGlyph(instance.status)} ${instance.instanceId}  status=${instance.status}`);
  if (instance.workflowName) lines.push(`  workflow: ${instance.workflowName}${instance.workflowVersion ? ` v${instance.workflowVersion}` : ""}`);
  // OPR.0.4.6.FAC1: the bound rig renders when present (unbound rows unchanged).
  if (instance.boundRig) lines.push(`  rig:      ${instance.boundRig}`);
  if (instance.createdAt) lines.push(`  created:  ${instance.createdAt}${instance.createdBySession ? ` by ${instance.createdBySession}` : ""}  (age ${humanAge(instance.createdAt, nowIso)})`);
  if (instance.currentStepId) lines.push(`  at step:  ${instance.currentStepId}  frontier=[${(instance.currentFrontier ?? []).join(", ")}]`);
  if (instance.hopCount !== undefined) lines.push(`  hops:     ${instance.hopCount}`);
  lines.push(`  next:     rig workflow trace ${instance.instanceId}`);
  return lines;
}
