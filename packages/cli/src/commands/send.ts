import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function sendCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("send").description("Send a message to an agent's terminal");
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<session>", "Target session name (e.g. dev-impl@my-rig)")
    .argument("<text>", "Message text to send")
    .option("--verify", "Verify delivery by checking pane content after send")
    .option("--force", "Send even if target pane appears mid-task")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig send dev-impl@my-rig "Context update: QA approved. Proceed."
  rig send dev-impl@my-rig "message" --verify
  rig send dev-impl@my-rig "Stop and read the spec." --force
  rig send dev-impl@my-rig "message" --json

The two-step send pattern (paste text, wait, submit Enter) is handled
automatically. Use --verify to confirm the message appeared in the pane.
Use --force to override mid-task safety checks.`)
    .action(async (session: string, text: string, opts: { verify?: boolean; force?: boolean; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<Record<string, unknown>>("/api/transport/send", {
        session, text, verify: opts.verify, force: opts.force,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      if (res.status >= 400) {
        const error = res.data["error"] as string | undefined;
        console.error(error ?? `Send failed (HTTP ${res.status})`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      console.log(`Sent to ${session}`);
      if (opts.verify) {
        const verified = res.data["verified"] as boolean | undefined;
        console.log(`Verified: ${verified ? "yes" : "no"}`);
      }
    });

  return cmd;
}
