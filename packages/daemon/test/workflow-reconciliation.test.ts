import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { inspectGraph, reviseGraph, recoverGraphOperation } from "../src/domain/workflow-reconciliation.js";
import { buildExecutionView } from "../src/domain/execution-view.js";
import { workflowRoutes } from "../src/routes/workflow.js";
import { Hono } from "hono";

describe("one preserved running graph and recoverable revision decision", () => {
  let db: ReturnType<typeof createDb>, bus: EventBus, queue: QueueRepository, runtime: WorkflowRuntime;
  let root: string, mission: string, project: any, plan: any;
  let sends: string[];
  const write = (file: string, value: unknown) => writeFileSync(file, YAML.stringify(value));
  const save = () => { write(join(root, "project.yaml"), project); write(join(mission, "mission.yaml"), plan); };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "graph-revision-")); mission = join(root, "missions", "trial");
    mkdirSync(join(mission, "slices", "01-child"), { recursive: true });
    project = { kind: "project", metadata: { id: "trial" }, lifecycle: { profile: "release", profiles: { release: { required_steps: ["plan", "finish"], workflow: {
      entry: { role: "owner" }, roles: { owner: { preferred_targets: ["owner@rig"] } },
      steps: [
        { id: "plan", actor_role: "owner", depends_on: [], allowed_exits: ["handoff"], objective: "Choose" },
        { id: "build", actor_role: "owner", depends_on: ["plan"], allowed_exits: ["handoff", "waiting"], objective: "Build" },
        { id: "finish", actor_role: "owner", depends_on: ["build"], allowed_exits: ["done"], objective: "Judge" },
      ],
    } } } } };
    plan = { kind: "mission", metadata: { name: "trial" }, composition: { slices: [{ ref: "slices/01-child/slice.yaml", order: 10 }] }, sdlc: { catalog: { address: "first.md" } }, lifecycle: { profile: "release", mode: "extend", workflow: { steps: [] } } };
    write(join(mission, "slices", "01-child", "slice.yaml"), { kind: "slice", metadata: { id: "child" }, composition: { mission: "../../mission.yaml" } });
    save(); db = createDb(); migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs(id,name) VALUES('r','rig')").run();
    bus = new EventBus(db); sends = [];
    queue = new QueueRepository(db, bus, { validateRig: () => true, transport: { send: async (_to, message) => { sends.push(message); return { ok: true, verified: true }; } } });
    queue.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const steps = () => project.lifecycle.profiles.release.workflow.steps as any[];
  async function progressed(key = "entry") {
    const run = await runtime.instantiateLifecycle({ missionPath: mission, operationKey: key, rootObjective: "Safely adapt", createdBySession: "owner@rig" });
    await runtime.project({ instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, actorSession: "owner@rig", exit: "handoff", closureEvidence: { evidence_ref: "plan.md" } });
    return runtime.instanceStore.getByIdOrThrow(run.instance.instanceId);
  }
  const apply = (id: string, key?: string) => {
    const v = inspectGraph(db, id);
    return { instanceId: id, expectedVersion: v.expectedVersion, expectedDigest: v.proposedDigest!, operationKey: key ?? v.operationKey!, actorSession: "owner@rig", reason: "Preserve work and revise future delivery" };
  };
  const unchanged = () => ({
    queue: db.prepare("SELECT * FROM queue_items ORDER BY qitem_id").all(),
    transitions: db.prepare("SELECT * FROM queue_transitions ORDER BY transition_id").all(),
    trails: db.prepare("SELECT * FROM workflow_step_trails ORDER BY trail_id").all(),
    frontier: db.prepare("SELECT * FROM workflow_frontier_bindings ORDER BY packet_id").all(),
    sends: [...sends],
  });

  it("distinguishes catalog-only bytes, shares cached read-only CLI/TUI comparison and preserves completed receipt", async () => {
    const run = await progressed();
    plan.sdlc.catalog.address = "installed.md"; save();
    const before = db.serialize();
    const view = inspectGraph(db, run.instanceId);
    expect(view.status, JSON.stringify(view)).toBe("source-only");
    expect(view.adopted).toBe(false);
    expect(view.composition.boundSlices).toHaveLength(1);
    expect(view.composition.executableSteps.map(s => s.id)).toEqual(["plan", "build", "finish"]);
    expect(view.composition.explanation).toContain("not automatic nested children");
    expect(inspectGraph(db, run.instanceId)).toBe(view);
    const execution = await buildExecutionView({ db, slicesRoot: () => join(root, "missions"), rigsRoot: () => join(root, "no-rigs"), buildInfo: { semver: null, commit: null, dirty: null, builtAt: null } }, { mission: "trial" }) as any;
    expect(execution.lifecycle_instances[0].reconciliation).toEqual(view);
    expect(db.serialize()).toEqual(before);
    const receipt = reviseGraph(db, bus, apply(run.instanceId));
    expect(receipt.receipt.sourceOnly).toBe(true);
    expect(runtime.inspect(run.instanceId).boundaryObligations.find(s => s.stepId === "plan")).toMatchObject({ state: "closed", receiptState: "recorded" });
    expect(inspectGraph(db, run.instanceId).status).toBe("current");
  });

  it("adopts a future dependency step with independent live child custody and never replays planning", async () => {
    const run = await progressed();
    const child = await queue.create({ sourceSession: "owner@rig", destinationSession: "worker@rig", body: "Independent child proof", nudge: false });
    await queue.claim({ qitemId: child.qitemId, destinationSession: "worker@rig", actorSession: "worker@rig" });
    await runtime.project({ instanceId: run.instanceId, currentPacketId: run.currentFrontier[0]!, actorSession: "owner@rig", exit: "waiting", blockedOn: child.qitemId });
    steps().push({ id: "inspect", actor_role: "owner", depends_on: ["build"], allowed_exits: ["handoff"], objective: "Inspect new condition" });
    steps().find(s => s.id === "finish").depends_on = ["inspect"]; save();
    const before = unchanged();
    const revision = reviseGraph(db, bus, apply(run.instanceId));
    expect(revision.replayed).toBe(false);
    expect(unchanged()).toEqual(before);
    await queue.update({ qitemId: child.qitemId, actorSession: "worker@rig", state: "done", closureReason: "no-follow-on", transitionNote: "Child delivered" });
    await runtime.project({ instanceId: run.instanceId, currentPacketId: run.currentFrontier[0]!, actorSession: "owner@rig", exit: "handoff" });
    const next = runtime.inspect(run.instanceId);
    expect(next.frontier.map(f => f.stepId)).toEqual(["inspect"]);
    expect(queue.getByIdOrThrow(next.frontier[0]!.packetId).body).toContain("Inspect new condition");
    expect(runtime.trailLog.listForInstance(run.instanceId).filter(t => t.stepId === "plan")).toHaveLength(1);
  });

  it.each(["plan", "build"])("refuses changes to %s with no write or resend, and names reconsideration", async id => {
    const run = await progressed(); steps().find(s => s.id === id).objective = "Changed decision"; save();
    const before = db.serialize();
    expect(inspectGraph(db, run.instanceId)).toMatchObject({ status: "incompatible", compatible: false });
    expect(inspectGraph(db, run.instanceId).reasons.join(" ")).toContain("explicit reconsideration");
    expect(() => reviseGraph(db, bus, apply(run.instanceId, "refused"))).toThrow("Revision refused");
    expect(db.serialize()).toEqual(before);
  });

  it("refuses lost obligations and newly eligible work rather than inventing a scheduling path", async () => {
    const run = await progressed();
    project.lifecycle.profiles.release.required_steps = ["plan"];
    steps().pop(); save();
    expect(inspectGraph(db, run.instanceId).reasons.join(" ")).toContain("Required obligation finish cannot be removed");
    steps().push({ id: "new-root", actor_role: "owner", depends_on: ["plan"], allowed_exits: ["done"] }); save();
    expect(inspectGraph(db, run.instanceId).reasons.join(" ")).toContain("no unfinished prerequisite");
  });

  it("recovers an applied HTTP operation after response loss and unreadable authored input without duplicate effects", async () => {
    const run = await progressed(); steps().find(s => s.id === "finish").objective = "New evidence"; save();
    const input = apply(run.instanceId);
    const app = new Hono(); app.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime); await next(); }); app.route("/api/workflow", workflowRoutes());
    // Discard the successful response body: the caller learns the effect only via the public operation route.
    const reply = await app.request("/api/workflow/" + run.instanceId + "/revision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(reply.status).toBe(200);
    const after = db.serialize();
    writeFileSync(join(mission, "mission.yaml"), "invalid: [");
    const recovered = await app.request("/api/workflow/operations/" + input.operationKey);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ kind: "revision", receipt: { operationKey: input.operationKey, previousDigest: run.compiledInputDigest }, instance: { instanceId: run.instanceId } });
    expect(reviseGraph(db, bus, input).replayed).toBe(true);
    expect(recoverGraphOperation(db, "entry")?.receipt.compiledInputDigest).toBe(run.compiledInputDigest);
    expect(() => reviseGraph(db, bus, { ...input, reason: "different decision" })).toThrow("different decision");
    expect(db.serialize()).toEqual(after);
  });

  it("refuses stale proposals and rolls back the whole revision if event persistence fails", async () => {
    const run = await progressed(); steps().find(s => s.id === "finish").objective = "First edit"; save();
    const input = apply(run.instanceId);
    steps().find(s => s.id === "finish").objective = "Second edit"; save();
    const before = db.serialize();
    expect(() => reviseGraph(db, bus, input)).toThrow("Authored input changed");
    expect(db.serialize()).toEqual(before);
    const current = apply(run.instanceId);
    db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON events WHEN NEW.type = 'workflow.revised' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    const beforeFailure = db.serialize();
    expect(() => reviseGraph(db, bus, current)).toThrow("synthetic write failure");
    expect(db.serialize()).toEqual(beforeFailure);
    expect(recoverGraphOperation(db, current.operationKey)).toBeNull();
  });
  it("invalidates proposed-member inspection on removal and recovers a missing source without another manifest edit", async () => {
    const run = await progressed();
    plan.composition.slices.push({ ref: "slices/02-new/slice.yaml", order: 20 }); save();
    expect(inspectGraph(db, run.instanceId).status).toBe("unavailable");
    const dir = join(mission, "slices", "02-new");
    mkdirSync(dir);
    const manifest = join(dir, "slice.yaml");
    write(manifest, { kind: "slice", metadata: { id: "new" }, composition: { mission: "../../mission.yaml" } });
    expect(inspectGraph(db, run.instanceId).status).toBe("source-only");
    rmSync(manifest);
    expect(inspectGraph(db, run.instanceId).status).toBe("unavailable");
    write(manifest, { kind: "slice", composition: { mission: "../wrong.yaml" } });
    expect(inspectGraph(db, run.instanceId).reasons.join(" ")).toContain("composition.mission");
  });

  it("keeps native operation keys unambiguous across creation, revision and another instance", async () => {
    const one = await progressed("first-entry"), two = await progressed("second-entry");
    steps().find(s => s.id === "finish").objective = "Better evidence"; save();
    const first = apply(one.instanceId, "shared-revision"), second = apply(two.instanceId, "shared-revision");
    reviseGraph(db, bus, first);
    const before = db.serialize();
    expect(() => reviseGraph(db, bus, second)).toThrow("different decision");
    await expect(runtime.instantiateLifecycle({ missionPath: mission, operationKey: "shared-revision", rootObjective: "Conflict control", createdBySession: "owner@rig" })).rejects.toMatchObject({ code: "lifecycle_operation_conflict" });
    expect(() => reviseGraph(db, bus, { ...second, operationKey: "first-entry" })).toThrow("different decision");
    expect(() => reviseGraph(db, bus, { ...second, operationKey: 4 as unknown as string })).toThrow("inspected version/digest");
    expect(db.serialize()).toEqual(before);
  });

  it("adopts only exception policy for future occurrences while preserving live child and completed judgment", async () => {
    const run = await progressed();
    const child = await queue.create({ sourceSession: "owner@rig", destinationSession: "owner@rig", body: "Unfinished child" });
    await runtime.project({ instanceId: run.instanceId, currentPacketId: run.currentFrontier[0]!, actorSession: "owner@rig", exit: "waiting", blockedOn: child.qitemId });
    expect(runtime.compileLifecycle(mission).exceptionReadiness?.selection).toMatchObject({ state: "missing", source: realpathSync(join(root, "project.yaml")) + "#lifecycle.profiles.release.workflow.exception_routing.orchestrator_role" });
    project.lifecycle.profiles.release.workflow.exception_routing = { orchestrator_role: "owner" }; save();
    expect(runtime.exceptionReadiness(run.instanceId)?.selection.state).toBe("missing");
    const view = runtime.inspectGraph(run.instanceId);
    expect(view).toMatchObject({ status: "compatible", adopted: false });
    expect(view.changes.some(c => c.kind === "exception-routing-changed")).toBe(true);
    const before = unchanged();
    const adopted = runtime.reviseGraph(apply(run.instanceId));
    expect(adopted.receipt.changes).toEqual(view.changes);
    expect(unchanged()).toEqual(before);
    expect(runtime.exceptionReadiness(run.instanceId)?.selection).toMatchObject({ state: "selected", role: "owner" });
    expect(runtime.resolveExceptionRouteFor(run.workflowName, adopted.instance.workflowVersion, "stuck_overdue", run.boundRig)?.destinationSession).toBe("owner@rig");
    project.lifecycle.profiles.release.workflow.roles.owner.preferred_targets = ["other@rig"]; save();
    expect(runtime.inspectGraph(run.instanceId).status).toBe("incompatible");
    expect(() => runtime.reviseGraph(apply(run.instanceId, "unsafe-role-edit"))).toThrow("Revision refused");
    expect(unchanged()).toEqual(before);
  });

  it("points to the mission owning selection when it explicitly overrides the project graph", () => {
    plan.lifecycle.mode = "override";
    plan.lifecycle.workflow = structuredClone(project.lifecycle.profiles.release.workflow);
    plan.lifecycle.workflow.exception_routing = { default: "human_only" };
    save();
    const compiled = runtime.compileLifecycle(mission);
    expect(compiled.exceptionReadiness?.selection.source).toBe(realpathSync(join(mission, "mission.yaml")) + "#lifecycle.workflow.exception_routing.orchestrator_role");
    expect(compiled.exceptionReadiness?.nextAction).toContain("no orchestrator selection is required");
  });

});
