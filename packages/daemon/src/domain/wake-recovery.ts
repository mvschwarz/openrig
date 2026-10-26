import type { QueueRepository } from "./queue-repository.js";

/** Startup's one recovery pass over current queue notifications, owned by the daemon but run after it listens. */
export interface WakeRecovery {
  /** Begins the pass (once); returns at once. */
  start(): void;
  /** Ends the pass after the delivery in flight, if any; notifications not yet attempted wait for the next start. */
  stop(): Promise<void>;
}

/**
 * Each recovered notification is a real, verified seat delivery, so a large current backlog takes as long as its
 * deliveries. The daemon's readiness must not wait for that: index.ts starts this pass once the daemon listens and
 * stops it first on shutdown. Claims left by an earlier process were reconciled before transport started
 * (`reconciled`), and an attempt interrupted by this stop is reconciled the same way on the next start.
 */
export function createWakeRecovery(repo: Pick<QueueRepository, "drainPendingWakeIntents">, reconciled: number,
  log: Pick<Console, "log" | "warn"> = console): WakeRecovery {
  let stopping = false, cutShort = false;
  let running: Promise<void> | undefined;
  // True only when the pass actually skipped a delivery for the stop, not merely when stop arrived after the last one.
  const stopRequested = () => (stopping ? (cutShort = true) : false);
  return {
    start() {
      if (running || stopping) return;
      running = repo.drainPendingWakeIntents({ stopRequested }).then((drained) => {
        if (drained.delivered || drained.indeterminate || drained.failed || reconciled) {
          log.log(`wake-intent recovery sweep: delivered=${drained.delivered} indeterminate=${drained.indeterminate} failed=${drained.failed} reconciled=${reconciled}${cutShort ? " (stopped before the rest)" : ""}`);
        }
      }, (err: unknown) => {
        // Non-fatal, as before: a failed pass leaves its notifications visible and retried on the next start.
        log.warn(`wake-intent recovery sweep: failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    async stop() {
      stopping = true;
      await running;
    },
  };
}
