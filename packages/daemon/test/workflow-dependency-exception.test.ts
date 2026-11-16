import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const GRAPH = `workflow:
  id: dependency-exception
  version: 1
  entry: {role: owner}
  roles:
    owner: {preferred_targets: [owner@rig]}
  exception_routing: {orchestrator_role: owner}
  steps:
    - id: root
      actor_role: owner
      depends_on: []
      allowed_exits: [done, failed]
    - id: left
      actor_role: owner
      depends_on: [root]
      allowed_exits: [done, failed]
    - id: right
      actor_role: owner
      depends_on: [root]
      allowed_exits: [done, failed]
`;

describe("dependency failure ownership and occurrence-local recovery", () => {
  let db: ReturnType<typeof createDb>;
  let queue: QueueRepository;
  let runtime: WorkflowRuntime;
  let dir: string;
  let sent: string[];
  beforeEach(() => {
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs(id,name) VALUES('rig','rig')").run();
    const bus = new EventBus(db); sent = [];
    queue = new QueueRepository(db, bus, { validateRig: () => true, transport: {
      send: async (_target, body) => { sent.push(body); return { ok: false, reason: "controlled terminal is stopped" }; },
    } });
    queue.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    dir = mkdtempSync(join(tmpdir(), "dependency-exception-"));
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  const exceptions = () => db.prepare(`SELECT * FROM queue_items WHERE EXISTS
    (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception') ORDER BY qitem_id`).all() as Array<Record<string, any>>;
  const wakes = () => db.prepare("SELECT * FROM outbox_entries WHERE outbox_id LIKE 'wake-intent-%' ORDER BY outbox_id").all();
  const snapshot = () => ["queue_items", "queue_transitions", "workflow_instances", "workflow_frontier_bindings", "workflow_failure_occurrences", "workflow_step_trails", "outbox_entries", "events"]
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  async function start(source = GRAPH) {
    const specPath = join(dir, "workflow.yaml"); writeFileSync(specPath, source);
    return runtime.instantiate({ specPath, rootObjective: "own and recover each failed handout check", createdBySession: "owner@rig" });
  }
  const project = (instanceId: string, packet: string, exit: "done" | "failed") => runtime.project({
    instanceId, currentPacketId: packet, actorSession: "owner@rig", exit,
    resultNote: exit === "failed" ? "controlled handout mismatch" : undefined,
    closureEvidence: { evidence_ref: "proof/actual-handout-comparison.json" },
  });
  async function branches(source = GRAPH) {
    const i = await start(source); await project(i.instance.instanceId, i.entryQitemId, "done");
    const view = runtime.inspect(i.instance.instanceId);
    return { id: i.instance.instanceId, root: i.entryQitemId,
      left: view.frontier.find(p => p.stepId === "left")!.packetId,
      right: view.frontier.find(p => p.stepId === "right")!.packetId };
  }

  it("admits one evidence-linked owner and durable failed wake while preserving a live sibling", async () => {
    const b = await branches(); const sibling = queue.getById(b.right); const completed = queue.getById(b.root);
    await project(b.id, b.left, "failed");
    expect(runtime.inspect(b.id).instance.status).toBe("active");
    expect(queue.getById(b.right)).toEqual(sibling); expect(queue.getById(b.root)).toEqual(completed);
    const [exception] = exceptions(); expect(exceptions()).toHaveLength(1);
    expect(exception).toMatchObject({ destination_session: "owner@rig", state: "pending", evidence_ref: `rig workflow trace ${b.id}` });
    expect(JSON.parse(exception!.tags)).toEqual(expect.arrayContaining([`instance:${b.id}`, "step:left", `occurrence:${b.left}`, "exception:unmapped_failed"]));
    expect(JSON.parse(exception!.chain_of_record)).toEqual([b.left]);
    expect(exception!.body).toContain(`rig workflow resume ${b.id} --occurrence ${b.left}`);
    expect(runtime.inspect(b.id).failures).toMatchObject([{ occurrenceId: b.left, stepId: "left", status: "unresolved" }]);
    expect(runtime.trailLog.listForInstance(b.id).find(t => t.priorQitemId === b.left)?.closureEvidence)
      .toMatchObject({ evidence_ref: "proof/actual-handout-comparison.json" });
    expect(db.prepare("SELECT delivery_state,audit_pointer FROM outbox_entries WHERE outbox_id = ?").get(`wake-intent-${exception!.qitem_id}`))
      .toEqual({ delivery_state: "failed", audit_pointer: exception!.qitem_id });
    const before = snapshot(); const sends = sent.length;
    await expect(project(b.id, b.left, "failed")).rejects.toMatchObject({ code: "packet_not_on_frontier" });
    expect(snapshot()).toEqual(before); expect(sent).toHaveLength(sends);
  });

  // A branch packet an ordinary queue handoff already closed, whose review then failed: the agent's failed exit is
  // recorded on the workflow and the failure is owned as usual, with no write to the closed row; the same exit again
  // writes nothing.
  it("records a failed exit on a branch packet the queue already closed, without writing its row, and once", async () => {
    const b = await branches(); const sibling = queue.getById(b.right);
    await queue.handoff({ qitemId: b.left, fromSession: "owner@rig", toSession: "reviewer2@rig" });
    const closedRow = () => ({ item: queue.getById(b.left),
      transitions: db.prepare("SELECT * FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid").all(b.left) });
    const closed = closedRow();

    const projected = await project(b.id, b.left, "failed");

    expect(closedRow()).toEqual(closed); expect(closed.item?.state).toBe("handed-off");
    expect(projected.advisories).toEqual([`packet ${b.left} was already handed-off in the queue, so the failed exit was recorded on the workflow without writing its queue row`]);
    expect(runtime.inspect(b.id).instance.status).toBe("active"); expect(queue.getById(b.right)).toEqual(sibling);
    expect(exceptions()).toHaveLength(1);
    expect(runtime.inspect(b.id).failures).toMatchObject([{ occurrenceId: b.left, stepId: "left", status: "unresolved" }]);
    expect(runtime.inspect(b.id).instance.currentFrontier).toEqual([b.right]);
    // The caller's result note is kept in the projector's record, since no queue row or next packet carries it.
    expect(runtime.trailLog.listForInstance(b.id).find(t => t.priorQitemId === b.left)?.closureEvidence?.queue_row_already_closed)
      .toMatchObject({ state: "handed-off", exit: "failed", result_note: "controlled handout mismatch", next_qitem_ids: [] });
    const before = snapshot(); const sends = sent.length;
    expect(await project(b.id, b.left, "failed")).toMatchObject({ closureReason: "failed", nextQitemIds: [], absorbedReplay: true, emittedEventTypes: [] });
    expect(snapshot()).toEqual(before); expect(sent).toHaveLength(sends);
  });

  // A sole frontier packet the queue already closed stays active on a waiting exit (its unchanged row isn't blocked), so
  // the waiting replay rule can't absorb the repeat; the projector's record does.
  it("absorbs a repeated waiting exit on a sole graph packet the queue already closed", async () => {
    const i = await start(GRAPH.replace("allowed_exits: [done, failed]", "allowed_exits: [done, failed, waiting]"));
    await queue.handoff({ qitemId: i.entryQitemId, fromSession: "owner@rig", toSession: "reviewer2@rig" });
    const waiting = { instanceId: i.instance.instanceId, currentPacketId: i.entryQitemId, actorSession: "owner@rig", exit: "waiting" as const,
      resultNote: "waiting on the reviewer", closureEvidence: {} };
    expect((await runtime.project(waiting)).instance).toMatchObject({ status: "active", currentFrontier: [i.entryQitemId] });
    const before = snapshot(); const sends = sent.length;
    expect(await runtime.project(waiting)).toMatchObject({ absorbedReplay: true, emittedEventTypes: [] });
    expect(snapshot()).toEqual(before); expect(sent).toHaveLength(sends);
  });

  it("redrives only the selected episode once and preserves a distinct unresolved failure and completed work", async () => {
    const b = await branches(); const completed = queue.getById(b.root);
    await project(b.id, b.left, "failed"); await project(b.id, b.right, "failed");
    expect(exceptions()).toHaveLength(2);
    const right = exceptions().find(row => JSON.parse(row.tags).includes(`occurrence:${b.right}`))!;
    const request = { instanceId: b.id, occurrenceId: b.left, decision: "corrected handout; retry left", actorSession: "owner@rig" };
    const resumed = await runtime.resume(request);
    expect(resumed.exceptionItemsClosed).toBe(1);
    expect(queue.getById(right.qitem_id)?.state).toBe("pending");
    expect(exceptions().find(row => JSON.parse(row.tags).includes(`occurrence:${b.left}`))).toMatchObject({ state: "done", closure_reason: "no-follow-on" });
    expect(runtime.inspect(b.id).failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ occurrenceId: b.left, status: "resolved", redrivePacketId: resumed.newPacketId }),
      expect.objectContaining({ occurrenceId: b.right, status: "unresolved" }),
    ]));
    const before = snapshot(); const sends = sent.length;
    expect(await runtime.resume(request)).toMatchObject({ newPacketId: resumed.newPacketId, exceptionItemsClosed: 0, absorbedReplay: true });
    expect(snapshot()).toEqual(before); expect(sent).toHaveLength(sends);
    await expect(runtime.resume({ ...request, decision: "different request" })).rejects.toMatchObject({ code: "failure_occurrence_replay_conflict" });
    expect(snapshot()).toEqual(before);
    await project(b.id, resumed.newPacketId, "done");
    expect(queue.getById(b.root)).toEqual(completed);
    expect(queue.getById(right.qitem_id)?.state).toBe("pending");
    expect(runtime.inspect(b.id).failures.find(f => f.occurrenceId === b.right)?.status).toBe("unresolved");
  });

  it.each(["create", "wake"])("rolls back failure, occurrence, queue and events if %s admission fails", async phase => {
    const b = await branches(); const before = snapshot(); const sends = sent.length;
    if (phase === "create") vi.spyOn(queue, "createWithinTransaction").mockImplementation(() => { throw new Error("controlled storage failure"); });
    else vi.spyOn(queue, "stageWakeIntent").mockImplementation(() => { throw new Error("controlled storage failure"); });
    await expect(project(b.id, b.left, "failed")).rejects.toThrow("controlled storage failure");
    expect(snapshot()).toEqual(before); expect(sent).toHaveLength(sends);
  });

  it("rolls back redrive and occurrence resolution when closing its exception fails", async () => {
    const b = await branches(); await project(b.id, b.left, "failed"); const before = snapshot(); const sends = sent.length;
    const original = queue.updateWithinTransaction.bind(queue);
    vi.spyOn(queue, "updateWithinTransaction").mockImplementation(input => {
      if (input.state === "done") throw new Error("controlled exception closure failure");
      return original(input);
    });
    await expect(runtime.resume({ instanceId: b.id, occurrenceId: b.left, actorSession: "owner@rig" })).rejects.toThrow("controlled exception closure failure");
    expect(snapshot()).toEqual(before); expect(sent).toHaveLength(sends);
  });

  it("admits the max-hop failure sibling without duplicating work or losing the other frontier", async () => {
    const source = GRAPH.replace("  entry:", "  loop_guards: {max_hops: 1}\n  entry:")
      .replace("    - id: left\n", "    - id: left\n      next_hop: {on: {done: root}}\n");
    const b = await branches(source); const sibling = queue.getById(b.right);
    const result = await project(b.id, b.left, "done");
    expect(result.closureReason).toBe("failed"); expect(result.nextQitemIds).toEqual([]);
    expect(exceptions()).toHaveLength(1); expect(exceptions()[0]!.summary).toContain("max_hops_exceeded");
    expect(queue.getById(b.right)).toEqual(sibling);
    expect(runtime.inspect(b.id).failures).toMatchObject([{ occurrenceId: b.left, status: "unresolved" }]);
  });

  it("preserves an explicitly handled failure as ordinary remediation with no exception", async () => {
    const source = GRAPH.replace("    - id: left\n", "    - id: left\n      next_hop: {on: {failed: repair}}\n")
      + "    - id: repair\n      actor_role: owner\n      allowed_exits: [done]\n";
    const b = await branches(source); const sibling = queue.getById(b.right);
    const result = await project(b.id, b.left, "failed");
    expect(result.nextStepIds).toEqual(["repair"]);
    expect(exceptions()).toEqual([]); expect(runtime.inspect(b.id).failures).toEqual([]);
    expect(queue.getById(b.right)).toEqual(sibling);
  });
});
