import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { sessionRigOf } from "../session-name.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, resolveRemoteBearer, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import type { AggregatedPayload, PerHostStatus } from "../lib/hosts/fanout-contract.js";

interface PsEntry {
  rigId: string;
  name: string;
  /** L3-followup: alias of `name`. Always populated and equal to `name`. */
  rigName?: string;
  nodeCount: number;
  runningCount: number;
  /** Slice 15 — subset of nodes producing tmux output within the silence
   *  window. Sourced from the daemon's SeatActivityService; NEVER derived
   *  from queue/assignment state. */
  activeCount?: number;
  /** Slice 15 — subset of nodes with at least one pending qitem assigned
   *  to their canonical session name. Sourced from queue_items; NEVER
   *  derived from tmux output. */
  hasWorkCount?: number;
  status: "running" | "partial" | "stopped";
  /** OPR.0.4.4.21 — additive: seats needing attention (lifecycle/startup
   *  attention, needs_input, held, startup error) folded daemon-side. */
  attentionCount?: number;
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
  uptime: string | null;
  latestSnapshot: string | null;
  /** OPR.0.3.3.19 - ISO timestamp when archived, or null if active. Present
   *  only when the daemon supports archive; optional for back-compat. */
  archivedAt?: string | null;
  /** OPR.0.3.3.19 - convenience flag; true iff the rig is archived. */
  isArchived?: boolean;
}

interface NodeEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  restoreOutcome: string;
  // OPR.0.4.3.06 — challenge-verified orientation, distinct from startupStatus.
  oriented?: string;
  lifecycleState?: "running" | "detached" | "recoverable" | "attention_required";
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  latestError: string | null;
  /** Slice 15 — `terminal-active` primitive. true=producing output,
   *  false=silent past threshold, null=no signal. NEVER derived from
   *  hasAssignedWork (non-inference contract). */
  terminalActive?: boolean | null;
  /** Slice 15 — `has-work-to-do` primitive. Derived from queue_items;
   *  NEVER derived from terminalActive. */
  hasAssignedWork?: boolean;
  /** Slice 15 — pending qitem count for this seat (cheap aggregate). */
  pendingWorkCount?: number;
  /** OPR.0.3.4.11 — held reason from node.held event. */
  heldReason?: string | null;
  agentActivity?: {
    state: "running" | "needs_input" | "idle" | "unknown";
    reason: string;
    evidenceSource: string;
    sampledAt: string;
    evidence: string | null;
  };
  // PL-012: context-usage block surfaced from the daemon's
  // /api/rigs/:id/nodes route (already populated). Optional because
  // older daemons may not emit it.
  contextUsage?: {
    availability: "known" | "unknown";
    usedPercentage: number | null;
    fresh: boolean;
    state?: "critical" | "warning" | "low" | "unknown";
    sampledAt: string | null;
  };
  /** OPR.0.4.0.34 — resume summary from the daemon node-inventory. resumeToken
   *  is the SECRET: surfaced as a present-boolean in compact, value only in --full. */
  resumeType?: string | null;
  resumeToken?: string | null;
  /** OPR.0.4.0.34 — startup-completion timestamp; the compact `lastActivity`
   *  fallback when no agentActivity sample exists. */
  startupCompletedAt?: string | null;
  [key: string]: unknown;
}

// L3-followup: human-output budgets bound default terminal output for hosts
// with realistic agent counts. `--full` opts out. JSON output remains
// unbounded by default for back-compat (Decision C hybrid).
function extractRigName(sessionName: string): string | undefined {
  // OPR.0.4.6.MH1 FR-8: the shared parse contract (greedy first-@ rig).
  return sessionRigOf(sessionName);
}

const HUMAN_RIG_BUDGET = 50;
const HUMAN_NODE_BUDGET = 100;

// L3-followup: --filter accepts only this allow-list. Unknown keys produce a
// clear error with the supported list (Guard Review Checklist: filter-parser
// security).
//
// PL-019 item 1: extends the allow-list with the nested key `agentActivity.state`.
// This is the only nested filter key v0 supports; the parser checks for the
// dotted form explicitly. Bare `agentActivity` is intentionally NOT a filter
// key — it's an object, not a scalar; project it via --fields if you need it.
const ALLOWED_FILTER_KEYS = new Set([
  "status",
  "lifecycleState",
  "name-prefix",
  "name",
  "agentActivity.state",
  // PL-012: context-usage filters. percent is numeric (>=, >, <=, <, =);
  // state is enum (critical / warning / low / unknown — lockstep with
  // computeContextHealthSummary tier vocabulary).
  "contextUsage.percent",
  "contextUsage.state",
]);

// PL-019 item 1: when filter key is `agentActivity.state`, the value is
// validated against the AgentActivityState enum. Invalid values produce a
// three-part error (what failed / what's allowed / what to do).
const ALLOWED_AGENT_ACTIVITY_STATES = new Set(["running", "needs_input", "idle", "unknown"]);

// PL-012: ALLOWED_CONTEXT_USAGE_STATES — must stay lockstep with the
// daemon's computeContextHealthSummary urgency vocab.
const ALLOWED_CONTEXT_USAGE_STATES = new Set(["critical", "warning", "low", "unknown"]);

const NUMERIC_FILTER_KEYS = new Set(["contextUsage.percent"]);
type NumericComparator = ">=" | ">" | "<=" | "<" | "=";
const NUMERIC_OPERATORS: NumericComparator[] = [">=", "<=", ">", "<", "="];

// C9a: --fields accepts a per-level allow-list. Unknown keys produce a clear
// error with the supported list, mirroring the --filter rejection pattern.
// Per-level because rig and node entries have different schemas (PsEntry
// rig-level vs NodeEntry node-level).
//
// Source of truth: PsEntry / NodeEntry interfaces above. `name` exists at
// rig-level only; `rigName` is the alias and exists at both levels (per the
// closed `rig ps trust and scale-safety` slice at openrig 0a9fb43).
const ALLOWED_RIG_FIELDS = new Set([
  "attentionCount",
  "rigId",
  "name",
  "rigName",
  "nodeCount",
  "runningCount",
  "activeCount",
  "hasWorkCount",
  "status",
  "lifecycleState",
  "uptime",
  "latestSnapshot",
]);
const ALLOWED_NODE_FIELDS = new Set([
  "rigId",
  "rigName",
  "logicalId",
  "podId",
  "podNamespace",
  "canonicalSessionName",
  "nodeKind",
  "runtime",
  "sessionStatus",
  "startupStatus",
  "restoreOutcome",
  "oriented",
  "lifecycleState",
  "tmuxAttachCommand",
  "resumeCommand",
  "latestError",
  "terminalActive",
  "hasAssignedWork",
  "pendingWorkCount",
  "agentActivity",
  "contextUsage",
  "heldReason",
]);

interface PsCliOptions {
  json?: boolean;
  nodes?: boolean;
  full?: boolean;
  verbose?: boolean;
  limit?: string;
  fields?: string;
  summary?: boolean;
  filter?: string;
  host?: string;
  allHosts?: boolean;
  hosts?: string;
  active?: boolean;
  running?: boolean;
  allRigs?: boolean;
  rig?: string;
  session?: string;
  /** OPR.0.3.3.19 - include archived rigs (default excludes them). Parity
   *  with `rig stream list --include-archived`. */
  includeArchived?: boolean;
}

