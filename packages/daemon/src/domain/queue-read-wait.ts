import type { EventBus } from "./event-bus.js";
import type { QueueItem, QueueRepository } from "./queue-repository.js";

/** A read waits only while its own item remains actionable; a claim or progress note is not an answer. */
export function waitForQueueItem(repo: QueueRepository, bus: EventBus, qitemId: string, seconds: number,
  signal: AbortSignal): Promise<{ item: QueueItem | null; parked: boolean; waited?: { outcome: "timeout"; seconds: number } }> {
  if (seconds === 0) return Promise.resolve({ item: repo.getById(qitemId), parked: false });
  return new Promise((resolve, reject) => {
    let parked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => { cleanup(); reject(signal.reason ?? new Error("Queue read canceled")); };
    const read = (timedOut = false) => {
      try {
        const item = repo.getById(qitemId);
        const active = item?.state === "pending" || item?.state === "in-progress";
        if (active && !timedOut) {
          parked = true;
          return;
        }
        cleanup();
        resolve({ item, parked, ...(active && timedOut ? { waited: { outcome: "timeout" as const, seconds } } : {}) });
      } catch (error) { cleanup(); reject(error); }
    };
    // Subscribe before the first read: completion between the two cannot be lost.
    // Read the authoritative row, never infer its state from an event's payload.
    unsubscribe = bus.subscribe(event => { if ("qitemId" in event && event.qitemId === qitemId) read(); });
    timer = setTimeout(() => read(true), seconds * 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else read();
  });
}
