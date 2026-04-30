import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";

export interface CaptureDeps extends StatusDeps {
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

export function captureCommand(depsOverride?: CaptureDeps): Command {
  const cmd = new Command("capture").description("Capture terminal output from agent sessions");
  const getDeps = (): CaptureDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("[session]", "Session name (omit for multi-target with --rig/--pod)")
    .option("--rig <name>", "Capture all sessions in a rig")
    .option("--pod <name>", "Capture all sessions in a pod")
    .option("--lines <n>", "Number of lines to capture (default: 20)", "20")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml (CLI-side ssh shell-out)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig capture dev-impl@my-rig
  rig capture dev-impl@my-rig --lines 50
  rig capture --rig my-rig
  rig capture --pod dev --rig my-rig
  rig capture --rig my-rig --json
  rig capture --host vm-claude-test dev-impl@my-rig --lines 50

Supported notes:
  - Multi-target capture reports unsupported external_cli nodes as explicit per-target failures.
  - For outbound-only external_cli nodes, use rig whoami/rig ps instead of rig capture.
  - --host runs the same command on a remote host declared in ~/.openrig/hosts.yaml
    via single-hop ssh. The remote rig is authoritative on what it can capture.`)
    .action(async (session: string | undefined, opts: { rig?: string; pod?: string; lines?: string; host?: string; json?: boolean }) => {
      const deps = getDeps();

      // --- Cross-host short-circuit (CLI-side ssh shell-out; daemon untouched) ---
      if (opts.host) {
        await runCrossHostCapture(opts.host, session, opts, deps);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));
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

async function runCrossHostCapture(
  hostId: string,
  session: string | undefined,
  opts: { rig?: string; pod?: string; lines?: string; json?: boolean },
  deps: CaptureDeps,
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

  // Reconstruct argv. Order: positional first, then flags.
  const argv: string[] = ["rig", "capture"];
  if (session) argv.push(session);
  if (opts.rig) argv.push("--rig", opts.rig);
  if (opts.pod) argv.push("--pod", opts.pod);
  if (opts.lines !== undefined) argv.push("--lines", opts.lines);
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

