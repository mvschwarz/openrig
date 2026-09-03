import { Command } from "commander";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fetchWithTimeout } from "../fetch-with-timeout.js";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  getDaemonUrl,
  readLogs,
  tailLogs,
  type LifecycleDeps,
  OPENRIG_DIR,
  resolveBindIntent,
} from "../daemon-lifecycle.js";

interface ProcessAliveDeps {
  signalCheck: (pid: number) => boolean;
  readProcessState: (pid: number) => string | null;
}

export function createIsProcessAlive(deps: ProcessAliveDeps): (pid: number) => boolean {
  return (pid: number) => {
    if (!deps.signalCheck(pid)) return false;

    const state = deps.readProcessState(pid)?.trim();
    if (!state) return false;
    if (state.startsWith("Z")) return false;
    return true;
  };
}

export function realDeps(): LifecycleDeps {
  const isProcessAlive = createIsProcessAlive({
    signalCheck: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    readProcessState: (pid) => {
      try {
        return execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf-8" });
      } catch {
        return null;
      }
    },
  });

  return {
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as Parameters<typeof spawn>[2]),
    fetch: async (url) => {
      const res = await fetchWithTimeout(globalThis.fetch, url, {}, {
        timeoutMs: 1_500,
        timeoutMessage: `Daemon health probe timed out for ${url}`,
      });
      // OPR.0.4.3.21 — expose json() so getDaemonStatus can read the enriched
      // /healthz event-loop evidence. Bound to this Response instance.
      return { ok: res.ok, json: () => res.json() };
    },
    kill: (pid, signal) => { process.kill(pid, signal as NodeJS.Signals); return true; },
    readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
    removeFile: (p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } },
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    pathKind: (p) => {
      try {
        const value = fs.lstatSync(p);
        if (value.isDirectory()) return "directory";
        if (value.isFile()) return "file";
        return "other";
      } catch {
        return "missing";
      }
    },
    openForAppend: (p) => fs.openSync(p, "a"),
    isProcessAlive,
    // RULING 1ae863d2 — sibling-home scan (home-resolution honesty).
    listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  };
}

