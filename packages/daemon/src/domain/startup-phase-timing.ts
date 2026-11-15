import { performance } from "node:perf_hooks";
import type { SlowOperationInstrumentation } from "./slow-op-recorder.js";

type StartupPhase = "migrations" | "reconciliation" | "managed_plugins" | "bind";
type Listener = "primary" | "secondary" | "guest";

/** Completed intervals only: no timers, readiness decisions or startup I/O. */
export function beginStartupPhase(phase: StartupPhase, listener?: Listener) {
  const fromElapsedMs = performance.now();
  const fromUtc = new Date().toISOString();
  return () => {
    const toElapsedMs = performance.now();
    return {
      schema: "openrig.startup-phase/v1", phase, pid: process.pid,
      fromUtc, toUtc: new Date().toISOString(), fromElapsedMs, toElapsedMs,
      durationMs: Math.max(0, toElapsedMs - fromElapsedMs),
      ...(listener ? { listener } : {}),
    };
  };
}

/** The bounded worker sink may drop a record; observation must never abort startup. */
export function recordStartupPhase(
  recorder: SlowOperationInstrumentation | undefined,
  record: ReturnType<ReturnType<typeof beginStartupPhase>>,
): void {
  try { recorder?.recordDiagnostic?.(record); } catch { /* observe only */ }
}
