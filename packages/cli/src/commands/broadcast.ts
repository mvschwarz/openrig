import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function broadcastCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("broadcast").description("Send a message to multiple agent sessions");
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<text>", "Message text to broadcast")
    .option("--rig <name>", "Broadcast to all sessions in a rig")
    .option("--pod <name>", "Broadcast to all sessions in a pod")
    .option("--force", "Send even if targets appear mid-task")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rigged broadcast --rig my-rig "Checkpoint review complete. Resume work."
  rigged broadcast --pod dev "New task spec at docs/planning/next-task.md"
  rigged broadcast "System maintenance in 5 minutes."
  rigged broadcast --rig my-rig "message" --json

Without --rig or --pod, broadcasts to ALL running sessions across all rigs.`)
    .action(async (text: string, opts: { rig?: string; pod?: string; force?: boolean; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rigged daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);
      const body: Record<string, unknown> = { text, force: opts.force };
      if (opts.rig) body.rig = opts.rig;
      if (opts.pod) body.pod = opts.pod;

      const res = await client.post<Record<string, unknown>>("/api/transport/broadcast", body);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Broadcast failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      const data = res.data as Record<string, unknown>;
      const results = (data["results"] as Array<{ sessionName: string; ok: boolean; error?: string }>) ?? [];
      for (const r of results) {
        if (r.ok) {
          console.log(`${r.sessionName}: sent`);
        } else {
          console.log(`${r.sessionName}: FAILED — ${r.error ?? "unknown error"}`);
        }
      }
      console.log(`${data["sent"]}/${data["total"]} delivered`);

      if ((data["failed"] as number) > 0) {
        process.exitCode = 1;
      }
    });

  return cmd;
}
