import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

type ShrinkResponse = {
  ok: boolean;
  status?: "ok" | "partial";
  rigId?: string;
  podId?: string;
  namespace?: string;
  removedLogicalIds?: string[];
  sessionsKilled?: number;
  nodes?: Array<{
    logicalId: string;
    nodeId: string;
    status: "removed" | "failed";
    sessionsKilled: number;
    error?: string;
  }>;
  error?: string;
};

export function shrinkCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("shrink").description("Remove an entire pod from a running rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running. Start it with: rig daemon start");
      return null;
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<rigId>", "Target rig ID")
    .argument("<podRef>", "Pod namespace or pod ID")
    .option("--json", "JSON output")
    .action(async (rigId: string, podRef: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const res = await client.delete<ShrinkResponse>(`/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(podRef)}`);
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400 || (res.data.ok && res.data.status !== "ok")) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `Shrink failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      if (res.data.status === "partial") {
        console.log(
          `Partially removed pod ${res.data.namespace} from rig ${res.data.rigId} (${res.data.removedLogicalIds?.length ?? 0} node(s), ${res.data.sessionsKilled} session killed)`
        );
        for (const node of res.data.nodes ?? []) {
          const icon = node.status === "removed" ? "OK" : "FAIL";
          const error = node.error ? ` — ${node.error}` : "";
          console.log(`  [${icon}] ${node.logicalId}${error}`);
        }
        process.exitCode = 1;
        return;
      }

      console.log(
        `Removed pod ${res.data.namespace} from rig ${res.data.rigId} (${res.data.removedLogicalIds?.length ?? 0} node(s), ${res.data.sessionsKilled} session killed)`
      );
    });

  return cmd;
}
