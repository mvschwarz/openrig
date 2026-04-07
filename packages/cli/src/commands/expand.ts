import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ExpandResult {
  ok: boolean;
  status?: "ok" | "partial" | "failed";
  podId?: string;
  podNamespace?: string;
  nodes?: Array<{ logicalId: string; nodeId: string; status: string; error?: string; sessionName?: string }>;
  warnings?: string[];
  retryTargets?: string[];
  code?: string;
  error?: string;
}

export function expandCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("expand").description("Add a pod to a running rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rig-id>", "ID of the target rig")
    .argument("<pod-fragment-path>", "Path to YAML pod fragment file")
    .option("--json", "JSON output for agents")
    .option("--rig-root <path>", "Root directory for agent resolution")
    .action(async (rigId: string, fragmentPath: string, opts: { json?: boolean; rigRoot?: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      // Read and parse YAML fragment
      let fileContent: string;
      try {
        fileContent = readFileSync(fragmentPath, "utf-8");
      } catch (err) {
        console.error(`Cannot read file: ${fragmentPath}`);
        process.exitCode = 1;
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        // Dynamic import to avoid bundling yaml at module load
        const { parse } = await import("yaml");
        parsed = parse(fileContent) as Record<string, unknown>;
      } catch {
        console.error("Invalid YAML in pod fragment file");
        process.exitCode = 1;
        return;
      }

      // Extract pod and optional crossPodEdges from the fragment
      const pod = parsed["pod"] ?? parsed;
      const crossPodEdges = parsed["crossPodEdges"] as unknown[] | undefined;

      const body: Record<string, unknown> = { pod };
      if (crossPodEdges) body["crossPodEdges"] = crossPodEdges;
      if (opts.rigRoot) body["rigRoot"] = opts.rigRoot;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<ExpandResult>(`/api/rigs/${encodeURIComponent(rigId)}/expand`, body);

      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        if (res.status >= 400 || (data.ok && data.status !== "ok")) process.exitCode = 1;
        return;
      }

      if (res.status >= 400 || !data.ok) {
        console.error(data.error ?? `Expansion failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      // Human-readable output
      console.log(`Expanded rig ${rigId}`);
      console.log(`  Pod: ${data.podNamespace}`);
      console.log(`  Status: ${data.status}`);
      console.log("");

      if (data.nodes && data.nodes.length > 0) {
        console.log("  Nodes:");
        for (const node of data.nodes) {
          const icon = node.status === "launched" ? "OK" : "FAIL";
          const session = node.sessionName ? ` (${node.sessionName})` : "";
          const error = node.error ? ` — ${node.error}` : "";
          console.log(`    [${icon}] ${node.logicalId}${session}${error}`);
        }
      }

      if (data.warnings && data.warnings.length > 0) {
        console.log("");
        for (const w of data.warnings) console.log(`  Warning: ${w}`);
      }

      // Honest retry guidance for failed nodes
      if (data.retryTargets && data.retryTargets.length > 0) {
        console.log("");
        console.log("  Failed nodes can be relaunched via the dashboard or CLI:");
        for (const target of data.retryTargets) {
          console.log(`    rig launch ${rigId} ${target}`);
        }
      }

      if (data.status !== "ok") {
        process.exitCode = 1;
      }
    });

  return cmd;
}
