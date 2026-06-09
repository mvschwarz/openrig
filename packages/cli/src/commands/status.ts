import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { DaemonClient } from "../client.js";
import {
  getDaemonStatus,
  getDaemonUrl,
  type LifecycleDeps,
} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import { ConfigStore } from "../config-store.js";

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

    const client = deps.clientFactory(getDaemonUrl(status));

    // Fetch summary + cmux + kernel readiness
    const [summaryRes, cmuxRes, kernelRes] = await Promise.all([
      client.get<Array<{ id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null }>>("/api/rigs/summary"),
      client.get<{ available: boolean }>("/api/adapters/cmux/status").catch(() => null),
      client.get<{ kernel_state?: string; error?: string }>("/api/kernel/status").catch(() => null),
    ]);

    console.log(`Daemon running on port ${status.port}`);

    // OPR.0.3.3.04.2 (AC-2): kernel readiness is a DISTINCT signal from daemon
    // health - the kernel rig auto-boots on daemon-start, and a daemon can be up
    // while the kernel is not yet ready (or a kernel agent is unhealthy). Surface
    // it as "here's what's currently true," never as a guarantee that downstream
    // agents are healthy.
    if (kernelRes && kernelRes.status === 200 && kernelRes.data?.kernel_state) {
      console.log(`Kernel: ${kernelRes.data.kernel_state} (boots on daemon-start; distinct from daemon health)`);
    } else if (kernelRes && kernelRes.status === 503) {
      console.log("Kernel: not tracked (no kernel-boot tracker wired)");
    } else {
      console.log("Kernel: unknown (status unavailable)");
    }

    // OPR.0.3.3.04.2 (AC-2 / gap #7): surface WHICH workspace root is effective
    // and whether it is the default or an override - the operator never guesses.
    // This reports what is currently live, NOT that any root is the right one.
    try {
      const resolved = new ConfigStore().resolveWithSource("workspace.root");
      const origin = resolved.source === "default" ? "default" : `override via ${resolved.source}`;
      console.log(`Workspace root: ${resolved.value} (${origin})`);
    } catch {
      // config resolution unavailable - omit rather than guess.
    }

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

    // OPR.0.3.3.04.2 (AC-1): reinforcing HINT back to the one canonical ordered
    // path - status does not re-author the sequence (that lives in `rig setup`
    // next-steps + docs/reference/getting-started.md).
    if (rigs.length === 0) {
      console.log("\nNext: launch a rig with `rig up <rig-spec>`. Guided path: `rig setup` output or docs/reference/getting-started.md");
    }
  });

  return cmd;
}
