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

/**
 * `rigged ps` — list running rigs.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function psCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("ps").description("List rigs and their status");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDepsF();

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);
      const res = await client.get<PsEntry[]>("/api/ps");

      if (res.status >= 400) {
        console.error("Failed to fetch rig list");
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
      const header = padRow("RIG", "NODES", "RUNNING", "STATUS", "UPTIME", "SNAPSHOT");
      console.log(header);
      for (const e of entries) {
        console.log(padRow(
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

function padRow(rig: string, nodes: string, running: string, status: string, uptime: string, snapshot: string): string {
  return [
    rig.padEnd(14),
    nodes.padEnd(7),
    running.padEnd(9),
    status.padEnd(10),
    uptime.padEnd(11),
    snapshot,
  ].join("");
}
