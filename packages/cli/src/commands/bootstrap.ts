import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

function logStageDetailErrors(data: Record<string, unknown>) {
  const stages = (data["stages"] as Array<{ stage: string; status: string; detail?: unknown }>) ?? [];
  for (const stage of stages) {
    if (stage.status !== "failed" && stage.status !== "blocked") continue;
    if (!stage.detail || typeof stage.detail !== "object") continue;
    const detail = stage.detail as Record<string, unknown>;
    const nestedErrors = Array.isArray(detail["errors"]) ? detail["errors"] as string[] : [];
    for (const err of nestedErrors) {
      console.error(`  DETAIL: ${err}`);
    }
    if (nestedErrors.length === 0 && typeof detail["error"] === "string") {
      console.error(`  DETAIL: ${detail["error"]}`);
    }
  }
}

export function bootstrapCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("bootstrap").description("Bootstrap a rig from a spec file");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running");
      return null;
    }
    return deps.clientFactory(`http://127.0.0.1:${status.port}`);
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

        if (opts.json) {
          console.log(JSON.stringify(res.data));
        } else if (res.status === 200) {
          const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
          console.log("BOOTSTRAP PLAN");
          for (const s of stages) {
            console.log(`  ${s.stage}: ${s.status}`);
          }
          const actionKeys = (res.data["actionKeys"] as string[]) ?? [];
          if (actionKeys.length > 0) {
            console.log(`\n  ${actionKeys.length} action(s) pending approval`);
          }
        } else {
          const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
          for (const s of stages) {
            console.log(`  ${s.stage}: ${s.status}`);
          }
          const errors = (res.data["errors"] as string[]) ?? [];
          if (errors.length > 0) {
            for (const e of errors) {
              console.error(`  ERROR: ${e}`);
            }
          } else if (typeof res.data["error"] === "string") {
            console.error(`  ERROR: ${res.data["error"]}`);
          }
          logStageDetailErrors(res.data);
        }
        if (res.status === 409) process.exitCode = 1;
        else if (res.status >= 400) process.exitCode = 2;
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
        logStageDetailErrors(res.data);
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
