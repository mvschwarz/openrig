import { signalProbe, createProcessLiveness, readProcessState } from "../process-liveness.js";
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { acquireDaemonStartLock, archiveSpentReservation, bootedAtMs, currentBootId, finishStartReservation, markReservationRetained, processStartToken } from "../daemon-start-lock.js";
import { formatDaemonHostForUrl } from "../client.js";
import { execFileSync, spawn } from "node:child_process";
import { fetchWithTimeout } from "../fetch-with-timeout.js";
import { daemonFetch } from "../daemon-transport.js";
import { personRegistrationOffer } from "../person-registration-offer.js";
import { ensureDefaultWorkspace } from "@openrig/daemon/instance-initialization";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  pendingStartEndpoint,
  readLogs,
  tailLogs,
  type LifecycleDeps,
  type ProcessLiveness,
  OPENRIG_DIR,
  STATE_FILE,
  resolveBindIntent,
  statusGuardMessage,
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

export { signalProbe, createProcessLiveness, readProcessState } from "../process-liveness.js";
export type { SignalOutcome } from "../process-liveness.js";

/** A --db value as better-sqlite3 opens it: it trims the name, and an empty name or ":memory:" is an in-memory database.
 *  Those and an absolute path stay exactly as given. A relative path is anchored at this command's working directory
 *  without normalizing it, so it names the same file (symlinks and ".." included) from wherever a later start runs. */
export function databaseFlagPath(db: string, cwd = process.cwd()): string {
  const opened = db.trim();
  if (opened === "" || opened === ":memory:" || path.isAbsolute(opened)) return db;
  return `${cwd}${path.sep}${opened}`;
}

