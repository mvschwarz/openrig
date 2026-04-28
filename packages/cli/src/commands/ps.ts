import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface PsEntry {
  rigId: string;
  name: string;
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
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function psCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("ps")
    .description("List rigs and their status")
    .addHelpText("after", `
Examples:
  rig ps                    Show all rigs with status
  rig ps --json             JSON output for piping/parsing
  rig ps --nodes            Show per-node detail for all rigs
  rig ps --nodes --json     Node inventory as JSON array

Exit codes:
  0  Success
  1  Daemon not running
  2  Failed to fetch data from daemon`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output for agents")
    .option("--nodes", "Show per-node detail for all rigs")
    .action(async (opts: { json?: boolean; nodes?: boolean }) => {
      const deps = getDepsF();

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      if (opts.nodes) {
        await handleNodes(client, opts.json ?? false);
        return;
      }

      const res = await client.get<PsEntry[]>("/api/ps");

      if (res.status >= 400) {
        console.error(`Failed to fetch rig list from daemon (HTTP ${res.status}). Check daemon status with: rig status`);
        process.exitCode = 2;
        return;
      }

      const entries = res.data;

      if (opts.json) {
        console.log(JSON.stringify(entries));
        return;
      }

      if (entries.length === 0) {
        console.log("No rigs");
        return;
      }

      // Formatted table
      const header = padRigRow("RIG", "NODES", "RUNNING", "STATUS", "LIFECYCLE", "UPTIME", "SNAPSHOT");
      console.log(header);
      for (const e of entries) {
        console.log(padRigRow(
          e.name,
          String(e.nodeCount),
          String(e.runningCount),
          e.status,
          abbrevRigLifecycle(e.lifecycleState),
          e.uptime ?? "—",
          e.latestSnapshot ?? "—",
        ));
      }
    });

  return cmd;
}

async function handleNodes(client: DaemonClient, json: boolean): Promise<void> {
  // Fetch rig list first
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
      console.error(`Warning: failed to fetch nodes for rig "${rig.name}" (HTTP ${nodesRes.status}). List rigs with: rig ps`);
      continue;
    }
    allNodes.push(...nodesRes.data);
  }

  if (json) {
    console.log(JSON.stringify(allNodes));
    return;
  }

  if (allNodes.length === 0) {
    console.log("No nodes");
    return;
  }

  const header = padNodeRow("RIG", "POD", "MEMBER", "SESSION", "RUNTIME", "STATUS", "STARTUP", "LIFECYCLE", "ACTIVITY", "RESTORE", "ERROR");
  console.log(header);
  for (const n of allNodes) {
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
