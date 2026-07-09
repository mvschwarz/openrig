// OPR.0.4.6.WF5 FR-2 class (a): the born-in-transaction exception item.
//
// The load-bearing never-lost AC: there is NO window where an instance is
// failed and no attention item exists — they commit together or roll back
// together (guard attention flag 1). Plus: THE TIER SPLIT at the wire
// (an orchestrator-routed item matches NEITHER leg of the shipped
// attention union), the never-lost fallback at every dial position, the
// write-gate fallback, and the happy-path zero-items negative (FR-5's
// teeth — zero items of ANY routing).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { isHumanSeatSession } from "../src/domain/human-route-enforcer.js";

const SPEC_WITH_ORCH = `workflow:
  id: wf5-exc-pipeline
  version: 1
  objective: WF-5 class-a fixture
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
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
  exception_routing:
    orchestrator_role: orch
`;

const SPEC_NO_ROUTING = SPEC_WITH_ORCH.replace(
  /  exception_routing:\n    orchestrator_role: orch\n/,
  "",
).replace("id: wf5-exc-pipeline", "id: wf5-exc-noroute");

const SPEC_HUMAN_ONLY = SPEC_WITH_ORCH.replace(
  "  exception_routing:\n    orchestrator_role: orch\n",
  "  exception_routing:\n    default: human_only\n    orchestrator_role: orch\n",
).replace("id: wf5-exc-pipeline", "id: wf5-exc-humanonly");

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
];

function exceptionRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT * FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
    .all() as Array<Record<string, unknown>>;
}

