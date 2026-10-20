/**
 * Child worker for Topic D failpoint contract: crash after artifact write,
 * before the in-process receipt index is updated.
 */
import fs from "node:fs";
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { coreSchema } from "../../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../../src/db/migrations/003_events.js";
import { writerAuthorityLeasesSchema } from "../../src/db/migrations/118_writer_authority_leases.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { WriterAuthority } from "../../src/domain/writer-authority.js";
import { FencedPublishTarget } from "../../src/domain/fenced-publish-target.js";
import { OperationPublishService } from "../../src/domain/operation-publish.js";
import type { ArtifactIdentity } from "../../src/domain/artifact-acceptance.js";

const [, , dbPath, targetRoot, operationId, body] = process.argv;
if (!dbPath || !targetRoot || !operationId || body === undefined) {
  process.stderr.write("usage: worker <dbPath> <targetRoot> <operationId> <body>\n");
  process.exit(2);
}

fs.mkdirSync(targetRoot, { recursive: true });

const artifactA: ArtifactIdentity = {
  repo: "/tmp/openrig-op-repo",
  commit: "aaa111op",
  tree: "tree-a",
  dirty: false,
};

const db = createDb(dbPath);
migrate(db, [coreSchema, eventsSchema, writerAuthorityLeasesSchema]);
const bus = new EventBus(db);
const writers = new WriterAuthority(db, bus);
const lease = writers.acquire("publish_target", "publish:failpoint", "executor@dev");
const target = new FencedPublishTarget({
  targetRoot,
  resourceId: "publish:failpoint",
  writers,
});
const ops = new OperationPublishService({ writers, publishTarget: target });

// OPENRIG_FAILPOINT=publish_after_artifact → process.exit(70) inside publish
ops.acceptAndPublish({
  operationId,
  artifact: artifactA,
  body,
  actor: "reviewer@dev",
  reason: "failpoint",
  holderSession: lease.holderSession,
  generation: lease.generation,
});

process.stderr.write("failpoint_worker_unexpected_success\n");
process.exit(1);
