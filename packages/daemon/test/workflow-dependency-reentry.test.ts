import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";

const BUILD = `workflow:
  id: build-with-signoff
  version: 1
  entry: {role: owner}
  loop_guards: {max_hops: 7}
  roles:
    owner: {preferred_targets: [owner@rig]}
  exception_routing: {orchestrator_role: owner}
  steps:
    - id: implement
      actor_role: owner
      depends_on: []
      allowed_exits: [handoff, failed]
    - id: code_review_codex
      actor_role: owner
      depends_on: [implement]
      allowed_exits: [handoff, failed]
      next_hop: {on: {failed: implement}}
    - id: code_review_claude
      actor_role: owner
      depends_on: [implement]
      allowed_exits: [handoff, failed]
      next_hop: {on: {failed: implement}}
    - id: ship_signoff
      actor_role: owner
      depends_on: [code_review_codex, code_review_claude]
      allowed_exits: [done, failed]
      gate: {target: human@host, summary: Ship sign-off, evidence_ref: proof/build.md}
      next_hop: {on: {failed: implement}}
`;

const STRAIGHT = `workflow:
  id: straight-through
  version: 1
  entry: {role: owner}
  roles:
    owner: {preferred_targets: [owner@rig]}
  exception_routing: {orchestrator_role: owner}
  steps:
    - id: a
      actor_role: owner
      depends_on: []
      allowed_exits: [handoff]
    - id: b
      actor_role: owner
      depends_on: [a]
      allowed_exits: [handoff]
    - id: c
      actor_role: owner
      depends_on: [b]
      allowed_exits: [handoff]
    - id: gate
      actor_role: owner
      depends_on: [b, c]
      allowed_exits: [done]
      gate: {target: human@host, summary: Sign-off, evidence_ref: proof/straight.md}
`;

describe("dependency graph re-entry through a routed exit", () => {
  let db: ReturnType<typeof createDb>;
  let runtime: WorkflowRuntime;
  let dir: string;
  // Unset means real time. A test sets it to move the workflow clock by hand.
  let clock: Date | undefined;
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs(id,name) VALUES('rig','rig')").run();
    const bus = new EventBus(db);
    const queue = new QueueRepository(db, bus, { validateRig: () => true, transport: {
      send: async () => ({ ok: false, reason: "controlled terminal is stopped" }),
    } });
    queue.attachOutbox(new OutboxHandler(db));
    clock = undefined;
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, now: () => clock ?? new Date() });
    dir = mkdtempSync(join(tmpdir(), "dependency-reentry-"));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  async function start(source: string) {
    const specPath = join(dir, "workflow.yaml"); writeFileSync(specPath, source);
    const started = await runtime.instantiate({ specPath, rootObjective: "re-run dependents after a routed exit", createdBySession: "owner@rig" });
    return { id: started.instance.instanceId, entry: started.entryQitemId };
  }
  const project = (instanceId: string, packet: string, exit: "handoff" | "done" | "failed") =>
    runtime.project({ instanceId, currentPacketId: packet, actorSession: "owner@rig", exit });
  const packetFor = (result: { nextStepIds: string[]; nextQitemIds: string[] }, stepId: string) =>
    result.nextQitemIds[result.nextStepIds.indexOf(stepId)]!;

  it("re-runs both reviews and reopens the gate after the sign-off sends implement back", async () => {
    const run = await start(BUILD);
    const firstImplement = await project(run.id, run.entry, "handoff");
    expect(firstImplement.nextStepIds).toEqual(["code_review_codex", "code_review_claude"]);
    await project(run.id, packetFor(firstImplement, "code_review_codex"), "handoff");
    const firstReviews = await project(run.id, packetFor(firstImplement, "code_review_claude"), "handoff");
    expect(firstReviews.nextStepIds).toEqual(["ship_signoff"]);
    const sentBack = await project(run.id, packetFor(firstReviews, "ship_signoff"), "failed");
    expect(sentBack.nextStepIds).toEqual(["implement"]);

    const fixRound = await project(run.id, packetFor(sentBack, "implement"), "handoff");
    expect(fixRound.nextStepIds).toEqual(["code_review_codex", "code_review_claude"]);
    expect(fixRound.instance.status).toBe("active");

    const codexAgain = await project(run.id, packetFor(fixRound, "code_review_codex"), "handoff");
    expect(codexAgain.nextStepIds).toEqual([]);
    expect(codexAgain.instance.status).toBe("active");
    const claudeAgain = await project(run.id, packetFor(fixRound, "code_review_claude"), "handoff");
    expect(claudeAgain.nextStepIds).toEqual(["ship_signoff"]);
    expect(claudeAgain.instance.status).toBe("waiting");

    const shipped = await project(run.id, packetFor(claudeAgain, "ship_signoff"), "done");
    expect(shipped.instance.status).toBe("completed");
    expect(runtime.trailLog.listForInstance(run.id).map((entry) => entry.stepId).reverse()).toEqual([
      "implement", "code_review_codex", "code_review_claude", "ship_signoff",
      "implement", "code_review_codex", "code_review_claude", "ship_signoff",
    ]);
  });

  it("completes a run with no routed exit exactly once", async () => {
    const run = await start(BUILD);
    const implemented = await project(run.id, run.entry, "handoff");
    await project(run.id, packetFor(implemented, "code_review_codex"), "handoff");
    const reviewed = await project(run.id, packetFor(implemented, "code_review_claude"), "handoff");
    const shipped = await project(run.id, packetFor(reviewed, "ship_signoff"), "done");
    expect(shipped.nextStepIds).toEqual([]);
    expect(shipped.instance.status).toBe("completed");
    expect(runtime.trailLog.listForInstance(run.id)).toHaveLength(4);
  });

  it("opens the gate when the clock steps back in a run with no routed exit", async () => {
    clock = new Date("2026-10-05T10:00:00.000Z");
    const run = await start(STRAIGHT);
    const afterA = await project(run.id, run.entry, "handoff");
    expect(afterA.nextStepIds).toEqual(["b"]);

    clock = new Date("2026-10-05T09:00:00.000Z");
    const afterB = await project(run.id, packetFor(afterA, "b"), "handoff");
    expect(afterB.nextStepIds).toEqual(["c"]);
    clock = new Date("2026-10-05T09:00:01.000Z");
    const afterC = await project(run.id, packetFor(afterB, "c"), "handoff");
    expect(afterC.nextStepIds).toEqual(["gate"]);
    expect(afterC.instance.status).toBe("waiting");
    expect(afterC.emittedEventTypes).not.toContain("workflow.completed");
  });
});
