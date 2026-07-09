import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { resolveCrossHostTarget } from "../cross-host-target.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";

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
    .option("--host <id>", "Capture on a remote host declared in ~/.openrig/hosts.yaml (ssh hosts shell out; http hosts go CLI-direct to the remote daemon)")
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
  - --host captures on a remote host declared in ~/.openrig/hosts.yaml. The host
    entry's transport decides the path: ssh hosts via single-hop ssh; http hosts
    (e.g. pair-registered) CLI-direct to the remote daemon's capture route. The
    remote is authoritative on what it can capture either way. A session of the
    form agent@rig@host is sugar for --host when the suffix is a REGISTERED
    host id (explicit --host > sugar > persisted selection).`)
    .action(async (session: string | undefined, opts: { rig?: string; pod?: string; lines?: string; host?: string; json?: boolean }) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly. OPR.0.4.6.MH4 §4: the raw flag is kept
      // so the target sugar slots BETWEEN explicit and selection.
      const explicitHost = opts.host;
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();

      // OPR.0.4.6.MH4 §4 — `agent@rig@host` target sugar (session operand
      // only; --rig/--pod values are names, never sugar-parsed). Suffix must
      // match a REGISTERED host id, else passthrough + loud-failure hint.
      let crossHostHint: string | undefined;
      if (session !== undefined) {
        const targetResolution = resolveCrossHostTarget(session, explicitHost, deps.hostRegistryLoader);
        if (!targetResolution.ok) {
          console.error(targetResolution.error);
          process.exitCode = 1;
          return;
        }
        session = targetResolution.target;
        crossHostHint = targetResolution.hint;
        opts.host = explicitHost ?? targetResolution.sugarHost ?? opts.host;
      }

      // --- Cross-host short-circuit (CLI-side; ssh shell-out or the MH-4 http branch; daemon untouched) ---
      if (opts.host) {
        await runCrossHostCapture(opts.host, session, opts, deps, crossHostHint);
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

      const res = await client.post<Record<string, unknown>>("/api/transport/capture", body, { headers: terminalAuthHeaders() });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Capture failed (HTTP ${res.status})`);
        // MH-4 §4 loud-failure hint: 3-part-shaped target, unregistered suffix.
        if (crossHostHint) console.error(`hint: ${crossHostHint}`);
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
  hint?: string,
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
    emitCrossHostError(hostId, "unknown-host", hint ? `${resolved.error} (${hint})` : resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  // OPR.0.4.6.MH4 — the http transport branch: CLI-direct POST to the
  // remote daemon's shipped /api/transport/capture with the SAME body the
  // local path posts. ssh hosts fall through to the shell-out verbatim.
  if (host.transport === "http") {
    await runHttpHostCapture(host, session, opts, deps, hint);
    return;
  }

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
      cross_host: { host: host.id, target: hostDisplayTarget(host) },
      result,
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, opts.json);
}

/**
 * OPR.0.4.6.MH4 C1 — cross-host capture over http, CLI-DIRECT to the remote
 * daemon's shipped POST /api/transport/capture (zero daemon-side changes).
 * Body parity with the local path (lines/rig/pod/session); the remote's
 * single/multi result renders exactly as a local capture does, under the
 * `[via host=…]` banner. Read-class deadline (the client default).
 */
async function runHttpHostCapture(
  host: HttpHostEntry,
  session: string | undefined,
  opts: { rig?: string; pod?: string; lines?: string; json?: boolean },
  deps: CaptureDeps,
  hint?: string,
): Promise<void> {
  const lines = parseInt(opts.lines ?? "20", 10);
  const body: Record<string, unknown> = { lines: isNaN(lines) ? 20 : lines };
  if (opts.rig) body.rig = opts.rig;
  if (opts.pod) body.pod = opts.pod;
  if (session) body.session = session;

  const result = await runRemoteHttpOp(host.id, "POST", "/api/transport/capture", body, deps, {});

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host), transport: "http" },
      result,
      ...(!result.ok && hint ? { hint } : {}),
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    emitRemoteHttpFailure(host.id, hostDisplayTarget(host), result, false, hint);
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  const data = (result.data ?? {}) as Record<string, unknown>;

  // Multi-target result — rendered exactly as the local path renders it.
  const results = data["results"] as Array<{ sessionName: string; content?: string; ok: boolean; error?: string }> | undefined;
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
  const content = data["content"] as string | undefined;
  if (content) {
    console.log(content);
  }
}

