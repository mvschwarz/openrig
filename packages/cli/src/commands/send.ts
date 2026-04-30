import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";

const WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS = 5_000;

export interface SendDeps extends StatusDeps {
  /**
   * Cross-host hooks. Both default to the production loaders/executors; tests
   * inject in-package mocks so no real ssh / no real ~/.ssh / no real network
   * is touched.
   */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

export function sendCommand(depsOverride?: SendDeps): Command {
  const cmd = new Command("send").description("Send a message to an agent's terminal");
  const getDeps = (): SendDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<session>", "Target session name (e.g. dev-impl@my-rig)")
    .argument("<text>", "Message text to send")
    .option("--verify", "Verify pane only delivery by checking content after send")
    .option("--force", "Send even if target pane appears mid-task")
    .option("--wait-for-idle <seconds>", "Wait until the target is explicitly idle before sending")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml (CLI-side ssh shell-out)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig send dev-impl@my-rig "Context update: QA approved. Proceed."
  rig send dev-impl@my-rig "message" --verify
  rig send dev-impl@my-rig "safe proof prompt" --wait-for-idle 30 --verify
  rig send dev-impl@my-rig "Stop and read the spec." --force
  rig send dev-impl@my-rig "message" --json
  rig send --host vm-claude-test dev-impl@my-rig "remote message" --verify

The two-step send pattern (paste text, wait, submit Enter) is handled
automatically. Use --wait-for-idle to send only after explicit idle evidence;
it fails closed on attention prompts, unknown activity, or timeout. Use --verify
to confirm the message appeared in the pane only; it is not agent acknowledgement.
Use --force to override mid-task safety checks without wait mode.

--host runs the same command on a remote host declared in ~/.openrig/hosts.yaml
via single-hop ssh. SSH success is NOT verify success: the remote rig's
'Verified: yes/no' line is what counts and is surfaced verbatim.`)
    .action(async (session: string, text: string, opts: { verify?: boolean; force?: boolean; waitForIdle?: string; host?: string; json?: boolean }) => {
      const waitForIdleMs = parseWaitForIdleMs(opts.waitForIdle);
      if (opts.force && waitForIdleMs !== undefined) {
        console.error("--wait-for-idle cannot be combined with --force");
        process.exitCode = 1;
        return;
      }
      if (waitForIdleMs === null) {
        console.error("--wait-for-idle must be a positive number of seconds");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();

      // --- Cross-host short-circuit (CLI-side ssh shell-out; daemon untouched) ---
      if (opts.host) {
        await runCrossHostSend(opts.host, session, text, opts, deps);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<Record<string, unknown>>("/api/transport/send", {
        session, text, verify: opts.verify, force: opts.force, waitForIdleMs,
      }, waitForIdleRequestOptions(waitForIdleMs));

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

async function runCrossHostSend(
  hostId: string,
  session: string,
  text: string,
  opts: { verify?: boolean; force?: boolean; waitForIdle?: string; json?: boolean },
  deps: SendDeps,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const runner = deps.crossHostRun ?? runCrossHostCommand;

  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  // Reconstruct argv for the remote `rig send` invocation. Order is positional
  // first so the remote Commander parses it the same way local does.
  const argv: string[] = ["rig", "send", session, text];
  if (opts.verify) argv.push("--verify");
  if (opts.force) argv.push("--force");
  if (opts.waitForIdle !== undefined) argv.push("--wait-for-idle", opts.waitForIdle);
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: host.target },
      result,
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(`[via host=${host.id} (${host.target})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, host.target, result, opts.json);
}

function parseWaitForIdleMs(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000);
}

function waitForIdleRequestOptions(waitForIdleMs: number | undefined): { timeoutMs: number } | undefined {
  if (waitForIdleMs === undefined) return undefined;
  return { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS };
}
