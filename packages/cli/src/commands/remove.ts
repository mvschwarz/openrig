import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function removeCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("remove").description("Remove a node from a running rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<rigId>", "Target rig ID")
    .argument("<nodeRef>", "Node logical ID or node ID")
    .option("--fallback <live-seat>", "Reroute active qitems to this running seat before removal")
    .option("--json", "JSON output")
    .action(async (rigId: string, nodeRef: string, opts: { fallback?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const fallbackQuery = opts.fallback ? `?fallback=${encodeURIComponent(opts.fallback)}` : "";
      const res = await client.delete<Record<string, unknown>>(
        `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeRef)}${fallbackQuery}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      const reroutedQitemIds = Array.isArray(res.data["reroutedQitemIds"])
        ? res.data["reroutedQitemIds"] as string[]
        : [];
      if (reroutedQitemIds.length > 0 && typeof res.data["fallbackDestination"] === "string") {
        console.log(`Rerouted ${reroutedQitemIds.join(", ")} to ${res.data["fallbackDestination"]}`);
      }

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `Remove failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`Removed node ${res.data["logicalId"]} from rig ${res.data["rigId"]} (${res.data["sessionsKilled"]} session killed)`);
    });

  return cmd;
}
