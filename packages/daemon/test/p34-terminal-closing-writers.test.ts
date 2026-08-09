// P34 — TERMINAL-CLOSING WRITERS ONTO THE W1 PRIMITIVES.
//
// Lock: qitem-20260809110825-be056197 · SHAPE artifact 4f2b04c161a8da959c…f49f453a
// Pre-edit rev-2: 2f4710b1512baa41c0c4ed0de09af8fc39e6386378f28941d6d10e4cccd73345
// Guard CLEAR: qitem-20260809180349-634de805 (verdict 5ba491d7c31cf98b…d085f8)
//
// THE ATOM: W1 made executed-but-unwoken impossible to WRITE *via the queue's own
// terminal verbs*. Mission Control, workflow-runtime and workflow-projector close
// and create OUTSIDE those verbs, so today the wave's premise holds for one writer
// and is merely detected for the rest. This suite pins the extension.
//
// ── RED 1 (this file, first increment): THE CURRENT MISS ──────────────────────
// Each ruled site drives a REAL terminal close + successor create through the real
// writer, with an intent store attached, and asserts the successor's wake intent
// is durable. Today every one of these FAILS with the intent absent (intents=0) —
// that failure IS the captured miss. They flip GREEN when the wiring lands.
//
// THE FIVE RULED SUCCESSOR SITES (planner ruling 17:57Z; guard CLEAR 18:03Z):
//   mission-control-write-contract.ts:174   (route / handoff)
//   workflow-projector.ts:466               (project → routes branch)
//   workflow-projector.ts:729               (project → failed branch — EXCLUSIVE
//                                            with :466; nextStatus="failed"
//                                            requires routes===false, :571-585)
//   workflow-runtime.ts:992                 (route)
//   workflow-runtime.ts:791                 (resume redrive)
//
// NOT A SITE, deliberately: workflow-runtime.ts:831 closes N exception items with
// closureReason "no-follow-on" and NO successor — a TERMINAL CLOSE WITH NO
// SUCCESSOR, the third state. It requires no intent, and pairing it with the :791
// packet would satisfy the assert against an unrelated successor: a check that can
// only pass. Its no-false-positive control is RED 4b (next increment).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import type { QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";

/** A two-step spec: the entry step hands off, so project(handoff) exercises the
 *  projector's ROUTES branch (:466). */
const SPEC = `workflow:
  id: p34-two-step
  version: 1
  objective: P34 terminal-closing writers
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
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
      - failed
`;

interface Harness {
  db: Database.Database;
  bus: EventBus;
  repo: QueueRepository;
  outbox: OutboxHandler;
  runtime: WorkflowRuntime;
  mc: MissionControlWriteContract;
  specPath: string;
  tmp: string;
}

/** Every wake intent is keyed on its SUCCESSOR (queue-repository.ts:616). */
function intentFor(h: Harness, successorQitemId: string) {
  return h.outbox.getById(`wake-intent-${successorQitemId}`);
}

function makeHarness(): Harness {
  const db = createDb();
  migrate(db, [
    coreSchema,
    eventsSchema,
    queueItemsSchema,
    queueTransitionsSchema,
    outboxEntriesSchema,
    workflowSpecsSchema,
    workflowInstancesSchema,
    workflowStepTrailsSchema,
    missionControlActionsSchema,
    queueTargetRepoSchema,
    queueItemSummarySchema,
    queueItemEvidenceRefSchema,
  ]);
  db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  const bus = new EventBus(db);
  const outbox = new OutboxHandler(db);
  const transport: QueueNudgeTransport = {
    async send() {
      return { ok: true, verified: true };
    },
  };
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  repo.attachTransport(transport);
  // The intent store is ATTACHED on purpose: this suite asks whether the wiring
  // stages an intent, not whether the store exists. A harness without an outbox
  // could not tell "not staged" from "nowhere to stage it".
  repo.attachOutbox(outbox);
  const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: repo });
  const mc = new MissionControlWriteContract({
    db,
    eventBus: bus,
    queueRepo: repo,
    actionLog: new MissionControlActionLog(db),
  });
  const tmp = mkdtempSync(join(tmpdir(), "p34-"));
  const specPath = join(tmp, "spec.yaml");
  writeFileSync(specPath, SPEC);
  return { db, bus, repo, outbox, runtime, mc, specPath, tmp };
}

describe("P34 RED 1 — the CURRENT MISS: terminal close + successor create stages NO wake intent", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it("mission-control-write-contract.ts:174 — handoff closes the source and creates the successor with a DURABLE wake intent", async () => {
    const source = await h.repo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "work",
    });
    const result = await h.mc.act({
      verb: "handoff",
      qitemId: source.qitemId,
      actorSession: "human-operator@kernel",
      destinationSession: "next@rig",
    });

    // The terminal close actually happened — otherwise this test would pass
    // vacuously by asserting an intent for a close that never occurred.
    expect(h.repo.getById(source.qitemId)?.state).toBe("handed-off");
    expect(result.createdQitemId).toBeTruthy();

    expect(intentFor(h, result.createdQitemId!)).not.toBeNull();
  });

  it("workflow-projector.ts:466 — project(handoff) ROUTES branch stages the next-step packet's wake intent", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await h.runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
      resultNote: "produced",
    });

    expect(h.repo.getById(inst.entryQitemId)?.state).toBe("handed-off");
    expect(projected.nextQitemId).toBeTruthy();

    expect(intentFor(h, projected.nextQitemId!)).not.toBeNull();
  });

  it("workflow-projector.ts:729 — project(failed) FAILED branch stages the exception item's wake intent", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await h.runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "producer@rig",
      resultNote: "blew up",
    });

    // EXCLUSIVITY, pinned: nextStatus==="failed" requires routes===false
    // (workflow-projector.ts:571-585), so the failed branch NEVER also produces a
    // next-step packet. :466 and :729 are alternatives, never two successors.
    expect(projected.nextQitemId).toBeNull();

    // The exception item is the successor here. Asserting EXACTLY ONE match keeps
    // this a lookup of a known row rather than a discovery that could quietly
    // select the wrong one.
    const exceptionItems = h.db
      .prepare(`SELECT qitem_id FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
      .all() as Array<{ qitem_id: string }>;
    expect(exceptionItems).toHaveLength(1);

    expect(intentFor(h, exceptionItems[0]!.qitem_id)).not.toBeNull();
  });

  it("workflow-runtime.ts:992 — route closes the old frontier packet and stages the re-routed packet's wake intent", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const routed = await h.runtime.route({
      instanceId: inst.instance.instanceId,
      toSession: "reviewer@rig",
      actorSession: "ops@rig",
      reason: "owner swap",
    });

    expect(h.repo.getById(routed.closedPacketId)?.state).toBe("handed-off");

    expect(intentFor(h, routed.newPacketId)).not.toBeNull();
  });

  it("workflow-runtime.ts:791 — resume redrive stages the NEW packet's wake intent (never the exception closes')", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    await h.runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "producer@rig",
      resultNote: "blew up",
    });
    const resumed = await h.runtime.resume({
      instanceId: inst.instance.instanceId,
      decision: "redrive it",
      actorSession: "ops@rig",
    });

    // The redrive packet is the ONLY successor in this transaction. The N
    // exception closes at :831 have no successor of their own.
    expect(resumed.exceptionItemsClosed).toBeGreaterThan(0);

    expect(intentFor(h, resumed.newPacketId)).not.toBeNull();
  });
});
