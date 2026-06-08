import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface UnarchiveResult {
  ok: boolean;
  rigId: string;
  unarchived?: boolean;
}

/**
 * `rig unarchive <rigId>` - OPR.0.3.3.19. Reverse of `rig archive`: clears the
 * `archived_at` flag so the rig returns to the default explorer + `rig ps` view.
 * Always non-destructive (the row and snapshots were retained while archived);
 * no `--force` and no running-rig guard - unarchiving only makes a rig visible.
 */
export function unarchiveCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("unarchive").description(
    "Unarchive a rig (reverse of 'rig archive'): returns it to the default view. Always safe.",
  );
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rigId>", "Rig identifier to unarchive")
    .option("--json", "JSON output for agents")
    .action(async (rigId: string, opts: { json?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<UnarchiveResult | { error: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/unarchive`,
        {},
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status === 404) {
        console.error(`Rig not found: ${rigId}. List archived rigs with: rig ps --include-archived`);
        process.exitCode = 1;
        return;
      }
      if (res.status >= 400) {
        console.error(`Unarchive failed (HTTP ${res.status}).`);
        process.exitCode = 2;
        return;
      }

      const r = res.data as UnarchiveResult;
      if (r.unarchived) {
        console.log(`Rig ${rigId} unarchived. It is back in the default view.`);
      } else {
        console.log(`Rig ${rigId} was not archived.`);
      }
    });

  return cmd;
}
