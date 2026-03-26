import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function bootstrapCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("bootstrap").description("Bootstrap a rig from a spec file");
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
    .option("--plan", "Plan mode — show reviewed plan without executing")
    .option("--yes", "Auto-approve trusted deterministic actions")
    .option("--json", "Output as parseable JSON")
    .action(async (spec: string, opts: { plan?: boolean; yes?: boolean; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      if (opts.plan) {
        // Plan mode
        const res = await client.post<Record<string, unknown>>("/api/bootstrap/plan", { sourceRef: spec });

        if (res.status >= 500) {
          if (opts.json) { console.log(JSON.stringify(res.data)); }
          else { console.error(res.data["errors"] ?? res.data["error"] ?? "Plan failed"); }
          process.exitCode = 2;
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(res.data));
        } else {
          const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
          console.log("BOOTSTRAP PLAN");
          for (const s of stages) {
            console.log(`  ${s.stage}: ${s.status}`);
          }
          const actionKeys = (res.data["actionKeys"] as string[]) ?? [];
          if (actionKeys.length > 0) {
            console.log(`\n  ${actionKeys.length} action(s) pending approval`);
          }
        }
        return;
      }

      // Apply mode
      const res = await client.post<Record<string, unknown>>("/api/bootstrap/apply", {
        sourceRef: spec,
        autoApprove: opts.yes ?? false,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        const status = res.data["status"] as string;
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}: ${s.status}`);
        }
        const rigId = res.data["rigId"] as string | undefined;
        if (rigId) console.log(`\nRig: ${rigId}`);
        console.log(`Status: ${status}`);

        const errors = (res.data["errors"] as string[]) ?? [];
        if (errors.length > 0) {
          for (const e of errors) {
            console.error(`  ERROR: ${e}`);
          }
        }
      }

      const resultStatus = (res.data["status"] as string) ?? "";
      if (res.status === 409) {
        process.exitCode = 1; // blocked
      } else if (res.status >= 500) {
        process.exitCode = 2; // failure
      } else if (resultStatus === "partial") {
        process.exitCode = 1; // partial is not clean success
      }
    });

  return cmd;
}