export interface PsDeps extends StatusDeps {
  /**
   * Cross-host hooks. Both default to the production loaders/executors; tests
   * inject in-package mocks so no real ssh / no real ~/.ssh / no real network
   * is touched. Mirrors the SendDeps/CaptureDeps shape from the closed
   * cross-host-rig-commands slice (cdce3a6).
   */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

interface ParsedFilter {
  key: string;
  value: string;
  /** PL-012: numeric comparator for keys in NUMERIC_FILTER_KEYS;
   *  defaults to "=" (equality) for all other keys. */
  op: NumericComparator;
  /** PL-012: parsed numeric value when op is a numeric comparator. */
  numericValue?: number;
}

function parseFilter(filter: string): ParsedFilter | { error: string } {
  // PL-012: pre-detect numeric comparators (>=, <=, >, <, =) so callers
  // can write `contextUsage.percent>=80`. Order matters: check >= and
  // <= before > and < so the longer prefix wins.
  let op: NumericComparator = "=";
  let opIdx = -1;
  for (const candidate of NUMERIC_OPERATORS) {
    const i = filter.indexOf(candidate);
    if (i !== -1) {
      // Prefer the leftmost match; on tie, prefer the longest comparator.
      if (opIdx === -1 || i < opIdx || (i === opIdx && candidate.length > op.length)) {
        opIdx = i;
        op = candidate;
      }
    }
  }
  if (opIdx === -1) {
    return { error: `--filter must be key<op>value (op = ${NUMERIC_OPERATORS.join(", ")}); got: '${filter}'` };
  }
  const key = filter.slice(0, opIdx);
  const value = filter.slice(opIdx + op.length);
  if (!ALLOWED_FILTER_KEYS.has(key)) {
    return {
      error: `Unknown --filter key '${key}'. Supported: ${[...ALLOWED_FILTER_KEYS].sort().join(", ")}`,
    };
  }
  if (!value) {
    return { error: `--filter value is empty for key '${key}'` };
  }

  // PL-012: numeric-keyed filters validate the value parses as a finite
  // number. Three-part error per the existing convention.
  if (NUMERIC_FILTER_KEYS.has(key)) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return {
        error: `--filter ${key}${op}'${value}' is not a numeric value. ` +
          `Allowed: a finite number (e.g., ${key}>=80). ` +
          `Use 'rig ps --nodes --fields contextUsage --json' to see what daemon is reporting.`,
      };
    }
    return { key, value, op, numericValue };
  }

  // PL-012: contextUsage.state enum guard — same shape as agentActivity.state.
  if (key === "contextUsage.state" && !ALLOWED_CONTEXT_USAGE_STATES.has(value)) {
    return {
      error: `--filter contextUsage.state='${value}' is not a valid context state. ` +
        `Allowed: ${[...ALLOWED_CONTEXT_USAGE_STATES].sort().join(", ")}. ` +
        `Use 'rig ps --nodes --fields contextUsage --json' to see what daemon is reporting.`,
    };
  }

  // PL-019 item 1: agentActivity.state is enum-valued; reject invalid values
  // up-front so operators don't get a silent empty result on a typo. Three-part
  // shape per `feedback_smart_agents_no_bureaucracy.md`: what failed / what's
  // allowed / what to do.
  if (key === "agentActivity.state" && !ALLOWED_AGENT_ACTIVITY_STATES.has(value)) {
    return {
      error: `--filter agentActivity.state='${value}' is not a valid activity state. ` +
        `Allowed: ${[...ALLOWED_AGENT_ACTIVITY_STATES].sort().join(", ")}. ` +
        `Use 'rig ps --nodes --fields agentActivity --json' to see what daemon is reporting.`,
    };
  }

  // Non-numeric keys must use op = "=".
  if (op !== "=") {
    return {
      error: `--filter ${key}${op}... uses a numeric comparator on a non-numeric key. ` +
        `Allowed numeric keys: ${[...NUMERIC_FILTER_KEYS].sort().join(", ")}. ` +
        `Use ${key}=<value> for equality.`,
    };
  }
  return { key, value, op };
}

// PL-012: derive a context-usage tier from a numeric percent. Lockstep
// with daemon-side computeContextHealthSummary thresholds.
function deriveContextUsageState(percent: number | null | undefined): "critical" | "warning" | "low" | "unknown" {
  if (typeof percent !== "number") return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "low";
}

// C9a: validate --fields against a per-level allow-list. Mirrors parseFilter's
// shape: rejects with a sorted-supported-list error message including the
// unknown key(s) quoted. The level-aware "Hint" fires when an operator types
// `--fields name` against a node query (the most likely confusion case
// preserved by the rigName/name aliasing at rig-level only).
function parseFields(input: string, allowed: Set<string>, level: "rig" | "nodes"): string[] | { error: string } {
  const fields = input.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
  if (fields.length === 0) {
    return { error: `--fields cannot be empty` };
  }
  const unknown = fields.filter((f) => !allowed.has(f));
  if (unknown.length > 0) {
    const sorted = [...allowed].sort().join(", ");
    const hint = level === "nodes" && unknown.includes("name")
      ? ` Hint: 'name' is a rig-level field; use 'rigName' for node entries.`
      : "";
    const keyWord = unknown.length > 1 ? "keys" : "key";
    return {
      error: `Unknown --fields ${keyWord} ${unknown.map((u) => `'${u}'`).join(", ")}. Supported: ${sorted}.${hint}`,
    };
  }
  return fields;
}

interface ParsedPsControls {
  parsedFilter: ParsedFilter | null;
  limit: number | null;
  fields: string[] | null;
  useEnvelope: boolean;
}

function parsePsControls(opts: PsCliOptions): ParsedPsControls | { error: string } {
  let effectiveFilter = opts.filter;
  if (opts.active) {
    if (effectiveFilter) {
      return {
        error:
          `--active and --filter cannot be combined. ` +
          `--active is sugar for --filter agentActivity.state=running. ` +
          `Pick one form, or compose by upgrading to --filter directly.`,
      };
    }
    effectiveFilter = "agentActivity.state=running";
  }

  let parsedFilter: ParsedFilter | null = null;
  if (effectiveFilter) {
    const result = parseFilter(effectiveFilter);
    if ("error" in result) return result;
    parsedFilter = result;
  }

  const limit = opts.limit !== undefined ? Number(opts.limit) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    return { error: `--limit must be a non-negative integer; got '${opts.limit}'` };
  }

  let fields: string[] | null = null;
  if (opts.fields !== undefined) {
    const fieldsLevel: "rig" | "nodes" = opts.nodes ? "nodes" : "rig";
    const fieldsAllowed = fieldsLevel === "nodes" ? ALLOWED_NODE_FIELDS : ALLOWED_RIG_FIELDS;
    const fieldsResult = parseFields(opts.fields, fieldsAllowed, fieldsLevel);
    if ("error" in fieldsResult) return fieldsResult;
    fields = fieldsResult;
  }

  return {
    parsedFilter,
    limit,
    fields,
    useEnvelope: parsedFilter !== null || limit !== null || fields !== null || opts.summary === true,
  };
}

function applyRigFilter(entries: PsEntry[], filter: ParsedFilter): PsEntry[] {
  return entries.filter((e) => {
    if (filter.key === "status") return e.status === filter.value;
    if (filter.key === "lifecycleState") return e.lifecycleState === filter.value;
    if (filter.key === "name-prefix") return (e.rigName ?? e.name).startsWith(filter.value);
    if (filter.key === "name") return (e.rigName ?? e.name) === filter.value;
    // PL-019 item 1: agentActivity.state is node-level only; at the rig
    // level it has no meaning, so the filter passes everything through and
    // the user gets all rigs (the operator can `--nodes` to scope it).
    if (filter.key === "agentActivity.state") return true;
    // PL-012: contextUsage.* filters are node-level only.
    if (filter.key === "contextUsage.percent" || filter.key === "contextUsage.state") return true;
    return true;
  });
}

