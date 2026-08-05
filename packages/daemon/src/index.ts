import { serve, type ServerType } from "@hono/node-server";
import { readOpenRigEnv } from "./openrig-compat.js";
import { createDaemon } from "./startup.js";
import { runQueueRetentionSweep, RETENTION_DEFAULTS } from "./domain/queue-retention.js";
import {
  assertBindAuthInvariant,
  detectTailscaleInterface,
  isLoopbackBind,
  isTailscaleBind,
  resolveToIpOrNull,
} from "./middleware/auth-bearer-token.js";
import type { SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";

/** OPR.0.4.3.21 (51elv2) — bound the graceful-shutdown recorder drain. */
export const SLOW_OP_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/**
 * OPR.0.4.3.21 (51elv2) — drain + close the slow-operation recorder on graceful
 * shutdown and report the process exit code. Returns 0 when the recorder closes
 * cleanly (or is absent), 1 when the drain rejects, times out, or the recorder
 * is in a terminal-failure state — an unproven/lost drain must never look like a
 * clean exit. Bounded by ONE finite timer (cleared + unref'd) so shutdown never
 * hangs; adds no retry, queue repair, migration, or supervisor machinery.
 */
export async function drainSlowOpRecorderOnShutdown(
  recorder: Pick<SlowOperationInstrumentation, "flush" | "close"> | undefined,
  opts?: { timeoutMs?: number; log?: (message: string, error?: unknown) => void },
): Promise<number> {
  const drain = recorder?.close ?? recorder?.flush;
  if (!recorder || !drain) return 0;
  const log = opts?.log ?? ((message: string, error?: unknown) => console.error(message, error));
  const timeoutMs = opts?.timeoutMs ?? SLOW_OP_SHUTDOWN_DRAIN_TIMEOUT_MS;

  let drainError: unknown;
  // Track rejection independently of its value: a Promise may reject with a
  // falsey value (undefined / null / false / 0 / ""), which is still a failure.
  let rejected = false;
  let settled = false;
  const drainPromise = Promise.resolve()
    .then(() => drain.call(recorder))
    .then(
      () => { settled = true; },
      (error) => { drainError = error; rejected = true; settled = true; },
    );

  // This finite timer is the ONLY thing keeping shutdown alive long enough to
  // enforce the bound once the servers + recorder Worker are unreferenced, so
  // it must stay referenced (do NOT unref it); it is cleared after settlement.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  await Promise.race([drainPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (!settled) {
    log("[slow-operation] shutdown drain timed out; instrumentation records may be lost");
    return 1;
  }
  if (rejected) {
    log("[slow-operation] shutdown drain failed; instrumentation records may be lost", drainError);
    return 1;
  }
  return 0;
}

/** OPR.0.3.4.9 — extracted for testability. Starts the periodic snapshot
 *  scheduler and updates the ps-projection status when enabled. */
export function startPeriodicSnapshotScheduler(deps: {
  periodicSnapshotScheduler?: { start(intervalMs: number, retentionKeep: number): void };
  psProjectionService: { setPeriodicSnapshotState(active: boolean, intervalSeconds: number): void };
  settingsStore?: { resolveOne(key: string): { value: unknown } };
}): void {
  if (!deps.periodicSnapshotScheduler) return;
  const settingsStore = deps.settingsStore;
  const enabled = settingsStore ? settingsStore.resolveOne("snapshots.periodic.enabled").value === true : true;
  if (!enabled) return;
  const intervalS = settingsStore ? (settingsStore.resolveOne("snapshots.periodic.interval_seconds").value as number) : 300;
  const retentionKeep = settingsStore ? (settingsStore.resolveOne("snapshots.periodic.retention_keep").value as number) : 10;
  deps.periodicSnapshotScheduler.start(intervalS * 1000, retentionKeep);
  deps.psProjectionService.setPeriodicSnapshotState(true, intervalS);
}

