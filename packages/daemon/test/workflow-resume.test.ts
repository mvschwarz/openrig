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
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";

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

const MIGRATIONS = [
  coreSchema,
  eventsSchema,
  queueItemsSchema,
  queueTransitionsSchema,
  workflowSpecsSchema,
  workflowInstancesSchema,
  workflowStepTrailsSchema,
  queueItemSummarySchema,
  queueItemEvidenceRefSchema,
  workflowInstanceVersionSchema,
  workflowSpecJsonSchema,
  workflowResumeSchema,
];

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

  const build = () => {
    db = createDb();
    migrate(db, MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
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
    expect(inst.currentStepId).toBe("produce");
    expect(inst.currentFrontier).toEqual([r.newPacketId]);
    expect(inst.resumeCount).toBe(1);
    // trail preserved + extended NEVER rewritten: the failure row stands,
    // no rows were re-run/rewritten by resume itself.
    expect(trailCount(instanceId)).toBe(trailBefore);
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