function applyNodeFilter(entries: NodeEntry[], filter: ParsedFilter): NodeEntry[] {
  return entries.filter((n) => {
    // status maps to sessionStatus for nodes; lifecycleState applies directly.
    if (filter.key === "status") return n.sessionStatus === filter.value;
    if (filter.key === "lifecycleState") return n.lifecycleState === filter.value;
    if (filter.key === "name-prefix") return n.rigName.startsWith(filter.value);
    if (filter.key === "name") return n.rigName === filter.value;
    // PL-019 item 1: nested-key traversal for agentActivity.state. Nodes
    // without an agentActivity attachment never match a non-unknown filter
    // value (the daemon reports `unknown` when it has no signal — explicit).
    if (filter.key === "agentActivity.state") return n.agentActivity?.state === filter.value;
    // PL-012: contextUsage.percent — numeric comparison. Nodes with no
    // sample fail every comparator (operator can filter on
    // contextUsage.state=unknown to find them).
    if (filter.key === "contextUsage.percent") {
      const pct = n.contextUsage?.usedPercentage;
      if (typeof pct !== "number" || filter.numericValue === undefined) return false;
      switch (filter.op) {
        case ">=": return pct >= filter.numericValue;
        case ">":  return pct >  filter.numericValue;
        case "<=": return pct <= filter.numericValue;
        case "<":  return pct <  filter.numericValue;
        case "=":  return pct === filter.numericValue;
      }
    }
    if (filter.key === "contextUsage.state") {
      const derived = n.contextUsage?.state ?? deriveContextUsageState(n.contextUsage?.usedPercentage ?? null);
      return derived === filter.value;
    }
    return true;
  });
}

// OPR.0.3.3.19 - build the /api/ps path, opting archived rigs back in when
// --include-archived is set. Default (no flag) leaves the daemon's
// archived-excluding default in force.
function fanOutNodesError(): string {
  return [
    "rig ps --all-hosts/--hosts --nodes: per-node fan-out requires the FULL explicit ladder.",
    "  rig ps --all-hosts --nodes -A             (fleet nodes per host, projected rows)",
    "  rig ps --all-hosts --nodes -A --full      (complete per-node records — the last rung)",
    "One rig's seats on one host: rig ps --host <id> --nodes --rig <name>.",
  ].join("\n");
}

/**
 * OPR.0.4.4.21 FR-2/FR-3 — THE centralized disclosure-ladder validator.
 * Runs BEFORE the local/HTTP-host/SSH/fan-out dispatch split so every path
 * obeys one grammar (qa1 plan-review: remote mode bypassed the session-rig
 * injection and fanned wide). Principle (arch-ratified): IMPLICIT SCOPE
 * DEFAULTS DON'T CROSS HOST BOUNDARIES — the session-rig default has no
 * stable referent on a remote host (a same-named rig there would silently
 * misresolve), so remote per-node views are explicit-or-error.
 * Returns the teaching error text, or null when the invocation is valid.
 */
export function validatePsLadder(opts: PsCliOptions, callerRig: string | undefined): string | null {
  const isFanOut = !!(opts.allHosts || opts.hosts);
  const isSingleRemote = !!opts.host;

  // FR-3: -A/--all-rigs has exactly ONE meaning — the --nodes fleet widener.
  if (opts.allRigs && !opts.nodes) {
    return [
      "rig ps -A: '-A/--all-rigs' now has exactly one meaning — the --nodes fleet widener.",
      "The consolidated all-rigs view IS the default: just run 'rig ps'.",
      "Fleet nodes: rig ps --nodes -A (add --full for complete per-node records).",
      "Archived history: rig ps --include-archived.",
    ].join("\n");
  }

  // FR-5: multi-host fan-out is rollup-only UNLESS the full explicit
  // ladder is requested — `--nodes -A` per host (`--full` for complete
  // records), exactly as the PRD writes it. Anything less explicit under
  // --nodes errors; never silent rig-tier data under a --nodes flag.
  if (opts.nodes && isFanOut && !opts.allRigs) {
    return fanOutNodesError();
  }

  // FR-2: --nodes always names its scope — session default locally,
  // explicit --rig / -A everywhere else. Never an implicit fan-out.
  if (opts.nodes && !opts.rig && !opts.allRigs) {
    if (isFanOut) {
      return fanOutNodesError();
    }
    if (isSingleRemote) {
      return [
        `rig ps --host ${opts.host} --nodes: no target — the local session's rig is not a remote scope`,
        "(implicit scope defaults don't cross host boundaries; a same-named remote rig would silently misresolve).",
        `Name one: rig ps --host ${opts.host} --nodes --rig <name>, or that host's fleet explicitly: rig ps --host ${opts.host} --nodes -A.`,
      ].join("\n");
    }
    if (!callerRig) {
      return [
        "rig ps --nodes: no target — outside a managed session there is no current rig to default to.",
        "Name one: rig ps --nodes --rig <name>, or go fleet-wide explicitly: rig ps --nodes -A.",
      ].join("\n");
    }
  }

  return null;
}

function psApiPath(opts: PsCliOptions): string {
  return opts.includeArchived ? "/api/ps?includeArchived=true" : "/api/ps";
}

function selectFields<T extends Record<string, unknown>>(entries: T[], fields: string[]): Array<Record<string, unknown>> {
  return entries.map((e) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = e[f];
    return out;
  });
}

function selectFanOutFields(entries: Array<Record<string, unknown>>, fields: string[]): Array<Record<string, unknown>> {
  return entries.map((e) => {
    const [selected] = selectFields([e], fields);
    return { ...selected, hostId: e.hostId };
  });
}

function needsAttention(node: NodeEntry): boolean {
  return node.lifecycleState === "attention_required"
    || node.startupStatus === "attention_required"
    || node.startupStatus === "failed"
    || node.agentActivity?.state === "needs_input";
}

// OPR.0.4.0.34 — the compact orch field set (PRD FR-4). Carries the
// source-available identity + state + resume-summary fields an orchestrator
// needs at a glance, WITHOUT leaking the resume token value or resumeCommand
// (security). recoveryGuidance/currentUsage stay on the node detail (slice 26).
function compactNodeProjection(nodes: NodeEntry[]): Array<Record<string, unknown>> {
  return nodes.map((n) => {
    const attention = needsAttention(n);
    const compact: Record<string, unknown> = {
      // identity (rigId/rigName + logicalId + session) — disambiguates under -A.
      rigId: n.rigId,
      rigName: n.rigName,
      logicalId: n.logicalId,
      canonicalSessionName: n.canonicalSessionName,
      // lifecycle + session/startup state.
      sessionStatus: n.sessionStatus,
      startupStatus: n.startupStatus,
      // OPR.0.4.3.06 — challenge-verified orientation, distinct from ready.
      oriented: n.oriented ?? "n-a",
      lifecycleState: n.lifecycleState,
      // activity (state always; short reason only when attention — keep it lean).
      agentActivity: attention
        ? { state: n.agentActivity?.state ?? "unknown", reason: n.agentActivity?.reason }
        : { state: n.agentActivity?.state ?? "unknown" },
      // work counts.
      hasAssignedWork: n.hasAssignedWork,
      pendingWorkCount: n.pendingWorkCount,
      // resume summary — type + PRESENT boolean only (never the token value).
      resumeType: n.resumeType ?? null,
      resumeTokenPresent: Boolean(n.resumeToken),
      // updated/age proxy. The node-list emits no dedicated `updatedAt`; the
      // freshest signal is agentActivity.sampledAt, then startupCompletedAt,
      // else null (documented FR-4 fallback — not a fabricated timestamp).
      lastActivity: n.agentActivity?.sampledAt ?? n.startupCompletedAt ?? null,
    };
    // held/attention reason (short) when present.
    if (n.heldReason) compact.heldReason = n.heldReason;
    if (attention && n.latestError) {
      compact.latestError = n.latestError;
    }
    return compact;
  });
}

function summarizeRigs(entries: PsEntry[]): {
  totalRigs: number;
  totalRunning: number;
  byLifecycle: Record<string, number>;
  byStatus: Record<string, number>;
} {
  const byLifecycle: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let totalRunning = 0;
  for (const e of entries) {
    const ls = e.lifecycleState ?? "unknown";
    byLifecycle[ls] = (byLifecycle[ls] ?? 0) + 1;
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    if (e.status === "running") totalRunning++;
  }
  return { totalRigs: entries.length, totalRunning, byLifecycle, byStatus };
}

