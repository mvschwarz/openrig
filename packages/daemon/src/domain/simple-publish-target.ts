import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { ArtifactIdentity, BoundAcceptance } from "./artifact-acceptance.js";
import { artifactDigest } from "./artifact-acceptance.js";

/**
 * Lease-free disposable publish target (Topic D unstack).
 *
 * Proves receipt↔operation and accept↔artifact without WriterAuthority.
 * Not an OS sandbox — soft seal only. Topic C adds the API fence on top.
 */

export interface PublishReceipt {
  receiptId: string;
  resourceId: string;
  operationId: string;
  artifactDigest: string;
  artifact: ArtifactIdentity;
  judgmentId: string;
  publishedAt: string;
  contentSha256: string;
  publishedPath: string;
  receiptPath: string;
}

export class SimplePublishError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export class SimplePublishTarget {
  readonly targetRoot: string;
  readonly resourceId: string;
  readonly publishedPath: string;
  private readonly receiptsDir: string;

  constructor(opts: { targetRoot: string; resourceId: string }) {
    if (!opts.targetRoot || !path.isAbsolute(opts.targetRoot)) {
      throw new SimplePublishError(
        "target_root_required",
        "SimplePublishTarget requires an absolute disposable targetRoot",
        { targetRoot: opts.targetRoot },
      );
    }
    this.targetRoot = path.resolve(opts.targetRoot);
    this.resourceId = opts.resourceId;
    const gateDir = path.join(this.targetRoot, ".gate");
    this.publishedPath = path.join(gateDir, "published", "artifact.json");
    this.receiptsDir = path.join(gateDir, "receipts");
    fs.mkdirSync(path.dirname(this.publishedPath), { recursive: true });
    fs.mkdirSync(this.receiptsDir, { recursive: true });
  }

  readPublished(): { artifact: ArtifactIdentity; contentSha256: string; body: string } | null {
    try {
      return JSON.parse(fs.readFileSync(this.publishedPath, "utf8")) as {
        artifact: ArtifactIdentity;
        contentSha256: string;
        body: string;
      };
    } catch {
      return null;
    }
  }

  readLatestReceipt(): PublishReceipt | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.receiptsDir, "latest.json"), "utf8"),
      ) as PublishReceipt;
    } catch {
      return null;
    }
  }

  publish(input: {
    operationId: string;
    acceptance: BoundAcceptance;
    body: string;
  }): PublishReceipt {
    if (input.acceptance.artifact.dirty) {
      throw new SimplePublishError(
        "dirty_candidate_refused",
        "refuse publish: candidate must be a clean immutable snapshot",
        { artifact: input.acceptance.artifact },
      );
    }
    if (!input.operationId?.trim()) {
      throw new SimplePublishError("operation_id_required", "operationId is required");
    }

    const contentSha256 = createHash("sha256").update(input.body).digest("hex");
    const digest = artifactDigest(input.acceptance.artifact);
    const payload = {
      artifact: input.acceptance.artifact,
      artifactDigest: digest,
      contentSha256,
      body: input.body,
      judgmentId: input.acceptance.judgmentId,
      operationId: input.operationId,
    };

    this.writeSealed(this.publishedPath, JSON.stringify(payload, null, 2) + "\n");
    const publishedAt = new Date().toISOString();
    const receipt: PublishReceipt = {
      receiptId: createHash("sha256")
        .update(`${digest}:${input.operationId}:${publishedAt}:${contentSha256}`)
        .digest("hex")
        .slice(0, 32),
      resourceId: this.resourceId,
      operationId: input.operationId,
      artifactDigest: digest,
      artifact: { ...input.acceptance.artifact },
      judgmentId: input.acceptance.judgmentId,
      publishedAt,
      contentSha256,
      publishedPath: this.publishedPath,
      receiptPath: path.join(this.receiptsDir, `${input.operationId}.json`),
    };
    this.writeSealed(receipt.receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    this.writeSealed(
      path.join(this.receiptsDir, "latest.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    return receipt;
  }

  private writeSealed(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      try {
        fs.chmodSync(filePath, 0o644);
      } catch {
        /* first write */
      }
    }
    const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o444);
  }
}
