// OPR.0.4.6.WF5 FR-4: resume (redrive) — the one engine extension.
//
// Pins: the happy redrive (failed → active, rebound, fresh packet,
// completed steps never re-run), THE ARCH PIN (owner RE-RESOLVED via the
// projection resolver — never copied from the stale destination), the
// livelock rail (hops-since-resume window + recorded count + honest new
// occurrence), the rejection matrix (active/waiting/completed resume),
// occurrence closure + the resume-cycle new-occurrence contract, decision
// durability, and the waiting-resume regression pin (the shipped waiting
// path is untouched — resume rejects it, project continues it).

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const SPEC = `workflow:
  id: wf5-resume-pipeline
  version: 1
  objective: WF-5 resume fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
    orch:
      preferred_targets:
        - orch-lead@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed
        - waiting
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
  exception_routing:
    orchestrator_role: orch
`;

const LOOP_SPEC = `workflow:
  id: wf5-resume-loop
  version: 1
  objective: WF-5 livelock-rail fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - failed
      next_hop:
        on:
          handoff: review
    - id: review
      actor_role: reviewer
      allowed_exits:
        - handoff
        - failed
      next_hop:
        on:
          handoff: produce
  loop_guards:
    max_hops: 2
`;

const PARALLEL_SPEC = `workflow:
  id: wf5-resume-parallel
  version: 1
  entry:
    role: root
  roles:
    root: { preferred_targets: [root@rig] }
    left: { preferred_targets: [left@rig] }
    right: { preferred_targets: [right@rig] }
  exception_routing: { orchestrator_role: root }
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
`;

describe("WF-5 rev1-r2 B2: the SSE allow-list carries workflow.resumed", () => {
  it("run/watch followers stream resumes live (source pin — the WF-3 import-graph-pin precedent)", () => {
    const src = readFileSync(new URL("../src/routes/workflow.ts", import.meta.url), "utf8");
    const sseFilter = src.slice(src.indexOf("const sseHandler"), src.indexOf("app.get(\"/sse\""));
    expect(sseFilter).toContain('event.type !== "workflow.resumed"');
  });
});

