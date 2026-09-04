import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_TIMEOUT_MS = 45_000;

export function restoreCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("restore")
    .description("Restore a rig from a snapshot")
    .addHelpText("after", "\nDirect restore: rig restore <snapshotId> --rig <rigId>");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("apply <snapshotId>", { isDefault: true, hidden: true })
    .description("Restore a rig from a snapshot")
    .requiredOption("--rig <rigId>", "Rig ID to restore into")
    .action(async (snapshotId: string, opts: { rig: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const rigId = opts.rig;

      // L3: install a SIGINT/SIGTERM handler that prints an honest message —
      // interrupting the CLI client does NOT stop daemon-side restore work.
      // Cancellation as a daemon protocol is a separate slice; ship the
      // message so operators are not surprised.
      const onSignal = () => {
        console.error("Client interrupt received; daemon-side restore may continue. Use 'rig ps --nodes' or 'rig restore-check' to follow progress.");
        process.exit(1);
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      const res = await client.post<{
        ok?: boolean;
        attemptId?: number;
        status?: string;
        rigId?: string;
        // Pre-restore-started error path keeps the original payload shape.
        rigResult?: string;
        blockers?: RestoreBlocker[];
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
        if ((res.data as { code?: string }).code === "pre_restore_validation_failed") {
          printRestoreNotAttempted(res.data);
          process.exitCode = 1;
          return;
        }
        if ((res.data as { code?: string }).code === "snapshot_unusable") {
          console.error(`Restore refused: ${(res.data as { error?: string }).error ?? "the selected snapshot is not restore-usable"}. Choose a different snapshot.`);
        } else {
          console.error(`Restore conflict: ${(res.data as { error?: string }).error ?? "rig may still be running"}. Stop the rig first with: rig down ${rigId}`);
        }
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`Restore failed: ${(res.data as { error?: string }).error ?? "unknown error"} (HTTP ${res.status}). Check daemon logs or try a different snapshot.`);
        process.exitCode = 1;
      } else if (res.data.attemptId !== undefined) {
        // L3 success path: route returned 202 immediately after restore.started.
        console.log(`Restore attempt id: ${res.data.attemptId}`);
        console.log(`Status: ${res.data.status ?? "started"}`);
        console.log("Daemon is restoring per-node in the background; follow progress with 'rig ps --nodes' or 'rig restore-check'.");
      } else {
        // Defensive: server responded ok=true but didn't include attemptId.
        // Fall back to the legacy summary if it's present (back-compat with
        // pre-L3 daemons during rolling upgrades).
        console.log("Restore complete:");
        if (res.data.rigResult) {
          console.log(`Rig result: ${res.data.rigResult}`);
        }
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
        if (res.data.rigResult === "partially_restored" || res.data.rigResult === "failed" || res.data.rigResult === "not_attempted" || nodes.some((node) => node.status === "failed")) {
          process.exitCode = 1;
        }
      }
    });

  cmd
    .command("status <attemptId>")
    .description("Show the derived current receipt for one restore attempt")
    .requiredOption("--rig <rigId>", "Rig ID containing the restore attempt")
    .option("--json", "JSON output")
    .action(async (attemptId: string, opts: { rig: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.get<{
        ok?: boolean;
        error?: string;
        attemptId?: number;
        snapshotSelection?: { snapshotId: string; mode: string; kind: string; ageMs: number; rationale: string } | null;
        originalResult?: { rigResult: string };
        currentIntendedSetVerdict?: string;
        intendedRoster?: unknown[];
        excludedNodes?: unknown[];
        unresolvedIntendedSeats?: Array<{ logicalId: string; status: string }>;
      }>(`/api/rigs/${encodeURIComponent(opts.rig)}/restore/status/${encodeURIComponent(attemptId)}`);
      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Restore attempt status failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      console.log(`Restore attempt ${res.data.attemptId ?? attemptId}`);
      if (res.data.snapshotSelection) {
        console.log(`Snapshot: ${res.data.snapshotSelection.snapshotId} (${res.data.snapshotSelection.kind}, ${res.data.snapshotSelection.mode})`);
        console.log(`Selection: ${res.data.snapshotSelection.rationale}`);
      }
      console.log(`Original verdict: ${res.data.originalResult?.rigResult ?? "unknown"}`);
      console.log(`Current intended-set verdict: ${res.data.currentIntendedSetVerdict ?? "unknown"}`);
      console.log(`Intended: ${res.data.intendedRoster?.length ?? 0}; excluded historical: ${res.data.excludedNodes?.length ?? 0}; unresolved: ${res.data.unresolvedIntendedSeats?.length ?? 0}`);
      for (const node of res.data.unresolvedIntendedSeats ?? []) console.log(`  ${node.logicalId}: ${node.status}`);
    });

  return cmd;
}

interface RestoreBlocker {
  code: string;
  severity?: string;
  logicalId?: string;
  nodeId?: string;
  target?: string;
  path?: string;
  message: string;
  remediation: string;
}

function printRestoreNotAttempted(data: { rigResult?: string; blockers?: RestoreBlocker[]; error?: string }): void {
  console.error(`Restore blocked: ${data.error ?? "pre-restore validation failed"}`);
  if (data.rigResult) {
    console.error(`Rig result: ${data.rigResult}`);
  }
  printBlockers(data.blockers ?? []);
}

function printBlockers(blockers: RestoreBlocker[]): void {
  for (const blocker of blockers) {
    const scope = blocker.logicalId ?? blocker.nodeId ?? blocker.target ?? blocker.code;
    console.error(`  ${scope}: ${blocker.message}`);
    if (blocker.path) console.error(`    path: ${blocker.path}`);
    console.error(`    remediation: ${blocker.remediation}`);
  }
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
