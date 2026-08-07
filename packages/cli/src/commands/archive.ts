import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ArchiveResult {
  ok: boolean;
  rigId: string;
  archived?: boolean;
}

interface ThreePartErrorBody {
  error:
    | { fact: string; consequence: string; action: string }
    | string;
}

/**
 * `rig archive <rigId>` - OPR.0.3.3.19. Soft, REVERSIBLE archive: hides a rig
 * from the default explorer + `rig ps`, while RETAINING the rigs row, topology,
 * and snapshots. This is NOT `rig down --delete` (which is destructive). Reverse
 * with `rig unarchive <rigId>`. Running/degraded rigs require `--force`.
 */
export function archiveCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("archive").description(
    "Archive a rig (soft + reversible: hides it from the default view, retains all data). NOT a delete; reverse with 'rig unarchive'.",
  );
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rigId>", "Rig identifier to archive")
    .option("--force", "Archive even if the rig is running or degraded")
    .option("--json", "JSON output for agents")
    .action(async (rigId: string, opts: { force?: boolean; json?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<ArchiveResult | ThreePartErrorBody>(
        `/api/rigs/${encodeURIComponent(rigId)}/archive`,
        { force: opts.force ?? false },
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 2 : 1;
        return;
      }

      if (res.status === 404) {
        console.error(`Rig not found: ${rigId}. Check the id with: rig ps`);
        process.exitCode = 1;
        return;
      }
      // AC-6: running/degraded without --force returns a 3-part honest error.
      if (res.status === 409) {
        const err = (res.data as ThreePartErrorBody).error;
        if (err && typeof err === "object") {
          process.stderr.write(`Error: ${err.fact}\n${err.consequence}\n${err.action}\n`);
        } else {
          process.stderr.write(`Error: ${String(err)}\n`);
        }
        process.exitCode = 2;
        return;
      }
      if (res.status >= 400) {
        console.error(`Archive failed (HTTP ${res.status}).`);
        process.exitCode = 2;
        return;
      }

      const r = res.data as ArchiveResult;
      if (r.archived) {
        console.log(`Rig ${rigId} archived (reversible). It is hidden from the default view.`);
        console.log(`  See it with:   rig ps --include-archived`);
        console.log(`  Bring it back: rig unarchive ${rigId}`);
      } else {
        console.log(`Rig ${rigId} was already archived.`);
      }
    });

  return cmd;
}
