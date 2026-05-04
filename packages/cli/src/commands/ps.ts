import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";

interface PsEntry {
  rigId: string;
  name: string;
  /** L3-followup: alias of `name`. Always populated and equal to `name`. */
  rigName?: string;
  nodeCount: number;
  runningCount: number;
  status: "running" | "partial" | "stopped";
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
  uptime: string | null;
  latestSnapshot: string | null;
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
  lifecycleState?: "running" | "detached" | "recoverable" | "attention_required";
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  latestError: string | null;
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
  [key: string]: unknown;
}

// L3-followup: human-output budgets bound default terminal output for hosts
// with realistic agent counts. `--full` opts out. JSON output remains
// unbounded by default for back-compat (Decision C hybrid).
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
  "rigId",
  "name",
  "rigName",
  "nodeCount",
  "runningCount",
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
  "lifecycleState",
  "tmuxAttachCommand",
  "resumeCommand",
  "latestError",
  "agentActivity",
  "contextUsage",
]);

interface PsCliOptions {
  json?: boolean;
  nodes?: boolean;
  full?: boolean;
  limit?: string;
  fields?: string;
  summary?: boolean;
  filter?: string;
  host?: string;
  active?: boolean;
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

function selectFields<T extends Record<string, unknown>>(entries: T[], fields: string[]): Array<Record<string, unknown>> {
  return entries.map((e) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = e[f];
    return out;
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
 * `rig ps` — list running rigs and optionally their nodes.
 *
 * L3-followup adds CLI-side shaping flags (`--limit`, `--fields`, `--summary`,
 * `--filter`, `--full`) for context-window-safe output on large hosts. Default
 * `rig ps` (human) truncates to ~50 rigs with an explicit footer naming totals
 * and the `--full` opt-out. Default `rig ps --json` keeps the bare-array shape
 * for back-compat; the truncation/envelope shape only applies when at least
 * one of `--limit`/`--summary`/`--fields`/`--filter` is specified.
 */
export function psCommand(depsOverride?: PsDeps): Command {
  const cmd = new Command("ps")
    .description("List rigs and their status")
    .addHelpText("after", `
Examples:
  rig ps                                          Show all rigs (human; truncated to ${HUMAN_RIG_BUDGET} with footer)
  rig ps --full                                   Disable human truncation
  rig ps --json                                   JSON output (bare array; back-compat)
  rig ps --json --limit 20                        Bounded JSON envelope
  rig ps --json --summary                         Aggregate-only JSON (no per-rig entries)
  rig ps --json --fields rigName,status,lifecycleState
                                                  Project JSON to named fields
  rig ps --filter lifecycleState=attention_required
                                                  Show only rigs needing attention
  rig ps --filter status=running                  Show only running rigs
  rig ps --filter name-prefix=demo                Filter by rig-name prefix
  rig ps --nodes                                  Per-node detail (human; truncated to ${HUMAN_NODE_BUDGET})
  rig ps --nodes --json --limit 50                Bounded per-node JSON envelope
  rig ps --nodes --active                         Show only nodes whose agentActivity.state == running (PL-019)
  rig ps --nodes --filter agentActivity.state=running
                                                  Same as --active (the explicit form)
  rig ps --host vm-claude-test --nodes --json     Run on a remote host via single-hop ssh

JSON output entries include both \`name\` and \`rigName\` (alias) for forward
compatibility; agent code should prefer \`rigName\` (matches per-node JSON).

--filter accepts: status, lifecycleState, name-prefix, name, agentActivity.state.
Other keys are rejected. agentActivity.state is node-level (use with --nodes);
allowed values: running, needs_input, idle, unknown.

--fields accepts (rig-level): rigId, name, rigName, nodeCount, runningCount,
status, lifecycleState, uptime, latestSnapshot.
--fields accepts (node-level, with --nodes): rigId, rigName, logicalId, podId,
podNamespace, canonicalSessionName, nodeKind, runtime, sessionStatus,
startupStatus, restoreOutcome, lifecycleState, tmuxAttachCommand,
resumeCommand, latestError, agentActivity. Other keys are rejected.
\`name\` is rig-level only; for node entries use \`rigName\`. Nested-field
projection (e.g. \`agentActivity.state\`) is not supported in this slice; pass
\`agentActivity\` to project the whole object and read the nested value
downstream.

--host runs the same command on a remote host declared in ~/.openrig/hosts.yaml
via single-hop ssh (CLI-side shell-out; daemon untouched). The remote rig's
output is what counts and is surfaced verbatim on success; failure is
distinguished into ssh-unreachable / permission-gate / remote-daemon-unreachable
/ remote-command-failed.

Exit codes:
  0  Success
  1  Daemon not running, or invalid --filter / --limit / --fields
  2  Failed to fetch data from daemon`);
  const getDepsF = (): PsDeps => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output for agents")
    .option("--nodes", "Show per-node detail for all rigs")
    .option("--full", "Disable default human-output truncation")
    .option("--limit <n>", "Limit number of entries (rigs or nodes)")
    .option("--fields <list>", "Comma-separated field list to project (JSON only)")
    .option("--summary", "Emit aggregate-only output (counts by status/lifecycle)")
    .option("--filter <key=value>", "Filter entries; supported keys: status, lifecycleState, name-prefix, name, agentActivity.state")
    .option("--active", "Shortcut for --filter agentActivity.state=running (PL-019)")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml (CLI-side ssh shell-out)")
    .action(async (opts: PsCliOptions) => {
      const deps = getDepsF();

      // --- Cross-host short-circuit (CLI-side ssh shell-out; daemon untouched) ---
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

      // Parse filter once up front so unknown keys/malformed filters surface
      // as exit-1 errors before any HTTP call.
      //
      // PL-019 item 1: --active is sugar for --filter agentActivity.state=running.
      // Combining --active with --filter is rejected (composition is
      // ambiguous — pick one explicit form). Parity is verified end-to-end
      // by the focused test: `--active` and the explicit filter must yield
      // identical output on the same fixture.
      let effectiveFilter = opts.filter;
      if (opts.active) {
        if (effectiveFilter) {
          console.error(
            `--active and --filter cannot be combined. ` +
            `--active is sugar for --filter agentActivity.state=running. ` +
            `Pick one form, or compose by upgrading to --filter directly.`
          );
          process.exitCode = 1;
          return;
        }
        effectiveFilter = "agentActivity.state=running";
      }
      let parsedFilter: ParsedFilter | null = null;
      if (effectiveFilter) {
        const result = parseFilter(effectiveFilter);
        if ("error" in result) {
          console.error(result.error);
          process.exitCode = 1;
          return;
        }
        parsedFilter = result;
      }

      const limit = opts.limit !== undefined ? Number(opts.limit) : null;
      if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
        console.error(`--limit must be a non-negative integer; got '${opts.limit}'`);
        process.exitCode = 1;
        return;
      }
      // C9a: validate --fields against the per-level allow-list before any HTTP
      // call, mirroring the --filter validation above. Level is determined by
      // --nodes; both branches downstream use the same `fields` variable, so
      // one up-front validation covers both paths.
      let fields: string[] | null = null;
      if (opts.fields !== undefined) {
        const fieldsLevel: "rig" | "nodes" = opts.nodes ? "nodes" : "rig";
        const fieldsAllowed = fieldsLevel === "nodes" ? ALLOWED_NODE_FIELDS : ALLOWED_RIG_FIELDS;
        const fieldsResult = parseFields(opts.fields, fieldsAllowed, fieldsLevel);
        if ("error" in fieldsResult) {
          console.error(fieldsResult.error);
          process.exitCode = 1;
          return;
        }
        fields = fieldsResult;
      }
      const useEnvelope = parsedFilter !== null || limit !== null || fields !== null || opts.summary === true;

      const client = deps.clientFactory(getDaemonUrl(status));

      if (opts.nodes) {
        await handleNodes(client, opts, parsedFilter, limit, fields, useEnvelope);
        return;
      }

      const res = await client.get<PsEntry[]>("/api/ps");

      if (res.status >= 400) {
        console.error(`Failed to fetch rig list from daemon (HTTP ${res.status}). Check daemon status with: rig status`);
        process.exitCode = 2;
        return;
      }

      const all = res.data;

      // Apply CLI-side filter (Amendment A: prefer CLI shaping).
      const filtered = parsedFilter ? applyRigFilter(all, parsedFilter) : all;

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
        } else {
          console.log("No rigs");
        }
        return;
      }

      // Human output: apply default truncation budget unless --full.
      const humanList = (opts.full || limit !== null) ? limited : limited.slice(0, HUMAN_RIG_BUDGET);
      const humanTruncated = !opts.full && limit === null && filtered.length > HUMAN_RIG_BUDGET;

      const header = padRigRow("RIG", "NODES", "RUNNING", "STATUS", "LIFECYCLE", "UPTIME", "SNAPSHOT");
      console.log(header);
      for (const e of humanList as PsEntry[]) {
        console.log(padRigRow(
          e.rigName ?? e.name,
          String(e.nodeCount),
          String(e.runningCount),
          e.status,
          abbrevRigLifecycle(e.lifecycleState),
          e.uptime ?? "—",
          e.latestSnapshot ?? "—",
        ));
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
): Promise<void> {
  const rigRes = await client.get<PsEntry[]>("/api/ps");
  if (rigRes.status >= 400) {
    console.error(`Failed to fetch rig list from daemon (HTTP ${rigRes.status}). Check daemon status with: rig status`);
    process.exitCode = 2;
    return;
  }

  const allNodes: NodeEntry[] = [];
  for (const rig of rigRes.data) {
    const nodesRes = await client.get<NodeEntry[]>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`);
    if (nodesRes.status >= 400) {
      console.error(`Warning: failed to fetch nodes for rig "${rig.rigName ?? rig.name}" (HTTP ${nodesRes.status}). List rigs with: rig ps`);
      continue;
    }
    allNodes.push(...nodesRes.data);
  }

  const filtered = parsedFilter ? applyNodeFilter(allNodes, parsedFilter) : allNodes;

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
  const projected = fields ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields) : limited;

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

  const header = padNodeRow("RIG", "POD", "MEMBER", "SESSION", "RUNTIME", "STATUS", "STARTUP", "LIFECYCLE", "ACTIVITY", "CTX", "RESTORE", "ERROR");
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
      abbrevNodeLifecycle(n.lifecycleState),
      formatActivity(n.agentActivity),
      formatContextUsage(n.contextUsage),
      n.restoreOutcome,
      n.latestError ? truncate(n.latestError, 30) : "—",
    ));
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

function padRigRow(rig: string, nodes: string, running: string, status: string, lifecycle: string, uptime: string, snapshot: string): string {
  return [
    fitCell(rig, 24),
    fitCell(nodes, 7),
    fitCell(running, 9),
    fitCell(status, 10),
    fitCell(lifecycle, 11),
    fitCell(uptime, 11),
    snapshot,
  ].join("");
}

function padNodeRow(rig: string, pod: string, member: string, session: string, runtime: string, status: string, startup: string, lifecycle: string, activity: string, ctx: string, restore: string, error: string): string {
  return [
    fitCell(rig, 30),
    fitCell(pod, 10),
    fitCell(member, 14),
    fitCell(session, 34),
    fitCell(runtime, 12),
    fitCell(status, 10),
    fitCell(startup, 10),
    fitCell(lifecycle, 11),
    fitCell(activity, 12),
    fitCell(ctx, 6),
    fitCell(restore, 10),
    error,
  ].join("");
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

  // Reconstruct argv. `rig ps` has no positional args; all flags propagate.
  const argv: string[] = ["rig", "ps"];
  if (opts.nodes) argv.push("--nodes");
  if (opts.full) argv.push("--full");
  if (opts.limit !== undefined) argv.push("--limit", opts.limit);
  if (opts.fields !== undefined) argv.push("--fields", opts.fields);
  if (opts.summary) argv.push("--summary");
  if (opts.filter !== undefined) argv.push("--filter", opts.filter);
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    if (result.ok) {
      // Verbatim remote stdout passthrough — the remote `rig ps --json` already
      // produced the correct JSON shape (bare array OR envelope per its own
      // shaping flags); we do NOT double-wrap.
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return;
    }
    emitCrossHostFailure(host.id, host.target, result, true);
    return;
  }

  console.log(`[via host=${host.id} (${host.target})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, host.target, result, false);
}
