import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function requirementsCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("requirements").description("Check requirements for a rig spec");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running");
      return null;
    }
    return deps.clientFactory(`http://localhost:${status.port}`);
  }

  cmd
    .argument("<spec>", "Path to rig spec YAML file")
    .option("--json", "Output as parseable JSON")
    .action(async (spec: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<Record<string, unknown>>("/api/bootstrap/plan", { sourceRef: spec });

      if (res.status >= 500) {
        console.error(res.data["errors"] ?? res.data["error"] ?? "Failed to check requirements");
        process.exitCode = 2;
        return;
      }

      const stages = (res.data["stages"] as Array<{ stage: string; status: string; detail: unknown }>) ?? [];
      const reqStage = stages.find((s) => s.stage === "probe_requirements");
      const planStage = stages.find((s) => s.stage === "build_install_plan");
      const detail = reqStage?.detail as { probed: number; results?: Array<{ name: string; kind: string; status: string; detectedPath: string | null }> } | undefined;

      if (opts.json) {
        const results = detail?.results ?? [];
        const allMet = results.length === 0 || results.every((r) => r.status === "installed");
        console.log(JSON.stringify({ requirements: reqStage?.detail, installPlan: planStage?.detail }));
        if (!allMet) process.exitCode = 1;
        return;
      }

      if (!detail?.results || detail.results.length === 0) {
        console.log("No requirements declared.");
        return;
      }

      console.log("REQUIREMENTS");
      let allMet = true;
      for (const r of detail.results) {
        const statusIcon = r.status === "installed" ? "OK" : r.status === "missing" ? "MISSING" : r.status.toUpperCase();
        console.log(`  ${statusIcon.padEnd(12)} ${r.kind.padEnd(16)} ${r.name}${r.detectedPath ? ` (${r.detectedPath})` : ""}`);
        if (r.status !== "installed") allMet = false;
      }

      if (allMet) {
        console.log("\nAll requirements met.");
      } else {
        console.log("\nSome requirements not met.");
        process.exitCode = 1;
      }
    });

  return cmd;
}