/** OPR.0.4.6.FS-1 W2 — start the queue-retention maintenance sweep (arch D3): a
 *  boot sweep + a daily tick that archives aged terminal `queue_transitions`
 *  (never-delete) and prunes `watchdog_history`, both in bounded batches with
 *  event-loop yields. Reads the `retention.*` settings (baked defaults via
 *  RETENTION_DEFAULTS). Fire-and-forget with error logging — a sweep failure must
 *  never crash the daemon. Returns the daily interval handle (cleared on
 *  shutdown), or null when disabled. */
export function startQueueRetentionScheduler(deps: {
  rigRepo: { db: import("better-sqlite3").Database };
  settingsStore?: { resolveOne(key: string): { value: unknown } };
}): ReturnType<typeof setInterval> | null {
  const store = deps.settingsStore;
  const enabled = store ? store.resolveOne("retention.enabled").value === true : true;
  if (!enabled) return null;
  const db = deps.rigRepo.db;
  const num = (key: string, fallback: number): number => {
    const v = store ? store.resolveOne(key).value : fallback;
    return typeof v === "number" ? v : fallback;
  };
  const runOnce = (): void => {
    void runQueueRetentionSweep(db, {
      nowIso: new Date().toISOString(),
      transitionsRetentionDays: num("retention.transitions_days", RETENTION_DEFAULTS.transitionsRetentionDays),
      watchdogRetentionDays: num("retention.watchdog_days", RETENTION_DEFAULTS.watchdogRetentionDays),
      watchdogKeepPerJob: num("retention.watchdog_keep_per_job", RETENTION_DEFAULTS.watchdogKeepPerJob),
      batchSize: num("retention.batch_size", RETENTION_DEFAULTS.batchSize),
    }).catch((err: unknown) => {
      console.error(`[queue-retention] sweep error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  runOnce(); // boot sweep (fire-and-forget)
  const DAILY_MS = 24 * 60 * 60 * 1000;
  return setInterval(runOnce, DAILY_MS);
}

async function isTrustedLocalOrTailnetBind(host: string): Promise<boolean> {
  if (isLoopbackBind(host)) return true;
  if (isTailscaleBind(host)) return true;
  if (!/^[\d.]+$/.test(host) && !host.includes(":")) {
    const resolvedIp = await resolveToIpOrNull(host);
    if (resolvedIp) return isLoopbackBind(resolvedIp) || isTailscaleBind(resolvedIp);
  }
  return false;
}

export async function startServer(port?: number) {
  const p = port ?? parseInt(readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT") ?? "7433", 10);
  const dbPath = readOpenRigEnv("OPENRIG_DB", "RIGGED_DB") ?? "openrig.sqlite";

  // bug-fix slice auth-bearer-tailscale-trust: distinguish "explicit
  // operator opt-in" from "default" by treating an undefined env as
  // default. When explicit, the operator takes responsibility (and the
  // bearer invariant applies to their chosen host). When default, the
  // daemon always binds loopback and ALSO binds the active tailscale
  // interface (if present) — both accepted paths in the invariant.
  const explicitHost = readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST");
  // PL-005 Phase B: bearer token for Mission Control write verbs.
  // No legacy alias (this env var is new in Phase B).
  const bearerToken = process.env.OPENRIG_AUTH_BEARER_TOKEN ?? null;

  let bindHosts: string[];
  const terminalTokenEnv = process.env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim();
  let terminalBearerToken: string | null = terminalTokenEnv || null;
  if (explicitHost) {
    // Operator opt-in path — invariant enforces bearer requirement for
    // genuinely public/LAN binds; loopback/tailscale binds short-circuit.
    await assertBindAuthInvariant({ host: explicitHost, bearerToken });
    if (!terminalBearerToken && !(await isTrustedLocalOrTailnetBind(explicitHost))) {
      terminalBearerToken = bearerToken;
    }
    bindHosts = [explicitHost];
  } else {
    // Default path — loopback always, plus tailscale auto-add when active.
    const tailscaleIp = detectTailscaleInterface();
    bindHosts = tailscaleIp ? ["127.0.0.1", tailscaleIp] : ["127.0.0.1"];
  }

  const { app, contextMonitor, deps, eventLoopMonitor, injectWebSocket } = await createDaemon({
    dbPath,
    bearerToken,
    terminalBearerToken,
  });

  // Multi-bind via N serve() instances sharing the same Hono app.
  // Hono's serve() targets a single host:port; for multi-bind we spawn
  // one per host. The contextMonitor + watchdog scheduler only start
  // once after the first successful bind callback fires.
  let monitorsStarted = false;
  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  const servers: ServerType[] = [];
  for (const host of bindHosts) {
    const srv = serve({ fetch: app.fetch, port: p, hostname: host }, (info) => {
      console.log(`OpenRig daemon listening on http://${host}:${info.port}`);
      if (!monitorsStarted) {
        monitorsStarted = true;
        contextMonitor.start();
        // PL-004 Phase C: start watchdog scheduler. Joins the supervision
        // tree post-bind so the HTTP surface is ready before the first
        // tick (matches contextMonitor pattern).
        deps.watchdogScheduler?.start();
        // Slice 15 — start the seat-activity scheduler (1Hz default).
        // Polls every running tmux-bound seat's window_activity timestamp so
        // PsProjectionService + node-inventory enrichment serve
        // fresh data on each request.
        deps.seatActivityService?.start(deps.rigRepo.db);
        // OPR.0.4.3.19 — start the liveness identity reconciler (5s default).
        // Persists the per-seat pane PID/command verdict so node-inventory
        // gates the running/active projection on verified process identity.
        deps.seatIdentityReconciler?.start();
        startPeriodicSnapshotScheduler(deps);
        // OPR.0.4.6.FS-1 W2 — boot sweep + daily retention tick (bounded,
        // yields between batches; a sweep failure is logged, never fatal).
        retentionTimer = startQueueRetentionScheduler(deps);
      }
    });
    injectWebSocket(srv);
    servers.push(srv);
  }

  // PL-004 Phase C: graceful shutdown — stop scheduler before process
  // exit so any in-flight policy evaluation completes (or is awaited).
  // Multi-bind: close every serve() instance in parallel.
  const shutdown = async (sig: string) => {
    console.log(`OpenRig daemon received ${sig}; shutting down`);
    try {
      await deps.watchdogScheduler?.stop();
    } catch (err) {
      console.error("[watchdog] shutdown error", err);
    }
    try {
      deps.seatActivityService?.stop();
    } catch (err) {
      console.error("[seat-activity] shutdown error", err);
    }
    try {
      deps.seatIdentityReconciler?.stop();
    } catch (err) {
      console.error("[seat-identity] shutdown error", err);
    }
    try {
      deps.periodicSnapshotScheduler?.stop();
    } catch (err) {
      console.error("[periodic-snapshot] shutdown error", err);
    }
    try {
      if (retentionTimer) clearInterval(retentionTimer);
    } catch (err) {
      console.error("[queue-retention] shutdown error", err);
    }
    try {
      // OPR.0.4.3.21 — disable the event-loop histogram + clear its tick interval.
      eventLoopMonitor.stop();
    } catch (err) {
      console.error("[event-loop-monitor] shutdown error", err);
    }
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise<void>((resolve) => {
            try {
              srv.close(() => resolve());
            } catch {
              resolve();
            }
          }),
      ),
    );
    // OPR.0.4.3.21 (51elv2) — drain the slow-operation recorder AFTER services
    // and HTTP servers have stopped, but before exit. A clean drain keeps exit
    // 0; a timeout / rejection / terminal recorder failure is logged and exits
    // nonzero so a lost drain never masquerades as a clean shutdown.
    const slowOpExitCode = await drainSlowOpRecorderOnShutdown(deps.slowOpRecorder);
    process.exit(slowOpExitCode);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Backward-compatible single-server return (callers that just need a
  // handle reference; multi-bind shutdown is wired via signal handlers).
  return servers[0]!;
}

// Only start the server when this file is executed directly (not imported).
const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  startServer();
}
