import { createHash } from "node:crypto";

/**
 * Exact-artifact acceptance (Topic D — accept↔artifact).
 *
 * Judgments that gate publish must bind to a **clean immutable** candidate
 * identity (repo, commit, tree with dirty=false). Publishing artifact B under
 * a judgment recorded for artifact A is refused.
 *
 * Independent of writer leases (Topic C): this module is pure binding.
 */

export interface ArtifactIdentity {
  repo: string;
  commit: string;
  tree: string;
  dirty: boolean;
}

export interface BoundAcceptance {
  judgmentId: string;
  verdict: "accept";
  artifact: ArtifactIdentity;
  digest: string;
  actor: string;
  at: string;
  reason: string;
}

export class ArtifactAcceptanceError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export function artifactDigest(identity: ArtifactIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repo: identity.repo,
        commit: identity.commit,
        tree: identity.tree,
        dirty: identity.dirty,
      }),
    )
    .digest("hex");
}

export function bindAcceptance(input: {
  judgmentId: string;
  artifact: ArtifactIdentity;
  actor: string;
  reason: string;
  at?: string;
}): BoundAcceptance {
  assertIdentity(input.artifact);
  assertCleanCandidate(input.artifact);
  if (!input.judgmentId?.trim()) {
    throw new ArtifactAcceptanceError("judgment_required", "judgmentId is required");
  }
  if (!input.actor?.trim()) {
    throw new ArtifactAcceptanceError("actor_required", "actor is required");
  }
  if (!input.reason?.trim()) {
    throw new ArtifactAcceptanceError("reason_required", "reason is required");
  }
  return {
    judgmentId: input.judgmentId,
    verdict: "accept",
    artifact: { ...input.artifact },
    digest: artifactDigest(input.artifact),
    actor: input.actor,
    at: input.at ?? new Date().toISOString(),
    reason: input.reason,
  };
}

export function assertCleanCandidate(identity: ArtifactIdentity): void {
  assertIdentity(identity);
  if (identity.dirty) {
    throw new ArtifactAcceptanceError(
      "dirty_candidate_refused",
      "refuse: dirty/untracked candidate is not a valid publish identity",
      { identity },
    );
  }
}

/** Refuse publish when the current artifact does not match the bound judgment. */
export function assertPublishAllowed(
  acceptance: BoundAcceptance,
  current: ArtifactIdentity,
): void {
  assertIdentity(current);
  assertCleanCandidate(current);
  if (acceptance.verdict !== "accept") {
    throw new ArtifactAcceptanceError(
      "not_accepted",
      "only an accept judgment may authorize publish",
      { judgmentId: acceptance.judgmentId },
    );
  }
  const judged = acceptance.artifact;
  if (
    judged.repo !== current.repo ||
    judged.commit !== current.commit ||
    judged.tree !== current.tree
  ) {
    throw new ArtifactAcceptanceError(
      "artifact_mismatch",
      "refuse publish: judgment is bound to a different artifact identity",
      {
        judgmentId: acceptance.judgmentId,
        judgmentDigest: acceptance.digest,
        currentDigest: artifactDigest(current),
      },
    );
  }
}

function assertIdentity(identity: ArtifactIdentity): void {
  if (!identity.repo?.trim() || !identity.commit?.trim() || !identity.tree?.trim()) {
    throw new ArtifactAcceptanceError(
      "identity_incomplete",
      "artifact identity requires repo, commit, and tree",
      { identity },
    );
  }
  if (typeof identity.dirty !== "boolean") {
    throw new ArtifactAcceptanceError(
      "identity_incomplete",
      "artifact identity requires dirty: boolean",
      { identity },
    );
  }
}