export function daemonCommand(depsOverride?: LifecycleDeps): Command {
  const getDeps = () => depsOverride ?? realDeps();
  const cmd = new Command("daemon").description("Manage the OpenRig daemon");

  cmd
    .command("start")
    .description("Start the daemon")
    .option("--port <port>", "Port to listen on")
    .option("--host <host>", "Host to bind on")
    .option("--db <path>", "Database path")
    // V0.3.1 slice 05 kernel-rig-as-default — skip the kernel auto-boot
    // path. Used by test fixtures, headless CI, and operators who want
    // a no-kernel daemon for ad-hoc topology work. The daemon proceeds
    // and serves its HTTP API normally; just doesn't materialize the
    // kernel rig.
    .option("--no-kernel", "Skip kernel auto-boot (daemon serves without the kernel rig)")
    // V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
    // After the daemon's healthz binds (current behavior preserved),
    // additionally poll /api/kernel/status until kernel_state is
    // ready / partial_ready, or the timeout elapses. Used by operators
    // who want a "kernel-ready" signal at start-time rather than the
    // weaker "daemon-ready". Default 60s; override with --wait-for-kernel-ms.
    .option("--wait-for-kernel", "After daemon binds, also wait for kernel-agent readiness (default timeout 60s)")
    .option("--wait-for-kernel-ms <ms>", "Override --wait-for-kernel timeout in milliseconds")
    .action(async (opts: { port?: string; host?: string; db?: string; kernel?: boolean; waitForKernel?: boolean; waitForKernelMs?: string }) => {
      try {
        const { ConfigStore } = await import("../config-store.js");
        const { SystemPreflight } = await import("../system-preflight.js");
        const { execSync } = await import("node:child_process");
        const configStore = new ConfigStore();
        const config = configStore.resolve();
        const effectivePort = opts.port ? parseInt(opts.port, 10) : config.daemon.port;
        // bug-fix slice auth-bearer-tailscale-trust: distinguish
        // user-explicit from default-fallback so the daemon can
        // multi-bind (loopback + tailscale auto-detect) when the operator
        // never opted in to a specific host.
        const hostResolution = configStore.resolveWithSource("daemon.host");
        // S20 — bind intent comes ONLY from the dedicated surfaces: the --host flag,
        // a FILE-sourced daemon.host, or OPENRIG_BIND_HOST. An env-sourced daemon.host
        // is the overloaded routing channel (ENV_MAP maps it from OPENRIG_HOST — the
        // exact injected state a managed environment carries) and never creates intent.
        const intent = resolveBindIntent({
          flagHost: opts.host,
          envBindHost: process.env["OPENRIG_BIND_HOST"],
          configSource: hostResolution.source,
          configHost: config.daemon.host,
        });
        const hostUserExplicit = intent.explicit;
        const effectiveHost = intent.host ?? "127.0.0.1";
        const hostForDaemon = intent.host;

        // Run preflight before starting
          const preflight = new SystemPreflight({
            exec: async (cmd) => execSync(cmd, { encoding: "utf-8" }),
            configStore,
            getDaemonStatus: () => getDaemonStatus(getDeps()),
            openrigHome: OPENRIG_DIR,
          });
        const preflightResult = await preflight.run({ port: effectivePort, host: effectiveHost });
        if (!preflightResult.ready) {
          for (const check of preflightResult.checks.filter((c) => !c.ok)) {
            console.error(`✗ ${check.name}: ${check.error}`);
            if (check.reason) console.error(`  Why: ${check.reason}`);
            if (check.fix) console.error(`  Fix: ${check.fix}`);
          }
          process.exitCode = 1;
          return;
        }

        // V0.3.1 slice 05 — Commander's --no-kernel inverts to opts.kernel === false.
        const skipKernel = opts.kernel === false;
        const state = await startDaemon(
          {
            port: effectivePort,
            host: hostForDaemon,
            db: opts.db ?? config.db.path,
            transcriptsEnabled: config.transcripts.enabled,
            transcriptsPath: config.transcripts.path,
            workspaceRoot: config.workspace.root,
            contextRoot: config.context.root,
            skillsRoot: config.skills.root,
            topologyRoot: config.topology.root,
            // V1 pre-release CLI/daemon Item 1 — project the
            // ConfigStore-resolved rotation tunables into the daemon
            // process env so file-stored values
            // (`rig config set transcripts.lines 500`) actually
            // reach the rotation hook.
            transcriptsLines: config.transcripts.lines,
            transcriptsPollIntervalSeconds: config.transcripts.pollIntervalSeconds,
            // V0.3.1 slice 05 kernel-rig-as-default — propagated via
            // OPENRIG_NO_KERNEL env var so the daemon's kernel-boot
            // check in startup.ts honors the flag.
            skipKernelBoot: skipKernel,
          },
          getDeps(),
        );
        console.log(`Daemon started on port ${state.port} (pid ${state.pid})`);

        // V0.3.1 slice 05 forward-fix #3 architectural — --wait-for-kernel
        // post-bind polling. Kernel boot is fire-and-forget after the
        // daemon binds healthz, so without this flag the CLI doesn't
        // know whether the kernel itself reached ready. Operators who
        // need a kernel-ready signal opt in here.
        if (opts.waitForKernel) {
          const { waitForKernelReady } = await import("../daemon-lifecycle.js");
          const timeoutMs = opts.waitForKernelMs && /^\d+$/.test(opts.waitForKernelMs)
            ? parseInt(opts.waitForKernelMs, 10)
            : 60_000;
          const baseUrl = `http://${state.host}:${state.port}`;
          const result = await waitForKernelReady(baseUrl, timeoutMs);
          if (result.ok) {
            console.log(`Kernel ${result.kernelState}; variant=${result.variant ?? "(none)"}`);
          } else {
            // Honest 3-part error per banked discipline.
            console.error(
              `Error: kernel did not reach ready / partial_ready within ${timeoutMs}ms.\n` +
                `Reason: kernel_state=${result.kernelState ?? "unknown"}` +
                (result.detail ? `; ${result.detail}` : "") +
                "\n" +
                "Fix: inspect `rig ps --rig kernel` for stalled agents, or run `claude auth status` / `codex login status` to confirm runtime auth.",
            );
            process.exitCode = 1;
          }
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      try {
        const deps = getDeps();
        let stopError: unknown;
        try {
          await stopDaemon(deps);
        } catch (err) {
          stopError = err;
        }
        const status = await getDaemonStatus(deps);
        if (status.state !== "stopped" && status.state !== "stale") {
          const configuredTarget = process.env.OPENRIG_URL || process.env.RIGGED_URL;
          const target = configuredTarget?.replace(/\/+$/, "")
            ?? (status.port !== undefined ? getDaemonUrl(status) : "the daemon selected by the active OpenRig configuration");
          const check = `${target}/healthz`;
          const stopCause = stopError instanceof Error ? ` Stop request reported: ${stopError.message}` : "";
          if (status.state === "running") {
            throw new Error(`Daemon stop verification failed: targeted ${target}; checked ${check}; the daemon is still listening.${stopCause}`);
          }
          throw new Error(`Daemon stop verification was inconclusive: targeted ${target}; checked ${check}; verified-down evidence was not observed (state=${status.state}).${stopCause}`);
        }
        if (stopError) throw stopError;
        console.log("Daemon stopped");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      const status = await getDaemonStatus(getDeps());
      const pidSuffix = status.pid !== undefined ? ` (pid ${status.pid})` : "";
      switch (status.state) {
        case "running":
          if (status.healthy === false) {
            // OPR.0.4.3.21 — process-present but unhealthy: name the real
            // cause (wedged control plane), not a bare "healthz failed", and
            // attach the event-loop evidence + seat-preserving recovery hint.
            const cause = status.reason === "unresponsive"
              ? "unresponsive (event loop may be starved — /healthz timed out)"
              : status.reason === "event-loop-starved"
                ? "event-loop starved"
                : "healthz failed";
            console.log(`Daemon running on port ${status.port}${pidSuffix} — process present but UNHEALTHY: ${cause}`);
            if (status.eventLoop) {
              const el = status.eventLoop;
              console.log(
                `  event-loop: lag mean ${el.lagMeanMs.toFixed(1)}ms, p99 ${el.lagP99Ms.toFixed(1)}ms, `
                + `utilization ${(el.utilization * 100).toFixed(0)}%, last-tick age ${el.lastTickAgeMs.toFixed(0)}ms`,
              );
            }
            console.log("  Recovery: restart the daemon only (`rig daemon stop && rig daemon start`) — this preserves the tmux seats.");
          } else {
            console.log(`Daemon running on port ${status.port}${pidSuffix}`);
          }
          break;
        case "stopped":
          console.log("Daemon stopped");
          break;
        case "stale":
          console.log("Daemon stale (cleaned up)");
          break;
        case "unverified":
          // 1ae863d2 — C3 semantics: we could NOT confirm up or down; never claim stopped.
          if (status.siblingHint) {
            console.log("Daemon state UNVERIFIED — the resolved OPENRIG_HOME has no daemon state, but a live daemon appears under a sibling home:");
            console.log(`  resolved: ${status.siblingHint.resolvedHome}`);
            console.log(`  sibling:  ${status.siblingHint.siblingHome}`);
            console.log("  Fix: point OPENRIG_HOME at the right home (or check your shell env) — this CLI is likely resolving the wrong home.");
          } else {
            console.log("Daemon state UNVERIFIED — the probe timed out or was inconclusive (this is NOT evidence the daemon is down).");
            console.log("  Re-check with: rig daemon status  ·  direct: curl the daemon /healthz");
          }
          break;
      }
    });

  cmd
    .command("logs")
    .description("Show daemon logs")
    .option("--follow", "Follow log output")
    .action((opts: { follow?: boolean }) => {
      if (opts.follow) {
        tailLogs(getDeps(), { follow: true });
      } else {
        const content = readLogs(getDeps());
        if (content) {
          console.log(content);
        } else {
          console.log("No daemon logs found");
        }
      }
    });

  return cmd;
}
