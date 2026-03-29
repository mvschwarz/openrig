import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function snapshotCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("snapshot").description("Manage rig snapshots");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      if (status.state === "running" && status.healthy === false) {
        console.error("Daemon unhealthy — healthz failed");
      } else {
        console.error("Daemon not running");
      }
      return null;
    }
    return deps.clientFactory(`http://127.0.0.1:${status.port}`);
  }

  // rigged snapshot <rigId> — default action creates a snapshot
  cmd
    .argument("<rigId>", "Rig ID to snapshot")
    .action(async (rigId: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{ id: string }>(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`);
      if (res.status === 404) {
        console.error(`Rig '${rigId}' not found`);
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`Snapshot failed: ${(res.data as { error?: string }).error ?? "unknown error"}`);
        process.exitCode = 1;
      } else {
        console.log(`Snapshot created: ${res.data.id}`);
      }
    });

  // rigged snapshot list <rigId>
  cmd
    .command("list <rigId>")
    .description("List snapshots for a rig")
    .action(async (rigId: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.get<Array<{ id: string; kind: string; status: string; createdAt: string }>>(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`);
      if (res.status >= 400) {
        console.error(`Failed to list snapshots: ${(res.data as { error?: string }).error ?? "unknown error"}`);
        process.exitCode = 1;
        return;
      }

      const snapshots = res.data;
      if (snapshots.length === 0) {
        console.log("No snapshots");
        return;
      }

      console.log("ID                         Kind    Status    Created");
      for (const snap of snapshots) {
        console.log(`${snap.id.padEnd(27)} ${snap.kind.padEnd(8)} ${snap.status.padEnd(10)} ${snap.createdAt}`);
      }
    });

  return cmd;
}
