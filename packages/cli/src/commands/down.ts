import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
}

const LONG_RUNNING_TIMEOUT_MS = 45_000;

/**
 * `rig down <rigId>` — tear down a rig.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function downCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("down").description("Tear down a rig");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rigId>", "Rig identifier to tear down")
    .option("--delete", "Delete rig record after stopping")
    .option("--force", "Kill sessions immediately")
    .option("--snapshot", "Take snapshot before teardown")
    .option("--json", "JSON output for agents")
    .action(async (rigId: string, opts: { delete?: boolean; force?: boolean; snapshot?: boolean; json?: boolean }) => {
      const deps = getDepsF();

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.post<TeardownResult | { error: string }>("/api/down", {
        rigId,
        delete: opts.delete ?? false,
        force: opts.force ?? false,
        snapshot: opts.snapshot ?? false,
      }, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) {
          process.exitCode = 2;
        } else {
          const r = res.data as TeardownResult;
          if (r.errors && r.errors.length > 0) process.exitCode = 2;
          else if (r.alreadyStopped && !r.deleted) process.exitCode = 1;
        }
        return;
      }

      // HTTP error
      if (res.status >= 400) {
        const errMsg = (res.data as { error: string }).error ?? "unknown error";
        console.error(`Down failed: ${errMsg} (HTTP ${res.status}). Check rig ID with: rig ps`);
        process.exitCode = 2;
        return;
      }

      const result = res.data as TeardownResult;

      // Exit code: errors first, then deleted, then alreadyStopped
      if (result.errors.length > 0) {
        console.log(`Rig ${rigId}: ${result.sessionsKilled} session(s) killed`);
        if (result.deleted) console.log("Rig deleted");
        if (result.snapshotId) console.log(`Snapshot: ${result.snapshotId}`);
        for (const e of result.errors) console.error(`  warning: ${e}`);
        process.exitCode = 2;
        return;
      }

      if (result.deleted) {
        console.log(`Rig ${rigId} deleted. ${result.sessionsKilled} session(s) killed.`);
        if (result.snapshotId) console.log(`Snapshot: ${result.snapshotId}`);
        return;
      }

      if (result.alreadyStopped) {
        console.log(`Rig ${rigId} already stopped`);
        process.exitCode = 1;
        return;
      }

      // Clean stop with post-command handoff
      console.log(`Rig ${rigId} stopped. ${result.sessionsKilled} session(s) killed.`);
      if (result.snapshotId) {
        console.log(`Snapshot: ${result.snapshotId}`);
        // Post-command handoff: how to restore (check for duplicate names)
        const rigName = (res.data as Record<string, unknown>)["rigName"] as string | undefined;
        const isUniqueName = (res.data as Record<string, unknown>)["isUniqueName"] as boolean | undefined;
        if (rigName && isUniqueName !== false) {
          console.log(`To restore: rig up ${rigName}`);
        } else {
          console.log(`To restore: rig restore ${result.snapshotId} --rig ${rigId}`);
        }
      }
    });

  return cmd;
}