describe("WF-5 FR-2 class (a): born-in-txn exception item", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;

  const build = (opts?: { validateRig?: (ref: string) => boolean; hostDefault?: () => "orchestrator" | "human_only" | null }) => {
    db = createDb();
    migrate(db, MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, {
      validateRig: opts?.validateRig ?? (() => true),
    });
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      exceptionDial: {
        hostDefault: opts?.hostDefault ?? (() => null),
        humanFallbackSeat: "human@host",
      },
    });
  };

  const seed = (spec: string) => {
    tmp = mkdtempSync(join(tmpdir(), "wf5-exc-"));
    const specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, spec);
    return specPath;
  };

  const failEntryStep = async (specPath: string) => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "wf5 exception walk",
      createdBySession: "ops@rig",
    });
    const packetId = inst.instance.currentFrontier[0]!;
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: packetId,
      exit: "failed",
      resultNote: "induced unmapped failure",
      actorSession: "producer@rig",
    });
    return { instanceId: inst.instance.instanceId, packetId };
  };

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("the failing commit carries the item: failed instance + exception item exist together, routed to the orchestrator target with the ORDINARY tier", async () => {
    build();
    const { instanceId, packetId } = await failEntryStep(seed(SPEC_WITH_ORCH));

    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    const item = rows[0]!;
    expect(item.destination_session).toBe("orch-lead@rig");
    // THE TIER-SPLIT NEGATIVE at the wire: neither attention-union leg
    // matches — ordinary tier AND non-human destination.
    expect(item.tier).not.toBe("human-gate");
    expect(isHumanSeatSession(item.destination_session)).toBe(false);
    // identity tags: queryable joins, never summary parsing
    const tags = String(item.tags);
    expect(tags).toContain(`instance:${instanceId}`);
    expect(tags).toContain("step:produce");
    expect(tags).toContain("exception:unmapped_failed");
    expect(tags).toContain(`occurrence:${packetId}`);
    // actionable: summary + evidence pointer + resolution affordance
    expect(String(item.summary)).toContain("no remediation branch");
    expect(String(item.evidence_ref)).toContain("rig workflow trace");
    expect(String(item.body)).toContain("rig workflow resume");
  });

  it("ATOMICITY: an injected failure during item creation rolls back the ENTIRE close — no failed-without-item window, no item-without-failure", async () => {
    build();
    const specPath = seed(SPEC_WITH_ORCH);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "atomicity pin",
      createdBySession: "ops@rig",
    });
    const packetId = inst.instance.currentFrontier[0]!;
    const spy = vi
      .spyOn(queueRepo, "createWithinTransaction")
      .mockImplementation(() => {
        throw new Error("boom-injected-mid-txn");
      });
    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: packetId,
        exit: "failed",
        resultNote: "induced",
        actorSession: "producer@rig",
      }),
    ).rejects.toThrow(/boom-injected/);
    spy.mockRestore();

    // whole txn rolled back: instance NOT failed, packet still open on
    // the frontier, zero exception items.
    const instRow = db
      .prepare(`SELECT status FROM workflow_instances WHERE instance_id = ?`)
      .get(inst.instance.instanceId) as { status: string };
    expect(instRow.status).toBe("active");
    expect(exceptionRows(db)).toHaveLength(0);
    const packet = db
      .prepare(`SELECT state FROM queue_items WHERE qitem_id = ?`)
      .get(packetId) as { state: string };
    expect(["pending", "in-progress"]).toContain(packet.state);
  });

  it("NEVER-LOST FALLBACK: no exception_routing + no host default → the item routes human@host with the human-gate tier", async () => {
    build();
    await failEntryStep(seed(SPEC_NO_ROUTING));
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("human@host");
    expect(rows[0]!.tier).toBe("human-gate");
  });

  it("HUMAN-ONLY dial: the item routes human@host FIRST with the human-gate tier (matches the shipped attention union's tier leg)", async () => {
    build();
    await failEntryStep(seed(SPEC_HUMAN_ONLY));
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("human@host");
    expect(rows[0]!.tier).toBe("human-gate");
  });

  it("host dial default (link 3) applies when the spec declares nothing", async () => {
    build({ hostDefault: () => "human_only" });
    await failEntryStep(seed(SPEC_NO_ROUTING.replace("wf5-exc-noroute", "wf5-exc-hostdial")));
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe("human-gate");
  });

  it("WRITE-GATE FALLBACK: a routed destination the queue gate rejects re-routes human@host instead of losing the exception or failing the close", async () => {
    build({
      validateRig: (ref: string) => !ref.includes("orch-lead"),
    });
    const { instanceId } = await failEntryStep(seed(SPEC_WITH_ORCH));
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("human@host");
    expect(rows[0]!.tier).toBe("human-gate");
    const instRow = db
      .prepare(`SELECT status FROM workflow_instances WHERE instance_id = ?`)
      .get(instanceId) as { status: string };
    expect(instRow.status).toBe("failed");
  });

  it("HAPPY-PATH NEGATIVE (FR-5's teeth): a healthy end-to-end run creates ZERO exception items of ANY routing", async () => {
    build();
    const specPath = seed(SPEC_WITH_ORCH.replace("id: wf5-exc-pipeline", "id: wf5-exc-happy"));
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "happy path",
      createdBySession: "ops@rig",
    });
    const p1 = inst.instance.currentFrontier[0]!;
    const r1 = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: p1,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: r1.nextQitemId!,
      exit: "done",
      actorSession: "reviewer@rig",
    });
    const instRow = db
      .prepare(`SELECT status FROM workflow_instances WHERE instance_id = ?`)
      .get(inst.instance.instanceId) as { status: string };
    expect(instRow.status).toBe("completed");
    expect(exceptionRows(db)).toHaveLength(0);
    // FR-5's second tooth: zero UNSOLICITED orchestrator involvement —
    // the declared orchestrator seat received NOTHING on a healthy run.
    const orchBound = db
      .prepare(`SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = 'orch-lead@rig'`)
      .get() as { n: number };
    expect(orchBound.n).toBe(0);
  });

  it("class (c) MID-FLOW: the WF-2 human gate item IS the exception item — one packet carrying the full class-c identity, occurrence = its own id (guard code-review fold)", async () => {
    build();
    const gated = SPEC_WITH_ORCH.replace("id: wf5-exc-pipeline", "id: wf5-exc-gate").replace(
      `    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed`,
      `    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
      gate:
        target: human@host
        summary: sign off the review
        evidence_ref: proof/review.md`,
    );
    const specPath = seed(gated);
    const inst = await runtime.instantiate({ specPath, rootObjective: "gate", createdBySession: "ops@rig" });
    const r = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.instance.currentFrontier[0]!,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    const item = rows[0]!;
    // ONE item: the gate packet ITSELF (no second minted item)
    expect(item.qitem_id).toBe(r.nextQitemId);
    const tags = String(item.tags);
    expect(tags).toContain("exception:human_gate_trip");
    expect(tags).toContain("step:review");
    expect(tags).toContain(`occurrence:${r.nextQitemId}`);
    expect(tags).toContain(`instance:${inst.instance.instanceId}`);
    // attention via the park leg (blocked_on human@host)
    expect(item.state).toBe("blocked");
    expect(item.blocked_on).toBe("human@host");
  });

  it("class (c) GATED ENTRY: the entry gate packet carries the class-c identity from birth", async () => {
    build();
    const entryGated = SPEC_WITH_ORCH.replace("id: wf5-exc-pipeline", "id: wf5-exc-entrygate").replace(
      `    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed`,
      `    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed
      gate:
        target: human@host
        summary: approve the kickoff
        evidence_ref: proof/kickoff.md`,
    );
    const specPath = seed(entryGated);
    const inst = await runtime.instantiate({ specPath, rootObjective: "entry gate", createdBySession: "ops@rig" });
    const entryId = inst.instance.currentFrontier[0]!;
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qitem_id).toBe(entryId);
    const tags = String(rows[0]!.tags);
    expect(tags).toContain("exception:human_gate_trip");
    expect(tags).toContain("step:produce");
    expect(tags).toContain(`occurrence:${entryId}`);
  });

  it("class (c) NEGATIVE: a handler-role gate carries NO exception identity (deterministic handoff)", async () => {
    build();
    const handlerGated = SPEC_WITH_ORCH.replace("id: wf5-exc-pipeline", "id: wf5-exc-handlergate").replace(
      `    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed`,
      `    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
      gate:
        target: reviewer`,
    );
    const specPath = seed(handlerGated);
    const inst = await runtime.instantiate({ specPath, rootObjective: "handler", createdBySession: "ops@rig" });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.instance.currentFrontier[0]!,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(exceptionRows(db)).toHaveLength(0);
  });

  it("a MAPPED failed (WF-2 branch) is remediation, NOT an exception — zero items", async () => {
    build();
    const branched = SPEC_WITH_ORCH.replace(
      "id: wf5-exc-pipeline",
      "id: wf5-exc-branched",
    ).replace(
      `    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed`,
      `    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed
      next_hop:
        on:
          failed: review`,
    );
    const specPath = seed(branched);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "mapped failed",
      createdBySession: "ops@rig",
    });
    const p1 = inst.instance.currentFrontier[0]!;
    const r = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: p1,
      exit: "failed",
      resultNote: "mapped — routes to remediation",
      actorSession: "producer@rig",
    });
    expect(r.nextStepId).toBe("review");
    const instRow = db
      .prepare(`SELECT status FROM workflow_instances WHERE instance_id = ?`)
      .get(inst.instance.instanceId) as { status: string };
    expect(instRow.status).toBe("active");
    expect(exceptionRows(db)).toHaveLength(0);
  });
});