export function realDeps(): LifecycleDeps {
  const isProcessAlive = createIsProcessAlive({
    signalCheck: (pid) => signalProbe(pid) === "sent",
    readProcessState: (pid) => readProcessState(pid),
  });
  const processLiveness = createProcessLiveness({
    signal: (pid) => signalProbe(pid),
    readProcessState: (pid) => readProcessState(pid),
  });

  // lsof's answer when it exits non-zero: status 1 is an answer (none of those files is open, or the process is gone).
  const lsofFailure = (error: unknown): false | { failure: string } => {
    const err = error as { status?: number | null; code?: string; signal?: string | null };
    if (err.status === 1) return false;
    return { failure: err.code === "ENOENT" ? "lsof isn't installed" : err.signal ? "lsof timed out" : "lsof failed" };
  };

  // Whether a process holds a file open, as the daemon's own database-holder check asks lsof (daemon-db-path.ts).
  const databaseHeldBy = (pid: number, file: string): boolean | { failure: string } => {
    let real: string;
    try { real = fs.realpathSync(file); } catch { return { failure: `${file} can't be resolved` }; }
    if (process.platform === "linux") {
      // Linux names each open file under /proc without lsof; a listing that can't be read leaves the answer to lsof.
      let fds: string[] | undefined;
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { fds = undefined; }
      if (fds) return fds.some((fd) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === real; } catch { return false; } });
    }
    // lsof exits 1 both when nothing it was asked about is found and on an error, so ask for the process's own open files:
    // a listing answers either way, and no listing is reported as unread, never as "not held".
    try {
      const listed = execFileSync("lsof", ["-a", "-p", String(pid), "-Fn"], { encoding: "utf-8", timeout: 2_000, maxBuffer: 1024 * 1024 });
      return listed.split("\n").some((line) => line.startsWith("n") && (line.slice(1) === real || line.slice(1) === file));
    } catch (error) {
      const failure = lsofFailure(error);
      return failure === false ? { failure: `lsof listed no open files for PID ${pid}` } : failure;
    }
  };

  // #3953: a process's stdout and stderr, read as the daemon's own database-holder check reads them (lsof, fds 1 and 2).
  const writesOutputTo = (pid: number, file: string): boolean | { failure: string } => {
    let real: string;
    try { real = fs.realpathSync(file); } catch { return { failure: `${file} can't be resolved` }; }
    if (process.platform === "linux") {
      // Linux names each open file under /proc without lsof; a link that can't be read leaves the answer to lsof.
      const links = [1, 2].map((fd) => {
        try { return fs.readlinkSync(`/proc/${pid}/fd/${fd}`); }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
      });
      if (links.every((link) => link !== undefined)) return links.includes(real);
    }
    try {
      const listed = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "1,2", "-Fn"], { encoding: "utf-8", timeout: 2_000, maxBuffer: 64 * 1024 });
      return listed.split("\n").some((line) => line.startsWith("n") && (line.slice(1) === real || line.slice(1) === file));
    } catch (error) {
      return lsofFailure(error);
    }
  };

  // #2860: where the OS has pid namespaces (Linux), a missing pid is only proof from the daemon's own.
  const pidNamespace = (): string | undefined => {
    if (process.platform !== "linux") return "host";
    try { return fs.readlinkSync("/proc/self/ns/pid"); } catch { return undefined; }
  };

  return {
    processLiveness,
    acquireStartLock: () => {
      const lock = acquireDaemonStartLock(OPENRIG_DIR, { bootId: currentBootId(), bootedAtMs: bootedAtMs(), processLiveness, pidNamespace: pidNamespace() });
      if (lock.archived) console.error(`An abandoned start reservation (from before this boot, or whose recorded launcher and child are both gone) was archived as ${lock.archived}`);
      return lock;
    },
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as Parameters<typeof spawn>[2]),
    fetch: async (url, init) => {
      let body = "";
      // #3957: each health probe on a connection of its own. With `connection: close`, undici closes the socket after the
      // response, so no later probe reuses one the daemon has since closed: a stopped listener reads refused, not reset.
      const probeInit: RequestInit = { headers: { connection: "close" }, ...(init?.signal ? { signal: init.signal } : {}) };
      const res = await fetchWithTimeout(daemonFetch(url, globalThis.fetch), url, probeInit, {
        timeoutMs: 1_500,
        timeoutMessage: `Daemon health probe timed out for ${url}`,
        consumeResponse: async (response) => { body = await response.text(); },
      });
      // Read the finite health body inside the deadline, then expose its cached JSON to lifecycle evidence readers.
      return { ok: res.ok, json: async () => JSON.parse(body) as unknown };
    },
    isPortOccupied: (host, port) => new Promise((resolve) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"));
      try {
        server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(false)));
      } catch { resolve(false); }
    }),
    fileSize: (p) => { try { return fs.statSync(p).size; } catch { return 0; } },
    readFileFrom: (p, offset) => {
      let fd: number | undefined;
      try {
        fd = fs.openSync(p, "r");
        const size = fs.fstatSync(fd).size;
        const start = size < offset ? 0 : offset; // The log may have been truncated.
        const buffer = Buffer.alloc(size - start);
        const read = fs.readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString("utf-8", 0, read);
      } catch { return null; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    },
    kill: (pid, signal) => { process.kill(pid, signal as NodeJS.Signals); return true; },
    readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
    writeFile: (p, content) => {
      if (p !== STATE_FILE) { fs.writeFileSync(p, content, "utf-8"); return; }
      const temporary = `${p}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, content, { encoding: "utf-8", flag: "wx" });
        fs.renameSync(temporary, p);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    },
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
    closeFile: (fd) => fs.closeSync(fd),
    isProcessAlive,
    // RULING 1ae863d2 — sibling-home scan (home-resolution honesty).
    listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
    pidNamespace,
    // #3315: what the start records and stop checks to confirm a start reservation still names its child.
    bootId: currentBootId,
    processStartToken,
    releaseStartReservation: archiveSpentReservation,
    retainStartReservation: markReservationRetained,
    finishStartReservation,
    databaseHeldBy,
    writesOutputTo,
  };
}

export function daemonCommand(depsOverride?: LifecycleDeps): Command {
  const getDeps = () => depsOverride ?? realDeps();
  const cmd = new Command("daemon").description("Manage the OpenRig daemon");

  cmd
    .command("start")
    .description("Start the daemon")
    .addHelpText("after", "\nStartup reserves this local instance before initialization and verifies the spawned child PID on every required listener.\nMissing/mismatched identity or child exit fails startup; failed publication withdraws only this launch's matching state. Use a matching CLI/daemon installation.\nA concurrent start fails without spawning another child. Inspect daemon-start.lock for launcher/child PIDs after an interrupted start;\nonly archive an abandoned reservation after proving both processes absent. A failed cleanup retains it and reports the child PID.\nA reservation from an earlier boot is archived as daemon-start.lock.abandoned-<time> and the start goes on; so is one from\nthis boot whose recorded launcher and child are both gone in this shell's pid namespace and that no stop retained.\nA start that ended pending (its child left running, its reservation kept) is finished by the next 'rig daemon start' once that\nchild is ready: it checks the child against the reservation, publishes daemon.json for it (or keeps one that already\ndescribes it) and retires that reservation, without starting another daemon.\n")
    .option("--port <port>", "Port to listen on")
    .option("--host <host>", "Host to bind on")
    .option("--db <path>", "Database path")
    .option("--allow-db-conflict", "Proceed for this start when another live daemon is confirmed using the database")
    // V0.3.1 slice 05 kernel-rig-as-default — skip the kernel auto-boot
    // path. Used by test fixtures, headless CI, and operators who want
    // a no-kernel daemon for ad-hoc topology work. The daemon proceeds
    // and serves its HTTP API normally; just doesn't materialize the
    // kernel rig.
    .option("--no-kernel", "Skip the kernel and its operator, which helps you start a team; for automation or when requested. Normal installation keeps the kernel")
    // V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
    // After the daemon's healthz binds (current behavior preserved),
    // additionally poll /api/kernel/status until kernel_state is
    // ready / partial_ready, or the timeout elapses. Used by operators
    // who want a "kernel-ready" signal at start-time rather than the
    // weaker "daemon-ready". Default 60s; override with --wait-for-kernel-ms.
    .option("--wait-for-kernel", "After daemon binds, also wait for kernel-agent readiness (default timeout 60s)")
    .option("--wait-for-kernel-ms <ms>", "Override --wait-for-kernel timeout in milliseconds")
    .action(async (opts: { port?: string; host?: string; db?: string; allowDbConflict?: boolean; kernel?: boolean; waitForKernel?: boolean; waitForKernelMs?: string }) => {
      try {
        const { ConfigStore } = await import("../config-store.js");
        const { SystemPreflight, quietPreflightExec } = await import("../system-preflight.js");
        const configStore = new ConfigStore();
        const config = configStore.resolve();
        const effectivePort = opts.port ? parseInt(opts.port, 10) : config.daemon.port;
        // --port abc or --port 99999 reached the preflight port check and died
        // with Node's raw ERR_SOCKET_BAD_PORT. Refuse only ports that cannot be
        // bound, with the same parseInt and range as the daemon.port config key,
        // so every --port value that starts a daemon today still does.
        if (Number.isNaN(effectivePort) || effectivePort < 0 || effectivePort > 65535) {
          throw new Error(`Invalid --port: must be an integer in [0, 65535], got "${opts.port}"`);
        }
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
            exec: quietPreflightExec,
            configStore,
            getDaemonStatus: () => getDaemonStatus(getDeps()),
            pendingStart: () => pendingStartEndpoint(getDeps()),
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
            // A relative --db is anchored at this directory, so the child, its reservation and daemon.json name the same file
            // for a later start from anywhere. db.path and OPENRIG_DB reach SQLite exactly as before.
            db: opts.db !== undefined ? databaseFlagPath(opts.db) : config.db.path,
            transcriptsEnabled: config.transcripts.enabled,
            transcriptsPath: config.transcripts.path,
            workspaceRoot: config.workspace.root,
            contextRoot: config.context.root,
            skillsRoot: config.skills.root,
            topologyRoot: config.topology.root,
            // Live transcript tunables are read from the shared config file.
            // Only operator-provided environment overrides should mask edits.
            // V0.3.1 slice 05 kernel-rig-as-default — propagated via
            // OPENRIG_NO_KERNEL env var so the daemon's kernel-boot
            // check in startup.ts honors the flag.
            skipKernelBoot: skipKernel,
            allowDbConflict: opts.allowDbConflict,
            readinessWaitSeconds: config.daemon.startReadinessWaitSeconds,
          },
          getDeps(),
        );
        if (state.finished) {
          // This start finished an earlier start that ended pending: no new daemon was started. Each part on its own line.
          const { publication, replacedPid, reservation, readiness } = state.finished;
          console.log(`Finished the earlier start of daemon pid ${state.pid} on port ${state.port}; no new daemon was started, and this command does not reconfigure the child's port, host or database.`);
          console.log(publication === "written"
            ? `  Publication: daemon.json written for pid ${state.pid}${replacedPid !== undefined ? `, replacing one that named pid ${replacedPid}, which isn't running` : ""}.`
            : `  Publication: daemon.json already described pid ${state.pid}; kept as it was.`);
          if ("retired" in reservation) console.log(`  Reservation: that start's reservation retired to ${reservation.retired}.`);
          else console.error(`  Reservation: kept: ${reservation.kept}.`);
          console.log("verified" in readiness
            ? `  Readiness: /healthz named pid ${state.pid} on ${readiness.verified.join(", ")}.`
            : `  Readiness: /healthz named pid ${state.pid} at the launch endpoint; unverified on ${readiness.unverified.join(", ")} (no clear answer, not a refusal).`);
        } else {
          console.log(`Daemon started on port ${state.port} (pid ${state.pid})`);
        }
        // The daemon leaves a workspace.root that holds a project of its own as it is, and its log says so; so does this
        // output, from the same read-only check.
        const workspace = ensureDefaultWorkspace({ root: config.workspace.root, dryRun: true });
        if (workspace.existingProject) {
          console.log(`workspace.root holds a project of its own (${workspace.existingProject}); OpenRig left it as it is and reads that project's own id.`);
        }

        // V0.3.1 slice 05 forward-fix #3 architectural — --wait-for-kernel
        // post-bind polling. Kernel boot is fire-and-forget after the
        // daemon binds healthz, so without this flag the CLI doesn't
        // know whether the kernel itself reached ready. Operators who
        // need a kernel-ready signal opt in here.
        if (opts.waitForKernel) {
          const { waitForKernelReady, skippedKernelMessage } = await import("../daemon-lifecycle.js");
          const { attentionLines, checkKernelAttention } = await import("../seat-attention.js");
          const { DaemonClient } = await import("../client.js");
          const timeoutMs = opts.waitForKernelMs && /^\d+$/.test(opts.waitForKernelMs)
            ? parseInt(opts.waitForKernelMs, 10)
            : 60_000;
          const baseUrl = `http://${formatDaemonHostForUrl(state.host ?? "127.0.0.1")}:${state.port}`;
          const result = await waitForKernelReady(baseUrl, timeoutMs);
          // A kernel seat held at a startup prompt or sign-in keeps the kernel short of ready: name it and why.
          const heldLines = result.kernelState !== "ready" && result.kernelState !== "skipped"
            ? attentionLines(await checkKernelAttention(new DaemonClient(baseUrl)), "pane").map(line => `  ${line}`) : [];
          if (result.ok) {
            console.log(`Kernel ${result.kernelState}; variant=${result.variant ?? "(none)"}`);
            for (const line of heldLines) console.log(line);
          } else if (result.kernelState === "skipped") {
            // Skipped on purpose, so neither a timeout nor an auth problem: say why, and the way back.
            console.error(skippedKernelMessage(result.detail));
            process.exitCode = 1;
          } else {
            // Honest 3-part error per banked discipline.
            console.error(
              `Error: kernel did not reach ready / partial_ready within ${timeoutMs}ms.\n` +
                `Reason: kernel_state=${result.kernelState ?? "unknown"}` +
                (result.detail ? `; ${result.detail}` : "") +
                "\n" +
                "Fix: inspect `rig ps --rig kernel` for stalled agents, or run `claude auth status` / `codex login status` to confirm runtime auth.",
            );
            for (const line of heldLines) console.error(line);
            process.exitCode = 1;
          }
        }
        if (process.exitCode !== 1) for (const line of await personRegistrationOffer()) console.log(line);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("stop")
    .description("Stop the daemon (10s shutdown budget; 12s process wait; incomplete drain exits nonzero)")
    .addHelpText("after", "\nSends at most one SIGTERM to a live target and verifies the original PID and listener. Repeated signals join shutdown.\nFor a recorded target, missing/stale receipts and incomplete drains exit nonzero, including retries.\nTarget state is retained until a matching clean receipt; status reads preserve unverified state.\nNo target is a distinct no-op, never clean-drain certification; unbound incomplete evidence stays unverified.\nInspect OPENRIG_HOME/daemon-shutdown.json and daemon.log for the phase and outcome.\nThe bound covers asynchronous shutdown; an event-loop wedge still requires operator recovery.\nWith no recorded target, the child of a start that ended pending is signalled only when its reservation still names it\n(same boot, launcher gone, same process, its endpoint checked) and its listener names it or does not answer in time.\n")
    .action(async () => {
      try {
        const outcome = await stopDaemon(getDeps());
        console.log(outcome === "stopped" ? "Daemon stopped" : "No daemon target recorded; listener refused. Nothing to stop; prior drain not certified.");
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
          console.log("Daemon PID is absent (stale state)");
          break;
        case "unverified":
          // T2: a live start reservation names a launch in progress (listener not up yet).
          if (status.startPending) {
            const since = status.startPending.since ? ` since ${status.startPending.since}` : "";
            console.log(`Daemon starting: launch reserved by pid ${status.startPending.pid}${since}; not listening yet`);
          }
          // 1ae863d2 — C3 semantics: we could NOT confirm up or down; never claim stopped.
          if (status.siblingHint) {
            console.log("Daemon state UNVERIFIED — the resolved OPENRIG_HOME has no daemon state, but a live daemon appears under a sibling home:");
            console.log(`  resolved: ${status.siblingHint.resolvedHome}`);
            console.log(`  sibling:  ${status.siblingHint.siblingHome}`);
            console.log("  Fix: point OPENRIG_HOME at the right home (or check your shell env) — this CLI is likely resolving the wrong home.");
          } else if (status.pidUnseen) {
            // #2860: the same words as the command guard.
            const unseen = statusGuardMessage(status);
            console.log(unseen.fact);
            console.log(`  ${unseen.consequence}`);
            console.log(`  ${unseen.action}`);
          } else if (!status.startPending) {
            // A pending start's probe was refused, not inconclusive; its line above says what is known.
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
