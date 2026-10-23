import { describe, it, expect } from "vitest";
import {
  artifactDigest,
  bindAcceptance,
  assertPublishAllowed,
  ArtifactAcceptanceError,
  type ArtifactIdentity,
} from "../src/domain/artifact-acceptance.js";

const cleanA: ArtifactIdentity = {
  repo: "/tmp/repo",
  commit: "aaa111",
  tree: "tree-a",
  dirty: false,
};
const cleanB: ArtifactIdentity = {
  repo: "/tmp/repo",
  commit: "bbb222",
  tree: "tree-b",
  dirty: false,
};

describe("artifact acceptance (Topic D)", () => {
  it("binds accept to a clean immutable artifact digest", () => {
    const acceptance = bindAcceptance({
      judgmentId: "j1",
      artifact: cleanA,
      actor: "reviewer@dev",
      reason: "lgtm",
    });
    expect(acceptance.verdict).toBe("accept");
    expect(acceptance.digest).toBe(artifactDigest(cleanA));
  });

  it("refuses dirty candidates", () => {
    expect(() =>
      bindAcceptance({
        judgmentId: "j1",
        artifact: { ...cleanA, dirty: true },
        actor: "reviewer@dev",
        reason: "nope",
      }),
    ).toThrow(ArtifactAcceptanceError);
  });

  it("refuses publish of B under judgment bound to A", () => {
    const acceptance = bindAcceptance({
      judgmentId: "j1",
      artifact: cleanA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    expect(() => assertPublishAllowed(acceptance, cleanB)).toThrow(ArtifactAcceptanceError);
    expect(() => assertPublishAllowed(acceptance, cleanA)).not.toThrow();
  });
});
