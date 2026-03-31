import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface PsEntry {
  rigId: string;
  name: string;
  nodeCount: number;
  runningCount: number;
  status: "running" | "partial" | "stopped";
  uptime: string | null;
  latestSnapshot: string | null;
}

interface NodeEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: "pending" | "ready" | "failed" | null;
  restoreOutcome: string;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  latestError: string | null;
  [key: string]: unknown;
}

/**
 * `rigged ps` — list running rigs and optionally their nodes.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function psCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("ps")
    .description("List rigs and their status")
    .addHelpText("after", `
Examples:
  rigged ps                    Show all rigs with status
  rigged ps --json             JSON output for piping/parsing
  rigged ps --nodes            Show per-node detail for all rigs
  rigged ps --nodes --json     Node inventory as JSON array

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
        console.error("Daemon not running. Start it with: rigged daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);

      if (opts.nodes) {
        await handleNodes(client, opts.json ?? false);
        return;
      }

      const res = await client.get<PsEntry[]>("/api/ps");

      if (res.status >= 400) {
        console.error(`Failed to fetch rig list from daemon (HTTP ${res.status}). Check daemon status with: rigged status`);
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
      const header = padRigRow("RIG", "NODES", "RUNNING", "STATUS", "UPTIME", "SNAPSHOT");
      console.log(header);
      for (const e of entries) {
        console.log(padRigRow(
          e.name,
          String(e.nodeCount),
          String(e.runningCount),
          e.status,
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
    console.error(`Failed to fetch rig list from daemon (HTTP ${rigRes.status}). Check daemon status with: rigged status`);
    process.exitCode = 2;
    return;
  }

  const allNodes: NodeEntry[] = [];
  for (const rig of rigRes.data) {
    const nodesRes = await client.get<NodeEntry[]>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`);
    if (nodesRes.status >= 400) {
      console.error(`Warning: failed to fetch nodes for rig "${rig.name}" (HTTP ${nodesRes.status}). List rigs with: rigged ps`);
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

  const header = padNodeRow("POD", "MEMBER", "SESSION", "RUNTIME", "STATUS", "STARTUP", "RESTORE", "ERROR");
  console.log(header);
  for (const n of allNodes) {
    const parts = n.logicalId.split(".");
    const pod = parts.length > 1 ? parts[0]! : "—";
    const member = parts.length > 1 ? parts.slice(1).join(".") : n.logicalId;
    console.log(padNodeRow(
      pod,
      member,
      n.canonicalSessionName ?? "—",
      n.runtime ?? "—",
      n.sessionStatus ?? "—",
      n.startupStatus ?? "—",
      n.restoreOutcome,
      n.latestError ? truncate(n.latestError, 30) : "—",
    ));
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function padRigRow(rig: string, nodes: string, running: string, status: string, uptime: string, snapshot: string): string {
  return [
    rig.padEnd(14),
    nodes.padEnd(7),
    running.padEnd(9),
    status.padEnd(10),
    uptime.padEnd(11),
    snapshot,
  ].join("");
}

function padNodeRow(pod: string, member: string, session: string, runtime: string, status: string, startup: string, restore: string, error: string): string {
  return [
    pod.padEnd(10),
    member.padEnd(10),
    session.padEnd(28),
    runtime.padEnd(14),
    status.padEnd(10),
    startup.padEnd(10),
    restore.padEnd(10),
    error,
  ].join("");
}
