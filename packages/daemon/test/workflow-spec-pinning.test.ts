import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { makeEnsureStuckExceptionItem } from "../src/domain/workflow-exception-escalation.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";

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
    lead:
      preferred_targets:
        - ${pod}-lead@rig
  exception_routing:
    orchestrator_role: lead
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
    - id: build
      actor_role: builder
      allowed_exits:
        - done
        - failed
`;

describe("#2607: a running workflow keeps the roles it started with", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
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
  const start = (specPath: string) => runtime.instantiate({ specPath, rootObjective: "a feature", createdBySession: "orch@rig" });
  /** Hand the run's plan step off and say who gets the build step. */
  const builderOf = async (run: Awaited<ReturnType<typeof start>>, by = runtime) => (await by.project({
    instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, exit: "handoff", actorSession: "feature-1-planner@rig", resultNote: "planned",
  })).nextOwnerSession;

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

  it("a run started from a copy with the same bytes doesn't follow edits to the other file", async () => {
    const original = write("feature-1", featureSpec("feature-1"));
    await start(original);
    // The copy's bytes match, so the cache keeps the original's row; the run still belongs to the copy.
    const run = await start(write("feature-1-copy", featureSpec("feature-1")));
    writeFileSync(original, featureSpec("feature-1", "feature-1-builder-b"));
    new WorkflowSpecCache(db).readThrough(original);
    expect(await builderOf(run)).toBe("feature-1-builder@rig");
  });

  it("an accepted edit to the run's own file outlives another file taking the row, across a restart", async () => {
    const own = write("feature-1", featureSpec("feature-1"));
    const run = await start(own);
    writeFileSync(own, featureSpec("feature-1", "feature-1-builder-b"));
    new WorkflowSpecCache(db).readThrough(own);
    await start(write("feature-2", featureSpec("feature-2")));
    // A restarted daemon reads the same database.
    expect(await builderOf(run, new WorkflowRuntime({ db, eventBus: bus, queueRepo }))).toBe("feature-1-builder-b@rig");
  });

  it("a run follows its file when the file moves unchanged, but not to a different file read after its file is gone", async () => {
    const own = write("feature-1", featureSpec("feature-1"));
    const moving = await start(own);
    const renamed = join(tmp, "renamed.yaml");
    renameSync(own, renamed);
    new WorkflowSpecCache(db).readThrough(renamed);
    writeFileSync(renamed, featureSpec("feature-1", "feature-1-builder-b"));
    new WorkflowSpecCache(db).readThrough(renamed);
    expect(await builderOf(moving)).toBe("feature-1-builder-b@rig");

    const gone = write("feature-1-again", featureSpec("feature-1", "feature-1-builder-c"));
    const orphan = await start(gone);
    rmSync(gone);
    rmSync(renamed);
    new WorkflowSpecCache(db).readThrough(write("feature-2", featureSpec("feature-2")));
    expect(await builderOf(orphan)).toBe("feature-1-builder-c@rig");
  });

  it("a resume after another file took the row re-resolves to the seat the run's own file last named", async () => {
    const own = write("feature-1", featureSpec("feature-1"));
    const run = await start(own);
    const build = await runtime.project({
      instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, exit: "handoff", actorSession: "feature-1-planner@rig", resultNote: "planned",
    });
    await runtime.project({
      instanceId: run.instance.instanceId, currentPacketId: build.nextQitemId!, exit: "failed", actorSession: "feature-1-builder@rig", resultNote: "the builder's seat died",
    });
    // The operator names a new builder in the run's own file; then another pod's file takes the row.
    writeFileSync(own, featureSpec("feature-1", "feature-1-builder-b"));
    new WorkflowSpecCache(db).readThrough(own);
    await start(write("feature-2", featureSpec("feature-2")));
    expect((await runtime.resume({ instanceId: run.instance.instanceId, actorSession: "orch@rig" })).ownerSession).toBe("feature-1-builder-b@rig");
  });

  it("a stuck run's exception goes to its own pod's lead after another pod's file took the row", async () => {
    const first = await start(write("feature-1", featureSpec("feature-1")));
    await start(write("feature-2", featureSpec("feature-2")));
    expect(runtime.resolveExceptionRouteFor("feature-flow", "1", "stuck_overdue", null, first.instance.instanceId)?.destinationSession).toBe("feature-1-lead@rig");
    // Named by id and version alone, the cached row decides, as before.
    expect(runtime.resolveExceptionRouteFor("feature-flow", "1", "stuck_overdue", null)?.destinationSession).toBe("feature-2-lead@rig");

    // The sweep's ensurer, wired as startup wires it, routes the overdue first run the same way.
    const past = new Date(Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 3600) * 1000).toISOString();
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(past, first.entryQitemId);
    await runWorkflowBootSweep({
      instanceStore: runtime.instanceStore, queueRepo, watchdogJobsRepo: new WatchdogJobsRepository(db),
      ensureStuckExceptionItem: makeEnsureStuckExceptionItem({
        db, queueRepo, humanFallbackSeat: "human@host",
        resolveRoute: (name, version, cls, boundRig, instanceId) => runtime.resolveExceptionRouteFor(name, version, cls, boundRig, instanceId),
      }),
      reconcileStuckExceptions: () => runtime.reconcileStuckExceptions(),
    });
    const items = db.prepare(`SELECT destination_session FROM queue_items WHERE tags LIKE '%exception:stuck_overdue%'`).all();
    expect(items).toEqual([{ destination_session: "feature-1-lead@rig" }]);
  });

  it("the run's own file is the same file under another path form (a symlinked folder), so its edits still reach it", async () => {
    const own = write("feature-1", featureSpec("feature-1"));
    symlinkSync(tmp, join(tmp, "via-link"));
    const run = await start(join(tmp, "via-link", "feature-1.yaml"));
    writeFileSync(own, featureSpec("feature-1", "feature-1-builder-b"));
    new WorkflowSpecCache(db).readThrough(own);
    expect(await builderOf(run)).toBe("feature-1-builder-b@rig");
  });

  it("a move is one step: a failure before the cache row changes leaves the runs and the row as they were", async () => {
    const own = write("feature-1", featureSpec("feature-1"));
    const run = await start(own);
    writeFileSync(own, featureSpec("feature-1", "feature-1-builder-b"));
    new WorkflowSpecCache(db).readThrough(own);
    const renamed = join(tmp, "renamed.yaml");
    renameSync(own, renamed);
    const runRow = () => db.prepare(`SELECT spec_source_path, spec_json FROM workflow_instances WHERE instance_id = ?`)
      .get(run.instance.instanceId) as { spec_source_path: string; spec_json: string };
    const cacheRow = () => db.prepare(`SELECT source_path, spec_json FROM workflow_specs WHERE name = 'feature-flow' AND version = '1'`).get();
    const builderNow = () => new WorkflowSpecCache(db).getForInstance(runtime.instanceStore.getById(run.instance.instanceId)!)?.spec.roles.builder?.preferred_targets;
    const before = { run: runRow(), cache: cacheRow() };

    // The cache row's replacement fails after the runs were updated, as a stop between the two writes would.
    db.exec(`CREATE TRIGGER fail_spec_replacement BEFORE UPDATE ON workflow_specs BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
    expect(() => new WorkflowSpecCache(db).readThrough(renamed)).toThrow("injected");
    expect({ run: runRow(), cache: cacheRow() }).toEqual(before);
    expect(builderNow()).toEqual(["feature-1-builder-b@rig"]);

    // Once the move reads cleanly, the run follows it, carrying the row's spec with the new path.
    db.exec(`DROP TRIGGER fail_spec_replacement`);
    new WorkflowSpecCache(db).readThrough(renamed);
    expect(runRow().spec_source_path).toBe(renamed);
    expect((JSON.parse(runRow().spec_json) as { roles: { builder: { preferred_targets: string[] } } }).roles.builder.preferred_targets).toEqual(["feature-1-builder-b@rig"]);
    expect(await builderOf(run, new WorkflowRuntime({ db, eventBus: bus, queueRepo }))).toBe("feature-1-builder-b@rig");
  });
});
