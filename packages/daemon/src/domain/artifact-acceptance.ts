import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * Exact-artifact acceptance (OpenRig writer-authority extract).
 *
 * Judgments that gate publish must bind to a **clean immutable** candidate
 * identity (repo, commit, tree with dirty=false). "SHA + dirty=true" is not
 * acceptable identity. Publishing artifact B under a judgment recorded for
 * artifact A is refused.
 */

export interface ArtifactIdentity {
  /** Absolute or canonical repo path / URL key. */
  repo: string;
  /** Full commit SHA (or synthetic digest for fixture trees). */
  commit: string;
  /** Tree SHA (git rev-parse HEAD^{tree}) or content digest. */
  tree: string;
  /** True when the worktree has uncommitted changes relative to commit. */
  dirty: boolean;
}

export interface BoundAcceptance {
  judgmentId: string;
  verdict: "accept";
  artifact: ArtifactIdentity;
  /** Stable digest of the identity — what publish compares against. */
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
  const payload = {
    repo: identity.repo,
    commit: identity.commit,
    tree: identity.tree,
    dirty: identity.dirty,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function identitiesEqual(a: ArtifactIdentity, b: ArtifactIdentity): boolean {
  return artifactDigest(a) === artifactDigest(b);
}

/**
 * Bind an accept judgment to an exact **clean** artifact identity.
 * Dirty / untracked candidates are refused — not a valid publish identity.
 */
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

/** Clean immutable snapshot required for accept/publish. */
export function assertCleanCandidate(identity: ArtifactIdentity): void {
  assertIdentity(identity);
  if (identity.dirty) {
    throw new ArtifactAcceptanceError(
      "dirty_candidate_refused",
      "refuse: dirty/untracked candidate is not a valid publish identity (need a clean immutable snapshot)",
      { identity },
    );
  }
}

/**
 * Refuse publish when the current artifact does not match the bound judgment.
 * Classic failure: publish B with judgment recorded for A.
 * Dirty candidates are always refused (not a valid publish identity).
 */
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
  if (acceptance.artifact.dirty) {
    throw new ArtifactAcceptanceError(
      "dirty_candidate_refused",
      "refuse publish: judgment was bound to a dirty candidate (invalid)",
      { artifact: acceptance.artifact },
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
        judgmentArtifact: acceptance.artifact,
        currentArtifact: current,
      },
    );
  }
}

/**
 * Capture identity from a git worktree. For fixtures without git, callers
 * should construct ArtifactIdentity directly.
 */
export function captureGitArtifactIdentity(repoPath: string): ArtifactIdentity {
  const run = (args: string[]) =>
    execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  let commit: string;
  let tree: string;
  try {
    commit = run(["rev-parse", "HEAD"]);
    tree = run(["rev-parse", "HEAD^{tree}"]);
  } catch (err) {
    throw new ArtifactAcceptanceError(
      "git_identity_unavailable",
      `cannot resolve commit/tree in ${repoPath}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
  let dirty = false;
  try {
    dirty = run(["status", "--porcelain"]).length > 0;
  } catch {
    dirty = true;
  }
  return { repo: repoPath, commit, tree, dirty };
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
