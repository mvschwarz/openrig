import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { DaemonClient } from "../client.js";
import {
  getDaemonStatus,
  type LifecycleDeps,
} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

export interface StatusDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (baseUrl: string) => DaemonClient;
}

function formatSnapshotAge(snapshotAt: string | null): string {
  if (!snapshotAt) return "none";
  const now = Date.now();
  const then = new Date(snapshotAt).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function statusCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("status").description("Show rig status");

  cmd.action(async () => {
    const deps = depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
    };

    const status = await getDaemonStatus(deps.lifecycleDeps);

    if (status.state === "stopped" || status.state === "stale") {
      console.log("Daemon not running");
      return;
    }

    // state === "running"
    if (status.healthy === false) {
      console.log(`Daemon running (pid ${status.pid}) but unhealthy — healthz failed`);
      return;
    }

    const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);

    // Fetch summary + cmux status
    const [summaryRes, cmuxRes] = await Promise.all([
      client.get<Array<{ id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null }>>("/api/rigs/summary"),
      client.get<{ available: boolean }>("/api/adapters/cmux/status").catch(() => null),
    ]);

    console.log(`Daemon running on port ${status.port}`);

    if (summaryRes.status !== 200) {
      console.error(`Failed to fetch rig summary (HTTP ${summaryRes.status})`);
      process.exitCode = 1;
      return;
    }

    const rigs = summaryRes.data;
    if (rigs.length === 0) {
      console.log("No rigs");
    } else {
      console.log(`${rigs.length} rig(s):`);
      for (const rig of rigs) {
        const snap = formatSnapshotAge(rig.latestSnapshotAt);
        console.log(`  ${rig.name}  ${rig.nodeCount} node(s)  snapshot: ${snap}`);
      }
    }

    // cmux status
    const cmuxAvailable = cmuxRes?.data?.available ?? false;
    console.log(`cmux: ${cmuxAvailable ? "available" : "unavailable"}`);
  });

  return cmd;
}
