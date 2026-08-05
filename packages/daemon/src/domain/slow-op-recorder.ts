import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

export const SLOW_OPERATION_BARRIER_TIMEOUT_MS = 250;
export const SLOW_OPERATION_THRESHOLD_MS = 250;
export const SLOW_OPERATION_ROTATION_BYTES = 1024 * 1024;
export const SLOW_OPERATION_ROTATION_COUNT = 3;
export const SLOW_OPERATION_LOG_BASENAME = "slow-operations.jsonl";

export interface SlowOperationSnapshot {
  healthy: boolean;
  reason?: string;
  site?: string;
}

/**
 * OPR.0.4.3.21 (51elv2) — the named terminal-failure signal. A rejected
 * flush/close carries this error after the recorder Worker is lost, so a
 * caller can never mistake a settled-but-lost drain for a successful durable
 * one (see the terminal transition in {@link SlowOpRecorder}).
 */
export class SlowOpRecorderTerminatedError extends Error {
  constructor(reason: string) {
    super(`slow-operation recorder terminated: ${reason}`);
    this.name = "SlowOpRecorderTerminatedError";
  }
}

export interface SlowOperationInstrumentation {
  runSync?<T>(site: string, fn: () => T): T;
  runStage?<T>(
    site: string,
    fn: () => Promise<T>,
    classify?: (value: T) => "ok" | "failed",
  ): Promise<T>;
  recordRequest?(site: string, durationMs: number): void;
  snapshot?(): SlowOperationSnapshot;
  setDegradedHandler?(handler: (snapshot: Required<Pick<SlowOperationSnapshot, "reason" | "site">>) => void): void;
  // OPR.0.4.3.21 (51elv2) — optional graceful-shutdown lifecycle. A drain that
  // cannot prove durability rejects (never a silent success); see index.ts.
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

interface SlowOpRecorderOptions {
  logPath: string;
  maxBytes?: number;
  rotationCount?: number;
  slowThresholdMs?: number;
  barrierTimeoutMs?: number;
}

interface Span {
  spanId: string;
  site: string;
  startedAt: number;
}

const WORKER_SOURCE = String.raw`
  const fs = require("node:fs");
  const path = require("node:path");
  const { parentPort } = require("node:worker_threads");

  function rotate(logPath, rotationCount) {
    for (let index = rotationCount; index >= 1; index -= 1) {
      const source = index === 1 ? logPath : logPath + "." + (index - 1);
      const target = logPath + "." + index;
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
      fs.chmodSync(target, 0o600);
    }
  }

  function append(message) {
    const line = JSON.stringify(message.record) + "\n";
    fs.mkdirSync(path.dirname(message.logPath), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(message.logPath).size; } catch {}
    if (size > 0 && size + Buffer.byteLength(line) > message.maxBytes) {
      rotate(message.logPath, message.rotationCount);
    }
    const fd = fs.openSync(message.logPath, "a", 0o600);
    try {
      fs.chmodSync(message.logPath, 0o600);
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  parentPort.on("message", (message) => {
    let ok = true;
    let error;
    try {
      if (message.type === "append") append(message);
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (message.signal) {
      const state = new Int32Array(message.signal);
      Atomics.store(state, 0, ok ? 1 : 2);
      Atomics.notify(state, 0);
    } else if (message.id) {
      parentPort.postMessage({ id: message.id, ok, error });
    }
  });
`;

export class SlowOpRecorder implements SlowOperationInstrumentation {
  private readonly worker: Worker;
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly rotationCount: number;
  private readonly slowThresholdMs: number;
  private readonly barrierTimeoutMs: number;
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  private degraded: SlowOperationSnapshot = { healthy: true };
  private degradedHandler?: (snapshot: Required<Pick<SlowOperationSnapshot, "reason" | "site">>) => void;
  private closed = false;
  // OPR.0.4.3.21 (51elv2) — set once the Worker is lost (error / unexpected
  // exit / messageerror / synchronous postMessage failure). Distinct from
  // `closed` (an expected caller-initiated teardown): a terminal recorder
  // rejects every future post/flush so nothing waits forever or reports a
  // false durable drain.
  private terminalReason: string | null = null;

