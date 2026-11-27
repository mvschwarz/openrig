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
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { inspectGraph, reviseGraph, recoverGraphOperation } from "../src/domain/workflow-reconciliation.js";
import { buildExecutionView } from "../src/domain/execution-view.js";
import { workflowRoutes } from "../src/routes/workflow.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
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
    // Compare the complete SQLite bytes natively; deep equality walks every Buffer element on slow runners.
    expect(db.serialize().equals(before)).toBe(true);
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
    expect(new WorkflowInstanceStore(db).getByIdOrThrow(run.instanceId).startedSpec?.spec.steps.map(s => s.id)).not.toContain("inspect");
    const revision = reviseGraph(db, bus, apply(run.instanceId));
    expect(revision.replayed).toBe(false);
    // The run now runs its revised version from the cache, so it no longer keeps the spec it started with (#2607).
    expect(new WorkflowInstanceStore(db).getByIdOrThrow(run.instanceId).startedSpec).toBeNull();
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
    expect(db.serialize().equals(before)).toBe(true);
  });

  it("refuses a lost obligation, even beside newly ready work it would otherwise project", async () => {
    const run = await progressed();
    project.lifecycle.profiles.release.required_steps = ["plan"];
    steps().pop(); save();
    expect(inspectGraph(db, run.instanceId).reasons.join(" ")).toContain("Required obligation finish cannot be removed");
    steps().push({ id: "new-root", actor_role: "owner", depends_on: ["plan"], allowed_exits: ["done"] }); save();
    expect(inspectGraph(db, run.instanceId)).toMatchObject({ status: "incompatible", projects: ["new-root"] });
  });

  // The release shape: publish and a required adoption both follow plan; the record waits on both, and close on the record.
  const release = (extra: any[] = [], roles: Record<string, unknown> = {}) => {
    const profile = project.lifecycle.profiles.release;
    profile.required_steps = ["plan", "publish", "adoption", "record", "close"];
    profile.workflow.roles = { ...profile.workflow.roles, ...roles };
    profile.workflow.steps = [
      { id: "plan", actor_role: "owner", depends_on: [], allowed_exits: ["handoff"], objective: "Choose" },
      { id: "publish", actor_role: "owner", depends_on: ["plan"], allowed_exits: ["handoff", "failed"], objective: "Publish" },
      { id: "adoption", actor_role: "owner", depends_on: ["plan"], allowed_exits: ["handoff", "waiting"], objective: "Adopt" },
      { id: "record", actor_role: "owner", depends_on: ["publish", "adoption"], allowed_exits: ["handoff", "failed"], objective: "Record" },
      { id: "close", actor_role: "owner", depends_on: ["record"], allowed_exits: ["done"], objective: "Close" },
      ...extra,
    ];
    save();
  };
  const step = (id: string) => steps().find(s => s.id === id);
  const frontier = (id: string) => runtime.inspect(id).frontier.map(f => f.stepId).sort();
  const packet = (id: string, stepId: string) => runtime.inspect(id).frontier.find(f => f.stepId === stepId)!.packetId;
  const close = (id: string, stepId: string, exit: "handoff" | "done" | "failed" = "handoff", by = runtime) =>
    by.project({ instanceId: id, currentPacketId: packet(id, stepId), actorSession: "owner@rig", exit, closureEvidence: { evidence_ref: stepId + ".md" }, ...(exit === "failed" ? { resultNote: "broke" } : {}) });
  async function planned(key = "release") {
    const run = await runtime.instantiateLifecycle({ missionPath: mission, operationKey: key, rootObjective: "Release", createdBySession: "owner@rig" });
    await runtime.project({ instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, actorSession: "owner@rig", exit: "handoff", closureEvidence: { evidence_ref: "plan.md" } });
    return run.instance.instanceId;
  }
  async function published(key = "release") {
    const id = await planned(key);
    await close(id, "publish");
    return id;
  }

  it("removes an obsolete order from unstarted work, keeps the live adoption, and projects the ready record once", async () => {
    release();
    const id = await published();
    expect(frontier(id)).toEqual(["adoption"]);
    const adoption = packet(id, "adoption"), adoptionRow = queue.getByIdOrThrow(adoption);
    step("record").depends_on = ["publish"]; save();
    const view = inspectGraph(db, id);
    expect(view).toMatchObject({ status: "compatible", compatible: true, reasons: [], projects: ["record"] });
    expect(view.changes).toEqual(expect.arrayContaining([
      { kind: "dependency-removed", ref: "adoption before record" },
      { kind: "required-order-removed", ref: "adoption before record" },
      { kind: "required-order-removed", ref: "adoption before close" },
      { kind: "step-projected", ref: "record" },
    ]));
    const sent = sends.length, input = apply(id);
    const revision = await runtime.reviseGraph(input);
    expect(revision.replayed).toBe(false);
    const record = revision.projected[0]!.qitemId;
    expect(revision.projected.map(p => p.step.id)).toEqual(["record"]);
    expect(revision.receipt.projected).toEqual([{ stepId: "record", qitemId: record, owner: "owner@rig" }]);
    expect(recoverGraphOperation(db, input.operationKey)?.receipt.projected).toEqual(revision.receipt.projected);
    const instance = runtime.instanceStore.getByIdOrThrow(id);
    expect(instance).toMatchObject({ status: "active", currentFrontier: [adoption, record] });
    expect(runtime.instanceStore.listFrontierBindings(id).find(b => b.packetId === record)).toMatchObject({ stepId: "record", hopCount: 0, hopsBaseline: 0 });
    expect(queue.getByIdOrThrow(adoption)).toEqual(adoptionRow);
    const row = queue.getByIdOrThrow(record);
    expect(row).toMatchObject({ destinationSession: "owner@rig", state: "pending" });
    expect(row.tags).toContain("step:record");
    expect(row.body).toContain("Projected by revision " + input.operationKey);
    expect(row.body).toContain("Decision: " + input.reason);
    expect(sends.length).toBeGreaterThan(sent);
    // The same decision again, as after a lost response: no packet and no wake.
    const after = db.serialize(), woke = sends.length;
    expect(await runtime.reviseGraph(input)).toMatchObject({ replayed: true, projected: [] });
    expect(db.serialize().equals(after)).toBe(true);
    expect(sends.length).toBe(woke);
    expect(inspectGraph(db, id).status).toBe("current");
    // Ordinary projection carries on from the revised graph; the adoption closes on its own.
    await close(id, "record");
    expect(frontier(id)).toEqual(["adoption", "close"]);
    await close(id, "adoption");
    expect(frontier(id)).toEqual(["close"]);
  });

  it.each([
    ["an unrelated change", () => { step("close").objective = "Close carefully"; }, "compatible"],
    ["a source-only change", () => { plan.sdlc.catalog.address = "second.md"; }, "source-only"],
  ] as const)("leaves a step that was already ready and never started alone on %s: nothing projected, and the revision applies", async (_label, mutate, status) => {
    release();
    const id = await published();
    // An adoption completion the projector never acted on: record is ready under the bound graph and was never started.
    // (A second dependency-free root is the natural case, but an eligible lifecycle can't hold one: the validator
    // refuses a step unreachable from the entry.)
    runtime.trailLog.record({ instanceId: id, stepId: "adoption", stepRole: "owner", closedAt: new Date().toISOString(), closureReason: "handoff", closureEvidence: {}, actorSession: "owner@rig", nextQitemId: null, priorQitemId: null } as never);
    mutate(); save();
    expect(inspectGraph(db, id)).toMatchObject({ status, compatible: true, projects: [] });
    const sent = sends.length;
    expect((await runtime.reviseGraph(apply(id))).projected).toEqual([]);
    expect(inspectGraph(db, id).status).toBe("current");
    expect(frontier(id)).toEqual(["adoption"]);
    expect(queue.list({ tag: "step:record" } as never)).toHaveLength(0);
    expect(sends.length).toBe(sent);
  });

  it("carries the revised slice associations: the step it projects, and later ones, get their newly active slice's tag", async () => {
    release();
    const id = await published();
    expect(runtime.instanceStore.getByIdOrThrow(id).scope?.stepSlices?.record).toBeUndefined();
    mkdirSync(join(mission, "slices", "record"), { recursive: true });
    write(join(mission, "slices", "record", "slice.yaml"), { kind: "slice", metadata: { id: "record" }, composition: { mission: "../../mission.yaml" } });
    plan.composition.slices.push({ ref: "slices/record/slice.yaml", order: 20 });
    step("record").depends_on = ["publish"]; save();
    const revision = await runtime.reviseGraph(apply(id));
    const scope = runtime.instanceStore.getByIdOrThrow(id).scope;
    expect(scope).toMatchObject({ project: "trial", mission: "trial", stepSlices: { record: "record" } });
    expect(queue.getByIdOrThrow(revision.projected[0]!.qitemId).tags).toContain("slice:record");
  });

  it("projects nothing early while a remaining prerequisite is unfinished; the ordinary close projects it", async () => {
    release();
    const id = await planned();
    step("record").depends_on = ["publish"]; save();
    expect(inspectGraph(db, id)).toMatchObject({ status: "compatible", projects: [] });
    expect((await runtime.reviseGraph(apply(id))).projected).toEqual([]);
    expect(frontier(id)).toEqual(["adoption", "publish"]);
    await close(id, "publish");
    expect(frontier(id)).toEqual(["adoption", "record"]);
  });

  it.each(["live", "completed", "failed"] as const)("refuses to remove a required order from a %s step, with no write", async state => {
    release();
    const id = await published();
    await close(id, "adoption");
    if (state === "completed") await close(id, "record");
    // A failed step's exception goes to the configured person.
    if (state === "failed") await close(id, "record", "failed", new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" } }));
    step("record").depends_on = ["publish"]; save();
    const view = inspectGraph(db, id);
    expect(view.status).toBe("incompatible");
    expect(view.reasons).toContain("Required order adoption before record cannot be removed: record already has completed, live or failed work.");
    const before = db.serialize();
    await expect(runtime.reviseGraph(apply(id, "refused"))).rejects.toThrow("Revision refused");
    expect(db.serialize().equals(before)).toBe(true);
  });

  it.each([
    ["a changed completed step", () => { step("plan").objective = "Changed decision"; }, "explicit reconsideration"],
    ["a removed required obligation", () => { project.lifecycle.profiles.release.required_steps = ["plan", "publish", "adoption", "record"]; }, "Required obligation close cannot be removed"],
  ] as const)("refuses the whole revision when the order removal comes with %s", async (_label, mutate, reason) => {
    release();
    const id = await published();
    step("record").depends_on = ["publish"]; mutate(); save();
    const view = inspectGraph(db, id);
    expect(view).toMatchObject({ status: "incompatible", projects: ["record"] });
    expect(view.reasons.join(" ")).toContain(reason);
    const before = db.serialize(), sent = sends.length;
    await expect(runtime.reviseGraph(apply(id, "mixed"))).rejects.toThrow("Revision refused");
    expect(db.serialize().equals(before)).toBe(true);
    expect(sends.length).toBe(sent);
  });

  it("refuses a stale version or digest with no packet, and the ordinary path projects the record exactly once", async () => {
    release();
    const id = await published();
    step("record").depends_on = ["publish"]; save();
    const stale = apply(id);
    step("record").objective = "Record differently"; save();
    let before = db.serialize();
    await expect(runtime.reviseGraph(stale)).rejects.toThrow("Authored input changed");
    expect(db.serialize().equals(before)).toBe(true);
    const current = apply(id);
    await close(id, "adoption");
    expect(frontier(id)).toEqual(["record"]);
    before = db.serialize();
    await expect(runtime.reviseGraph(current)).rejects.toThrow("progressed since inspection");
    expect(db.serialize().equals(before)).toBe(true);
    expect(queue.list({ tag: "step:record" } as never).length).toBe(1);
  });

  it("recovers a projecting revision by its key after a lost HTTP response, without another packet or wake", async () => {
    release();
    const id = await published();
    step("record").depends_on = ["publish"]; save();
    const input = apply(id);
    const app = new Hono(); app.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime); await next(); }); app.route("/api/workflow", workflowRoutes());
    expect((await app.request("/api/workflow/" + id + "/revision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status).toBe(200);
    const after = db.serialize(), sent = sends.length;
    const recovered = await (await app.request("/api/workflow/operations/" + input.operationKey)).json() as any;
    expect(recovered.receipt.projected).toEqual([{ stepId: "record", qitemId: packet(id, "record"), owner: "owner@rig" }]);
    const replay = await app.request("/api/workflow/" + id + "/revision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(await replay.json()).toMatchObject({ replayed: true, projected: [] });
    expect(db.serialize().equals(after)).toBe(true);
    expect(sends.length).toBe(sent);
  });

  it("counts a prerequisite's completion only if it's newer than its own prerequisite's latest, as the projector does", async () => {
    release();
    const id = await published();
    // plan completes again after publish did, so publish's completion no longer counts and record isn't ready.
    runtime.trailLog.record({ instanceId: id, stepId: "plan", stepRole: "owner", closedAt: new Date().toISOString(), closureReason: "handoff", closureEvidence: {}, actorSession: "owner@rig", nextQitemId: null, priorQitemId: null } as never);
    step("record").depends_on = ["publish"]; save();
    expect(inspectGraph(db, id)).toMatchObject({ status: "compatible", projects: [] });
  });

  it("rolls back the revision, packet, frontier, keepalive and wake when the write fails after a packet is created", async () => {
    release();
    const id = await published();
    step("record").depends_on = ["publish"]; save();
    const guarded = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, watchdogJobsRepo: new WatchdogJobsRepository(db) });
    const input = apply(id);
    db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON events WHEN NEW.type = 'workflow.next_qitem_projected' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    const before = db.serialize(), sent = sends.length;
    await expect(guarded.reviseGraph(input)).rejects.toThrow("synthetic write failure");
    expect(db.serialize().equals(before)).toBe(true);
    expect(sends.length).toBe(sent);
    expect(recoverGraphOperation(db, input.operationKey)).toBeNull();
    db.exec("DROP TRIGGER fail_projection");
    const jobs = () => (db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs").get() as { n: number }).n;
    const armed = jobs();
    expect((await guarded.reviseGraph(input)).projected).toHaveLength(1);
    expect(jobs()).toBe(armed + 1);
  });

  it("refuses the whole revision when a projected step's owner can't be resolved", async () => {
    release([], { ghost: {} });
    const id = await published();
    Object.assign(step("record"), { depends_on: ["publish"], actor_role: "ghost" }); save();
    expect(inspectGraph(db, id)).toMatchObject({ status: "compatible", projects: ["record"] });
    const before = db.serialize(), sent = sends.length;
    await expect(runtime.reviseGraph(apply(id))).rejects.toThrow("cannot resolve next owner");
    expect(db.serialize().equals(before)).toBe(true);
    expect(sends.length).toBe(sent);
  });

  it("projects several ready steps with their own owner, gate, body and frontier", async () => {
    release([{ id: "notes", actor_role: "reviewer", depends_on: ["publish", "adoption"], allowed_exits: ["handoff"], objective: "Write notes",
      gate: { target: "human@host", summary: "Sign the notes", evidence_ref: "proof/notes.md" } }], { reviewer: { preferred_targets: ["reviewer@rig"] } });
    const id = await published();
    const adoption = packet(id, "adoption");
    step("record").depends_on = ["publish"]; step("notes").depends_on = ["publish"]; save();
    expect(inspectGraph(db, id).projects).toEqual(["record", "notes"]);
    const revision = await runtime.reviseGraph(apply(id));
    const [record, notes] = revision.projected;
    expect(revision.projected.map(p => p.step.id)).toEqual(["record", "notes"]);
    expect(queue.getByIdOrThrow(record!.qitemId)).toMatchObject({ destinationSession: "owner@rig", state: "pending" });
    const gated = queue.getByIdOrThrow(notes!.qitemId);
    expect(gated).toMatchObject({ state: "blocked", summary: "Sign the notes", evidenceRef: "proof/notes.md" });
    expect(gated.tags).toEqual(expect.arrayContaining(["gate", "step:notes"]));
    expect(gated.body).toContain("Projected by revision");
    const instance = runtime.instanceStore.getByIdOrThrow(id);
    expect(instance).toMatchObject({ status: "active", currentFrontier: [adoption, record!.qitemId, notes!.qitemId], currentStepId: null });
    expect(runtime.instanceStore.listFrontierBindings(id).map(b => b.stepId).sort()).toEqual(["adoption", "notes", "record"]);
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
    expect(db.serialize().equals(after)).toBe(true);
  });

  it("refuses stale proposals and rolls back the whole revision if event persistence fails", async () => {
    const run = await progressed(); steps().find(s => s.id === "finish").objective = "First edit"; save();
    const input = apply(run.instanceId);
    steps().find(s => s.id === "finish").objective = "Second edit"; save();
    const before = db.serialize();
    expect(() => reviseGraph(db, bus, input)).toThrow("Authored input changed");
    expect(db.serialize().equals(before)).toBe(true);
    const current = apply(run.instanceId);
    db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON events WHEN NEW.type = 'workflow.revised' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    const beforeFailure = db.serialize();
    expect(() => reviseGraph(db, bus, current)).toThrow("synthetic write failure");
    expect(db.serialize().equals(beforeFailure)).toBe(true);
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
    expect(db.serialize().equals(before)).toBe(true);
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
    const adopted = await runtime.reviseGraph(apply(run.instanceId));
    expect(adopted.receipt.changes).toEqual(view.changes);
    expect(unchanged()).toEqual(before);
    expect(runtime.exceptionReadiness(run.instanceId)?.selection).toMatchObject({ state: "selected", role: "owner" });
    expect(runtime.resolveExceptionRouteFor(run.workflowName, adopted.instance.workflowVersion, "stuck_overdue", run.boundRig)?.destinationSession).toBe("owner@rig");
    project.lifecycle.profiles.release.workflow.roles.owner.preferred_targets = ["other@rig"]; save();
    expect(runtime.inspectGraph(run.instanceId).status).toBe("incompatible");
    await expect(runtime.reviseGraph(apply(run.instanceId, "unsafe-role-edit"))).rejects.toThrow("Revision refused");
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