function summarizeNodes(entries: NodeEntry[]): {
  totalNodes: number;
  byLifecycle: Record<string, number>;
  bySessionStatus: Record<string, number>;
} {
  const byLifecycle: Record<string, number> = {};
  const bySessionStatus: Record<string, number> = {};
  for (const n of entries) {
    const ls = n.lifecycleState ?? "unknown";
    byLifecycle[ls] = (byLifecycle[ls] ?? 0) + 1;
    const ss = n.sessionStatus ?? "unknown";
    bySessionStatus[ss] = (bySessionStatus[ss] ?? 0) + 1;
  }
  return { totalNodes: entries.length, byLifecycle, bySessionStatus };
}

// Compact rig-level lifecycle codes for the rig table header (3-char fixed width).
function abbrevRigLifecycle(state: PsEntry["lifecycleState"] | undefined): string {
  if (!state) return "—";
  if (state === "running") return "run";
  if (state === "recoverable") return "rec";
  if (state === "stopped") return "stp";
  if (state === "degraded") return "deg";
  if (state === "attention_required") return "att";
  return "—";
}

// Compact per-node lifecycle codes for the nodes table.
function abbrevNodeLifecycle(state: NodeEntry["lifecycleState"] | undefined): string {
  if (!state) return "—";
  if (state === "running") return "run";
  if (state === "recoverable") return "rec";
  if (state === "detached") return "det";
  if (state === "attention_required") return "att";
  return "—";
}

/**
 * `rig ps` — the consolidated fleet map + explicit disclosure ladder.
 *
 * OPR.0.4.4.21: the default is ALL active rigs, one compact O(rigs) row each
 * (the current-rig-only default is retired). The token-safety invariant: no
 * invocation returns per-node detail across all rigs unless explicitly
 * flagged (--nodes -A), and even then rows are projected unless --full.
 * Default `rig ps --json` keeps the bare-array shape for back-compat; the
 * truncation/envelope shape only applies when at least one of
 * `--limit`/`--summary`/`--fields`/`--filter` is specified.
 */
