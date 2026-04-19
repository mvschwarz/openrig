import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_TIMEOUT_MS = 45_000;

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
          console.error("Daemon unhealthy — healthz check failed. Restart with: rig daemon start");
        } else {
          console.error("Daemon not running. Start it with: rig daemon start");
        }
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));
      const rigId = opts.rig;

      const res = await client.post<{
        nodes?: Array<{
          nodeId: string;
          logicalId: string;
          status: string;
          error?: string;
          canonicalSessionName?: string | null;
          tmuxAttachCommand?: string | null;
          resumeCommand?: string | null;
          recoveryGuidance?: {
            summary: string;
            commands: string[];
            notes: string[];
          } | null;
          cwd?: string | null;
        }>;
        attachCommand?: string;
      }>(
        `/api/rigs/${encodeURIComponent(rigId)}/restore/${encodeURIComponent(snapshotId)}`,
        undefined,
        { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
      );

      if (res.status === 404) {
        console.error(`Snapshot "${snapshotId}" or rig "${rigId}" not found. List snapshots with: rig snapshot list --rig ${rigId}`);
        process.exitCode = 1;
      } else if (res.status === 409) {
        console.error(`Restore conflict: ${(res.data as { error?: string }).error ?? "rig may still be running"}. Stop the rig first with: rig down ${rigId}`);
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`Restore failed: ${(res.data as { error?: string }).error ?? "unknown error"} (HTTP ${res.status}). Check daemon logs or try a different snapshot.`);
        process.exitCode = 1;
      } else {
        console.log("Restore complete:");
        const nodes = res.data.nodes ?? [];
        for (const node of nodes) {
          const label = node.status === "failed" && node.error ? `${node.status} — ${node.error}` : node.status;
          console.log(`  ${node.logicalId}: ${label}`);
        }
        printRecoveryGuidance(nodes);
        const attachCommand = (res.data as Record<string, unknown>)["attachCommand"] as string | undefined;
        if (attachCommand) {
          console.log(`Attach: ${attachCommand}`);
        }
        if (nodes.some((node) => node.status === "failed")) {
          process.exitCode = 1;
        }
      }
    });

  return cmd;
}

function printRecoveryGuidance(
  nodes: Array<{
    logicalId: string;
    status: string;
    canonicalSessionName?: string | null;
    tmuxAttachCommand?: string | null;
    recoveryGuidance?: { summary: string; commands: string[]; notes: string[] } | null;
    cwd?: string | null;
  }>,
): void {
  const actionable = nodes.filter((node) =>
    (node.status === "fresh" || node.status === "failed") && node.recoveryGuidance
  );

  if (actionable.length === 0) return;

  console.log("\nRecovery guidance:");
  for (const node of actionable) {
    console.log(`  ${node.logicalId}: ${node.recoveryGuidance!.summary}`);
    if (node.tmuxAttachCommand) {
      console.log(`    attach: ${node.tmuxAttachCommand}`);
    }
    if (node.canonicalSessionName) {
      console.log(`    session: ${node.canonicalSessionName}`);
    }
    if (node.cwd) {
      console.log(`    cwd: ${node.cwd}`);
    }
    for (const command of node.recoveryGuidance!.commands) {
      console.log(`    $ ${command}`);
    }
    for (const note of node.recoveryGuidance!.notes) {
      console.log(`    note: ${note}`);
    }
  }
}
