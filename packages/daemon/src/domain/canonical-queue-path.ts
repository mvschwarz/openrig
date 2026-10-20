/**
 * Thin Stage 1 contract 4 extract: public submit → one QueueRepository row →
 * real executor claim/close of THAT same qitem.
 *
 * Does **not** replace the full OpenRig / PiotrOS queue product surface.
 * Wraps the existing QueueRepository so callers cannot accidentally treat
 * EventBus-only rebuild as proof of canonical queue integration.
 */
import type { QueueItem, QueueRepository } from "./queue-repository.js";

export class CanonicalQueuePathError extends Error {
  constructor(
    readonly code: "queue_not_wired" | "qitem_missing" | "wrong_state",
    message: string,
  ) {
    super(message);
    this.name = "CanonicalQueuePathError";
  }
}

export interface CanonicalSubmitInput {
  summary: string;
  body?: string;
  sourceSession: string;
  destinationSession: string;
  /** Optional stable id; when omitted QueueRepository allocates one. */
  qitemId?: string;
}

export interface CanonicalSubmitResult {
  qitemId: string;
  state: QueueItem["state"];
}

export interface CanonicalCompleteInput {
  qitemId: string;
  actorSession: string;
  /** Correlation id stored as closureTarget (e.g. receipt / result id). */
  correlationId: string;
  transitionNote?: string;
}

/**
 * Product-facing path that always goes through the canonical QueueRepository.
 * Construct with an explicit repository — never invent queue rows from events alone.
 */
export class CanonicalQueuePath {
  constructor(private readonly queue: QueueRepository | null | undefined) {}

  private requireQueue(): QueueRepository {
    if (!this.queue) {
      throw new CanonicalQueuePathError(
        "queue_not_wired",
        "CanonicalQueuePath requires a QueueRepository; EventBus rebuild alone does not invent queue rows",
      );
    }
    return this.queue;
  }

  async submit(input: CanonicalSubmitInput): Promise<CanonicalSubmitResult> {
    const queue = this.requireQueue();
    const created = await queue.create({
      qitemId: input.qitemId,
      sourceSession: input.sourceSession,
      destinationSession: input.destinationSession,
      body: input.body ?? input.summary,
      nudge: false,
    });
    return { qitemId: created.qitemId, state: created.state };
  }

  claimAsExecutor(qitemId: string, destinationSession: string): QueueItem {
    const queue = this.requireQueue();
    return queue.claim({ qitemId, destinationSession });
  }

  complete(input: CanonicalCompleteInput): QueueItem {
    const queue = this.requireQueue();
    const existing = queue.getById(input.qitemId);
    if (!existing) {
      throw new CanonicalQueuePathError("qitem_missing", `qitem ${input.qitemId} not found`);
    }
    return queue.update({
      qitemId: input.qitemId,
      actorSession: input.actorSession,
      state: "done",
      closureReason: "no-follow-on",
      closureTarget: input.correlationId,
      transitionNote:
        input.transitionNote ?? `canonical-complete:${input.correlationId}`,
    });
  }

  get(qitemId: string): QueueItem | null {
    return this.requireQueue().getById(qitemId);
  }
}
