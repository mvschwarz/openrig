import type { WatchdogJob, WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import type { WatchdogPolicyEngine } from "./watchdog-policy-engine.js";

/**
 * Watchdog scheduler (PL-004 Phase C; daemon-native supervision tree
 * member). Joins createDaemon's lifecycle: started by startup.ts after
 * the policy engine is ready, stopped during graceful shutdown.
 *
 * Loop semantics:
 *   - Wakes every `tickIntervalMs` (default 1000) and queries the
 *     repository for active jobs whose `interval_seconds` has elapsed
 *     since `last_evaluation_at` (or who have never been evaluated).
 *   - For each due job, calls policyEngine.evaluate(job). The engine
 *     records meaningful outcomes; pure not-due polls are filtered
 *     here and never reach history.
 *   - SQLite is the canonical schedule state — restart recovery is
 *     automatic: on startup, `listActive()` returns the same set
 *     and `last_evaluation_at` determines next-due.
 *
 * Concurrency:
 *   - One in-flight tick at a time. If a tick takes longer than
 *     tickIntervalMs (long policy.evaluate or slow delivery), the
 *     next tick is delayed; we don't queue overlapping ticks.
 *   - Within a tick, jobs are evaluated sequentially. This bounds
 *     resource use and matches the POC's single-loop behavior.
 *
 * Shutdown:
 *   - stop() sets shuttingDown=true, clears the timer, and awaits the
 *     in-flight tick (if any). Idempotent.
 */

export interface WatchdogSchedulerDeps {
  jobsRepo: WatchdogJobsRepository;
  policyEngine: WatchdogPolicyEngine;
  /** Tick wake-up cadence. Default 1000 ms. */
  tickIntervalMs?: number;
  /** Override clock for tests. */
  now?: () => Date;
  /** Override timer scheduler for tests. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Notification on tick errors (for telemetry; defaults to console.error). */
  onTickError?: (err: unknown) => void;
}

export class WatchdogScheduler {
  private readonly jobsRepo: WatchdogJobsRepository;
  private readonly policyEngine: WatchdogPolicyEngine;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (handle: NodeJS.Timeout) => void;
  private readonly onTickError: (err: unknown) => void;

  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private shuttingDown = false;
  private started = false;

  constructor(deps: WatchdogSchedulerDeps) {
    this.jobsRepo = deps.jobsRepo;
    this.policyEngine = deps.policyEngine;
    this.tickIntervalMs = deps.tickIntervalMs ?? 1000;
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    this.onTickError = deps.onTickError ?? ((err) => console.error("[watchdog] tick error", err));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.shuttingDown = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        // Errors already logged via onTickError; suppress during shutdown.
      }
    }
    this.started = false;
  }

  isRunning(): boolean {
    return this.started && !this.shuttingDown;
  }

  /**
   * Run one tick synchronously (await result). Exposed for tests so
   * they can drive ticks without timers. Production path calls this
   * via the timer loop.
   */
  async runTickNow(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.tick();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private scheduleNextTick(): void {
    if (this.shuttingDown) return;
    this.timer = this.setTimer(() => {
      void this.runTickNow()
        .catch((err) => this.onTickError(err))
        .finally(() => this.scheduleNextTick());
    }, this.tickIntervalMs);
  }

  private async tick(): Promise<void> {
    if (this.shuttingDown) return;
    const nowMs = this.now().getTime();
    const active = this.jobsRepo.listActive();
    for (const job of active) {
      if (this.shuttingDown) return;
      if (!isDue(job, nowMs)) continue;
      try {
        await this.policyEngine.evaluate(job);
      } catch (err) {
        this.onTickError(err);
      }
    }
  }
}

/**
 * R1 fix: scan cadence is governed by `scan_interval_seconds` when
 * supplied, falling back to `interval_seconds`. Mirrors POC engine
 * (lib/engine.mjs:38-46) where `last_scan_at` and `scan_interval_seconds`
 * gate the policy invocation. Wake-cadence (`active_wake_interval_seconds`)
 * is enforced one layer up by the policy engine, NOT here.
 */
export function isDue(job: WatchdogJob, nowMs: number): boolean {
  if (!job.lastEvaluationAt) return true;
  const last = Date.parse(job.lastEvaluationAt);
  if (Number.isNaN(last)) return true;
  const cadenceSeconds = job.scanIntervalSeconds ?? job.intervalSeconds;
  return nowMs - last >= cadenceSeconds * 1000;
}