export function psCommand(depsOverride?: PsDeps): Command {
  const cmd = new Command("ps")
    .description("List rigs and their status")
    .addHelpText("after", `
Default (OPR.0.4.4.21): ALL active rigs, ONE compact row each — O(rigs), never
a fleet node fan-out — plus the host rollup line ("N rigs · M seats · K need
attention"), the archived/stopped count line, and the drill-ladder footer.
STATED contract: default --json is a bare array of ALL non-archived rigs
INCLUDING stopped ones (existing keys preserved; additive attentionCount);
only the HUMAN table folds stopped rigs into the count line.

The disclosure ladder (each heavier view is an explicit step):
  rig ps                      the consolidated map (this default)
  rig ps --rig <name>         one rig's detail
  rig ps --nodes              per-node, CURRENT rig (session default, local only)
  rig ps --nodes --rig <name> per-node, named rig
  rig ps --nodes -A           fleet nodes, projected rows
  rig ps --nodes -A --full    complete per-node records (the only full fan-out)

-A/--all-rigs has exactly ONE meaning: the --nodes fleet widener. Bare -A
errors (all-rigs IS the default; archived history stays behind
--include-archived). The session-rig default never crosses host boundaries:
remote --nodes requires an explicit --rig or -A.

Compact defaults: 'rig ps --nodes' shows a compact summary per node
(rig, session, lifecycle, activity state, reason when attention, queue counts,
resume type + present indicator). Resume token values and resumeCommand are
excluded from compact output (security); use --full to see them.

Use '--full' (or '--verbose') for the uncompacted per-node payload (contextUsage
scalars, resume commands/tokens, agent references). Note (OPR.0.4.0.26): the
node-list payload carries recoveryGuidance: null and contextUsage.currentUsage:
null even with --full; fetch the full recovery guidance + currentUsage from the
single-node detail (/api/rigs/:rigId/nodes/:logicalId) or 'rig whoami'.

Examples:
  rig ps                                          All active rigs, one row each + rollup
  rig ps --rig <name>                             One rig's detail
  rig ps --full                                   All rigs, no table truncation
  rig ps --json                                   All non-archived rigs, bare JSON array
  rig ps --json --limit 20                        Bounded JSON envelope
  rig ps --json --summary                         Aggregate-only JSON
  rig ps --json --fields rigName,status,lifecycleState
                                                  Project JSON to named fields
  rig ps --filter lifecycleState=attention_required
                                                  Show only rigs needing attention
  rig ps --filter status=running                  Show only running rigs
  rig ps --filter name-prefix=demo                Filter by rig-name prefix
  rig ps --nodes                                  Current rig per-node compact summary
  rig ps --nodes -A                               All rigs per-node compact summary
  rig ps --nodes --json                           Current rig per-node compact JSON
  rig ps --nodes --json --full                    Complete per-node LIST payload (guidance/currentUsage relocated to node detail)
  rig ps --nodes --json --rig openrig-build       Compact nodes for a specific rig
  rig ps --nodes --json --session dev1-impl@myrig Filter to a single session (within current rig; use -A for cross-rig)
  rig ps --nodes --json --limit 50                Bounded per-node JSON envelope
  rig ps --nodes --active                         Only nodes with agentActivity.state=running
  rig ps --nodes --running                        Same as --active
  rig ps --nodes --filter agentActivity.state=running
                                                  Same as --active (the explicit form)
  rig ps --host vm-1 --nodes --rig <name> --json  Remote host per-node (explicit target required)
  rig ps --all-hosts                              Per-host O(rigs) rollups (AggregatedPayload JSON)
  rig ps --include-archived                       Include archived rigs (marked with *); hidden by default

--rig <name> scopes to one rig. -A/--all-rigs is ONLY the --nodes fleet widener.
--session <name> filters within the effective rig scope; use --nodes -A if the
target session is in a different rig.
Multi-host fan-out (--all-hosts/--hosts) is rollup-only by default; the full
explicit ladder (--all-hosts --nodes -A, --full for complete records) fans out
per-node with hostId-stamped projected rows.

--active/--running narrow to agentActivity.state=running. Cannot combine with --filter.

--filter accepts: status, lifecycleState, name-prefix, name, agentActivity.state,
contextUsage.percent, contextUsage.state. Other keys are rejected.

--fields accepts (rig-level): rigId, name, rigName, nodeCount, runningCount,
activeCount, hasWorkCount, attentionCount, status, lifecycleState, uptime,
latestSnapshot.
--fields accepts (node-level, with --nodes): rigId, rigName, logicalId, podId,
podNamespace, canonicalSessionName, nodeKind, runtime, sessionStatus,
startupStatus, restoreOutcome, lifecycleState, tmuxAttachCommand,
resumeCommand, latestError, terminalActive, hasAssignedWork,
pendingWorkCount, agentActivity, contextUsage, heldReason.

--host runs on a remote host declared in ~/.openrig/hosts.yaml (no current-rig
default applied; the remote host's rigs are shown).

Exit codes:
  0  Success
  1  Daemon not running, or invalid --filter / --limit / --fields
  2  Failed to fetch data from daemon`);
  const getDepsF = (): PsDeps => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output for agents")
    .option("--nodes", "Show per-node detail (current rig; -A for all rigs)")
    .option("--full", "Show all node-list fields per node (uncompacted rows; node-list recoveryGuidance/currentUsage live on the node detail, not the list)")
    .option("--verbose", "Alias for --full")
    .option("--limit <n>", "Limit number of entries (rigs or nodes)")
    .option("--fields <list>", "Comma-separated field list to project (JSON only)")
    .option("--summary", "Emit aggregate-only output (counts by status/lifecycle)")
    .option("--filter <key=value>", "Filter entries; supported keys: status, lifecycleState, name-prefix, name, agentActivity.state")
    .option("--active", "Shortcut for --filter agentActivity.state=running (PL-019)")
    .option("--running", "Alias for --active")
    .option("-A, --all-rigs", "Show all rigs (default is current rig only)")
    .option("--rig <name>", "Show only nodes belonging to the named rig")
    .option("--session <name>", "Show only the node matching this canonical session name")
    .option("--include-archived", "Include archived rigs (default hides them); parity with 'rig stream list --include-archived'")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml")
    .option("--all-hosts", "Fan out to all registered HTTP hosts (observation-only)")
    .option("--hosts <ids>", "Fan out to specific hosts (comma-separated)")
    .action(async (opts: PsCliOptions) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly. Fan-out
      // flags are their OWN explicit scope — never mixed with selection.
      if (!opts.allHosts && !opts.hosts) opts.host = resolveEffectiveHost(opts.host);
      if (opts.verbose) opts.full = true;
      if (opts.running) opts.active = true;
      const isRemote = !!(opts.host || opts.allHosts || opts.hosts);
      // OPR.0.4.4.21 FR-1: the rig tier is consolidated ALL-ACTIVE-RIGS by
      // default (the current-rig-only default is RETIRED — it hid running
      // rigs from the operator's field of view). The session-rig default
      // now applies ONLY to the node tier (FR-2's scoped --nodes), and
      // ONLY locally (the ladder validator enforces explicit-or-error on
      // every remote path).
      const sessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
      const callerRig = sessionName ? extractRigName(sessionName) : undefined;
      const ladderError = validatePsLadder(opts, callerRig);
      if (ladderError) {
        console.error(ladderError);
        process.exitCode = 1;
        return;
      }
      if (opts.nodes && !opts.allRigs && !opts.rig && !isRemote && callerRig) {
        opts.rig = callerRig;
      }
      const deps = getDepsF();

      // OPR.0.4.4.21 rev1-r2 fixback: the shared shaping controls
      // (--active/--filter/--limit/--fields/--summary) parse + validate
      // BEFORE any dispatch — local, single-host, or fan-out — so every
      // path honors the same composition contract and rejections stay
      // pre-HTTP on remote paths too.
      // Parse shared composition controls once up front so local, single-host,
      // and fan-out paths reject malformed --filter/--limit/--fields before
      // any HTTP call and apply the same shaping semantics.
      const controls = parsePsControls(opts);
      if ("error" in controls) {
        console.error(controls.error);
        process.exitCode = 1;
        return;
      }
      const { parsedFilter, limit, fields, useEnvelope } = controls;

      if (opts.allHosts || opts.hosts) {
        // AggregatedPayload is the closed fan-out contract (items + hosts).
        // Do not add an ad-hoc summary member here; teach the per-host form.
        if (opts.summary) {
          console.error(
            "rig ps --all-hosts/--hosts --summary: summary does not compose with the merged fan-out payload.\n" +
            "Summarize one host: rig ps --host <id> --summary; or drop --summary for the merged AggregatedPayload.",
          );
          process.exitCode = 1;
          return;
        }
        await runFanOutPs(opts, deps, { parsedFilter, limit, fields });
        return;
      }

      if (opts.host) {
        await runCrossHostPs(opts.host, opts, deps);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      if (opts.nodes) {
        await handleNodes(client, opts, parsedFilter, limit, fields, useEnvelope);
        return;
      }

      // OPR.0.4.4.21 FR-1: ONE O(rigs) fetch including archived so the
      // count line can be computed; visibility is split client-side below
      // (JSON keeps today's default of excluding archived — parity).
      const res = await client.get<PsEntry[]>("/api/ps?includeArchived=true");

      if (res.status >= 400) {
        console.error(`Failed to fetch rig list from daemon (HTTP ${res.status}). Check daemon status with: rig status`);
        process.exitCode = 2;
        return;
      }

      const all = res.data;

      // OPR.0.4.4.21 — archived visibility parity: the daemon call above
      // always includes archived (for the count line); without
      // --include-archived they are dropped from BOTH renders here, exactly
      // as the daemon default used to do. archivedCount feeds the FR-1
      // count line only.
      const archivedCount = all.filter((e) => e.isArchived === true).length;
      const visible = opts.includeArchived ? all : all.filter((e) => e.isArchived !== true);

      const rigScoped = opts.rig
        ? visible.filter((e) => (e.rigName ?? e.name) === opts.rig)
        : visible;

      // Apply CLI-side filter (Amendment A: prefer CLI shaping).
      const filtered = parsedFilter ? applyRigFilter(rigScoped, parsedFilter) : rigScoped;

      // Summary mode short-circuits per-entry output.
      if (opts.summary) {
        const summary = summarizeRigs(filtered);
        if (opts.json) {
          console.log(JSON.stringify(summary));
        } else {
          console.log(`totalRigs: ${summary.totalRigs}`);
          console.log(`totalRunning: ${summary.totalRunning}`);
          console.log(`byStatus: ${JSON.stringify(summary.byStatus)}`);
          console.log(`byLifecycle: ${JSON.stringify(summary.byLifecycle)}`);
        }
        return;
      }

      // Apply --limit on top of filter (CLI side; daemon stays bare-array).
      const limited = limit !== null ? filtered.slice(0, limit) : filtered;
      const truncated = limit !== null && filtered.length > limit;

      // Field projection runs last so requested fields apply to the limited set.
      const projected = fields ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields) : limited;

      if (opts.json) {
        if (useEnvelope) {
          // Envelope only on flag use; default JSON stays a bare array for compat.
          const envelope: Record<string, unknown> = {
            entries: projected,
            totalRigs: filtered.length,
            truncated,
          };
          if (truncated) envelope.hint = "rig ps --full --json";
          console.log(JSON.stringify(envelope));
        } else {
          console.log(JSON.stringify(projected));
        }
        return;
      }

      if (limited.length === 0) {
        if (parsedFilter) {
          console.log(`No rigs match --filter ${parsedFilter.key}=${parsedFilter.value}`);
        } else if (archivedCount > 0 && !opts.includeArchived) {
          // Proven-empty with the history pointer, never a bare "No rigs"
          // while archived history exists.
          console.log(`No active rigs · ${archivedCount} archived (rig ps --include-archived)`);
        } else {
          console.log("No rigs");
        }
        return;
      }

      // OPR.0.4.4.21 FR-1 (human table ONLY — JSON keeps ALL non-archived
      // entries including stopped; this scope split is a STATED contract
      // sentence in the help text): on the BARE default (no filter, no
      // --rig, no --include-archived) stopped rigs fold into the count
      // line — history is what the default drops, not field of view.
      const bareDefault = !parsedFilter && !opts.rig && !opts.includeArchived;
      const tableRows = bareDefault ? limited.filter((e) => e.status !== "stopped") : limited;
      const stoppedCount = bareDefault ? limited.length - tableRows.length : 0;

      // FR-1 display element 1: the host rollup line.
      const rollupSeats = tableRows.reduce((n, e) => n + e.nodeCount, 0);
      const rollupAttention = tableRows.reduce((n, e) => n + (e.attentionCount ?? 0), 0);
      console.log(`${tableRows.length} rig${tableRows.length === 1 ? "" : "s"} · ${rollupSeats} seat${rollupSeats === 1 ? "" : "s"} · ${rollupAttention} need${rollupAttention === 1 ? "s" : ""} attention`);

      // Human output: apply default truncation budget unless --full.
      const humanList = (opts.full || limit !== null) ? tableRows : tableRows.slice(0, HUMAN_RIG_BUDGET);
      const humanTruncated = !opts.full && limit === null && tableRows.length > HUMAN_RIG_BUDGET;

      const header = padRigRow("RIG", "NODES", "RUNNING", "ACTIVE", "WORK", "ATTN", "STATUS", "LIFECYCLE", "UPTIME", "SNAPSHOT");
      console.log(header);
      let anyArchivedShown = false;
      for (const e of humanList as PsEntry[]) {
        // OPR.0.3.3.19 - archived rigs only appear under --include-archived;
        // mark them with a trailing "*" (legend footer below) so the operator
        // can tell archived from active at a glance.
        if (e.isArchived) anyArchivedShown = true;
        console.log(padRigRow(
          e.isArchived ? `${e.rigName ?? e.name} *` : (e.rigName ?? e.name),
          String(e.nodeCount),
          String(e.runningCount),
          // Slice 15 — "—" when daemon predates the field; honest absence.
          e.activeCount !== undefined ? String(e.activeCount) : "—",
          e.hasWorkCount !== undefined ? String(e.hasWorkCount) : "—",
          // OPR.0.4.4.21 — the founder's field-of-view anchor: where is
          // something that might concern me. "—" = daemon predates the field.
          e.attentionCount !== undefined ? (e.attentionCount > 0 ? `▲${e.attentionCount}` : "0") : "—",
          e.status,
          abbrevRigLifecycle(e.lifecycleState),
          e.uptime ?? "—",
          e.latestSnapshot ?? "—",
        ));
      }
      if (anyArchivedShown) {
        console.log("* = archived (hidden from the default view; shown via --include-archived). Reverse with: rig unarchive <rig>");
      }
      // FR-1 display element 2: history as ONE count line, never rows.
      if (stoppedCount > 0 || (!opts.includeArchived && archivedCount > 0)) {
        const parts: string[] = [];
        if (stoppedCount > 0) parts.push(`${stoppedCount} stopped (rig ps --filter status=stopped)`);
        if (!opts.includeArchived && archivedCount > 0) parts.push(`${archivedCount} archived (rig ps --include-archived)`);
        console.log(`not shown: ${parts.join(" · ")}`);
      }
      // FR-1 display element 3: the affordance footer — the drill ladder.
      if (bareDefault) {
        console.log("drill: rig ps --rig <name> (one rig) · rig ps --nodes --rig <name> (its seats) · --full (everything)");
      }
      if (humanTruncated) {
        const remaining = filtered.length - HUMAN_RIG_BUDGET;
        console.log(`... and ${remaining} more rig${remaining === 1 ? "" : "s"} (truncated at ${HUMAN_RIG_BUDGET}).`);
        console.log("Run 'rig ps --full' to see all, or 'rig ps --filter lifecycleState=attention_required' to narrow.");
      } else if (truncated) {
        const remaining = filtered.length - (limit ?? 0);
        console.log(`... and ${remaining} more rig${remaining === 1 ? "" : "s"} (--limit ${limit}).`);
      }
    });

  return cmd;
}

