import { createHash } from "node:crypto";

/**
 * Read-only capture observer (0.6.0 S01/S02 P2).
 *
 * Records what the send/verify, probe and guard-retention paths ALREADY saw, so a
 * later offline or asynchronous consumer can classify it. It never decides
 * anything: it grants no paste/Enter/replay authority, takes no new capture and
 * never changes the caller's result.
 *
 * `record()` is the only call made on the hot path. It is synchronous, does no
 * I/O, never awaits and never throws: an internal failure is counted, not raised.
 * The queue is bounded; when full, the NEW observation is dropped and counted so
 * denominators stay honest. `drain()` hands bounded batches to an injected
 * consumer; it never replays a batch and never blocks `record()`.
 */

export type ObserverSeam = "send_verify" | "probe_activity" | "retained_no_write";

/**
 * What a capture slot held. `unavailable` never claims a cause it cannot know.
 * captureSeq orders observed capture invocations in one transport process;
 * capturedAt timestamps their return/error. Neither is observation enqueue order
 * or a provider clock. Join persisted evidence by attemptId and pre/post slot.
 */
export type CaptureSlot =
  | { state: "captured"; content: string; capturedAt: string; captureSeq: number }
  /** The adapter returned null, which at this base means empty OR failed. */
  | { state: "unavailable"; cause: "empty_or_failed"; capturedAt: string; captureSeq: number }
  /** The capture call threw: the failure itself is known. */
  | { state: "unavailable"; cause: "capture_error"; capturedAt: string; captureSeq: number }
  /** This attempt did not ask for this capture (e.g. send without verify). */
  | { state: "not_requested" }
  /** Requested, but the attempt ended before reaching it (e.g. paste failed). */
  | { state: "not_reached" };

export interface ObservedBinding {
  sessionName: string;
  nodeId: string | null;
  occupant: string | null;
  pane: string | null;
}

export interface ObservationInput {
  seam: ObserverSeam;
  /** One id per transport attempt; the same attempt's observations share it. */
  attemptId: string;
  binding: ObservedBinding;
  runtime: string | null;
  /** Hash of the sent text, never the text itself; null when nothing was sent. */
  sentHash: string | null;
  pre: CaptureSlot;
  post: CaptureSlot;
  /**
   * The existing regex/transport verdict: only fields the caller actually
   * produced are copied; an absent optional field stays absent, never a verdict.
   */
  regexResult: Record<string, unknown>;
  /** When the attempt completed (distinct from each capture's capturedAt). */
  completedAt: string;
}

export interface Observation extends Readonly<ObservationInput> {
  /** Monotonic order of acceptance into this observer. */
  readonly seq: number;
}

export interface CaptureObserverStats {
  recorded: number;
  dropped: number;
  recordErrors: number;
  missingCaptures: number;
  notRequestedCaptures: number;
  notReachedCaptures: number;
  drained: number;
  consumerFailures: number;
  consumerFailedObservations: number;
  queued: number;
  queuedBytes: number;
  drainingBytes: number;
  droppedBytes: number;
}

export type ObservationConsumer = (batch: readonly Observation[]) => void | Promise<void>;

export const DEFAULT_OBSERVER_CAPACITY = 256;
export const DEFAULT_DRAIN_BATCH = 64;

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function hashSentText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** Deep-freeze plain data so a queued observation cannot be mutated later. */
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) freeze(v);
  }
  return value;
}

export class CaptureObserver {
  private accepting = true;
  private readonly capacity: number;
  private readonly queue: Observation[] = [];
  private readonly maxQueuedBytes: number;
  private readonly maxObservationBytes: number;
  private queuedBytes = 0;
  private drainingBytes = 0;
  private readonly sizes: number[] = [];
  private nextSeq = 1;
  private draining = false;
  private readonly counters = {
    recorded: 0, dropped: 0, droppedBytes: 0, recordErrors: 0, missingCaptures: 0, notRequestedCaptures: 0, notReachedCaptures: 0,
    drained: 0, consumerFailures: 0, consumerFailedObservations: 0,
  };

  constructor(opts?: { capacity?: number; maxQueuedBytes?: number; maxObservationBytes?: number }) {
    this.capacity = positiveInteger(opts?.capacity, DEFAULT_OBSERVER_CAPACITY);
    this.maxQueuedBytes = positiveInteger(opts?.maxQueuedBytes, 4 * 1024 * 1024);
    this.maxObservationBytes = positiveInteger(opts?.maxObservationBytes, 256 * 1024);
  }

  /** Hot-path entry. Synchronous, no I/O, never throws. */
  record(input: ObservationInput): void {
    if (!this.accepting) return;
    try {
      for (const slot of [input.pre, input.post]) {
        if (slot.state === "unavailable") this.counters.missingCaptures++;
        else if (slot.state === "not_requested") this.counters.notRequestedCaptures++;
        else if (slot.state === "not_reached") this.counters.notReachedCaptures++;
      }
      if (this.queue.length >= this.capacity) {
        this.counters.dropped++;
        return;
      }
      const contentBytes = [input.pre, input.post].reduce((n, slot) => n + (slot.state === "captured" ? Buffer.byteLength(slot.content) : 0), 0);
      if (contentBytes > this.maxObservationBytes) { this.counters.dropped++; this.counters.droppedBytes += contentBytes; return; }
      const observation = freeze({ ...structuredClone(input), seq: this.nextSeq++ }) as Observation;
      const size = Buffer.byteLength(JSON.stringify(observation)) + 1;
      if (size > this.maxObservationBytes || this.queuedBytes + size > this.maxQueuedBytes) {
        this.counters.dropped++; this.counters.droppedBytes += size; return;
      }
      this.sizes.push(size); this.queuedBytes += size;
      this.queue.push(observation);
      this.counters.recorded++;
    } catch {
      this.counters.recordErrors++;
    }
  }

  /**
   * Hand up to `maxItems` queued observations to `consumer`, in order. Removed
   * before the call: a failing consumer loses that batch (counted), it is never
   * replayed. Concurrent drains are refused (returns 0) rather than awaited.
   */
  async drain(consumer: ObservationConsumer, maxItems = DEFAULT_DRAIN_BATCH): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    const batch = Object.freeze(this.queue.splice(0, positiveInteger(maxItems, DEFAULT_DRAIN_BATCH)));
    this.drainingBytes = this.sizes.splice(0, batch.length).reduce((n, size) => n + size, 0);
    this.queuedBytes -= this.drainingBytes;
    try {
      if (batch.length === 0) return 0;
      await consumer(batch);
      this.counters.drained += batch.length;
      return batch.length;
    } catch {
      this.counters.consumerFailures++;
      this.counters.consumerFailedObservations += batch.length;
      return 0;
    } finally {
      this.draining = false; this.drainingBytes = 0;
    }
  }

  stats(): CaptureObserverStats {
    return { ...this.counters, queued: this.queue.length, queuedBytes: this.queuedBytes, drainingBytes: this.drainingBytes };
  }

  /** Stop new observations; an already queued batch remains available to drain. */
  stopRecording(): void { this.accepting = false; }
}

/** The narrow interface the transport depends on (any sink with a safe record()). */
export interface CaptureObserverSink {
  record(input: ObservationInput): void;
}
