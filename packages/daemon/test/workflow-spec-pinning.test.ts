import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";

// #2607: one rig runs several same-shaped feature pods, and each pod's copy of a workflow names its own seats under
// the same workflow id and version. Starting the second pod's run must not move the first pod's run into it.

const featureSpec = (pod: string, builder = `${pod}-builder`) => `workflow:
  id: feature-flow
  version: 1
  objective: build one feature inside its own pod
  entry:
    role: planner
  roles:
    planner:
      preferred_targets:
        - ${pod}-planner@rig
    builder:
      preferred_targets:
        - ${builder}@rig
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
    - id: build
      actor_role: builder
      allowed_exits:
        - done
`;

describe("#2607: a running workflow keeps the roles it started with", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-pinning-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const write = (name: string, yaml: string) => {
    const path = join(tmp, `${name}.yaml`);
    writeFileSync(path, yaml);
    return path;
  };

  it("a second pod's expansion of the same id and version moves neither pod's run, whichever file was read last", async () => {
    const paths = ["feature-1", "feature-2"].map((pod) => write(pod, featureSpec(pod)));
    const first = await runtime.instantiate({ specPath: paths[0]!, rootObjective: "feature 1", createdBySession: "orch@rig" });
    const second = await runtime.instantiate({ specPath: paths[1]!, rootObjective: "feature 2", createdBySession: "orch@rig" });

    const firstNext = await runtime.project({
      instanceId: first.instance.instanceId, currentPacketId: first.entryQitemId, exit: "handoff", actorSession: "feature-1-planner@rig", resultNote: "planned",
    });
    expect(firstNext.nextOwnerSession).toBe("feature-1-builder@rig");
    // A later read of the first pod's file hands the cached row back to it; the second pod's run stays put as well.
    new WorkflowSpecCache(db).readThrough(paths[0]!);
    const secondNext = await runtime.project({
      instanceId: second.instance.instanceId, currentPacketId: second.entryQitemId, exit: "handoff", actorSession: "feature-2-planner@rig", resultNote: "planned",
    });
    expect(secondNext.nextOwnerSession).toBe("feature-2-builder@rig");
  });

  it("an edit to the run's own spec file still reaches the run", async () => {
    const path = write("feature-1", featureSpec("feature-1"));
    const run = await runtime.instantiate({ specPath: path, rootObjective: "feature 1", createdBySession: "orch@rig" });
    // The operator replaces the builder seat in the file this run started from, and the cache reads it.
    writeFileSync(path, featureSpec("feature-1", "feature-1-builder-b"));
    new WorkflowSpecCache(db).readThrough(path);
    const next = await runtime.project({
      instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, exit: "handoff", actorSession: "feature-1-planner@rig", resultNote: "planned",
    });
    expect(next.nextOwnerSession).toBe("feature-1-builder-b@rig");
  });
});
