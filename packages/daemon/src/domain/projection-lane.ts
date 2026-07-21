// slice-04 — one process-local cooperative projection lane shared by /api/ps and
// /api/rigs/summary.
//
// Both routes' whole synchronous response construction (projection + c.json) runs
// as ONE job here. The lane serializes jobs FIFO and yields to the event loop
// (native setImmediate — the same pattern as queue-retention.ts) BEFORE every job,
// so under a concurrent burst the loop is monopolized for at most ONE job at a time
// and interleaved work (e.g. /healthz) stays responsive. It is NOT a cache, worker,
// or generic async framework: no cancellation, no config, no persistence — just
// cooperative yielding between synchronous jobs.
const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

class ProjectionLane {
  // The FIFO chain. Each job runs after the previous settles; `tail` is recovered
  // after both success and failure so one throwing job never wedges the lane.
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => T): Promise<T> {
    const result = this.tail.then(async () => {
      await yieldToLoop(); // yield BEFORE the synchronous job so the loop can service other work
      return job();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// Process-local singleton — owned by this module; no wiring/DI change, so the
// route files import it directly and the (frozen) test fixture wiring is untouched.
export const projectionLane = new ProjectionLane();
