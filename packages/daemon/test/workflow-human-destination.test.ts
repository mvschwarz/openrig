import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { resolveWorkflowHumanDestination } from "../src/domain/workflow-human-destination.js";
import { addHumanFragment, writeProjection, projectionPath, type HumanFragment } from "../src/domain/gateway/human-registry.js";
import { makeEnsureStuckExceptionItem } from "../src/domain/workflow-exception-escalation.js";
import { workflowRoutes } from "../src/routes/workflow.js";

// SettingsStore captures its default path at import time. Keep real setting
// resolution, but bind each caller to this test's registry/config directory.
vi.mock("../src/domain/user-settings/settings-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/domain/user-settings/settings-store.js")>();
  return { ...actual, SettingsStore: class extends actual.SettingsStore {
    constructor(configPath?: string) { super(configPath ?? join(process.env["OPENRIG_HOME"]!, "config.json")); }
  } };
});

const human = (name: string): HumanFragment => ({ entityId: name, class: "human", displayName: name,
  address: `${name}@external`, connectorBindings: [{ kind: "slack", connectorRef: "fixture", secretsRef: "fixture", role: "primary" }],
  prefs: { deliveryClass: "A" } });
const SERIAL_SPEC = `workflow:
  id: registered-human-test
  version: 1
  roles:
    worker: { preferred_targets: [worker@rig] }
  steps:
    - id: work
      actor_role: worker
      allowed_exits: [done, failed]
`;