describe("WF-5 FR-4: resume (redrive)", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;

  const build = (validateRig: (destination: string) => boolean = () => true) => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig });
    // P34: the W1 seam is fail-closed (MF2) — a nudge-intended terminal
    // close needs a SAME-DB intent store to make its wake durable.
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" },
    });
  };

  const seed = (spec: string, name = "spec.yaml") => {
    tmp = tmp ?? mkdtempSync(join(tmpdir(), "wf5-resume-"));
    const specPath = join(tmp, name);
    writeFileSync(specPath, spec);
    return specPath;
  };

  const instantiateAndFail = async (specPath: string) => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "resume walk",
      createdBySession: "ops@rig",
    });
    const packetId = inst.instance.currentFrontier[0]!;
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: packetId,
      exit: "failed",
      resultNote: "induced",
      actorSession: "producer@rig",
    });
    return { instanceId: inst.instance.instanceId, failedPacketId: packetId };
  };

  const trailCount = (instanceId: string) =>
    (db
      .prepare(`SELECT COUNT(*) AS n FROM workflow_step_trails WHERE instance_id = ?`)
      .get(instanceId) as { n: number }).n;

  afterEach(() => {
    db.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined as never;
  });

  it("the happy redrive: failed → active, rebound to the failed step, fresh packet to the owner, trail preserved + NOT re-run, occurrence closed, count recorded", async () => {
    build();
    const { instanceId, failedPacketId } = await instantiateAndFail(seed(SPEC));
    const trailBefore = trailCount(instanceId);
    const excBefore = db
      .prepare(`SELECT qitem_id, state FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
      .all() as Array<{ qitem_id: string; state: string }>;
    expect(excBefore.filter((r) => r.state === "pending")).toHaveLength(1);

    const r = await runtime.resume({
      instanceId,
      decision: "root cause fixed — retry",
      actorSession: "orch-lead@rig",
    });
    expect(r.stepId).toBe("produce");
    expect(r.resumeCount).toBe(1);
    expect(r.exceptionItemsClosed).toBe(1);
    expect(r.ownerSession).toBe("producer@rig");

    const inst = runtime.instanceStore.getByIdOrThrow(instanceId);
    expect(inst.status).toBe("active");
    // A redrive reopens the instance. The terminal failure timestamp must
    // not continue to make an active run look completed to API/UI clients.
    expect(inst.completedAt).toBeNull();
    expect(inst.currentStepId).toBe("produce");
    expect(inst.currentFrontier).toEqual([r.newPacketId]);
    expect(inst.resumeCount).toBe(1);
    // trail preserved + extended NEVER rewritten: the failure row stands,
    // no rows were re-run/rewritten by resume itself; it adds one resume line.
    expect(trailCount(instanceId)).toBe(trailBefore + 1);
    // decision durability: the redrive packet carries the instruction.
    const packet = db
      .prepare(`SELECT body, chain_of_record FROM queue_items WHERE qitem_id = ?`)
      .get(r.newPacketId) as { body: string; chain_of_record: string | null };
    expect(packet.body).toContain("root cause fixed — retry");
    expect(String(packet.chain_of_record)).toContain(failedPacketId);
    // occurrence closed
    const excAfter = db
      .prepare(`SELECT state FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
      .all() as Array<{ state: string }>;
    expect(excAfter.every((x) => x.state === "done")).toBe(true);
  });

  it("the redriven step completes and the flow continues deterministically downstream", async () => {
    build();
    const { instanceId } = await instantiateAndFail(seed(SPEC));
    const r = await runtime.resume({ instanceId, actorSession: "orch-lead@rig" });
    const advanced = await runtime.project({
      instanceId,
      currentPacketId: r.newPacketId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(advanced.nextStepId).toBe("review");
    await runtime.project({
      instanceId,
      currentPacketId: advanced.nextQitemId!,
      exit: "done",
      actorSession: "reviewer@rig",
    });
    expect(runtime.instanceStore.getByIdOrThrow(instanceId).status).toBe("completed");
  });

  it("THE ARCH PIN: the owner is RE-RESOLVED at resume — a preferred_targets change between failure and resume routes the NEW target, never the stale recorded destination", async () => {
    build();
    const { instanceId } = await instantiateAndFail(seed(SPEC));
    // The operator's remedy: the dead seat is replaced in the spec cache
    // (the exact scenario the pin exists for).
    const row = db
      .prepare(`SELECT spec_id, spec_json FROM workflow_specs WHERE name = 'wf5-resume-pipeline'`)
      .get() as { spec_id: string; spec_json: string };
    const spec = JSON.parse(row.spec_json);
    spec.roles.producer.preferred_targets = ["producer-replacement@rig"];
    db.prepare(`UPDATE workflow_specs SET spec_json = ? WHERE spec_id = ?`).run(
      JSON.stringify(spec),
      row.spec_id,
    );
    const r = await runtime.resume({ instanceId, actorSession: "orch-lead@rig" });
    expect(r.ownerSession).toBe("producer-replacement@rig");
  });

  it("a named owner (--owner) receives the instance redrive instead of the role's default seat, recorded as named", async () => {
    build();
    const { instanceId } = await instantiateAndFail(seed(SPEC));
    const r = await runtime.resume({ instanceId, ownerSession: "producer-slot-2@rig", actorSession: "orch-lead@rig" });
    expect(r.ownerSession).toBe("producer-slot-2@rig");
    const packet = db
      .prepare(`SELECT destination_session, body FROM queue_items WHERE qitem_id = ?`)
      .get(r.newPacketId) as { destination_session: string; body: string };
    expect(packet.destination_session).toBe("producer-slot-2@rig");
    expect(packet.body).toContain("owner: producer-slot-2@rig (named by orch-lead@rig)");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = 'producer@rig' AND state = 'pending'`).get())
      .toEqual({ n: 0 });
    const event = db
      .prepare(`SELECT payload FROM events WHERE type = 'workflow.resumed' ORDER BY seq DESC LIMIT 1`)
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ ownerSession: "producer-slot-2@rig", ownerSource: "named" });
  });

  it("without --owner the redrive is recorded as resolved from the role", async () => {
    build();
    const { instanceId } = await instantiateAndFail(seed(SPEC));
    const r = await runtime.resume({ instanceId, actorSession: "orch-lead@rig" });
    expect(r.ownerSession).toBe("producer@rig");
    const body = (db.prepare(`SELECT body FROM queue_items WHERE qitem_id = ?`).get(r.newPacketId) as { body: string }).body;
    expect(body).not.toContain("named by");
    const event = db
      .prepare(`SELECT payload FROM events WHERE type = 'workflow.resumed' ORDER BY seq DESC LIMIT 1`)
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ ownerSession: "producer@rig", ownerSource: "resolved" });
  });

  it("a named owner receives the per-occurrence (packet) redrive, recorded as named; a replay naming another owner conflicts", async () => {
    build();
    const inst = await runtime.instantiate({ specPath: seed(PARALLEL_SPEC, "parallel.yaml"), rootObjective: "fan", createdBySession: "ops@rig" });
    const instanceId = inst.instance.instanceId;
    await runtime.project({ instanceId, currentPacketId: inst.entryQitemId, exit: "done", actorSession: "root@rig" });
    const left = runtime.inspect(instanceId).frontier.find((p) => p.stepId === "left")!;
    await runtime.project({ instanceId, currentPacketId: left.packetId, exit: "failed", actorSession: "left@rig" });

    const r = await runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "left-slot-2@rig", actorSession: "orch-lead@rig" });
    expect(r.ownerSession).toBe("left-slot-2@rig");
    const packet = db
      .prepare(`SELECT destination_session, body FROM queue_items WHERE qitem_id = ?`)
      .get(r.newPacketId) as { destination_session: string; body: string };
    expect(packet.destination_session).toBe("left-slot-2@rig");
    expect(packet.body).toContain("owner: left-slot-2@rig (named by orch-lead@rig)");
    const event = db
      .prepare(`SELECT payload FROM events WHERE type = 'workflow.resumed' ORDER BY seq DESC LIMIT 1`)
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ occurrenceId: left.packetId, ownerSession: "left-slot-2@rig", ownerSource: "named" });
    expect(runtime.instanceStore.getByIdOrThrow(instanceId).lastContinuationDecision)
      .toMatchObject({ ownerSession: "left-slot-2@rig", ownerSource: "named" });

    const replay = await runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "left-slot-2@rig", actorSession: "orch-lead@rig" });
    expect(replay).toMatchObject({ absorbedReplay: true, newPacketId: r.newPacketId });
    await expect(runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "left@rig", actorSession: "orch-lead@rig" }))
      .rejects.toMatchObject({ code: "failure_occurrence_replay_conflict" });
  });

  it("an occurrence replay with a blank --owner is absorbed with no new packet and does not claim the owner was resolved", async () => {
    build();
    const inst = await runtime.instantiate({ specPath: seed(PARALLEL_SPEC, "parallel.yaml"), rootObjective: "fan", createdBySession: "ops@rig" });
    const instanceId = inst.instance.instanceId;
    await runtime.project({ instanceId, currentPacketId: inst.entryQitemId, exit: "done", actorSession: "root@rig" });
    const left = runtime.inspect(instanceId).frontier.find((p) => p.stepId === "left")!;
    await runtime.project({ instanceId, currentPacketId: left.packetId, exit: "failed", actorSession: "left@rig" });

    const r = await runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "left-slot-2@rig", actorSession: "orch-lead@rig" });
    const countPackets = () => (db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n;
    const countResumed = () => (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'workflow.resumed'`).get() as { n: number }).n;
    const packetsBefore = countPackets();
    const resumedBefore = countResumed();

    const replay = await runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "  ", actorSession: "orch-lead@rig" });
    expect(replay).toMatchObject({
      absorbedReplay: true,
      newPacketId: r.newPacketId,
      ownerSession: "left-slot-2@rig",
      ownerNote: "--owner was empty; replay absorbed, already resumed to left-slot-2@rig",
    });
    expect(replay.ownerNote).not.toContain("the owner was resolved");
    expect(countPackets()).toBe(packetsBefore);
    expect(countResumed()).toBe(resumedBefore);
  });

  it("a replay compares --owner with the owner the occurrence was resumed to, not the packet's owner after a fallback reroute", async () => {
    build();
    const inst = await runtime.instantiate({ specPath: seed(PARALLEL_SPEC, "parallel.yaml"), rootObjective: "fan", createdBySession: "ops@rig" });
    const instanceId = inst.instance.instanceId;
    await runtime.project({ instanceId, currentPacketId: inst.entryQitemId, exit: "done", actorSession: "root@rig" });
    const left = runtime.inspect(instanceId).frontier.find((p) => p.stepId === "left")!;
    await runtime.project({ instanceId, currentPacketId: left.packetId, exit: "failed", actorSession: "left@rig" });
    const r = await runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "left-slot-2@rig", actorSession: "orch-lead@rig" });
    queueRepo.routeToFallback(r.newPacketId, "left-slot-3@rig", "seat removed");

    const rows = () => ({
      packets: (db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n,
      events: (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n,
      outbox: (db.prepare(`SELECT COUNT(*) AS n FROM outbox_entries`).get() as { n: number }).n,
    });
    const before = rows();
    const replay = await runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "left-slot-2@rig", actorSession: "orch-lead@rig" });
    expect(replay).toMatchObject({ absorbedReplay: true, newPacketId: r.newPacketId, ownerSession: "left-slot-2@rig", currentOwnerSession: "left-slot-3@rig" });
    expect(rows()).toEqual(before);
    expect(db.prepare(`SELECT destination_session FROM queue_items WHERE qitem_id = ?`).get(r.newPacketId))
      .toEqual({ destination_session: "left-slot-3@rig" });

    await expect(runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "left-slot-3@rig", actorSession: "orch-lead@rig" }))
      .rejects.toMatchObject({ code: "failure_occurrence_replay_conflict", details: { expectedOwner: "left-slot-2@rig", currentOwner: "left-slot-3@rig" } });
    expect(rows()).toEqual(before);
  });

  it.each(["instance", "occurrence"] as const)("%s redrive writes a resume line to the step trail with the owner and whether it was named or resolved", async (path) => {
    build();
    const trail = (instanceId: string) => db
      .prepare(`SELECT step_id, closure_reason, closure_evidence_json, prior_qitem_id, next_qitem_id FROM workflow_step_trails WHERE instance_id = ? AND closure_reason = 'resumed' ORDER BY rowid`)
      .all(instanceId) as Array<{ step_id: string; closure_reason: string; closure_evidence_json: string; prior_qitem_id: string; next_qitem_id: string }>;
    if (path === "instance") {
      const named = await instantiateAndFail(seed(SPEC));
      const r = await runtime.resume({ instanceId: named.instanceId, ownerSession: "producer-slot-2@rig", actorSession: "orch-lead@rig" });
      const [row] = trail(named.instanceId);
      expect(row).toMatchObject({ step_id: "produce", next_qitem_id: r.newPacketId });
      expect(JSON.parse(row!.closure_evidence_json)).toEqual({ resume: { ownerSession: "producer-slot-2@rig", ownerSource: "named", actorSession: "orch-lead@rig", decision: null } });

      const resolved = await instantiateAndFail(seed(SPEC, "again.yaml"));
      await runtime.resume({ instanceId: resolved.instanceId, actorSession: "orch-lead@rig" });
      expect(JSON.parse(trail(resolved.instanceId)[0]!.closure_evidence_json)).toMatchObject({ resume: { ownerSession: "producer@rig", ownerSource: "resolved" } });
      return;
    }
    const inst = await runtime.instantiate({ specPath: seed(PARALLEL_SPEC, "parallel.yaml"), rootObjective: "fan", createdBySession: "ops@rig" });
    const instanceId = inst.instance.instanceId;
    await runtime.project({ instanceId, currentPacketId: inst.entryQitemId, exit: "done", actorSession: "root@rig" });
    const left = runtime.inspect(instanceId).frontier.find((p) => p.stepId === "left")!;
    // Handed off by the queue first, so the failed exit is recorded as a projection on an already-closed row.
    await queueRepo.handoff({ qitemId: left.packetId, fromSession: "left@rig", toSession: "reviewer2@rig" });
    await runtime.project({ instanceId, currentPacketId: left.packetId, exit: "failed", actorSession: "left@rig" });
    const r = await runtime.resume({ instanceId, occurrenceId: left.packetId, ownerSession: "left-slot-2@rig", actorSession: "orch-lead@rig" });
    const rows = trail(instanceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step_id: "left", prior_qitem_id: left.packetId, next_qitem_id: r.newPacketId });
    expect(JSON.parse(rows[0]!.closure_evidence_json)).toEqual({ resume: { ownerSession: "left-slot-2@rig", ownerSource: "named", actorSession: "orch-lead@rig", decision: null, occurrenceId: left.packetId } });
    // The resume line is not a projection record: a repeat of the failure projection is still absorbed.
    await expect(runtime.project({ instanceId, currentPacketId: left.packetId, exit: "failed", actorSession: "left@rig" }))
      .resolves.toMatchObject({ absorbedReplay: true });
    // The redriven step is not counted as completed: the redrive packet still closes normally.
    await runtime.project({ instanceId, currentPacketId: r.newPacketId, exit: "done", actorSession: "left-slot-2@rig" });
  });

  // A named owner gets the same checks as an explicit --next-owner: a bad one is
  // rejected with the existing structured code and nothing is redriven or woken.
  const failForPath = async (path: "instance" | "occurrence", pin = false) => {
    const withPin = (spec: string, role: string) =>
      pin ? spec.replace(`      actor_role: ${role}\n`, `      actor_role: ${role}\n      harness: codex\n`) : spec;
    if (path === "instance") {
      const { instanceId } = await instantiateAndFail(seed(withPin(SPEC, "producer")));
      return { instanceId, occurrenceId: undefined };
    }
    const inst = await runtime.instantiate({ specPath: seed(withPin(PARALLEL_SPEC, "left"), "parallel.yaml"), rootObjective: "fan", createdBySession: "ops@rig" });
    const instanceId = inst.instance.instanceId;
    await runtime.project({ instanceId, currentPacketId: inst.entryQitemId, exit: "done", actorSession: "root@rig" });
    const left = runtime.inspect(instanceId).frontier.find((p) => p.stepId === "left")!;
    await runtime.project({ instanceId, currentPacketId: left.packetId, exit: "failed", actorSession: "left@rig" });
    return { instanceId, occurrenceId: left.packetId };
  };
  const packetCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n;
  const resumedCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'workflow.resumed'`).get() as { n: number }).n;

  it.each(["instance", "occurrence"] as const)("%s redrive: a named owner outside the bound target is rejected unknown_destination_rig, nothing redriven", async (path) => {
    build((destination) => !destination.includes("{rig}"));
    const { instanceId, occurrenceId } = await failForPath(path);
    const packets = packetCount();
    await expect(runtime.resume({ instanceId, occurrenceId, ownerSession: "slot-2@{rig}", actorSession: "orch-lead@rig" }))
      .rejects.toMatchObject({ code: "unknown_destination_rig" });
    expect(packetCount()).toBe(packets);
    expect(resumedCount()).toBe(0);
  });

  it.each(["instance", "occurrence"] as const)("%s redrive: a named owner violating the step's harness pin is rejected harness_pin_unsatisfied, nothing redriven", async (path) => {
    build();
    const seedSeat = (sessionName: string, runtimeName: string, nodeId: string) => {
      db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'r-1', ?, ?)`).run(nodeId, sessionName.split("@")[0], runtimeName);
      db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`).run(`s-${nodeId}`, nodeId, sessionName);
    };
    seedSeat(path === "instance" ? "producer@rig" : "left@rig", "codex", "n-codex");
    seedSeat("claude-seat@rig", "claude-code", "n-claude");
    const { instanceId, occurrenceId } = await failForPath(path, true);
    const packets = packetCount();
    await expect(runtime.resume({ instanceId, occurrenceId, ownerSession: "claude-seat@rig", actorSession: "orch-lead@rig" }))
      .rejects.toMatchObject({ code: "harness_pin_unsatisfied" });
    expect(packetCount()).toBe(packets);
    expect(resumedCount()).toBe(0);
  });

  it("rejection matrix: resume on active/waiting/completed = structured instance_not_failed naming the state", async () => {
    build();
    const specPath = seed(SPEC);
    // active
    const a = await runtime.instantiate({ specPath, rootObjective: "a", createdBySession: "ops@rig" });
    await expect(
      runtime.resume({ instanceId: a.instance.instanceId, actorSession: "x@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_failed" });
    // waiting (the shipped park) — REGRESSION PIN half 1: resume rejects it
    const w = await runtime.instantiate({ specPath, rootObjective: "w", createdBySession: "ops@rig" });
    await runtime.project({
      instanceId: w.instance.instanceId,
      currentPacketId: w.instance.currentFrontier[0]!,
      exit: "waiting",
      blockedOn: "external-thing",
      actorSession: "producer@rig",
    });
    await expect(
      runtime.resume({ instanceId: w.instance.instanceId, actorSession: "x@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_failed" });
    // REGRESSION PIN half 2: the shipped waiting path continues via
    // project on the PRESERVED packet, exactly as before.
    const cont = await runtime.project({
      instanceId: w.instance.instanceId,
      currentPacketId: w.instance.currentFrontier[0]!,
      exit: "done",
      actorSession: "producer@rig",
    });
    expect(cont.instance.status).toBe("completed");
    // completed
    await expect(
      runtime.resume({ instanceId: w.instance.instanceId, actorSession: "x@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_failed" });
  });

  it("sequential double-resume: the second resume rejects (the first made it active) — no double-drive", async () => {
    build();
    const { instanceId } = await instantiateAndFail(seed(SPEC));
    await runtime.resume({ instanceId, actorSession: "orch-lead@rig" });
    await expect(
      runtime.resume({ instanceId, actorSession: "orch-lead@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_failed" });
  });

  it("THE LIVELOCK RAIL: a max_hops-failed instance resumed gets ONE fresh bounded window (hops-since-resume), the count is recorded, and re-exceed raises an honest NEW occurrence", async () => {
    build();
    const specPath = seed(LOOP_SPEC, "loop.yaml");
    const inst = await runtime.instantiate({ specPath, rootObjective: "loop", createdBySession: "ops@rig" });
    const id = inst.instance.instanceId;
    // Drive to the guard trip: max_hops=2 → hop 3 converts to failed.
    let packet = inst.instance.currentFrontier[0]!;
    let actor = "producer@rig";
    for (;;) {
      const res = await runtime.project({
        instanceId: id,
        currentPacketId: packet,
        exit: "handoff",
        actorSession: actor,
      });
      const now = runtime.instanceStore.getByIdOrThrow(id);
      if (now.status === "failed") break;
      packet = res.nextQitemId!;
      actor = actor === "producer@rig" ? "reviewer@rig" : "producer@rig";
    }
    const failed1 = runtime.instanceStore.getByIdOrThrow(id);
    const hopsAtFail = failed1.hopCount;
    const firstOccurrenceItems = db
      .prepare(`SELECT qitem_id FROM queue_items WHERE tags LIKE '%workflow-exception%' AND state = 'pending'`)
      .all();
    expect(firstOccurrenceItems).toHaveLength(1);

    // Resume: one fresh window — the FIRST post-resume projection must
    // NOT re-trip (without the rail it would: hopCount already > max).
    const r = await runtime.resume({ instanceId: id, actorSession: "orch-lead@rig" });
    const resumed = runtime.instanceStore.getByIdOrThrow(id);
    expect(resumed.status).toBe("active");
    expect(resumed.resumeCount).toBe(1);
    expect(resumed.hopsBaseline).toBe(hopsAtFail);

    const afterOne = await runtime.project({
      instanceId: id,
      currentPacketId: r.newPacketId,
      exit: "handoff",
      actorSession: resumed.currentStepId === "produce" ? "producer@rig" : "reviewer@rig",
    });
    expect(runtime.instanceStore.getByIdOrThrow(id).status).toBe("active");

    // Drive on until the fresh window re-exceeds → an honest NEW
    // occurrence (occurrence-distinct item; the first stays closed).
    let p2 = afterOne.nextQitemId!;
    let a2 = afterOne.nextOwnerSession!;
    for (;;) {
      const res = await runtime.project({
        instanceId: id,
        currentPacketId: p2,
        exit: "handoff",
        actorSession: a2,
      });
      const now = runtime.instanceStore.getByIdOrThrow(id);
      if (now.status === "failed") break;
      p2 = res.nextQitemId!;
      a2 = res.nextOwnerSession!;
    }
    const items = db
      .prepare(`SELECT qitem_id, state, tags FROM queue_items WHERE tags LIKE '%workflow-exception%' ORDER BY ts_created`)
      .all() as Array<{ qitem_id: string; state: string; tags: string }>;
    expect(items).toHaveLength(2);
    const open = items.filter((x) => x.state === "pending");
    expect(open).toHaveLength(1);
    // occurrence-distinct: different occurrence keys on the two items
    const occ = (t: string) => /"occurrence:([^"]+)"/.exec(t)?.[1];
    expect(occ(items[0]!.tags)).not.toBe(occ(items[1]!.tags));
  });
});
