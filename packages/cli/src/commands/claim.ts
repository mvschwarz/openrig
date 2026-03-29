import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function claimCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("claim").description("Claim a discovered session into a rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running");
      return null;
    }
    return deps.clientFactory(`http://127.0.0.1:${status.port}`);
  }

  cmd
    .argument("<discoveredId>", "ID of the discovered session")
    .requiredOption("--rig <rigId>", "Target rig ID")
    .option("--logical-id <name>", "Logical ID for the new node")
    .action(async (discoveredId: string, opts: { rig: string; logicalId?: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<Record<string, unknown>>(`/api/discovery/${encodeURIComponent(discoveredId)}/claim`, {
        rigId: opts.rig,
        logicalId: opts.logicalId,
      });

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `Claim failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`Claimed as node ${res.data["nodeId"]} in rig ${opts.rig}`);
    });

  return cmd;
}
