import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { WriterAuthority, WriterLease } from "./writer-authority.js";
import { WriterAuthorityError } from "./writer-authority.js";
import type { ArtifactIdentity, BoundAcceptance } from "./artifact-acceptance.js";
import { artifactDigest } from "./artifact-acceptance.js";
import { tripFailpoint } from "./failpoints.js";

/**
 * Disposable fenced publish/integration target (OpenRig disposable publish target).
 *
 * Guarantee boundary (honest):
 * - **API fencing:** Only {@link FencedPublishTarget.publish} under a live
 *   `publish_target` writer lease is the authorized mutation path. Revoke /
 *   stale generation blocks the OpenRig publish API.
 * - **Not an OS sandbox:** mode `0444` is a soft seal against accidental
 *   same-UID overwrite via open(O_WRONLY). A worker with the path can still
 *   `chmod` + write, `rename`/`replace`, or tamper with the receipt. Hidden
 *   path opacity is convenience, not a security boundary.
 * - Workers should receive the candidate workspace only — never treat path
 *   secrecy as enforcement.
 */

export interface PublishReceipt {
  receiptId: string;
  resourceId: string;
  artifactDigest: string;
  artifact: ArtifactIdentity;
  judgmentId: string;
  publishedAt: string;
  /** Bytes actually written (sha256). */
  contentSha256: string;
  /** Absolute path of the published artifact file. */
  publishedPath: string;
  /** Absolute path of the receipt file. */
  receiptPath: string;
}

export class FencedPublishError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export interface FencedPublishTargetOptions {
  /** Disposable absolute root (temp / sandbox OPENRIG_HOME subtree). */
  targetRoot: string;
  resourceId: string;
  writers: WriterAuthority;
}

export class FencedPublishTarget {
  readonly targetRoot: string;
  readonly resourceId: string;
  readonly publishedPath: string;
  readonly receiptPath: string;
  /** Secret gate dir — not handed to workers. */
  private readonly gateDir: string;
  private readonly writers: WriterAuthority;
  /** Opaque token proving caller is the publish gate (not a worker). */
  private readonly gateToken: string;

  constructor(opts: FencedPublishTargetOptions) {
    if (!opts.targetRoot || !path.isAbsolute(opts.targetRoot)) {
      throw new FencedPublishError(
        "target_root_required",
        "FencedPublishTarget requires an absolute disposable targetRoot",
        { targetRoot: opts.targetRoot },
      );
    }
    this.targetRoot = path.resolve(opts.targetRoot);
    this.resourceId = opts.resourceId;
    this.writers = opts.writers;
    this.gateToken = randomBytes(16).toString("hex");
    this.gateDir = path.join(this.targetRoot, ".gate");
    this.publishedPath = path.join(this.gateDir, "published", "artifact.json");
    this.receiptPath = path.join(this.gateDir, "receipts", "latest.json");
    fs.mkdirSync(path.dirname(this.publishedPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.receiptPath), { recursive: true });
    // Seal gate dir: workers without the path still cannot create siblings easily;
    // published artifact is 0444 after write so raw overwrite fails for same UID.
    fs.chmodSync(this.gateDir, 0o755);
  }

