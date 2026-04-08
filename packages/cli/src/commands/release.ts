import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function releaseCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("release").description("Release claimed sessions from a rig without killing tmux sessions");
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
    .argument("<rigId>", "Rig identifier")
    .option("--delete", "Delete the rig record after a clean release")
    .option("--json", "JSON output")
    .addHelpText("after", `
Notes:
  - Use rig unclaim <sessionRef> to release a single claimed session.
  - Release only covers claimed/adopted sessions; OpenRig-launched nodes still require rig down.`)
    .action(async (rigId: string, opts: { delete?: boolean; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const res = await client.post<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/release`, {
        delete: opts.delete === true,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400 || res.status === 207) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const launched = Array.isArray(res.data["launchedLogicalIds"])
          ? (res.data["launchedLogicalIds"] as unknown[]).filter((value): value is string => typeof value === "string")
          : [];
        console.error(res.data["error"] ?? `Release failed (HTTP ${res.status})`);
        if (launched.length > 0) {
          console.error(`Launched nodes: ${launched.join(", ")}`);
        }
        process.exitCode = 1;
        return;
      }

      const released = Array.isArray(res.data["released"]) ? res.data["released"] as Array<Record<string, unknown>> : [];
      const failed = Array.isArray(res.data["failed"]) ? res.data["failed"] as Array<Record<string, unknown>> : [];
      const status = res.data["status"];

      if (status === "partial") {
        console.error(`Partially released ${released.length} claimed session(s) from rig ${rigId}`);
        for (const entry of failed) {
          console.error(`  ${entry["logicalId"]}: ${entry["error"]}`);
        }
        process.exitCode = 1;
        return;
      }

      console.log(`Released ${released.length} claimed session(s) from rig ${rigId}${opts.delete ? " and deleted the rig record" : ""}`);
      for (const entry of released) {
        console.log(`  ${entry["logicalId"]} <- ${entry["sessionName"]}`);
      }
    });

  return cmd;
}
