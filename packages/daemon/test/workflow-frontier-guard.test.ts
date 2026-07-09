import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { createWorkflowFrontierPredicate } from "../src/domain/workflow-frontier-guard.js";

/**
 * OPR.0.4.6.WF3 FR-6 — the frontier close-path guard (pm ruling:
 * prevention over detection). Injected-predicate shape (arch pin):
 * the queue never imports the workflow domain — pinned at the
 * import-graph level in the last test.
 */

const SPEC = `workflow:
  id: guard-fixture
  version: 1
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
        suggested_roles:
          - reviewer
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
      - failed
`;

describe("workflow frontier close-path guard (WF3 FR-6)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      workflowInstanceVersionSchema, workflowSpecJsonSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    // The PRODUCTION wiring shape: predicate INJECTED at construction
    // (startup.ts does exactly this).
    queueRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      workflowFrontierPredicate: createWorkflowFrontierPredicate(db),
    });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-guard-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  async function instantiate() {
    const r = await runtime.instantiate({
      specPath,
      rootObjective: "guard pins",
      createdBySession: "orch@rig",
    });
    return { instanceId: r.instance.instanceId, entryPacket: r.entryQitemId };
  }

  it("out-of-band terminal closure of a LIVE frontier packet is REJECTED loud, naming the workflow verbs (what/why/fix)", async () => {
    const { entryPacket } = await instantiate();
    let caught: QueueRepositoryError | null = null;
    try {
      queueRepo.update({
        qitemId: entryPacket,
        actorSession: "rogue@rig",
        state: "done",
        closureReason: "no-follow-on",
      });
    } catch (err) {
      caught = err as QueueRepositoryError;
    }
    expect(caught).toBeInstanceOf(QueueRepositoryError);
    expect(caught?.code).toBe("workflow_frontier_packet");
    // what/why/fix: names the binding AND the correct verbs.
    expect(caught?.message).toContain("frontier packet");
    expect(caught?.message).toContain("strand");
    expect(caught?.message).toContain("rig workflow project");
    expect(caught?.message).toContain("rig workflow route");
    // The packet is UNTOUCHED (prevention, not detection).
    const row = db.prepare(`SELECT state FROM queue_items WHERE qitem_id = ?`).get(entryPacket) as { state: string };
    expect(row.state).toBe("pending");
  });

  it("MC-route-shaped closure (handed-off via the in-txn primitive) is equally guarded", async () => {
    const { entryPacket } = await instantiate();
    expect(() =>
      db.transaction(() => {
        queueRepo.updateWithinTransaction({
          qitemId: entryPacket,
          actorSession: "mc@rig",
          state: "handed-off",
          closureReason: "handed_off_to",
          closureTarget: "elsewhere@rig",
          handedOffTo: "elsewhere@rig",
        });
      })(),
    ).toThrowError(/workflow instance/);
  });

  it("the workflow verbs themselves are UNAFFECTED (they hold the invariant)", async () => {
    const { instanceId, entryPacket } = await instantiate();
    // project (advance) works…
    const advanced = await runtime.project({
      instanceId,
      currentPacketId: entryPacket,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(advanced.nextStepId).toBe("review");
    // …and route works on the new frontier.
    const routed = await runtime.route({
      instanceId,
      toSession: "reviewer2@rig",
      actorSession: "orch@rig",
    });
    expect(routed.toSession).toBe("reviewer2@rig");
  });

  it("ZERO-FRICTION NEGATIVE: a non-workflow qitem's closure is byte-identical with and without the predicate wired", async () => {
    // Repo WITH the predicate (production shape).
    const created = await queueRepo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "ordinary work",
    });
    const closed = queueRepo.update({
      qitemId: created.qitemId,
      actorSession: "b@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    expect(closed.state).toBe("done");

    // Repo WITHOUT any predicate (legacy shape) — same fields, same result.
    const bareRepo = new QueueRepository(db, bus, { validateRig: () => true });
    const created2 = await bareRepo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "ordinary work",
    });
    const closed2 = bareRepo.update({
      qitemId: created2.qitemId,
      actorSession: "b@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    expect(closed2.state).toBe("done");
    expect(closed2.closureReason).toBe(closed.closureReason);
  });

  it("a TERMINAL instance's packets are not guarded (the predicate is scoped to LIVE frontiers)", async () => {
    const { instanceId, entryPacket } = await instantiate();
    await runtime.project({ instanceId, currentPacketId: entryPacket, exit: "failed", actorSession: "producer@rig" });
    // The instance failed; its (already-closed) packet is off the live
    // frontier — no guard interference with any later queue hygiene.
    expect(createWorkflowFrontierPredicate(db)(entryPacket)).toBeNull();
  });

  it("THE IMPORT-GRAPH PIN (arch layering rule): queue-repository.ts imports NOTHING from the workflow domain", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../src/domain/queue-repository.ts"), "utf-8");
    const importLines = src.split("\n").filter((l) => l.trimStart().startsWith("import "));
    for (const line of importLines) {
      expect(line).not.toMatch(/workflow-/);
    }
  });
});
