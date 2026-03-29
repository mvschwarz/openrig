import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function discoverCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("discover").description("Scan for unmanaged tmux sessions");
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
    .option("--json", "Output as parseable JSON")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{ sessions?: Array<Record<string, unknown>>; error?: string }>("/api/discovery/scan", {});

      if (res.status >= 400) {
        console.error(res.data.error ?? `Scan failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        return;
      }

      const sessions = res.data.sessions ?? [];
      if (sessions.length === 0) {
        console.log("No unmanaged sessions discovered.");
        return;
      }

      console.log("DISCOVERED SESSIONS");
      for (const s of sessions) {
        const hint = String(s["runtimeHint"] ?? "unknown").padEnd(12);
        const conf = String(s["confidence"] ?? "").padEnd(8);
        console.log(`  ${s["id"]}  ${hint} ${conf} ${s["tmuxSession"]}:${s["tmuxPane"]}  ${s["cwd"] ?? ""}`);
      }
    });

  return cmd;
}
