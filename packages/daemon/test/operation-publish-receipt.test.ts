/**
 * Topic D contracts (unstacked — no WriterAuthority / lease):
 * 1) Receipt belongs to a specific operation (not latest target state)
 * 2) Accept↔artifact binding refuses B under judgment A
 * 3) Without a publish target: simulation=true, never published=true
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SimplePublishTarget } from "../src/domain/simple-publish-target.js";
import {
  OperationPublishService,
  OperationPublishError,
} from "../src/domain/operation-publish.js";
import type { ArtifactIdentity } from "../src/domain/artifact-acceptance.js";

const artifactA: ArtifactIdentity = {
  repo: "/tmp/openrig-op-repo",
  commit: "aaa111op",
  tree: "tree-a",
  dirty: false,
};
const artifactB: ArtifactIdentity = {
  repo: "/tmp/openrig-op-repo",
  commit: "bbb222op",
  tree: "tree-b",
  dirty: false,
};
const bodyA = "operation-A-bytes\n";
const bodyB = "operation-B-bytes\n";

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("Contract 1 — receipt belongs to a specific operation", () => {
  let targetRoot: string;
  let target: SimplePublishTarget;
  let ops: OperationPublishService;

  beforeEach(() => {
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-receipt-op-"));
    target = new SimplePublishTarget({
      targetRoot,
      resourceId: "publish:contract",
    });
    ops = new OperationPublishService({ publishTarget: target });
  });

  afterEach(() => {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  });

  it("publish A then B; retry A returns receipt A (not B) and does not re-publish A", () => {
    const pubA = ops.acceptAndPublish({
      operationId: "op-a",
      artifact: artifactA,
      body: bodyA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    expect(pubA.published).toBe(true);
    expect(pubA.receipt?.contentSha256).toBe(sha(bodyA));
    const receiptA = pubA.receipt!;

    const pubB = ops.acceptAndPublish({
      operationId: "op-b",
      artifact: artifactB,
      body: bodyB,
      actor: "reviewer@dev",
      reason: "accept B",
    });
    expect(pubB.published).toBe(true);
    expect(pubB.receipt?.contentSha256).toBe(sha(bodyB));
    expect(target.readPublished()?.body).toBe(bodyB);
    expect(target.readLatestReceipt()?.contentSha256).toBe(sha(bodyB));

    const retryA = ops.acceptAndPublish({
      operationId: "op-a",
      artifact: artifactA,
      body: bodyA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    expect(retryA.replayed).toBe(true);
    expect(retryA.receipt?.receiptId).toBe(receiptA.receiptId);
    expect(retryA.receipt?.contentSha256).toBe(sha(bodyA));
    expect(ops.getReceipt("op-a")?.receiptId).toBe(receiptA.receiptId);
    expect(target.readPublished()?.body).toBe(bodyB);
  });

  it("refuse retry when body skews from historical content digest", () => {
    ops.acceptAndPublish({
      operationId: "op-a",
      artifact: artifactA,
      body: bodyA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    expect(() =>
      ops.acceptAndPublish({
        operationId: "op-a",
        artifact: artifactA,
        body: bodyB,
        actor: "reviewer@dev",
        reason: "accept A",
      }),
    ).toThrow(OperationPublishError);
  });
});

describe("Contract — simulation without target", () => {
  it("never emits published=true without a wired SimplePublishTarget", () => {
    const ops = new OperationPublishService({ publishTarget: null });
    const result = ops.acceptAndPublish({
      operationId: "sim-1",
      artifact: artifactA,
      body: bodyA,
      actor: "reviewer@dev",
      reason: "sim",
    });
    expect(result.simulation).toBe(true);
    expect(result.published).toBe(false);
    expect(result.receipt).toBeNull();
  });
});

describe("SimplePublishTarget", () => {
  it("stores per-operation receipt files while latest points at B", () => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-simple-pub-"));
    const target = new SimplePublishTarget({ targetRoot, resourceId: "t1" });
    const ops = new OperationPublishService({ publishTarget: target });
    ops.acceptAndPublish({
      operationId: "op-a",
      artifact: artifactA,
      body: bodyA,
      actor: "r",
      reason: "a",
    });
    ops.acceptAndPublish({
      operationId: "op-b",
      artifact: artifactB,
      body: bodyB,
      actor: "r",
      reason: "b",
    });
    expect(ops.getReceipt("op-a")?.contentSha256).toBe(sha(bodyA));
    expect(ops.getReceipt("op-b")?.contentSha256).toBe(sha(bodyB));
    expect(target.readLatestReceipt()?.operationId).toBe("op-b");
    fs.rmSync(targetRoot, { recursive: true, force: true });
  });
});
