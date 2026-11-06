import { createHash } from "node:crypto";
import type { SimplePublishTarget, PublishReceipt } from "./simple-publish-target.js";
import { SimplePublishError } from "./simple-publish-target.js";
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
 * **Independent of Topic C writer leases.** Uses optional
 * {@link SimplePublishTarget}; when absent, simulation=true and never
 * published=true. Receipts are keyed by `operationId` (historical), not
 * "latest on target".
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
  /** True when no SimplePublishTarget is wired — never silent published=true. */
  simulation: boolean;
  receipt: PublishReceipt | null;
  replayed: boolean;
}

export interface OperationPublishInput {
  operationId: string;
  artifact: ArtifactIdentity;
  body?: string;
  actor: string;
  reason: string;
}

export class OperationPublishService {
  private readonly target: SimplePublishTarget | null;
  private readonly now: () => Date;
  private readonly acceptances = new Map<string, BoundAcceptance>();
  private readonly contentByOperation = new Map<string, string>();
  private readonly receiptsByOperation = new Map<string, PublishReceipt>();

  constructor(opts: { publishTarget?: SimplePublishTarget | null; now?: () => Date } = {}) {
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

    if (useTarget && input.body === undefined) {
      throw new OperationPublishError(
        "body_required",
        "real publish requires the clean candidate body",
      );
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
          operationId: input.operationId,
          acceptance,
          body: input.body!,
        });
      } catch (err) {
        if (err instanceof SimplePublishError) {
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
