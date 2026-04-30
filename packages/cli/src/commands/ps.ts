import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

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
const ALLOWED_FILTER_KEYS = new Set(["status", "lifecycleState", "name-prefix", "name"]);

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
]);

interface PsCliOptions {
  json?: boolean;
  nodes?: boolean;
  full?: boolean;
  limit?: string;
  fields?: string;
  summary?: boolean;
  filter?: string;
}

interface ParsedFilter {
  key: string;
  value: string;
}

function parseFilter(filter: string): ParsedFilter | { error: string } {
  const idx = filter.indexOf("=");
  if (idx === -1) return { error: `--filter must be key=value; got: '${filter}'` };
  const key = filter.slice(0, idx);
  const value = filter.slice(idx + 1);
  if (!ALLOWED_FILTER_KEYS.has(key)) {
    return {
      error: `Unknown --filter key '${key}'. Supported: ${[...ALLOWED_FILTER_KEYS].sort().join(", ")}`,
    };
  }
  if (!value) {
    return { error: `--filter value is empty for key '${key}'` };
  }
  return { key, value };
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
export function psCommand(depsOverride?: StatusDeps): Command {
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

JSON output entries include both \`name\` and \`rigName\` (alias) for forward
compatibility; agent code should prefer \`rigName\` (matches per-node JSON).

--filter accepts: status, lifecycleState, name-prefix, name. Other keys are rejected.

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

Exit codes:
  0  Success
  1  Daemon not running, or invalid --filter / --limit
  2  Failed to fetch data from daemon`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output for agents")
    .option("--nodes", "Show per-node detail for all rigs")
    .option("--full", "Disable default human-output truncation")
    .option("--limit <n>", "Limit number of entries (rigs or nodes)")
    .option("--fields <list>", "Comma-separated field list to project (JSON only)")
    .option("--summary", "Emit aggregate-only output (counts by status/lifecycle)")
    .option("--filter <key=value>", "Filter entries; supported keys: status, lifecycleState, name-prefix, name")
    .action(async (opts: PsCliOptions) => {
      const deps = getDepsF();

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      // Parse filter once up front so unknown keys/malformed filters surface
      // as exit-1 errors before any HTTP call.
      let parsedFilter: ParsedFilter | null = null;
      if (opts.filter) {
        const result = parseFilter(opts.filter);
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

  const header = padNodeRow("RIG", "POD", "MEMBER", "SESSION", "RUNTIME", "STATUS", "STARTUP", "LIFECYCLE", "ACTIVITY", "RESTORE", "ERROR");
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

function padNodeRow(rig: string, pod: string, member: string, session: string, runtime: string, status: string, startup: string, lifecycle: string, activity: string, restore: string, error: string): string {
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
    fitCell(restore, 10),
    error,
  ].join("");
}