async function handleNodes(
  client: DaemonClient,
  opts: PsCliOptions,
  parsedFilter: ParsedFilter | null,
  limit: number | null,
  fields: string[] | null,
  useEnvelope: boolean,
  requestHeaders?: Record<string, string>,
): Promise<void> {
  const rigRes = await client.get<PsEntry[]>(psApiPath(opts), requestHeaders ? { headers: requestHeaders } : undefined);
  if (rigRes.status >= 400) {
    console.error(`Failed to fetch rig list from daemon (HTTP ${rigRes.status}). Check daemon status with: rig status`);
    process.exitCode = 2;
    return;
  }

  const effectiveRigs = opts.rig
    ? rigRes.data.filter((r) => (r.rigName ?? r.name) === opts.rig)
    : rigRes.data;

  // OPR.0.4.3 healthz-wedge: the daemon nodes route is CHEAP by default (no
  // per-node tmux capture) — `rig ps --nodes` gets snapshot-based activity. Pass
  // ?full=true only when the operator asks for --full, which opts into the
  // per-node pane-heuristic (freshest needs_input) at the fan-out's cost.
  const nodesQuery = opts.full ? "?full=true" : "";
  const allNodes: NodeEntry[] = [];
  for (const rig of effectiveRigs) {
    const nodesRes = await client.get<NodeEntry[]>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes${nodesQuery}`, requestHeaders ? { headers: requestHeaders } : undefined);
    if (nodesRes.status >= 400) {
      console.error(`Warning: failed to fetch nodes for rig "${rig.rigName ?? rig.name}" (HTTP ${nodesRes.status}). List rigs with: rig ps`);
      continue;
    }
    const parentRigName = rig.rigName ?? rig.name;
    allNodes.push(...nodesRes.data.map((n) => ({
      ...n,
      rigId: n.rigId ?? rig.rigId,
      rigName: n.rigName ?? parentRigName,
    })));
  }

  let narrowed = allNodes;
  if (opts.rig) narrowed = narrowed.filter((n) => n.rigName === opts.rig);
  if (opts.session) narrowed = narrowed.filter((n) => n.canonicalSessionName === opts.session);

  const filtered = parsedFilter ? applyNodeFilter(narrowed, parsedFilter) : narrowed;

  if (opts.summary) {
    const summary = summarizeNodes(filtered);
    if (opts.json) {
      console.log(JSON.stringify(summary));
    } else {
      console.log(`totalNodes: ${summary.totalNodes}`);
      console.log(`bySessionStatus: ${JSON.stringify(summary.bySessionStatus)}`);
      console.log(`byLifecycle: ${JSON.stringify(summary.byLifecycle)}`);
    }
    return;
  }

  const limited = limit !== null ? filtered.slice(0, limit) : filtered;
  const limitTruncated = limit !== null && filtered.length > limit;
  const useCompact = !opts.full && !fields;
  const projected = fields
    ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields)
    : useCompact
      ? compactNodeProjection(limited)
      : limited;

  if (opts.json) {
    if (useEnvelope) {
      const envelope: Record<string, unknown> = {
        entries: projected,
        totalNodes: filtered.length,
        truncated: limitTruncated,
      };
      if (limitTruncated) envelope.hint = "rig ps --nodes --full --json";
      console.log(JSON.stringify(envelope));
    } else {
      console.log(JSON.stringify(projected));
    }
    return;
  }

  if (limited.length === 0) {
    if (parsedFilter) {
      console.log(`No nodes match --filter ${parsedFilter.key}=${parsedFilter.value}`);
    } else {
      console.log("No nodes");
    }
    return;
  }

  const humanList = (opts.full || limit !== null) ? limited : limited.slice(0, HUMAN_NODE_BUDGET);
  const humanTruncated = !opts.full && limit === null && filtered.length > HUMAN_NODE_BUDGET;

  if (useCompact) {
    console.log(padCompactNodeRow("RIG", "SESSION", "LIFECYCLE", "ACTIVITY", "WORK", "REASON"));
    for (const n of humanList as NodeEntry[]) {
      const attn = needsAttention(n);
      const reason = attn
        ? (n.latestError ? truncate(n.latestError, 40) : n.agentActivity?.reason ?? "—")
        : "—";
      console.log(padCompactNodeRow(
        n.rigName,
        n.canonicalSessionName ?? "—",
        abbrevNodeLifecycle(n.lifecycleState),
        formatActivity(n.agentActivity),
        formatHasWork(n.hasAssignedWork, n.pendingWorkCount),
        reason,
      ));
    }
  } else {
    const header = padNodeRow("RIG", "POD", "MEMBER", "SESSION", "RUNTIME", "STATUS", "STARTUP", "ORIENTED", "LIFECYCLE", "TERMINAL", "WORK", "ACTIVITY", "CTX", "RESTORE", "ERROR");
    console.log(header);
    for (const n of humanList as NodeEntry[]) {
      const parts = n.logicalId.split(".");
      const pod = n.podNamespace ?? (parts.length > 1 ? parts[0]! : "—");
      const member = parts.length > 1 ? parts.slice(1).join(".") : n.logicalId;
      const rig = `${n.rigName}#${n.rigId}`;
      console.log(padNodeRow(
        rig,
        pod,
        member,
        n.canonicalSessionName ?? "—",
        n.runtime ?? "—",
        n.sessionStatus ?? "—",
        n.startupStatus ?? "—",
        n.oriented ?? "—",
        abbrevNodeLifecycle(n.lifecycleState),
        formatTerminalActive(n.terminalActive),
        formatHasWork(n.hasAssignedWork, n.pendingWorkCount),
        formatActivity(n.agentActivity),
        formatContextUsage(n.contextUsage),
        n.restoreOutcome,
        n.latestError ? truncate(n.latestError, 30) : n.heldReason ? `held: ${truncate(n.heldReason, 25)}` : "—",
      ));
    }
  }
  if (humanTruncated) {
    const remaining = filtered.length - HUMAN_NODE_BUDGET;
    console.log(`... and ${remaining} more node${remaining === 1 ? "" : "s"} (truncated at ${HUMAN_NODE_BUDGET}).`);
    console.log("Run 'rig ps --nodes --full' to see all, or '--filter lifecycleState=attention_required' to narrow.");
  } else if (limitTruncated) {
    const remaining = filtered.length - (limit ?? 0);
    console.log(`... and ${remaining} more node${remaining === 1 ? "" : "s"} (--limit ${limit}).`);
  }
}

