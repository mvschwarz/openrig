import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { rigIdForHandle } from "../rig-handle.js";

export function snapshotCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("snapshot").description("Manage rig snapshots");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // rig snapshot <rigId> — default action creates a snapshot
  cmd
    .argument("<rig>", "Rig name or ID to snapshot")
    .option("--intended-seats <ids>", "Comma-separated intended topology roster stored with the snapshot")
    .action(async (rigId: string, opts: { intendedSeats?: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const target = await rigIdForHandle(client, rigId);
      if (!target.ok) { console.error(target.message); process.exitCode = 1; return; }

      const intendedSeats = opts.intendedSeats?.split(",").map((seat) => seat.trim()).filter(Boolean);
      const res = await client.post<{ id: string }>(
        `/api/rigs/${encodeURIComponent(target.id)}/snapshots`,
        intendedSeats ? { intendedSeats } : undefined,
      );
      if (res.status === 404) {
        console.error(`Rig '${rigId}' not found`);
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`Snapshot failed: ${(res.data as { error?: string }).error ?? "unknown error"}`);
        process.exitCode = 1;
      } else {
        console.log(`Snapshot created: ${res.data.id}`);
        console.log(`To restore: rig restore ${res.data.id} --rig ${target.id}`);
      }
    });

  // rig snapshot list <rig>
  cmd
    .command("list <rig>")
    .description("List snapshots for a rig")
    .action(async (rigId: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const target = await rigIdForHandle(client, rigId);
      if (!target.ok) { console.error(target.message); process.exitCode = 1; return; }

      const res = await client.get<Array<{ id: string; kind: string; status: string; createdAt: string }>>(`/api/rigs/${encodeURIComponent(target.id)}/snapshots`);
      if (res.status >= 400) {
        console.error(`Failed to list snapshots: ${(res.data as { error?: string }).error ?? "unknown error"}`);
        process.exitCode = 1;
        return;
      }

      const snapshots = res.data;
      // The daemon lists snapshots by exact rig id and answers [] for an id it has none for, so an unknown
      // handle would read as a rig with no snapshots. Snapshots kept under a removed rig's id still list.
      if (snapshots.length === 0 && !target.known) {
        console.error(`Rig '${rigId}' not found: no rig has that name or id. List rigs with: rig ps`);
        process.exitCode = 1;
        return;
      }
      if (snapshots.length === 0) {
        console.log("No snapshots");
        return;
      }

      // Size each column to its widest value, so a long kind such as auto-pre-down (every rig down makes one)
      // keeps Status and Created in their columns.
      const header = ["ID", "Kind", "Status", "Created"];
      const rows = snapshots.map((snap) => [snap.id, snap.kind, snap.status, snap.createdAt]);
      // A reduce, not Math.max(...rows): a long snapshot history must not hit the argument-count limit.
      const widths = header.map((title, i) => rows.reduce((width, row) => Math.max(width, row[i]!.length), title.length));
      const line = (cells: string[]) => cells.map((cell, i) => (i < cells.length - 1 ? cell.padEnd(widths[i]!) : cell)).join("  ");
      console.log(line(header));
      for (const row of rows) console.log(line(row));
    });

  return cmd;
}
