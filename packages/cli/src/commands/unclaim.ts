import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function unclaimCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("unclaim").description("Release an adopted session without killing the tmux session");
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
    .argument("<sessionRef>", "Claimed session ID or session name")
    .option("--json", "JSON output")
    .addHelpText("after", `
Notes:
  - Use rig release <rigId> to release all claimed sessions from one rig.
  - Unclaim preserves the live session; it only removes OpenRig management for that node.`)
    .action(async (sessionRef: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const res = await client.post<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionRef)}/unclaim`, {});
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `Unclaim failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      console.log(`Released claimed session ${res.data["sessionName"]} from ${res.data["logicalId"]} in rig ${res.data["rigId"]}`);
    });

  return cmd;
}