describe.each(["serial", "dependency"])("workflow registered-human selection at the actual runtime callers (%s)", (graph) => {
  const spec = graph === "dependency" ? SERIAL_SPEC.replace("      actor_role: worker", "      actor_role: worker\n      depends_on: []") : SERIAL_SPEC;
  let dir: string;
  let db: ReturnType<typeof createDb>;
  let runtime: WorkflowRuntime;
  let queue: QueueRepository;
  let bus: EventBus;
  let specPath: string;
  let terminal: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "workflow-human-selection-"));
    vi.stubEnv("OPENRIG_HOME", dir);
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "");
    expect(writeProjection()).toMatchObject({ ok: true });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs(id,name) VALUES ('r','rig')").run();
    bus = new EventBus(db);
    terminal = vi.fn(async () => ({ success: true }));
    queue = new QueueRepository(db, bus, { validateRig: () => true, transport: { send: terminal } });
    queue.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    specPath = join(dir, "workflow.yaml");
    writeFileSync(specPath, spec);
  });
  afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  const add = (name: string) => expect(addHumanFragment(human(name))).toMatchObject({ ok: true });
  const start = () => runtime.instantiate({ specPath, rootObjective: "private fixture", createdBySession: "ops@rig" });
  const fail = (i: Awaited<ReturnType<typeof start>>) => runtime.project({ instanceId: i.instance.instanceId,
    currentPacketId: i.entryQitemId, actorSession: "worker@rig", exit: "failed" });
  const exceptions = () => db.prepare("SELECT * FROM queue_items WHERE tags LIKE '%workflow-exception%'").all() as Array<Record<string, unknown>>;

  it("failed projection and overdue detection both route to the registered gateway address, never its terminal", async () => {
    add("decision-owner");
    const first = await start();
    terminal.mockClear();
    await fail(first);
    expect(exceptions()[0]).toMatchObject({ destination_session: "decision-owner@external", tier: "human-gate" });
    expect(exceptions()[0]!.evidence_ref).toBe(`rig workflow trace ${first.instance.instanceId}`);
    expect(exceptions()[0]!.last_nudge_result).toMatch(/^gateway-owned:/);
    expect(terminal).not.toHaveBeenCalled();
    const second = await start();
    db.prepare("UPDATE queue_items SET ts_created = '2020-01-01T00:00:00Z' WHERE qitem_id = ?").run(second.entryQitemId);
    terminal.mockClear();
    const ensure = makeEnsureStuckExceptionItem({ db, queueRepo: queue,
      resolveRoute: (n, v, c, r) => runtime.resolveExceptionRouteFor(n, v, c, r) });
    const result = await ensure({ workflowName: second.instance.workflowName, workflowVersion: second.instance.workflowVersion,
      createdBySession: "ops@rig", verdict: runtime.inspect(second.instance.instanceId).frontier[0]!.deadline });
    expect(result.outcome).toBe("created");
    expect(queue.getById(result.qitemId!)?.destinationSession).toBe("decision-owner@external");
    expect(queue.getById(result.qitemId!)?.lastNudgeResult).toMatch(/^gateway-owned:/);
    expect(terminal).not.toHaveBeenCalled();
  });

  it("an explicit existing setting selects among humans and is re-read for the next episode", () => {
    add("owner-one"); add("owner-two");
    expect(() => resolveWorkflowHumanDestination()).toThrow(/explicitly select/);
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "owner-two@external");
    expect(resolveWorkflowHumanDestination()).toBe("owner-two@external");
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "owner-one@external");
    expect(resolveWorkflowHumanDestination()).toBe("owner-one@external");
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "human@host");
    expect(() => resolveWorkflowHumanDestination()).toThrow(/does not select a registered human/);
  });

  it.each(["missing", "ambiguous", "registry-unavailable"])("%s selection returns 409 and rolls back the failed close without a phantom row", async (state) => {
    if (state === "ambiguous") { add("owner-one"); add("owner-two"); }
    if (state === "registry-unavailable") { add("owner-one"); writeFileSync(projectionPath(), "not a registry"); }
    const i = await start();
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime as never); c.set("eventBus" as never, bus as never); await next(); });
    app.route("/workflow", workflowRoutes());
    const inspected = runtime.exceptionReadiness(i.instance.instanceId)!;
    expect(inspected.selection.state).toBe("missing");
    expect(inspected.routes.map(route => route.state)).toEqual([state, state]);
    const response = await app.request("/workflow/project", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: i.instance.instanceId, currentPacketId: i.entryQitemId, actorSession: "worker@rig", exit: "failed" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workflow_human_destination_unavailable", state });
    expect(runtime.instanceStore.getByIdOrThrow(i.instance.instanceId).status).toBe("active");
    expect(queue.getById(i.entryQitemId)?.state).toBe("pending");
    expect(exceptions()).toHaveLength(0);
  });

  it("a configured orchestrator route works without any registered human", async () => {
    writeFileSync(specPath, spec + "  exception_routing:\n    orchestrator_role: worker\n");
    await fail(await start());
    expect(exceptions()[0]).toMatchObject({ destination_session: "worker@rig", tier: "mode2" });
  });

  it("a storage/admission failure cannot be relabeled as a bad agent destination", async () => {
    add("owner-one");
    writeFileSync(specPath, spec + "  exception_routing:\n    orchestrator_role: worker\n");
    const i = await start();
    const spy = vi.spyOn(queue, "createWithinTransaction").mockImplementation(() => {
      throw new QueueRepositoryError("fixture_storage_failure", "storage write refused");
    });
    await expect(fail(i)).rejects.toMatchObject({ code: "fixture_storage_failure" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(exceptions()).toHaveLength(0);
  });
  it("only an unavailable agent rig falls back to the registered human during admission", async () => {
    add("owner-one");
    writeFileSync(specPath, spec + "  exception_routing: { orchestrator_role: worker }\n");
    const i = await start();
    const create = queue.createWithinTransaction.bind(queue);
    const attempted: string[] = [];
    vi.spyOn(queue, "createWithinTransaction").mockImplementation(input => {
      attempted.push(input.destinationSession);
      if (input.destinationSession === "worker@rig") throw new QueueRepositoryError("unknown_destination_rig", "controlled unavailable rig");
      return create(input);
    });
    await fail(i);
    expect(attempted).toEqual(["worker@rig", "owner-one@external"]);
    expect(exceptions()).toHaveLength(1);
    expect(exceptions()[0]).toMatchObject({ destination_session: "owner-one@external", tier: "human-gate" });
  });

  it("honors an authored human-only policy without trying the selected agent", async () => {
    add("owner-one");
    writeFileSync(specPath, spec + "  exception_routing: { default: human_only, orchestrator_role: worker }\n");
    const i = await start(); terminal.mockClear();
    await fail(i);
    expect(exceptions()).toHaveLength(1);
    expect(exceptions()[0]).toMatchObject({ destination_session: "owner-one@external", tier: "human-gate" });
    expect(terminal).not.toHaveBeenCalled();
  });
  it.each(["project", "overdue"] as const)("%s preserves capability, preferred and no-match routing while exposing read faults", async (channel) => {
    add("owner-one");
    const rigs = new RigRepository(db);
    const pod = new PodRepository(db).createPod("r", "dev", "dev");
    const node = rigs.addNode("r", "dev.orch", { role: "orch", runtime: "codex", cwd: dir,
      podId: pod.id, agentRef: "local:agents/fixture", profile: "default" });
    db.prepare("INSERT INTO sessions(id,node_id,session_name,status) VALUES('orch-session',?,'dev-orch@rig','running')").run(node.id);
    const boundSpec = spec.replace("  roles:", "  target: { rig: rig }\n  roles:\n    orch: {}")
      + "  exception_routing:\n    orchestrator_role: orch\n";
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("workflowRuntime" as never, runtime as never); c.set("eventBus" as never, bus as never); await next(); });
    app.route("/workflow", workflowRoutes());
    const ensure = makeEnsureStuckExceptionItem({ db, queueRepo: queue,
      resolveRoute: (n, v, c, r) => runtime.resolveExceptionRouteFor(n, v, c, r) });
    for (const mode of ["capability", "preferred", "no-match", "read-fault", ...(channel === "overdue" ? ["binding-read-fault"] as const : [])] as const) {
      const faultExpected = mode === "read-fault" || mode === "binding-read-fault";
      writeFileSync(specPath, boundSpec.replace("registered-human-test", `read-proof-${mode}`)
        .replace("orch: {}", mode === "preferred" ? "orch: { preferred_targets: [dev-orch@rig] }" : "orch: {}"));
      db.prepare("UPDATE sessions SET status = ? WHERE id = 'orch-session'").run(mode === "no-match" ? "exited" : "running");
      const i = await start();
      if (channel === "overdue") db.prepare("UPDATE queue_items SET ts_created = '2020-01-01T00:00:00Z' WHERE qitem_id = ?").run(i.entryQitemId);
      const snapshot = () => ({ instance: runtime.instanceStore.getByIdOrThrow(i.instance.instanceId),
        packet: queue.getById(i.entryQitemId),
        transitions: db.prepare("SELECT * FROM queue_transitions").all(),
        trails: db.prepare("SELECT * FROM workflow_step_trails").all(),
        occurrences: db.prepare("SELECT * FROM workflow_failure_occurrences").all(),
        frontier: db.prepare("SELECT * FROM workflow_frontier_bindings").all(),
        outbox: db.prepare("SELECT * FROM outbox_entries").all(),
        events: db.prepare("SELECT * FROM events").all() });
      const before = snapshot();
      const previousExceptions = exceptions().length;
      const prepare = db.prepare.bind(db);
      let faultHits = 0;
      const readFault = Object.assign(new Error("fixture capability evidence read failed"), { code: "SQLITE_IOERR" });
      const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
        if (((mode === "read-fault" || mode === "preferred") && sql === "SELECT id FROM rigs WHERE name = ? ORDER BY archived_at IS NOT NULL, created_at LIMIT 1")
          || (mode === "binding-read-fault" && sql === "SELECT bound_rig FROM workflow_instances WHERE instance_id = ?")) {
          faultHits += 1;
          throw readFault;
        }
        return prepare(sql);
      });
      try {
        if (channel === "project") {
          const response = await app.request("/workflow/project", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ instanceId: i.instance.instanceId, currentPacketId: i.entryQitemId, actorSession: "worker@rig", exit: "failed" }) });
          expect(response.status).toBe(faultExpected ? 500 : 200);
          if (faultExpected) expect(await response.json()).toMatchObject({ error: "internal_error", message: readFault.message });
        } else {
          const pending = ensure({ workflowName: i.instance.workflowName, workflowVersion: i.instance.workflowVersion,
            createdBySession: "ops@rig", verdict: runtime.inspect(i.instance.instanceId).frontier[0]!.deadline });
          if (faultExpected) await expect(pending).rejects.toBe(readFault);
          else expect((await pending).outcome).toBe("created");
        }
      } finally { spy.mockRestore(); }
      if (faultExpected) {
        expect(faultHits).toBe(1);
        expect(exceptions()).toHaveLength(previousExceptions);
        expect(snapshot()).toEqual(before);
      } else {
        expect(faultHits).toBe(0);
        expect(exceptions()).toHaveLength(previousExceptions + 1);
        expect(exceptions().at(-1)).toMatchObject(mode === "no-match"
          ? { destination_session: "owner-one@external", tier: "human-gate" }
          : { destination_session: "dev-orch@rig", tier: "mode2" });
      }
    }
  });

  it("reports the selected owner, no-match, and read faults without converting an unknown to human fallback", async () => {
    add("owner-one");
    const pod = new PodRepository(db).createPod("r", "dev", "dev");
    const node = new RigRepository(db).addNode("r", "dev.orch", { role: "orch", runtime: "codex", cwd: dir,
      podId: pod.id, agentRef: "local:agents/fixture", profile: "default" });
    db.prepare("INSERT INTO sessions(id,node_id,session_name,status) VALUES('reader-orch',?,'dev-orch@rig','running')").run(node.id);
    writeFileSync(specPath, spec.replace("  roles:", "  target: { rig: rig }\n  roles:\n    orch: {}") + "  exception_routing: { orchestrator_role: orch }\n");
    const i = await start(), id = i.instance.instanceId;
    const before = db.serialize();
    expect(runtime.exceptionReadiness(id)).toMatchObject({ posture: "advisory", selection: { state: "selected", role: "orch" },
      routes: [{ state: "ready", roleResolution: "capability-match", destinationSession: "dev-orch@rig" },
        { state: "ready", roleResolution: "capability-match", destinationSession: "dev-orch@rig" }] });
    expect(db.serialize()).toEqual(before);
    db.prepare("UPDATE sessions SET status='exited' WHERE id='reader-orch'").run();
    expect(runtime.exceptionReadiness(id)?.routes[0]).toMatchObject({ state: "ready", roleResolution: "no-match", position: "fallback", destinationSession: "owner-one@external" });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      if (sql === "SELECT id FROM rigs WHERE name = ? ORDER BY archived_at IS NOT NULL, created_at LIMIT 1") throw new Error("fixture inventory unavailable");
      return prepare(sql);
    });
    expect(runtime.exceptionReadiness(id)?.routes[0]).toMatchObject({ state: "unavailable", roleResolution: "unavailable", destinationSession: null, message: "fixture inventory unavailable" });
  });

  it("distinguishes an intentional human policy from an unselected ordinary owner and checks authored target identity", async () => {
    add("owner-one");
    const missing = await start();
    const r = runtime.exceptionReadiness(missing.instance.instanceId)!;
    expect(r.selection).toMatchObject({ state: "missing", role: null, source: specPath + "#workflow.exception_routing.orchestrator_role" });
    expect(r.nextAction).toContain("A defined entry/ordinary role does not select exception ownership");
    expect(r.routes[0]).toMatchObject({ position: "fallback", roleResolution: "missing-selection", destinationSession: "owner-one@external" });
    writeFileSync(specPath, spec.replace("version: 1", "version: 2") + "  exception_routing: { default: human_only }\n");
    const direct = await start();
    expect(runtime.exceptionReadiness(direct.instance.instanceId)?.nextAction).toContain("no orchestrator selection is required");
    writeFileSync(specPath, spec.replace("version: 1", "version: 3") + "  exception_routing: { orchestrator_role: worker }\n");
    const preferred = await start();
    expect(runtime.exceptionReadiness(preferred.instance.instanceId)?.routes[0]).toMatchObject({ state: "unregistered", roleResolution: "preferred-target", destinationSession: "worker@rig" });
  });

});
