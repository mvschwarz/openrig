import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { buildExecutionView } from "../src/domain/execution-view.js";
import { workflowRoutes } from "../src/routes/workflow.js";

const PARALLEL_SPEC = `workflow:
  id: route-parallel
  version: 1
  entry: { role: root }
  roles:
    root: { preferred_targets: [root@rig] }
    left: { preferred_targets: [left@rig] }
    right: { preferred_targets: [right@rig] }
  steps:
    - { id: root, actor_role: root, allowed_exits: [done, failed] }
    - { id: left, actor_role: left, depends_on: [root], allowed_exits: [done, failed] }
    - { id: right, actor_role: right, depends_on: [root], allowed_exits: [done, failed] }
`;

describe("S06 lifecycle HTTP surface", () => {
  let db: Database.Database;
  let app: Hono;
  let runtime: WorkflowRuntime;
  let root: string;
  let missionDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queue = new QueueRepository(db, bus, { validateRig: () => true });
    queue.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("workflowRuntime" as never, runtime);
      await next();
    });
    app.route("/api/workflow", workflowRoutes());

    root = mkdtempSync(join(tmpdir(), "workflow-lifecycle-routes-"));
    missionDir = join(root, "missions", "release-1.0.0");
    mkdirSync(join(missionDir, "slices", "01-build"), { recursive: true });
    writeFileSync(join(root, "project.yaml"), `kind: project\nmetadata: { id: demo }\nlifecycle: { profile: release }\n`);
    writeFileSync(join(missionDir, "mission.yaml"), `kind: mission\nmetadata: { name: release-1.0.0 }\ncomposition:\n  slices:\n    - { ref: slices/01-build/slice.yaml, order: 10 }\n`);
    writeFileSync(join(missionDir, "slices", "01-build", "slice.yaml"), `kind: slice\nmetadata: { id: build }\ncomposition: { mission: ../../mission.yaml }\nexecution:\n  actor_role: builder\n  preferred_targets: [builder@rig]\n  allowed_exits: [done, failed]\n`);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function counts(): Record<string, number> {
    return Object.fromEntries(["workflow_specs", "workflow_instances", "queue_items", "queue_transitions", "events"].map((table) => [
      table,
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]));
  }

  it("compiles read-only, instantiates once, replays once, and rejects changed source bytes", async () => {
    const beforeCompile = counts();
    const compile = await app.request("/api/workflow/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ missionPath: missionDir, operationKey: "release-op" }),
    });
    expect(compile.status).toBe(200);
    expect(await compile.json()).toMatchObject({ eligible: true, identity: { project: "demo", mission: "release-1.0.0" } });
    expect(counts()).toEqual(beforeCompile);

    const request = {
      missionPath: missionDir,
      operationKey: "release-op",
      rootObjective: "ship",
      createdBySession: "orch@rig",
    };
    const first = await app.request("/api/workflow/instantiate-lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { instance: { instanceId: string; workflowName: string; workflowVersion: string }; entryQitemId: string };
    const execution = buildExecutionView({
      db,
      slicesRoot: () => join(root, "missions"),
      rigsRoot: () => join(root, "rigs"),
      buildInfo: { semver: null, commit: null, dirty: null, builtAt: null },
    }, { mission: "release-1.0.0" }) as { lifecycle_instances: Array<Record<string, unknown>> };
    expect(execution.lifecycle_instances).toMatchObject([{
      instance_id: firstBody.instance.instanceId,
      status: "active",
      operation_key: "release-op",
      frontier_packets: [{ packet_id: firstBody.entryQitemId, step_id: "build", owner: "builder@rig", queue_state: "pending" }],
      failure_occurrences: [],
      unknowns: [],
    }]);
    const beforeReplay = counts();
    const replay = await app.request("/api/workflow/instantiate-lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, instance: { instanceId: firstBody.instance.instanceId }, entryQitemId: firstBody.entryQitemId });
    expect(counts()).toEqual(beforeReplay);

    writeFileSync(join(missionDir, "slices", "01-build", "slice.yaml"), `kind: slice\nmetadata: { id: build }\ncomposition: { mission: ../../mission.yaml }\nexecution:\n  actor_role: builder\n  preferred_targets: [builder@rig]\n  allowed_exits: [done, failed]\n  objective: changed bytes\n`);
    const conflict = await app.request("/api/workflow/instantiate-lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "lifecycle_operation_conflict" });
    expect(counts()).toEqual(beforeReplay);

    const changed = await app.request("/api/workflow/instantiate-lifecycle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, operationKey: "release-op-2" }),
    });
    expect(changed.status).toBe(201);
    const changedBody = await changed.json() as { instance: { workflowVersion: string } };
    expect(changedBody.instance.workflowVersion).not.toBe(firstBody.instance.workflowVersion);
    expect(runtime.specCache.getByNameVersion(firstBody.instance.workflowName, firstBody.instance.workflowVersion)?.spec.steps[0]?.objective).toBeUndefined();
    expect(runtime.specCache.getByNameVersion(firstBody.instance.workflowName, changedBody.instance.workflowVersion)?.spec.steps[0]?.objective).toBe("changed bytes");
  });

  it("exposes packet-addressed route, occurrence-addressed resume, and global abort", async () => {
    const specPath = join(root, "parallel.yaml");
    writeFileSync(specPath, PARALLEL_SPEC);
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "parallel", createdBySession: "orch@rig" }),
    });
    const created = await create.json() as { instance: { instanceId: string }; entryQitemId: string };
    await app.request("/api/workflow/project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: created.instance.instanceId, currentPacketId: created.entryQitemId, exit: "done", actorSession: "root@rig" }),
    });
    const show = await app.request(`/api/workflow/${created.instance.instanceId}`);
    const shown = await show.json() as { frontierPackets: Array<{ packetId: string; stepId: string; ownerSession: string }> };
    expect(shown.frontierPackets).toHaveLength(2);
    const beforeAmbiguousRoute = counts();
    const ambiguousRoute = await app.request(`/api/workflow/${created.instance.instanceId}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toSession: "left2@rig", actorSession: "orch@rig" }),
    });
    expect(ambiguousRoute.status).toBe(409);
    expect(await ambiguousRoute.json()).toMatchObject({ error: "frontier_packet_required", candidates: expect.any(Array) });
    expect(counts()).toEqual(beforeAmbiguousRoute);

    const left = shown.frontierPackets.find((packet) => packet.stepId === "left")!;
    const right = shown.frontierPackets.find((packet) => packet.stepId === "right")!;
    const routed = await app.request(`/api/workflow/${created.instance.instanceId}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packetId: left.packetId, toSession: "left2@rig", actorSession: "orch@rig" }),
    });
    expect(routed.status).toBe(200);
    const routedBody = await routed.json() as { newPacketId: string };
    for (const packetId of [routedBody.newPacketId, right.packetId]) {
      const packet = (await (await app.request(`/api/workflow/${created.instance.instanceId}`)).json() as { frontierPackets: Array<{ packetId: string; ownerSession: string }> }).frontierPackets.find((item) => item.packetId === packetId)!;
      await app.request("/api/workflow/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId: created.instance.instanceId, currentPacketId: packetId, exit: "failed", actorSession: packet.ownerSession }),
      });
    }
    const failed = await (await app.request(`/api/workflow/${created.instance.instanceId}`)).json() as { failureOccurrences: Array<{ occurrenceId: string }> };
    expect(failed.failureOccurrences).toHaveLength(2);
    const ambiguousResume = await app.request(`/api/workflow/${created.instance.instanceId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorSession: "orch@rig" }),
    });
    expect(ambiguousResume.status).toBe(409);
    expect(await ambiguousResume.json()).toMatchObject({ error: "failure_occurrence_required", candidates: expect.any(Array) });

    const resumed = await app.request(`/api/workflow/${created.instance.instanceId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorSession: "orch@rig", occurrenceId: failed.failureOccurrences[0]!.occurrenceId, decision: "retry left" }),
    });
    expect(resumed.status).toBe(200);
    const replayConflict = await app.request(`/api/workflow/${created.instance.instanceId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorSession: "orch@rig", occurrenceId: failed.failureOccurrences[0]!.occurrenceId, decision: "different retry" }),
    });
    expect(replayConflict.status).toBe(409);
    expect(await replayConflict.json()).toMatchObject({ error: "failure_occurrence_replay_conflict" });
    const aborted = await app.request(`/api/workflow/${created.instance.instanceId}/abort`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorSession: "orch@rig", reason: "operator stopped" }),
    });
    expect(aborted.status).toBe(200);
    expect(await aborted.json()).toMatchObject({ status: "aborted", closedPacketIds: expect.any(Array) });
    expect(await (await app.request(`/api/workflow/${created.instance.instanceId}`)).json()).toMatchObject({ status: "aborted", frontierPackets: [] });
  });
});
