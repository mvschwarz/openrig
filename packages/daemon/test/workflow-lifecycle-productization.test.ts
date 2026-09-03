import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";

const PARALLEL_SPEC = `workflow:
  id: lifecycle-parallel
  version: 1
  entry:
    role: root
  roles:
    root: { preferred_targets: [root@rig] }
    left: { preferred_targets: [left@rig] }
    right: { preferred_targets: [right@rig] }
    join: { preferred_targets: [join@rig] }
  steps:
    - id: root
      actor_role: root
      allowed_exits: [done, failed]
    - id: left
      actor_role: left
      depends_on: [root]
      allowed_exits: [done, failed]
    - id: right
      actor_role: right
      depends_on: [root]
      allowed_exits: [done, failed]
    - id: join
      actor_role: join
      depends_on: [left, right]
      allowed_exits: [done, failed]
`;

const ACCEPTANCE_SPEC = `workflow:
  id: lifecycle-acceptance
  version: 1
  entry: { role: producer }
  roles:
    producer: { preferred_targets: [producer@rig] }
    gate: { preferred_targets: [gate@rig] }
  steps:
    - id: produce
      actor_role: producer
      allowed_exits: [handoff]
    - id: accept
      actor_role: gate
      acceptance:
        candidate: abc123
        verdicts: [CLEAR]
        evidence_ref: proof/review.md
      allowed_exits: [done]
`;

const MAPPED_FAILURE_SPEC = `workflow:
  id: lifecycle-mapped-failure
  version: 1
  entry: { role: root }
  roles:
    root: { preferred_targets: [root@rig] }
    left: { preferred_targets: [left@rig] }
    right: { preferred_targets: [right@rig] }
    repair: { preferred_targets: [repair@rig] }
  steps:
    - id: root
      actor_role: root
      allowed_exits: [done]
    - id: left
      actor_role: left
      depends_on: [root]
      allowed_exits: [done, failed]
      next_hop:
        on:
          failed: repair
    - id: right
      actor_role: right
      depends_on: [root]
      allowed_exits: [done, failed]
    - id: repair
      actor_role: repair
      allowed_exits: [done]
`;

const WAITING_SPEC = PARALLEL_SPEC.replace(
  /allowed_exits: \[done, failed\]/g,
  "allowed_exits: [done, failed, waiting]",
);

