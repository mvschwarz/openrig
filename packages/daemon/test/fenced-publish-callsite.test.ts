/**
 * Topic C call-site proof: the first fenced product verb is publish onto a
 * disposable FencedPublishTarget under a live `publish_target` lease.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { writerAuthorityLeasesSchema } from "../src/db/migrations/118_writer_authority_leases.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WriterAuthority, WriterAuthorityError } from "../src/domain/writer-authority.js";
import { FencedPublishTarget, FencedPublishError } from "../src/domain/fenced-publish-target.js";
import { bindAcceptance, type ArtifactIdentity } from "../src/domain/artifact-acceptance.js";

const artifactA: ArtifactIdentity = {
  repo: "/tmp/openrig-fenced-repo",
  commit: "aaa111clean",
  tree: "tree-aaa",
  dirty: false,
};

const bodyA = "candidate-A-immutable-bytes\n";

describe("Fenced publish call site (Topic C first verb)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let writers: WriterAuthority;
  let targetRoot: string;
  let target: FencedPublishTarget;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, writerAuthorityLeasesSchema]);
    bus = new EventBus(db);
    writers = new WriterAuthority(db, bus);
    targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-fenced-callsite-"));
    target = new FencedPublishTarget({
      targetRoot,
      resourceId: "publish:disposable",
      writers,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(targetRoot, { recursive: true, force: true });
  });

  it("publish under live lease writes artifact + receipt", () => {
    const lease = writers.acquire("publish_target", "publish:disposable", "executor@dev");
    const acceptance = bindAcceptance({
      judgmentId: "j-a",
      artifact: artifactA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    const receipt = target.publish({
      holderSession: "executor@dev",
      generation: lease.generation,
      acceptance,
      body: bodyA,
    });
    expect(receipt.contentSha256.length).toBe(64);
    expect(target.readPublished()?.body).toBe(bodyA);
    expect(target.readReceipt()?.receiptId).toBe(receipt.receiptId);
  });

  it("revoke blocks subsequent publish for the prior generation", () => {
    const lease = writers.acquire("publish_target", "publish:disposable", "executor@dev");
    writers.revoke(lease.leaseId, "operator@dev", "test-revoke");
    const acceptance = bindAcceptance({
      judgmentId: "j-a",
      artifact: artifactA,
      actor: "reviewer@dev",
      reason: "accept A",
    });
    expect(() =>
      target.publish({
        holderSession: "executor@dev",
        generation: lease.generation,
        acceptance,
        body: bodyA,
      }),
    ).toThrow(FencedPublishError);
    expect(target.readPublished()).toBeNull();
  });

  it("stale generation is refused via withProtectedMutation", () => {
    const lease = writers.acquire("publish_target", "publish:disposable", "executor@dev");
    expect(() =>
      writers.withProtectedMutation(
        "publish_target",
        "publish:disposable",
        "executor@dev",
        lease.generation + 1,
        () => "should-not-run",
      ),
    ).toThrow(WriterAuthorityError);
  });
});
