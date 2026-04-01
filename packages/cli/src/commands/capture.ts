import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function captureCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("capture").description("Capture terminal output from agent sessions");
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("[session]", "Session name (omit for multi-target with --rig/--pod)")
    .option("--rig <name>", "Capture all sessions in a rig")
    .option("--pod <name>", "Capture all sessions in a pod")
    .option("--lines <n>", "Number of lines to capture (default: 20)", "20")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rigged capture dev-impl@my-rig
  rigged capture dev-impl@my-rig --lines 50
  rigged capture --rig my-rig
  rigged capture --pod dev --rig my-rig
  rigged capture --rig my-rig --json`)
    .action(async (session: string | undefined, opts: { rig?: string; pod?: string; lines?: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rigged daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);
      const lines = parseInt(opts.lines ?? "20", 10);

      const body: Record<string, unknown> = { lines: isNaN(lines) ? 20 : lines };
      if (opts.rig) body.rig = opts.rig;
      if (opts.pod) body.pod = opts.pod;
      if (session) body.session = session;

      const res = await client.post<Record<string, unknown>>("/api/transport/capture", body);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Capture failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      // Multi-target result
      const results = (res.data as Record<string, unknown>)["results"] as Array<{ sessionName: string; content?: string; ok: boolean; error?: string }> | undefined;
      if (results) {
        for (const r of results) {
          console.log(`--- ${r.sessionName} ---`);
          if (r.ok && r.content) {
            console.log(r.content);
          } else {
            console.log(`  (error: ${r.error ?? "no content"})`);
          }
        }
        return;
      }

      // Single target result
      const content = (res.data as Record<string, unknown>)["content"] as string | undefined;
      if (content) {
        console.log(content);
      }
    });

  return cmd;
}