function formatActivity(activity: NodeEntry["agentActivity"]): string {
  if (!activity) return "unknown";
  if (activity.state === "running") return "running";
  if (activity.state === "needs_input") return "needs_input";
  if (activity.state === "idle") return "idle";
  return "unknown";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fitCell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

function padRigRow(rig: string, nodes: string, running: string, active: string, work: string, attn: string, status: string, lifecycle: string, uptime: string, snapshot: string): string {
  return [
    fitCell(rig, 24),
    fitCell(nodes, 7),
    fitCell(running, 9),
    // Slice 15 — distinct columns for the three orthogonal primitives.
    // RUNNING = process-alive (legacy); ACTIVE = terminal-active (tmux);
    // WORK = has-assigned-work (queue). UI/CLI render them separately so
    // operators see which dimension differs at a glance.
    fitCell(active, 8),
    fitCell(work, 6),
    // OPR.0.4.4.21 — ATTN: seats needing attention (the field-of-view anchor).
    fitCell(attn, 6),
    fitCell(status, 10),
    fitCell(lifecycle, 11),
    fitCell(uptime, 11),
    snapshot,
  ].join("");
}

function padNodeRow(rig: string, pod: string, member: string, session: string, runtime: string, status: string, startup: string, oriented: string, lifecycle: string, terminal: string, work: string, activity: string, ctx: string, restore: string, error: string): string {
  return [
    fitCell(rig, 30),
    fitCell(pod, 10),
    fitCell(member, 14),
    fitCell(session, 34),
    fitCell(runtime, 12),
    fitCell(status, 10),
    fitCell(startup, 10),
    // OPR.0.4.3.06 — challenge-verified orientation, distinct from STARTUP.
    fitCell(oriented, 9),
    fitCell(lifecycle, 11),
    // Slice 15 — distinct TERMINAL + WORK columns.
    fitCell(terminal, 9),
    fitCell(work, 6),
    fitCell(activity, 12),
    fitCell(ctx, 6),
    fitCell(restore, 10),
    error,
  ].join("");
}

function padCompactNodeRow(rig: string, session: string, lifecycle: string, activity: string, work: string, reason: string): string {
  return [
    fitCell(rig, 22),
    fitCell(session, 38),
    fitCell(lifecycle, 11),
    fitCell(activity, 14),
    fitCell(work, 6),
    reason,
  ].join("");
}

// Slice 15 — render the terminal-active primitive honestly.
// `null` (no signal) is rendered distinctly from `false` (silent past
// threshold) so an operator can see whether the daemon hasn't observed
// the seat yet vs has observed and seen no output.
function formatTerminalActive(t: boolean | null | undefined): string {
  if (t === true) return "active";
  if (t === false) return "idle";
  return "—"; // null / undefined → no signal
}

// Slice 15 — render has-work with a hint of how much.
// Pending count appended in parens when known and > 1 keeps the column
// compact while remaining honest.
function formatHasWork(has: boolean | undefined, count: number | undefined): string {
  if (has === undefined) return "—";
  if (!has) return "no";
  if (typeof count === "number" && count > 1) return `${count}`;
  return "yes";
}

// PL-012: render context-usage as a 5-char cell — "<percent>%" when
// known + fresh, "<percent>%*" when known but stale, "??" when unknown.
// 4-char width keeps the table compact without truncating two-digit
// percentages (e.g., "98%*" or "5%").
function formatContextUsage(ctx: NodeEntry["contextUsage"]): string {
  if (!ctx || ctx.availability !== "known" || typeof ctx.usedPercentage !== "number") {
    return "??";
  }
  const stale = ctx.fresh === false ? "*" : "";
  return `${ctx.usedPercentage}%${stale}`;
}


async function runCrossHostPs(
  hostId: string,
  opts: PsCliOptions,
  deps: PsDeps,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const runner = deps.crossHostRun ?? runCrossHostCommand;

  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  if (host.transport === "http") {
    await runHttpPs(host, opts, deps);
    return;
  }

  // SSH path — reconstruct argv
  const argv: string[] = ["rig", "ps"];
  if (opts.nodes) argv.push("--nodes");
  if (opts.full) argv.push("--full");
  // OPR.0.4.0.34: forward the breadth flag so `--host h -A` keeps all-rigs
  // breadth across the hop (the current-rig default is local-only and never
  // applied to a remote call, but an explicit -A must still reach the remote).
  // OPR.0.4.4.21 FR-3: -A is legal only alongside --nodes (the validator
  // already rejected the bare form before any dispatch; this guard keeps
  // the reconstructed remote argv obeying the same grammar).
  if (opts.allRigs && opts.nodes) argv.push("--all-rigs");
  if (opts.limit !== undefined) argv.push("--limit", opts.limit);
  if (opts.fields !== undefined) argv.push("--fields", opts.fields);
  if (opts.summary) argv.push("--summary");
  if (opts.filter !== undefined) argv.push("--filter", opts.filter);
  // OPR.0.4.0.34: opts.active is the normalized form (set by --active OR
  // --running). Forward it so the state filter survives the hop.
  if (opts.active) argv.push("--active");
  if (opts.rig !== undefined) argv.push("--rig", opts.rig);
  if (opts.session !== undefined) argv.push("--session", opts.session);
  if (opts.includeArchived) argv.push("--include-archived");
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    if (result.ok) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return;
    }
    emitCrossHostFailure(host.id, hostDisplayTarget(host), result, true);
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, false);
}

function buildRemoteHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function runHttpPs(
  host: HttpHostEntry,
  opts: PsCliOptions,
  deps: PsDeps,
): Promise<void> {
  const bearerResult = resolveRemoteBearer(host);
  if (!bearerResult.ok) {
    emitCrossHostError(host.id, bearerResult.failedStep, bearerResult.error, opts.json);
    process.exitCode = 1;
    return;
  }

  const controls = parsePsControls(opts);
  if ("error" in controls) {
    console.error(controls.error);
    process.exitCode = 1;
    return;
  }
  const { parsedFilter, limit, fields, useEnvelope } = controls;

  const client = deps.clientFactory(host.url);
  const headers = buildRemoteHeaders(bearerResult.token);

  try {
    if (opts.nodes) {
      await handleNodes(client, opts, parsedFilter, limit, fields, useEnvelope, headers);
      return;
    }

    const res = await client.get<PsEntry[]>(psApiPath(opts), { headers });
    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      emitCrossHostError(host.id, failedStep, `HTTP ${res.status}`, opts.json);
      process.exitCode = 1;
      return;
    }

    const all = Array.isArray(res.data) ? res.data : [];
    const filtered = parsedFilter ? applyRigFilter(all, parsedFilter) : all;

    if (opts.summary) {
      const summary = summarizeRigs(filtered);
      if (opts.json) {
        console.log(JSON.stringify(summary));
      } else {
        console.log(`[via host=${host.id} (${host.url})]`);
        console.log(JSON.stringify(summary, null, 2));
      }
      return;
    }

    const limited = limit !== null ? filtered.slice(0, limit) : filtered;
    const truncated = limit !== null && filtered.length > limit;
    const projected = fields ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields) : limited;

    if (opts.json) {
      if (useEnvelope) {
        const envelope: Record<string, unknown> = { entries: projected, totalRigs: filtered.length, truncated };
        console.log(JSON.stringify(envelope));
      } else {
        console.log(JSON.stringify(projected));
      }
    } else {
      console.log(`[via host=${host.id} (${host.url})]`);
      console.log(JSON.stringify(projected, null, 2));
    }
  } catch (err) {
    const failedStep = classifyHttpError(err);
    emitCrossHostError(host.id, failedStep, (err as Error).message, opts.json);
    process.exitCode = 1;
  }
}

