import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function transcriptCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("transcript").description("Read agent transcript output");
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<session>", "Session name (e.g. dev-impl@my-rig)")
    .option("--tail <lines>", "Show last N lines (default: 50)", "50")
    .option("--grep <pattern>", "Search for lines matching pattern (regex)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rigged transcript dev-impl@my-rig --tail 100
  rigged transcript dev-impl@my-rig --grep "decision|architecture"
  rigged transcript dev-impl@my-rig --json`)
    .action(async (session: string, opts: { tail?: string; grep?: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rigged daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);

      // --grep takes precedence over --tail when both given
      const useGrep = !!opts.grep;
      let res: { status: number; data: Record<string, unknown> };

      if (useGrep) {
        res = await client.get<Record<string, unknown>>(
          `/api/transcripts/${encodeURIComponent(session)}/grep?pattern=${encodeURIComponent(opts.grep!)}`,
        );
      } else {
        const lines = parseInt(opts.tail ?? "50", 10);
        res = await client.get<Record<string, unknown>>(
          `/api/transcripts/${encodeURIComponent(session)}/tail?lines=${isNaN(lines) ? 50 : lines}`,
        );
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Transcript request failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      if (useGrep) {
        const matches = (res.data as Record<string, unknown>)["matches"] as string[] | undefined;
        if (matches && matches.length > 0) {
          for (const line of matches) {
            console.log(line);
          }
        } else {
          console.log("No matches found.");
        }
      } else {
        const content = (res.data as Record<string, unknown>)["content"] as string | undefined;
        if (content) {
          // Print each line via console.log for consistent capture in tests and terminal
          const lines = content.split("\n");
          for (const line of lines) {
            if (line) console.log(line);
          }
        }
      }
    });

  return cmd;
}
