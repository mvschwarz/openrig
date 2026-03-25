import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function restoreCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("restore").description("Restore a rig from a snapshot");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<snapshotId>", "Snapshot ID to restore")
    .requiredOption("--rig <rigId>", "Rig ID to restore into")
    .action(async (snapshotId: string, opts: { rig: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        if (status.state === "running" && status.healthy === false) {
          console.error("Daemon unhealthy — healthz failed");
        } else {
          console.error("Daemon not running");
        }
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://localhost:${status.port}`);
      const rigId = opts.rig;

      const res = await client.post<{ nodes?: Array<{ nodeId: string; status: string }> }>(`/api/rigs/${encodeURIComponent(rigId)}/restore/${encodeURIComponent(snapshotId)}`);

      if (res.status === 404) {
        console.error("Snapshot or rig not found");
        process.exitCode = 1;
      } else if (res.status === 409) {
        console.error("Restore already in progress");
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`Restore failed: ${(res.data as { error?: string }).error ?? "unknown error"}`);
        process.exitCode = 1;
      } else {
        console.log("Restore complete:");
        const nodes = res.data.nodes ?? [];
        for (const node of nodes) {
          console.log(`  ${node.nodeId}: ${node.status}`);
        }
      }
    });

  return cmd;
}
