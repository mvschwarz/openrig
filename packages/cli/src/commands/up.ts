import nodePath from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, startDaemon, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function upCommand(depsOverride?: StatusDeps & { lifecycleDeps?: LifecycleDeps }): Command {
  const cmd = new Command("up").description("Bootstrap a rig from a spec or bundle");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<source>", "Path to .yaml rig spec or .rigbundle")
    .option("--plan", "Plan mode — preview without executing")
    .option("--yes", "Auto-approve trusted actions")
    .option("--target <root>", "Target root directory for package installation")
    .option("--json", "JSON output for agents")
    .action(async (source: string, opts: { plan?: boolean; yes?: boolean; target?: string; json?: boolean }) => {
      const deps = getDepsF();

      // Auto-start daemon if not running
      let status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        try {
          await startDaemon({}, deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch {
          console.error("Failed to auto-start daemon. Start manually with: rigged daemon start");
          process.exitCode = 2;
          return;
        }
      }

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rigged daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);

      const res = await client.post<Record<string, unknown>>("/api/up", {
        sourceRef: nodePath.resolve(source),
        plan: opts.plan ?? false,
        autoApprove: opts.yes ?? false,
        targetRoot: opts.target,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }

      if (res.status >= 400) {
        const code = res.data["code"] as string | undefined;
        if (code === "cycle_error") {
          console.error("Cycle detected in rig topology. Check edge definitions for circular dependencies.");
        } else if (code === "validation_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Rig spec validation failed:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: update your rig spec and retry.`);
        } else if (code === "preflight_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Preflight check failed:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: resolve the issues above and retry.`);
        } else {
          console.error(`Up failed: ${res.data["error"] ?? "unknown error"} (HTTP ${res.status}). Check daemon logs or validate your spec with: rigged rig validate <path>`);
        }
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}: ${s.status}`);
        }
        process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }

      // Success output
      const resStatus = res.data["status"] as string;
      const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
      for (const s of stages) {
        console.log(`  ${s.stage}: ${s.status}`);
      }

      const rigId = res.data["rigId"] as string | undefined;
      if (rigId) console.log(`\nRig: ${rigId}`);
      console.log(`Status: ${resStatus}`);

      if (resStatus === "partial") process.exitCode = 1;
    });

  return cmd;
}