describe("S06 lifecycle productization", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
  let sentNudges: string[];
  let dir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    sentNudges = [];
    queueRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      transport: {
        send: async (session) => {
          sentNudges.push(session);
          return { ok: true, verified: true };
        },
      },
    });
    queueRepo.attachOutbox(new OutboxHandler(db));
    watchdogRepo = new WatchdogJobsRepository(db);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo, watchdogJobsRepo: watchdogRepo });
    dir = mkdtempSync(join(tmpdir(), "workflow-lifecycle-"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function spec(text: string, name = "workflow.yaml"): string {
    const file = join(dir, name);
    writeFileSync(file, text);
    return file;
  }

  function mutationCounts(): Record<string, number> {
    const tables = [
      "workflow_specs",
      "workflow_instances",
      "workflow_step_trails",
      "workflow_frontier_bindings",
      "workflow_failure_occurrences",
      "queue_items",
      "queue_transitions",
      "events",
      "watchdog_jobs",
    ];
    return Object.fromEntries(tables.map((table) => [
      table,
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]));
  }

  it("keyed instantiate absorbs exact replay and rejects changed bytes without mutation", async () => {
    const specPath = spec(PARALLEL_SPEC);
    const first = await runtime.instantiate({
      specPath,
      rootObjective: "release",
      createdBySession: "orch@rig",
      lifecycle: {
        operationKey: "opaque-release-operation",
        compiledInputDigest: "digest-a",
        binding: { project: "openrig", mission: "release-0.5.9" },
      },
    });
    const before = mutationCounts();
    const replay = await runtime.instantiate({
      specPath,
      rootObjective: "release",
      createdBySession: "orch@rig",
      lifecycle: {
        operationKey: "opaque-release-operation",
        compiledInputDigest: "digest-a",
        binding: { project: "openrig", mission: "release-0.5.9" },
      },
    });
    expect(replay.instance.instanceId).toBe(first.instance.instanceId);
    expect(replay.entryQitemId).toBe(first.entryQitemId);
    expect(replay.replayed).toBe(true);
    expect(mutationCounts()).toEqual(before);

    await expect(runtime.instantiate({
      specPath,
      rootObjective: "release",
      createdBySession: "orch@rig",
      lifecycle: {
        operationKey: "opaque-release-operation",
        compiledInputDigest: "digest-b",
        binding: { project: "openrig", mission: "release-0.5.9" },
      },
    })).rejects.toMatchObject({ code: "lifecycle_operation_conflict" });
    expect(mutationCounts()).toEqual(before);
  });

  it("absorbs a concurrent double-instantiate and a daemon-restart replay", async () => {
    const specPath = spec(PARALLEL_SPEC);
    const input = {
      specPath,
      rootObjective: "release",
      createdBySession: "orch@rig",
      lifecycle: {
        operationKey: "concurrent-release-operation",
        compiledInputDigest: "same-digest",
        binding: { mission: "release-0.5.9" },
      },
    };
    const [left, right] = await Promise.all([runtime.instantiate(input), runtime.instantiate(input)]);
    expect(left.instance.instanceId).toBe(right.instance.instanceId);
    expect(left.entryQitemId).toBe(right.entryQitemId);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    const before = mutationCounts();

    const restarted = new WorkflowRuntime({ db, eventBus: new EventBus(db), queueRepo });
    const replay = await restarted.instantiate(input);
    expect(replay.replayed).toBe(true);
    expect(replay.instance.instanceId).toBe(left.instance.instanceId);
    expect(mutationCounts()).toEqual(before);
  });

  it("fans out, requires packet-addressed route, and preserves the sibling byte-for-byte", async () => {
    const created = await runtime.instantiate({
      specPath: spec(PARALLEL_SPEC),
      rootObjective: "parallel",
      createdBySession: "orch@rig",
    });
    const fanout = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: created.entryQitemId,
      exit: "done",
      actorSession: "root@rig",
    });
    expect(fanout.nextQitemIds).toHaveLength(2);
    const before = runtime.inspect(created.instance.instanceId);
    const left = before.frontier.find((p) => p.stepId === "left")!;
    const right = before.frontier.find((p) => p.stepId === "right")!;
    const rightRowBefore = db.prepare(`SELECT * FROM queue_items WHERE qitem_id = ?`).get(right.packetId);

    await expect(runtime.route({
      instanceId: created.instance.instanceId,
      toSession: "left2@rig",
      actorSession: "orch@rig",
    })).rejects.toMatchObject({ code: "frontier_packet_required" });

    const routed = await runtime.route({
      instanceId: created.instance.instanceId,
      packetId: left.packetId,
      toSession: "left2@rig",
      actorSession: "orch@rig",
    });
    expect(routed.closedPacketId).toBe(left.packetId);
    expect(runtime.instanceStore.getByIdOrThrow(created.instance.instanceId).currentFrontier)
      .toContain(right.packetId);
    expect(db.prepare(`SELECT * FROM queue_items WHERE qitem_id = ?`).get(right.packetId))
      .toEqual(rightRowBefore);
  });

  it("records an unmapped failure locally, resumes the exact occurrence, and advances fan-in once", async () => {
    const created = await runtime.instantiate({
      specPath: spec(PARALLEL_SPEC),
      rootObjective: "recover",
      createdBySession: "orch@rig",
    });
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: created.entryQitemId, exit: "done", actorSession: "root@rig" });
    let view = runtime.inspect(created.instance.instanceId);
    const left = view.frontier.find((p) => p.stepId === "left")!;
    const right = view.frontier.find((p) => p.stepId === "right")!;

    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: left.packetId, exit: "failed", actorSession: "left@rig" });
    view = runtime.inspect(created.instance.instanceId);
    expect(view.instance.status).toBe("active");
    expect(view.frontier.map((p) => p.packetId)).toEqual([right.packetId]);
    expect(view.failures).toMatchObject([{ occurrenceId: left.packetId, stepId: "left", status: "unresolved" }]);

    const resumed = await runtime.resume({ instanceId: created.instance.instanceId, occurrenceId: left.packetId, decision: "retry left", actorSession: "orch@rig" });
    expect(runtime.instanceStore.getByIdOrThrow(created.instance.instanceId).currentFrontier)
      .toEqual(expect.arrayContaining([right.packetId, resumed.newPacketId]));
    const replay = await runtime.resume({ instanceId: created.instance.instanceId, occurrenceId: left.packetId, decision: "retry left", actorSession: "orch@rig" });
    expect(replay.absorbedReplay).toBe(true);
    expect(replay.newPacketId).toBe(resumed.newPacketId);
    const beforeConflict = mutationCounts();
    await expect(runtime.resume({
      instanceId: created.instance.instanceId,
      occurrenceId: left.packetId,
      decision: "different retry",
      actorSession: "orch@rig",
    })).rejects.toMatchObject({ code: "failure_occurrence_replay_conflict" });
    expect(mutationCounts()).toEqual(beforeConflict);

    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: right.packetId, exit: "done", actorSession: "right@rig" });
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: resumed.newPacketId, exit: "done", actorSession: "left@rig" });
    view = runtime.inspect(created.instance.instanceId);
    expect(view.frontier).toHaveLength(1);
    expect(view.frontier[0]!.stepId).toBe("join");
    expect(view.frontier).toHaveLength(1);
    expect(db.prepare(`SELECT count(*) AS n FROM queue_items WHERE tags LIKE '%\"step:join\"%'`).get())
      .toEqual({ n: 1 });
  });

  it("keeps mapped failure-edge behavior while preserving an independent sibling", async () => {
    const created = await runtime.instantiate({
      specPath: spec(MAPPED_FAILURE_SPEC),
      rootObjective: "mapped repair",
      createdBySession: "orch@rig",
    });
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: created.entryQitemId, exit: "done", actorSession: "root@rig" });
    const before = runtime.inspect(created.instance.instanceId);
    const left = before.frontier.find((packet) => packet.stepId === "left")!;
    const right = before.frontier.find((packet) => packet.stepId === "right")!;
    const rightRowBefore = db.prepare(`SELECT * FROM queue_items WHERE qitem_id = ?`).get(right.packetId);

    const result = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: left.packetId,
      exit: "failed",
      actorSession: "left@rig",
    });

    expect(result.nextStepIds).toEqual(["repair"]);
    const after = runtime.inspect(created.instance.instanceId);
    expect(after.frontier.map((packet) => packet.stepId).sort()).toEqual(["repair", "right"]);
    expect(after.failures).toEqual([]);
    expect(after.instance.status).toBe("active");
    expect(db.prepare(`SELECT * FROM queue_items WHERE qitem_id = ?`).get(right.packetId)).toEqual(rightRowBefore);
  });

  it("derives aggregate active, waiting, failed, and completed states from all packets and failures", async () => {
    const waiting = await runtime.instantiate({
      specPath: spec(WAITING_SPEC, "waiting.yaml"),
      rootObjective: "aggregate waiting",
      createdBySession: "orch@rig",
    });
    await runtime.project({ instanceId: waiting.instance.instanceId, currentPacketId: waiting.entryQitemId, exit: "done", actorSession: "root@rig" });
    let packets = runtime.inspect(waiting.instance.instanceId).frontier;
    await runtime.project({ instanceId: waiting.instance.instanceId, currentPacketId: packets[0]!.packetId, exit: "waiting", actorSession: packets[0]!.ownerSession! });
    expect(runtime.inspect(waiting.instance.instanceId).instance.status).toBe("active");
    packets = runtime.inspect(waiting.instance.instanceId).frontier;
    const actionable = packets.find((packet) => packet.queueState !== "blocked")!;
    await runtime.project({ instanceId: waiting.instance.instanceId, currentPacketId: actionable.packetId, exit: "waiting", actorSession: actionable.ownerSession! });
    expect(runtime.inspect(waiting.instance.instanceId).instance.status).toBe("waiting");

    const failed = await runtime.instantiate({
      specPath: spec(PARALLEL_SPEC, "failed.yaml"),
      rootObjective: "aggregate failure",
      createdBySession: "orch@rig",
    });
    await runtime.project({ instanceId: failed.instance.instanceId, currentPacketId: failed.entryQitemId, exit: "done", actorSession: "root@rig" });
    for (const packet of runtime.inspect(failed.instance.instanceId).frontier) {
      await runtime.project({ instanceId: failed.instance.instanceId, currentPacketId: packet.packetId, exit: "failed", actorSession: packet.ownerSession! });
    }
    expect(runtime.inspect(failed.instance.instanceId).instance.status).toBe("failed");

    const completed = await runtime.instantiate({
      specPath: spec(PARALLEL_SPEC, "completed.yaml"),
      rootObjective: "aggregate completion",
      createdBySession: "orch@rig",
    });
    await runtime.project({ instanceId: completed.instance.instanceId, currentPacketId: completed.entryQitemId, exit: "done", actorSession: "root@rig" });
    for (const packet of runtime.inspect(completed.instance.instanceId).frontier) {
      await runtime.project({ instanceId: completed.instance.instanceId, currentPacketId: packet.packetId, exit: "done", actorSession: packet.ownerSession! });
    }
    const join = runtime.inspect(completed.instance.instanceId).frontier[0]!;
    await runtime.project({ instanceId: completed.instance.instanceId, currentPacketId: join.packetId, exit: "done", actorSession: join.ownerSession! });
    expect(runtime.inspect(completed.instance.instanceId).instance.status).toBe("completed");
  });

  it("refuses an ambiguous resume with candidates and zero mutation", async () => {
    const created = await runtime.instantiate({
      specPath: spec(PARALLEL_SPEC),
      rootObjective: "two failures",
      createdBySession: "orch@rig",
    });
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: created.entryQitemId, exit: "done", actorSession: "root@rig" });
    const packets = runtime.inspect(created.instance.instanceId).frontier;
    for (const packet of packets) {
      await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: packet.packetId, exit: "failed", actorSession: packet.ownerSession! });
    }
    const before = mutationCounts();
    await expect(runtime.resume({ instanceId: created.instance.instanceId, actorSession: "orch@rig" }))
      .rejects.toMatchObject({
        code: "failure_occurrence_required",
        details: { candidates: expect.arrayContaining(packets.map((packet) => expect.objectContaining({ occurrenceId: packet.packetId }))) },
      });
    expect(mutationCounts()).toEqual(before);
  });

  it("requires the dedicated acceptance payload and aborts every live packet transactionally", async () => {
    const accepted = await runtime.instantiate({ specPath: spec(ACCEPTANCE_SPEC), rootObjective: "accept", createdBySession: "orch@rig" });
    const next = await runtime.project({ instanceId: accepted.instance.instanceId, currentPacketId: accepted.entryQitemId, exit: "handoff", actorSession: "producer@rig" });
    await expect(runtime.project({ instanceId: accepted.instance.instanceId, currentPacketId: next.nextQitemId!, exit: "done", actorSession: "gate@rig" }))
      .rejects.toMatchObject({ code: "acceptance_payload_required" });
    const beforeMismatch = mutationCounts();
    for (const acceptance of [
      { candidate: "wrong", verdict: "CLEAR", evidence_ref: "proof/review.md" },
      { candidate: "abc123", verdict: "BLOCKING", evidence_ref: "proof/review.md" },
      { candidate: "abc123", verdict: "CLEAR", evidence_ref: "proof/other.md" },
    ]) {
      await expect(runtime.project({
        instanceId: accepted.instance.instanceId,
        currentPacketId: next.nextQitemId!,
        exit: "done",
        actorSession: "gate@rig",
        closureEvidence: { acceptance },
      })).rejects.toMatchObject({ code: "acceptance_payload_mismatch" });
      expect(mutationCounts()).toEqual(beforeMismatch);
    }
    await runtime.project({
      instanceId: accepted.instance.instanceId,
      currentPacketId: next.nextQitemId!,
      exit: "done",
      actorSession: "gate@rig",
      closureEvidence: { acceptance: { candidate: "abc123", verdict: "CLEAR", evidence_ref: "proof/review.md" } },
    });
    expect(runtime.instanceStore.getByIdOrThrow(accepted.instance.instanceId).status).toBe("completed");

    const parallel = await runtime.instantiate({ specPath: spec(PARALLEL_SPEC, "parallel.yaml"), rootObjective: "abort", createdBySession: "orch@rig" });
    await runtime.project({ instanceId: parallel.instance.instanceId, currentPacketId: parallel.entryQitemId, exit: "done", actorSession: "root@rig" });
    const aborted = await runtime.abort({ instanceId: parallel.instance.instanceId, reason: "operator stopped", actorSession: "orch@rig" });
    expect(aborted.closedPacketIds).toHaveLength(2);
    expect(runtime.instanceStore.getByIdOrThrow(parallel.instance.instanceId).status).toBe("aborted");
    for (const id of aborted.closedPacketIds) expect(queueRepo.getById(id)?.state).toBe("canceled");
  });

  it("arms and retires liveness independently for every frontier packet", async () => {
    const created = await runtime.instantiate({ specPath: spec(PARALLEL_SPEC), rootObjective: "liveness", createdBySession: "orch@rig" });
    expect(watchdogRepo.listActive()).toHaveLength(1);
    expect(watchdogRepo.listActive()[0]!.specYaml).toContain(`workflow_packet_id: ${created.entryQitemId}`);
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: created.entryQitemId, exit: "done", actorSession: "root@rig" });
    const before = runtime.inspect(created.instance.instanceId);
    expect(watchdogRepo.listActive()).toHaveLength(2);
    for (const packet of before.frontier) {
      expect(watchdogRepo.listActive().some((job) => job.specYaml.includes(`workflow_packet_id: ${packet.packetId}`))).toBe(true);
    }
    const left = before.frontier.find((packet) => packet.stepId === "left")!;
    const right = before.frontier.find((packet) => packet.stepId === "right")!;
    const bindings = runtime.instanceStore.listFrontierBindings(created.instance.instanceId);
    expect(bindings.map((binding) => [binding.stepId, binding.hopCount]).sort()).toEqual([
      ["left", 1],
      ["right", 1],
    ]);

    const past = new Date(Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60) * 1000).toISOString();
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(past, left.packetId);
    const deadlineByStep = new Map(runtime.inspect(created.instance.instanceId).frontier.map((packet) => [packet.stepId, packet.deadline.state]));
    expect(deadlineByStep.get("left")).toBe("overdue-unclaimed");
    expect(deadlineByStep.get("right")).toBe("healthy");
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(new Date().toISOString(), left.packetId);

    for (const job of watchdogRepo.listActive()) watchdogRepo.markTerminal(job.jobId, "simulated restart");
    db.prepare(`UPDATE queue_items SET last_nudge_attempt = NULL, last_nudge_result = NULL WHERE qitem_id IN (?, ?)`).run(left.packetId, right.packetId);
    sentNudges = [];
    const swept = await runWorkflowBootSweep({
      instanceStore: runtime.instanceStore,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
    });
    expect(swept.keepalivesArmed).toBe(2);
    expect(swept.lostNudgesReissued).toBe(2);
    expect(sentNudges.sort()).toEqual(["left@rig", "right@rig"]);

    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: left.packetId, exit: "done", actorSession: "left@rig" });
    expect(watchdogRepo.listActive()).toHaveLength(1);
    expect(watchdogRepo.listActive()[0]!.specYaml).toContain(right.packetId);
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: right.packetId, exit: "done", actorSession: "right@rig" });
    expect(watchdogRepo.listActive()).toHaveLength(1);
    const join = runtime.inspect(created.instance.instanceId).frontier;
    expect(join).toHaveLength(1);
    expect(join[0]!.stepId).toBe("join");
    expect(watchdogRepo.listActive().filter((job) => job.specYaml.includes(join[0]!.packetId))).toHaveLength(1);
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: join[0]!.packetId, exit: "done", actorSession: "join@rig" });
    expect(watchdogRepo.listActive()).toHaveLength(0);
  });

  it("serializes concurrent sibling completion into one fan-in packet with no live queue orphan", async () => {
    const created = await runtime.instantiate({ specPath: spec(PARALLEL_SPEC), rootObjective: "concurrent fan-in", createdBySession: "orch@rig" });
    await runtime.project({ instanceId: created.instance.instanceId, currentPacketId: created.entryQitemId, exit: "done", actorSession: "root@rig" });
    const siblings = runtime.inspect(created.instance.instanceId).frontier;

    await Promise.all(siblings.map((packet) => runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packet.packetId,
      exit: "done",
      actorSession: packet.ownerSession!,
    })));

    const view = runtime.inspect(created.instance.instanceId);
    expect(view.frontier).toHaveLength(1);
    expect(view.frontier[0]!.stepId).toBe("join");
    const liveRows = db.prepare(
      `SELECT qitem_id FROM queue_items
       WHERE tags LIKE ? AND state IN ('pending', 'in-progress', 'blocked')
       ORDER BY qitem_id`,
    ).all(`%"instance:${created.instance.instanceId}"%`) as Array<{ qitem_id: string }>;
    expect(liveRows.map((row) => row.qitem_id)).toEqual([view.frontier[0]!.packetId]);
    expect(db.prepare(`SELECT count(*) AS n FROM workflow_frontier_bindings WHERE instance_id = ?`).get(created.instance.instanceId)).toEqual({ n: 1 });
  });
});
