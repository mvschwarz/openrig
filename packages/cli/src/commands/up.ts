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
          await startDaemon(deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch {
          console.error("Failed to auto-start daemon");
          process.exitCode = 2;
          return;
        }
      }

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);

      const res = await client.post<Record<string, unknown>>("/api/up", {
        sourceRef: source,
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
        console.error(res.data["error"] ?? "Up failed");
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