  constructor(options: SlowOpRecorderOptions) {
    this.logPath = options.logPath;
    this.maxBytes = options.maxBytes ?? SLOW_OPERATION_ROTATION_BYTES;
    this.rotationCount = options.rotationCount ?? SLOW_OPERATION_ROTATION_COUNT;
    this.slowThresholdMs = options.slowThresholdMs ?? SLOW_OPERATION_THRESHOLD_MS;
    this.barrierTimeoutMs = options.barrierTimeoutMs ?? SLOW_OPERATION_BARRIER_TIMEOUT_MS;
    this.worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [] });
    this.worker.unref();
    this.worker.on("message", (message: { id?: string; ok?: boolean }) => {
      if (!message.id) return;
      if (message.ok === false) this.markDegraded("recorder_write_failed", "recorder.worker");
      this.pending.get(message.id)?.resolve();
      this.pending.delete(message.id);
    });
    // One terminal transition for every unrecoverable Worker-loss trigger.
    this.worker.on("error", () => this.handleTerminalFailure("recorder_worker_failed"));
    // An unexpected exit (any code — 0 included) while the recorder is still
    // open is a loss; a normal close() sets `closed` first, so we skip it.
    this.worker.on("exit", () => {
      if (!this.closed) this.handleTerminalFailure("recorder_worker_exited");
    });
    this.worker.on("messageerror", () => this.handleTerminalFailure("recorder_worker_message_error"));
  }

  setDegradedHandler(handler: (snapshot: Required<Pick<SlowOperationSnapshot, "reason" | "site">>) => void): void {
    this.degradedHandler = handler;
  }

  snapshot(): SlowOperationSnapshot {
    return { ...this.degraded };
  }

  beginSyncSpan(site: string): Span {
    const span: Span = { spanId: randomUUID(), site, startedAt: performance.now() };
    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const state = new Int32Array(signal);
    try {
      this.worker.postMessage({
        type: "append",
        signal,
        logPath: this.logPath,
        maxBytes: this.maxBytes,
        rotationCount: this.rotationCount,
        record: { v: 1, ts: new Date().toISOString(), spanId: span.spanId, phase: "begin", site },
      });
    } catch {
      // Synchronous postMessage failure means the Worker is gone: degrade
      // through the terminal transition but still return the span so the
      // wrapped operation runs to completion (its value/error stays exact).
      this.handleTerminalFailure("recorder_post_failed", site);
      return span;
    }
    const wait = Atomics.wait(state, 0, 0, this.barrierTimeoutMs);
    if (wait === "timed-out") this.markDegraded("begin_barrier_timeout", site);
    else if (Atomics.load(state, 0) !== 1) this.markDegraded("begin_barrier_failed", site);
    return span;
  }

  runSync<T>(site: string, fn: () => T): T {
    const span = this.beginSyncSpan(site);
    try {
      const value = fn();
      this.endSpan(span, "ok");
      return value;
    } catch (error) {
      this.endSpan(span, "failed");
      throw error;
    }
  }

  async runStage<T>(
    site: string,
    fn: () => Promise<T>,
    classify?: (value: T) => "ok" | "failed",
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const value = await fn();
      this.recordMeasurement(site, performance.now() - startedAt, classify?.(value) ?? "ok");
      return value;
    } catch (error) {
      this.recordMeasurement(site, performance.now() - startedAt, "failed");
      throw error;
    }
  }

  recordMeasurement(site: string, durationMs: number, outcome: "ok" | "failed" = "ok"): void {
    this.appendAsync({
      v: 1,
      ts: new Date().toISOString(),
      spanId: randomUUID(),
      phase: "end",
      site,
      durationMs: Math.max(0, durationMs),
      outcome,
    });
  }

  recordRequest(site: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < this.slowThresholdMs) return;
    this.recordMeasurement(`request:${site}`, durationMs);
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    // Rejects with SlowOpRecorderTerminatedError when the Worker is lost —
    // finite, and never a false durable-drain success.
    await this.postAndWait({ type: "flush" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Best-effort drain that still tears the Worker down and finishes finitely,
    // but preserves a terminal drain failure for the caller (index.ts maps it
    // to a nonzero exit so a lost drain never looks like a clean shutdown).
    let drainError: unknown;
    try {
      await this.flush();
    } catch (error) {
      drainError = error;
    }
    this.closed = true;
    await this.worker.terminate();
    if (drainError) throw drainError;
  }

  private endSpan(span: Span, outcome: "ok" | "failed"): void {
    this.appendAsync({
      v: 1,
      ts: new Date().toISOString(),
      spanId: span.spanId,
      phase: "end",
      site: span.site,
      durationMs: Math.max(0, performance.now() - span.startedAt),
      outcome,
    });
  }

  private appendAsync(record: Record<string, unknown>): void {
    if (this.closed) return;
    // Fire-and-forget: a terminal Worker loss rejects this promise, so we
    // internalize that outcome — Worker loss must never surface as an
    // unhandled rejection on a measurement path.
    void this.postAndWait({
      type: "append",
      logPath: this.logPath,
      maxBytes: this.maxBytes,
      rotationCount: this.rotationCount,
      record,
    }).catch(() => {});
  }

  private postAndWait(message: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.terminalReason !== null) return Promise.reject(this.terminalError());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...message, id });
      } catch {
        // Synchronous postMessage failure — the Worker is gone. Same terminal
        // transition; this waiter is rejected along with any others.
        this.pending.delete(id);
        this.handleTerminalFailure("recorder_post_failed");
        reject(this.terminalError());
      }
    });
  }

  private terminalError(): SlowOpRecorderTerminatedError {
    return new SlowOpRecorderTerminatedError(this.terminalReason ?? "recorder_terminated");
  }

  /**
   * The single terminal-failure transition for every unrecoverable Worker-loss
   * trigger. Idempotent (settles pending exactly once), marks health degraded
   * with the one-shot high-urgency signal, and rejects every pending waiter so
   * no flush hangs or reports a false durable drain.
   */
  private handleTerminalFailure(reason: string, site = "recorder.worker"): void {
    if (this.terminalReason !== null) return;
    this.terminalReason = reason;
    this.markDegraded(reason, site);
    const error = this.terminalError();
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private markDegraded(reason: string, site: string): void {
    if (!this.degraded.healthy) return;
    this.degraded = { healthy: false, reason, site };
    try {
      this.degradedHandler?.({ reason, site });
    } catch {}
  }
}