  /** Worker-visible candidate root (writable) — separate from the publish gate. */
  candidateWorkspace(): string {
    const dir = path.join(this.targetRoot, "candidate");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Path workers are told about for "status" — never the gate write path.
   * Reading may return null until a successful publish.
   */
  workerStatusPath(): string {
    return path.join(this.targetRoot, "public", "STATUS.md");
  }

  /** Fingerprint of authoritative target state (published + receipt). */
  targetStateFingerprint(): string {
    const published = this.safeRead(this.publishedPath);
    const receipt = this.safeRead(this.receiptPath);
    return createHash("sha256")
      .update(JSON.stringify({ published, receipt }))
      .digest("hex");
  }

  readPublished(): {
    artifact: ArtifactIdentity;
    contentSha256: string;
    body: string;
  } | null {
    const raw = this.safeRead(this.publishedPath);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as {
      artifact: ArtifactIdentity;
      contentSha256: string;
      body: string;
    };
    return parsed;
  }

  readReceipt(): PublishReceipt | null {
    const raw = this.safeRead(this.receiptPath);
    if (raw === null) return null;
    return JSON.parse(raw) as PublishReceipt;
  }

  /**
   * Authorized publish: requires live writer fence on this publish_target.
   * Writes sealed artifact + receipt; returns receipt after read-back check.
   */
  publish(input: {
    holderSession: string;
    generation: number;
    acceptance: BoundAcceptance;
    /** Immutable candidate body (clean snapshot bytes). */
    body: string;
  }): PublishReceipt {
    if (input.acceptance.artifact.dirty) {
      throw new FencedPublishError(
        "dirty_candidate_refused",
        "refuse publish: candidate must be a clean immutable snapshot (dirty=true is not acceptable identity)",
        { artifact: input.acceptance.artifact },
      );
    }

    const contentSha256 = createHash("sha256").update(input.body).digest("hex");
    const payload = {
      artifact: input.acceptance.artifact,
      artifactDigest: artifactDigest(input.acceptance.artifact),
      contentSha256,
      body: input.body,
      judgmentId: input.acceptance.judgmentId,
    };

    // Idempotent only when published bytes AND receipt both confirm THIS digest.
    // Skewed state (artifact B + receipt A) must NOT treat receipt A as confirmation of B.
    const priorReceipt = this.readReceipt();
    const priorPublished = this.readPublished();
    if (
      priorReceipt &&
      priorPublished &&
      priorPublished.contentSha256 === contentSha256 &&
      priorReceipt.contentSha256 === contentSha256 &&
      artifactDigest(priorPublished.artifact) === payload.artifactDigest &&
      priorReceipt.artifactDigest === payload.artifactDigest
    ) {
      return priorReceipt;
    }

    let receipt: PublishReceipt | null = null;
    try {
      this.writers.withProtectedMutation(
        "publish_target",
        this.resourceId,
        input.holderSession,
        input.generation,
        (_lease: WriterLease) => {
          this.privilegedWrite(
            this.publishedPath,
            JSON.stringify(payload, null, 2) + "\n",
          );
          // Crash window: artifact on disk, receipt not yet rewritten.
          tripFailpoint("publish_after_artifact");
          const publishedAt = new Date().toISOString();
          receipt = {
            receiptId: createHash("sha256")
              .update(`${payload.artifactDigest}:${publishedAt}:${contentSha256}`)
              .digest("hex")
              .slice(0, 32),
            resourceId: this.resourceId,
            artifactDigest: payload.artifactDigest,
            artifact: { ...input.acceptance.artifact },
            judgmentId: input.acceptance.judgmentId,
            publishedAt,
            contentSha256,
            publishedPath: this.publishedPath,
            receiptPath: this.receiptPath,
          };
          this.privilegedWrite(this.receiptPath, JSON.stringify(receipt, null, 2) + "\n");
          // Public status pointer (no credentials) — digest only.
          const statusDir = path.dirname(this.workerStatusPath());
          fs.mkdirSync(statusDir, { recursive: true });
          fs.writeFileSync(
            this.workerStatusPath(),
            `# published\ndigest: ${payload.artifactDigest}\nreceipt: ${receipt.receiptId}\n`,
            { encoding: "utf8", mode: 0o644 },
          );
        },
      );
    } catch (err) {
      if (err instanceof WriterAuthorityError) {
        throw new FencedPublishError(err.code, err.message, err.meta);
      }
      throw err;
    }

    // Read-back: actually published artifact must match B.
    const readBack = this.readPublished();
    if (!readBack) {
      throw new FencedPublishError("publish_readback_missing", "published artifact missing after write");
    }
    if (
      readBack.contentSha256 !== contentSha256 ||
      artifactDigest(readBack.artifact) !== artifactDigest(input.acceptance.artifact)
    ) {
      throw new FencedPublishError(
        "publish_readback_mismatch",
        "read-back of published artifact does not match the accepted candidate",
        { expected: payload, actual: readBack },
      );
    }
    const storedReceipt = this.readReceipt();
    if (!storedReceipt || storedReceipt.receiptId !== receipt!.receiptId) {
      throw new FencedPublishError("receipt_missing", "publish receipt not recorded");
    }
    return storedReceipt;
  }

  /**
   * Simulate a worker/attacker bypass: raw write to the sealed published path
   * without a writer lease. On a correctly sealed target this fails (EACCES)
   * and {@link targetStateFingerprint} stays unchanged.
   */
  attemptRawBypassWrite(evilBody: string): { ok: false; error: string } | { ok: true } {
    try {
      fs.writeFileSync(this.publishedPath, evilBody, { encoding: "utf8", flag: "w" });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Gate token is never exposed to workers — tests may assert opacity. */
  hasGateToken(token: string): boolean {
    return token === this.gateToken;
  }

  private privilegedWrite(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Temporarily writable for the gated writer only.
    if (fs.existsSync(filePath)) {
      try {
        fs.chmodSync(filePath, 0o644);
      } catch {
        /* first write */
      }
    }
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644 });
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, 0o444); // sealed: raw overwrite by worker → EACCES
  }

  private safeRead(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  }
}