/** INTERNAL transport result of one fan-out leg (arch adjudication: the
 *  shared P4 contract is fanout-contract's AggregatedPayload/PerHostStatus;
 *  this shape survives only as the fan-out's internal carriage, adapted
 *  below before anything is emitted). */
interface FanOutHostResult {
  host: string;
  ok: boolean;
  failedStep: import("../cross-host-types.js").FailedStep | "unsupported-transport";
  data?: unknown;
  error?: string;
}

/** OPR.0.4.4.21 FR-5 — adapter to the intra-P4 shared contract
 *  (fanout-contract.ts, slice 15 first-lander at 0ecd329b; the closed
 *  status enum is THE contract, failedStep rides as additive detail). */
function toPerHostStatus(r: FanOutHostResult): PerHostStatus {
  const status: PerHostStatus["status"] =
    r.ok ? "ok"
    : r.failedStep === "unsupported-transport" ? "unsupported-transport"
    : r.failedStep === "permission-gate" ? "auth-failed"
    : "unreachable";
  const out: PerHostStatus = { hostId: r.host, status };
  if (r.error) out.error = r.error;
  if (!r.ok && r.failedStep !== "unsupported-transport") out.failedStep = r.failedStep;
  return out;
}

async function runFanOutPs(
  opts: PsCliOptions,
  deps: PsDeps,
  shaping: { parsedFilter: ParsedFilter | null; limit: number | null; fields: string[] | null },
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    console.error(`Error: ${registry.error}`);
    process.exitCode = 1;
    return;
  }

  const allHosts = registry.registry.hosts;
  let targetIds: string[];
  if (opts.hosts) {
    targetIds = opts.hosts.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = targetIds.filter((id) => !allHosts.some((h) => h.id === id));
    if (unknown.length > 0) {
      console.error(`Error: unknown host ids: ${unknown.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  } else {
    // OPR.0.4.4.21 fixback (qa1 F1): target EVERY declared host — non-HTTP
    // hosts must appear in hosts[] as unsupported-transport (R15-2), never
    // be silently absent. The per-host leg classifies transport.
    targetIds = allHosts.map((h) => h.id);
  }

  const results: FanOutHostResult[] = await Promise.all(
    targetIds.map(async (id): Promise<FanOutHostResult> => {
      const host = allHosts.find((h) => h.id === id);
      if (!host) return { host: id, ok: false, failedStep: "remote-daemon-unreachable", error: `unknown host ${id}` };
      if (host.transport !== "http") {
        // R15-2 (shared contract): an SSH-declared host is a STRUCTURED
        // unsupported-transport status — never prose-only, never silently
        // thinner output.
        return { host: id, ok: false, failedStep: "unsupported-transport", error: `host ${id} uses transport ${host.transport}; HTTP fan-out requires transport: http` };
      }
      const httpHost = host as HttpHostEntry;
      const bearerResult = resolveRemoteBearer(httpHost);
      if (!bearerResult.ok) {
        return { host: id, ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
      }
      const client = deps.clientFactory(httpHost.url);
      const headers = buildRemoteHeaders(bearerResult.token);
      try {
        const psQuery = opts.includeArchived ? "?includeArchived=true" : "";
        const res = await client.get<unknown>(`/api/ps${psQuery}`, { headers });
        const failedStep = classifyHttpFailedStep(res.status);
        if (failedStep !== "none") {
          return { host: id, ok: false, failedStep, error: `HTTP ${res.status}` };
        }
        if (!opts.nodes) {
          return { host: id, ok: true, failedStep: "none", data: res.data };
        }
        // OPR.0.4.4.21 FR-5 — the full explicit ladder (--nodes -A, --full
        // for complete records): per-host node fan-out, projected unless
        // --full (the invariant's last rung; validated as -A-only upstream).
        const rigs = Array.isArray(res.data) ? (res.data as PsEntry[]) : [];
        const nodes: NodeEntry[] = [];
        for (const rig of rigs) {
          const nodesRes = await client.get<NodeEntry[]>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`, { headers });
          if (nodesRes.status >= 400) {
            return { host: id, ok: false, failedStep: classifyHttpFailedStep(nodesRes.status), error: `HTTP ${nodesRes.status} fetching nodes for rig ${rig.rigName ?? rig.name}` };
          }
          const parentRigName = rig.rigName ?? rig.name;
          nodes.push(...nodesRes.data.map((n) => ({
            ...n,
            rigId: n.rigId ?? rig.rigId,
            rigName: n.rigName ?? parentRigName,
          })));
        }
        return { host: id, ok: true, failedStep: "none", data: nodes };
      } catch (err) {
        return { host: id, ok: false, failedStep: classifyHttpError(err), error: (err as Error).message };
      }
    }),
  );

  const hasFailure = results.some((r) => !r.ok);

  if (opts.json) {
    // OPR.0.4.4.21 FR-5 — the intra-P4 shared payload (ONE contract with
    // slice 15): items = each host's rows stamped with their origin hostId
    // (flat-mergeable; origin never positional), hosts = the per-host
    // structured status array. EVERY targeted host appears in hosts[] —
    // ok or not (no silent thinning).
    const rawItems: Array<Record<string, unknown>> = results.flatMap((r) =>
      r.ok && Array.isArray(r.data)
        ? (r.data as Array<Record<string, unknown>>).map((row) => ({ ...row, hostId: r.host }))
        : [],
    );
    const hostStatuses = results.map(toPerHostStatus);
    let narrowed = rawItems;
    if (opts.rig) narrowed = narrowed.filter((e) => (e.rigName ?? e.name) === opts.rig);
    if (opts.nodes && opts.session) narrowed = narrowed.filter((n) => n.canonicalSessionName === opts.session);

    const filtered = shaping.parsedFilter
      ? opts.nodes
        ? (applyNodeFilter(narrowed as unknown as NodeEntry[], shaping.parsedFilter) as unknown as Array<Record<string, unknown>>)
        : (applyRigFilter(narrowed as unknown as PsEntry[], shaping.parsedFilter) as unknown as Array<Record<string, unknown>>)
      : narrowed;

    let items: Array<Record<string, unknown>>;
    if (opts.summary) {
      items = [
        opts.nodes
          ? summarizeNodes(filtered as unknown as NodeEntry[])
          : summarizeRigs(filtered as unknown as PsEntry[]),
      ];
    } else {
      const limited = shaping.limit !== null ? filtered.slice(0, shaping.limit) : filtered;
      items = shaping.fields
        ? selectFanOutFields(limited, shaping.fields)
        : opts.nodes && !opts.full
          ? compactNodeProjection(limited as unknown as NodeEntry[]).map((row, i) => ({
              ...row,
              hostId: limited[i]?.hostId,
            }))
          : limited;
    }

    const payload: AggregatedPayload<Record<string, unknown>> = {
      items,
      hosts: hostStatuses,
    };
    console.log(JSON.stringify(payload));
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(`\n[host=${r.host}]`);
        console.log(JSON.stringify(r.data, null, 2));
      } else {
        console.log(`\n[host=${r.host}] FAILED (${r.failedStep}): ${r.error}`);
      }
    }
  }

  if (hasFailure) process.exitCode = 3;
}
