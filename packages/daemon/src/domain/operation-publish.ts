import { createHash } from "node:crypto";
import type { WriterAuthority } from "./writer-authority.js";
import { WriterAuthorityError } from "./writer-authority.js";
import type { FencedPublishTarget, PublishReceipt } from "./fenced-publish-target.js";
import { FencedPublishError } from "./fenced-publish-target.js";
import {
  ArtifactAcceptanceError,
  artifactDigest,
  assertPublishAllowed,
  bindAcceptance,
  type ArtifactIdentity,
  type BoundAcceptance,
} from "./artifact-acceptance.js";

/**
 * Thin accept↔artifact + receipt↔operation binding (Topic D).
 *
 * Stacked on WriterAuthority / FencedPublishTarget (Topic C). This is **not**
 * ExecutionSliceService: no seats/roles/queue/Jeff — only:
 * 1. Accept binds a clean immutable artifact identity
 * 2. Receipt is keyed by `operationId` (historical), not "latest on target"
 */

export class OperationPublishError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export interface OperationPublishResult {
  acceptance: BoundAcceptance;
  published: boolean;
  /** True when no FencedPublishTarget is wired — never silent published=true. */
  simulation: boolean;
  receipt: PublishReceipt | null;
  replayed: boolean;
}

export interface OperationPublishInput {
  /** Stable id for this accept/publish operation (submission / op key). */
  operationId: string;
  artifact: ArtifactIdentity;
  /** Immutable candidate body bytes. Required for real publish; optional for simulation replay checks. */
  body?: string;
  actor: string;
  reason: string;
  holderSession: string;
  generation: number;
}

export class OperationPublishService {
  private readonly writers: WriterAuthority;
  private readonly target: FencedPublishTarget | null;
  private readonly now: () => Date;
  private readonly acceptances = new Map<string, BoundAcceptance>();
  private readonly contentByOperation = new Map<string, string>();
  /** Per-operation historical receipts — not target latest. */
  private readonly receiptsByOperation = new Map<string, PublishReceipt>();

  constructor(opts: {
    writers: WriterAuthority;
    publishTarget?: FencedPublishTarget | null;
    now?: () => Date;
  }) {
    this.writers = opts.writers;
    this.target = opts.publishTarget ?? null;
    this.now = opts.now ?? (() => new Date());
  }

  getReceipt(operationId: string): PublishReceipt | null {
    return this.receiptsByOperation.get(operationId) ?? null;
  }

  acceptAndPublish(input: OperationPublishInput): OperationPublishResult {
    if (!input.operationId?.trim()) {
      throw new OperationPublishError("operation_id_required", "operationId is required");
    }

    const useTarget = this.target !== null;
    const existing = this.acceptances.get(input.operationId);
    if (existing && existing.digest === artifactDigest(input.artifact)) {
      return this.replayExisting(input, existing, useTarget);
    }

    if (useTarget) {
      if (input.body === undefined) {
        throw new OperationPublishError(
          "body_required",
          "real publish requires the clean candidate body",
        );
      }
    }

    // Real publish requires a live publish_target lease. Simulation (no target)
    // still binds accept↔artifact but never claims published=true.
    if (useTarget) {
      try {
        this.writers.assertHolder(
          "publish_target",
          this.target!.resourceId,
          input.holderSession,
          input.generation,
        );
      } catch (err) {
        if (err instanceof WriterAuthorityError) {
          throw new OperationPublishError(err.code, err.message, err.meta);
        }
        throw err;
      }
    }

    let acceptance: BoundAcceptance;
    try {
      acceptance = bindAcceptance({
        judgmentId: `judgment:${input.operationId}`,
        artifact: input.artifact,
        actor: input.actor,
        reason: input.reason,
        at: this.now().toISOString(),
      });
      assertPublishAllowed(acceptance, input.artifact);
    } catch (err) {
      if (err instanceof ArtifactAcceptanceError) {
        throw new OperationPublishError(err.code, err.message, err.meta);
      }
      throw err;
    }

    const contentSha256 =
      input.body !== undefined
        ? createHash("sha256").update(input.body).digest("hex")
        : "";

    let receipt: PublishReceipt | null = null;
    if (useTarget) {
      try {
        receipt = this.target!.publish({
          holderSession: input.holderSession,
          generation: input.generation,
          acceptance,
          body: input.body!,
        });
      } catch (err) {
        if (err instanceof FencedPublishError) {
          throw new OperationPublishError(err.code, err.message, err.meta);
        }
        throw err;
      }
    }

    this.acceptances.set(input.operationId, acceptance);
    if (contentSha256) this.contentByOperation.set(input.operationId, contentSha256);
    if (receipt) this.receiptsByOperation.set(input.operationId, receipt);

    return {
      acceptance,
      published: useTarget && receipt !== null,
      simulation: !useTarget,
      receipt,
      replayed: false,
    };
  }

  private replayExisting(
    input: OperationPublishInput,
    existing: BoundAcceptance,
    useTarget: boolean,
  ): OperationPublishResult {
    const priorContent = this.contentByOperation.get(input.operationId);
    if (useTarget && input.body !== undefined && priorContent) {
      const bodyHash = createHash("sha256").update(input.body).digest("hex");
      if (bodyHash !== priorContent) {
        throw new OperationPublishError(
          "content_digest_mismatch",
          "retry body does not match the previously accepted content digest",
          { expected: priorContent, actual: bodyHash },
        );
      }
    }
    const historical = this.receiptsByOperation.get(input.operationId) ?? null;
    return {
      acceptance: existing,
      published: useTarget && historical !== null,
      simulation: !useTarget,
      receipt: historical,
      replayed: true,
    };
  }
}
