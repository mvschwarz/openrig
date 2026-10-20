import { describe, it, expect } from "vitest";
import {
  artifactDigest,
  assertPublishAllowed,
  bindAcceptance,
  ArtifactAcceptanceError,
  type ArtifactIdentity,
} from "../src/domain/artifact-acceptance.js";

const artifactA: ArtifactIdentity = {
  repo: "/tmp/repo",
  commit: "aaa111",
  tree: "tree-aaa",
  dirty: false,
};

const artifactB: ArtifactIdentity = {
  repo: "/tmp/repo",
  commit: "bbb222",
  tree: "tree-bbb",
  dirty: false,
};

describe("ArtifactAcceptance (exact commit/tree bind)", () => {
  it("bindAcceptance fingerprints repo+commit+tree+dirty", () => {
    const bound = bindAcceptance({
      judgmentId: "j1",
      artifact: artifactA,
      actor: "reviewer@dev",
      reason: "looks good",
    });
    expect(bound.digest).toBe(artifactDigest(artifactA));
    expect(bound.digest).not.toBe(artifactDigest(artifactB));
  });

  it("refuse publish B with judgment bound to A", () => {
    const bound = bindAcceptance({
      judgmentId: "j1",
      artifact: artifactA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    expect(() => assertPublishAllowed(bound, artifactB)).toThrow(ArtifactAcceptanceError);
    try {
      assertPublishAllowed(bound, artifactB);
    } catch (err) {
      expect((err as ArtifactAcceptanceError).code).toBe("artifact_mismatch");
    }
  });

  it("refuse publish when worktree is dirty", () => {
    const bound = bindAcceptance({
      judgmentId: "j1",
      artifact: artifactA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    expect(() =>
      assertPublishAllowed(bound, { ...artifactA, dirty: true }),
    ).toThrow(ArtifactAcceptanceError);
    try {
      assertPublishAllowed(bound, { ...artifactA, dirty: true });
    } catch (err) {
      expect((err as ArtifactAcceptanceError).code).toBe("dirty_candidate_refused");
    }
  });

  it("refuse binding a dirty candidate as accept identity", () => {
    expect(() =>
      bindAcceptance({
        judgmentId: "j2",
        artifact: { ...artifactA, dirty: true },
        actor: "reviewer@dev",
        reason: "dirty",
      }),
    ).toThrow(ArtifactAcceptanceError);
    try {
      bindAcceptance({
        judgmentId: "j2",
        artifact: { ...artifactA, dirty: true },
        actor: "reviewer@dev",
        reason: "dirty",
      });
    } catch (err) {
      expect((err as ArtifactAcceptanceError).code).toBe("dirty_candidate_refused");
    }
  });

  it("allows publish when identity matches exactly", () => {
    const bound = bindAcceptance({
      judgmentId: "j1",
      artifact: artifactA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    expect(() => assertPublishAllowed(bound, { ...artifactA })).not.toThrow();
  });
});
