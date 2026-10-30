import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentLifecycle } from "../src/domain/environment-lifecycle.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { EnvironmentPlatform, sha256 } from "../src/domain/environment-platform.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(attached = false, automatic = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "environment-lifecycle-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const resource = { id: "compute-one", name: "worker-one", workspace: "workspace", phase: "Ready", operationId: "create-one" };
  let present = attached, running = true, unavailable = false, loseStop = false, stopCalls = 0, deleteCalls = 0, creates = 0;
  let dependents = { workload: false, supervisor: false, volumes: false };
  const files = new Map<string, Buffer>();
  const native = { nativeId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", nativeType: "community:openshell-claude", generation: "generation-one" };
  const history = Buffer.from(JSON.stringify({ sessionId: native.nativeId, type: "user", message: { content: "retained context" } }) + "\n");
  files.set(`/sandbox/openrig/native/projects/-sandbox-openrig-work/${native.nativeId}.jsonl`, history);
  const driver = { version: 1 as const,
    list: async () => { if (unavailable) throw new Error("provider unavailable"); return { complete: true, resources: present ? [{ ...resource }] : [] }; },
    create: async (input: { operationId: string }) => { creates++; present = true; resource.operationId = input.operationId; return { ...resource }; },
    inspect: async () => { if (unavailable || !present) throw new Error("lookup unavailable"); return { ...resource }; },
    upload: async (_b: unknown, source: string, destination: string) => { files.set(destination, readFileSync(source)); },
    read: async (_b: unknown, destination: string) => { const data = files.get(destination); if (!data) throw new Error("missing"); return data; },
    download: async (_b: unknown, source: string, destination: string) => { writeFileSync(destination, files.get(source)!); },
    nativeIdentity: async () => ({ ...native, running }),
    stopNative: async () => { stopCalls++; running = false; if (loseStop) throw new Error("reply lost"); },
    stopCompute: async () => { stopCalls++; running = false; resource.phase = "Stopped"; if (loseStop) throw new Error("reply lost"); },
    deleteEnvironment: async () => { deleteCalls++; present = false; },
    cleanupState: async () => ({ ...dependents }),
    checkpointFiles: async () => [{ path: `native/projects/-sandbox-openrig-work/${native.nativeId}.jsonl`, bytes: history.length, sha256: (await import("../src/domain/environment-platform.js")).sha256(history) }],
  };
  const queueEvents = new EventBus(db), queue = new QueueRepository(db, queueEvents); queue.attachOutbox(new OutboxHandler(db));
  const f = createTestApp(db, { appDeps: { eventBus: automatic ? queueEvents : new EventBus(db), queueRepo: queue, environmentDriver: driver, environmentArtifactRoot: join(root, "artifacts"), environmentStateRoot: join(root, "retained") } as never });
  const rig = f.rigRepo.createRig("lifecycle"), node = f.rigRepo.addNode(rig.id, "worker", { runtime: "openshell-claude", cwd: root });
  const request = async (path: string, body?: unknown) => { const res = await f.app.request(`/api/environments${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-openrig-session": "coordinator@lifecycle" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: res.status, body: await res.json() as Record<string, any> }; };
  const policy = join(root, "policy.yaml"); writeFileSync(policy, "version: 1\n");
  const input = { version: 1, bindingId: "binding-one", operationId: "create-one", nodeId: node.id, seat: "worker@lifecycle", baseRuntime: "claude-code", guestRoot: "/sandbox/openrig", guestBaseUrl: "http://guest.test:7433", placement: { gateway: "gateway", workspace: "workspace", name: "worker-one", image: `image@sha256:${"a".repeat(64)}`, provider: "provider", policy } };
  const created = await request(attached ? "/attach" : "/create", { ...input, ...(attached ? { resourceId: resource.id } : {}) }); expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  db.prepare("UPDATE environment_bindings SET generation='generation-one' WHERE binding_id='binding-one'").run();
  const receipt = { version: 1, bindingId: "binding-one", nodeId: node.id, resourceId: resource.id, ...native, activityGrantId: "grant-one" };
  db.prepare("INSERT INTO environment_operations(operation_id,binding_id,kind,request_json,state,receipt_json) VALUES ('launch-generation-one','binding-one','launch',?,'confirmed',?)").run(JSON.stringify(receipt), JSON.stringify(receipt));
  const effect = (name: string, operationId = "effect-one") => request("/binding-one/effect", { operationId, generation: "generation-one", effect: name });
  const lifecycle = new EnvironmentLifecycle(new EnvironmentPlatform(db, driver), queue, join(root, "retained"));
  return { root, db, driver, queue, lifecycle, request, effect, resource, native, files, history, capture: () => f.snapshotCapture.captureSnapshot(rig.id, "manual"), disappear: () => { present = false; }, counts: () => ({ stopCalls, deleteCalls, creates }), loseStop: () => { loseStop = true; }, unavailable: () => { unavailable = true; }, dirtyCleanup: () => { dependents.volumes = true; } };
}
describe("owned and attached environment effects", () => {
  it("stops only the selected native and reconciles a lost acknowledgement without a second signal", async () => {
    const f = await fixture(); f.loseStop();
    const first = await f.effect("stop-native"); expect(first.body.state).toBe("confirmed");
    expect(first.body.effect).toBe("stop-native");
    const replay = await f.effect("stop-native"); expect(replay.body).toEqual(first.body); expect(f.counts().stopCalls).toBe(1);
    expect(f.resource.phase).toBe("Ready"); expect(f.counts().deleteCalls).toBe(0);
  });
  it("observes stopped compute independently from native and viewer state", async () => {
    const f = await fixture(); const result = await f.effect("stop-compute");
    expect(result.body).toMatchObject({ state: "confirmed", effect: "stop-compute", resourceId: "compute-one" });
    expect(f.resource.phase).toBe("Stopped"); expect(f.counts().deleteCalls).toBe(0);
  });
  it.each(["stop-native", "stop-compute", "delete-owned"])("preserves attached resources for %s", async effect => {
    const f = await fixture(true), result = await f.effect(effect);
    expect(result.status).toBe(409); expect(result.body.code).toBe("environment_attached_preserved");
    expect(f.counts()).toMatchObject({ stopCalls: 0, deleteCalls: 0, creates: 0 });
  });
  it("does not call provider absence complete until workload, supervisor and volumes are all observed absent", async () => {
    const f = await fixture(); f.dirtyCleanup();
    const result = await f.effect("delete-owned"); expect(result.body.state).toBe("unconfirmed");
    expect(result.body.remaining.volumes).toBe(true); expect(f.counts().deleteCalls).toBe(1);
    await f.effect("delete-owned"); expect(f.counts().deleteCalls).toBe(1);
  });
  it("keeps the original operation pending when a lookup fails and never infers absence", async () => {
    const f = await fixture(); f.unavailable();
    const result = await f.effect("delete-owned"); expect(result.body.state).toBe("unconfirmed");
    expect(f.counts().deleteCalls).toBe(0);
  });
  it("refuses the wrong generation before any provider mutation", async () => {
    const f = await fixture(), result = await f.request("/binding-one/effect", { operationId: "stale", generation: "older", effect: "stop-compute" });
    expect(result.status).toBe(409); expect(f.counts().stopCalls).toBe(0);
  });
});
describe("exact contained checkpoint and restore", () => {
  it("retains verified private history bytes and nonsecret exact native/compute references", async () => {
    const f = await fixture(), result = await f.request("/binding-one/checkpoint", { operationId: "checkpoint-one", generation: "generation-one" });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ version: 1, bindingId: "binding-one", nativeId: f.native.nativeId, nativeType: "community:openshell-claude", predecessorResourceId: "compute-one" });
    expect(result.body.files).toHaveLength(1); expect(readFileSync(result.body.files[0].source)).toEqual(f.history);
    expect(JSON.stringify(result.body)).not.toContain("retained context");
  });
  it("carries nonsecret environment/native/checkpoint references in the ordinary snapshot", async () => {
    const f = await fixture(); await f.request("/binding-one/checkpoint", { operationId: "checkpoint-one", generation: "generation-one" });
    const snapshot = f.capture(), references = Object.values(snapshot.data.environmentBindingsByNode ?? {});
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ bindingId: "binding-one", resourceId: "compute-one", checkpointId: "checkpoint-one", nativeId: f.native.nativeId, nativeType: f.native.nativeType, nativeState: "/sandbox/openrig/native" });
    expect(JSON.stringify(snapshot.data.environmentBindingsByNode)).not.toContain("retained context");
  });
  it("rejects missing checkpoint state before creating successor compute", async () => {
    const f = await fixture(), result = await f.request("/binding-one/recreate", { operationId: "recreate-one", generation: "generation-two", checkpointId: "missing", resumeType: "community:openshell-claude", resumeToken: f.native.nativeId, placement: { ...f.resource, name: "worker-two" } });
    expect(result.status).toBe(409); expect(f.counts().creates).toBe(1);
  });
  it("recreates only after verified predecessor absence and carries the exact retained native id", async () => {
    const f = await fixture(), checkpoint = await f.request("/binding-one/checkpoint", { operationId: "checkpoint-one", generation: "generation-one" });
    expect(checkpoint.status).toBe(200); f.disappear();
    const policy = join(f.root, "policy.yaml");
    // The provider fixture returns a different immutable ID on explicit successor creation.
    f.resource.id = "compute-two"; f.resource.name = "worker-two";
    const result = await f.request("/binding-one/recreate", { operationId: "recreate-one", generation: "generation-one", checkpointId: "checkpoint-one", resumeType: "community:openshell-claude", resumeToken: f.native.nativeId,
      placement: { gateway: "gateway", workspace: "workspace", name: "worker-two", image: `image@sha256:${"a".repeat(64)}`, provider: "new-provider", policy } });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ state: "confirmed", predecessorResourceId: "compute-one", successorResourceId: "compute-two", nativeId: f.native.nativeId });
  });
  it("refuses changed private history before any successor create", async () => {
    const f = await fixture(), checkpoint = await f.request("/binding-one/checkpoint", { operationId: "checkpoint-one", generation: "generation-one" });
    expect(checkpoint.status).toBe(200); writeFileSync(checkpoint.body.files[0].source, "changed history"); f.disappear();
    const result = await f.request("/binding-one/recreate", { operationId: "recreate-one", generation: "generation-one", checkpointId: "checkpoint-one", resumeType: "community:openshell-claude", resumeToken: f.native.nativeId, placement: {} });
    expect(result.status).toBe(409); expect(f.counts().creates).toBe(1);
  });
  it("refuses another native type without starting a fresh conversation", async () => {
    const f = await fixture(), result = await f.request("/binding-one/recreate", { operationId: "recreate-one", generation: "generation-two", checkpointId: "missing", resumeType: "codex_id", resumeToken: "foreign" });
    expect(result.status).toBe(409); expect(f.counts().creates).toBe(1);
  });
});

describe("finite completion is selected work plus a verified actual export", () => {
  async function selected(automatic = true) {
    const f = await fixture(false, automatic);
    await f.queue.create({ qitemId: "task-one", sourceSession: "coordinator@lifecycle", destinationSession: "worker@lifecycle", body: "Produce the report", nudge: false });
    f.lifecycle.selectCompletion("binding-one", { operationId: "completion-one", generation: "generation-one", taskId: "task-one", exportOperationId: "export-one", effect: "stop-native" });
    const publish = () => {
      const path = join(f.root, "verified-report.json"), bytes = Buffer.from("actual report bytes"); writeFileSync(path, bytes);
      const receipt = { bindingId: "binding-one", generation: "generation-one", taskId: "task-one", path, bytes: bytes.length, sha256: sha256(bytes) };
      f.db.prepare("INSERT INTO environment_operations(operation_id,binding_id,kind,request_json,state,receipt_json) VALUES ('export-one','binding-one','export','{}','confirmed',?)").run(JSON.stringify(receipt));
      return path;
    };
    const done = () => f.queue.update({ qitemId: "task-one", actorSession: "worker@lifecycle", state: "done", closureReason: "no-follow-on", transitionNote: "Verified result complete" });
    return { ...f, publish, done };
  }
  it("does not stop on an empty/unsettled queue or a pending export", async () => {
    const f = await selected(); await f.lifecycle.checkCompletions(); expect(f.counts().stopCalls).toBe(0);
    f.done(); await f.lifecycle.checkCompletions(); expect(f.counts().stopCalls).toBe(0);
    f.publish(); await f.lifecycle.checkCompletions(); expect(f.counts().stopCalls).toBe(1);
    await f.lifecycle.checkCompletions(); expect(f.counts().stopCalls).toBe(1);
  });
  it("the actual queue event schedules selected completion without another manual check", async () => {
    const f = await selected(); f.publish(); f.done();
    for (let turn = 0; turn < 20 && !f.counts().stopCalls; turn++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.counts().stopCalls).toBe(1);
  });
  it("another seat's same-state note does not undo a settled selected task", async () => {
    const f = await selected(); f.done();
    f.queue.update({ qitemId: "task-one", actorSession: "observer@lifecycle", transitionNote: "Result noted" });
    f.publish(); await f.lifecycle.checkCompletions(); expect(f.counts().stopCalls).toBe(1);
  });
  it("keeps failed work and another task's export from triggering completion", async () => {
    const f = await selected(); f.publish();
    f.queue.update({ qitemId: "task-one", actorSession: "worker@lifecycle", state: "failed", transitionNote: "Task failed" });
    await f.lifecycle.checkCompletions(); expect(f.counts().stopCalls).toBe(0);
  });
  it("preserves execution when the returned artifact changed after its receipt", async () => {
    const f = await selected(), path = f.publish(); f.done(); writeFileSync(path, "changed host artifact");
    await f.lifecycle.checkCompletions(); expect(f.counts().stopCalls).toBe(0);
  });
  it("does not stop a successor generation for an old task's successful close", async () => {
    const f = await selected(); f.publish(); f.done();
    f.db.prepare("UPDATE environment_bindings SET generation='generation-two' WHERE binding_id='binding-one'").run();
    await f.lifecycle.checkCompletions(); expect(f.counts().stopCalls).toBe(0);
  });
  it.each(["stop-native", "stop-compute"] as const)("rechecks selected completion %s after awaited provider observation", async effect => {
    for (const change of ["task", "artifact", "generation"] as const) {
      const f = await selected(false), artifact = f.publish();
      f.db.prepare("UPDATE environment_operations SET request_json=json_set(request_json,'$.effect',?) WHERE operation_id='completion-one'").run(effect);
      f.done();
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const inspect = f.driver.inspect;
      f.driver.inspect = async () => { enter(); await gate; return inspect(); };
      const attempt = f.lifecycle.checkCompletions(); await entered;
      if (change === "task") f.queue.update({ qitemId: "task-one", actorSession: "worker@lifecycle", state: "in-progress", reopen: true, transitionNote: "Reopen selected work" });
      if (change === "artifact") writeFileSync(artifact, "changed while observing provider");
      if (change === "generation") f.db.prepare("UPDATE environment_bindings SET generation='generation-two' WHERE binding_id='binding-one'").run();
      release(); await attempt; expect(f.counts().stopCalls, change).toBe(0);
      const op = f.db.prepare("SELECT state FROM environment_operations WHERE operation_id LIKE 'completion-stop-%'").get() as { state: string } | undefined;
      expect(op?.state, change).not.toBe("requested");
    }
  });
  it("bounds pending completion observations and retains an inspectable last attempt", async () => {
    const f = await selected(false); f.publish(); f.done();
    let clock = Date.now(); const now = vi.spyOn(Date, "now").mockImplementation(() => clock); cleanup.push(() => now.mockRestore());
    let inspections = 0, signals = 0;
    const inspect = f.driver.inspect;
    f.driver.inspect = async () => { inspections++; return inspect(); };
    f.driver.stopNative = async () => { signals++; }; // Native remains present after its one TERM.
    await f.lifecycle.checkCompletions(); const first = inspections;
    for (let event = 0; event < 5; event++) await f.lifecycle.checkCompletions();
    expect(inspections).toBe(first); expect(signals).toBe(1);
    const op = f.db.prepare("SELECT state,receipt_json FROM environment_operations WHERE operation_id='completion-one'").get() as { state: string; receipt_json: string };
    expect(op.state).toBe("requested"); expect(JSON.parse(op.receipt_json)).toMatchObject({ state: "pending", lastAttemptAt: clock });
    clock += 60_001; await f.lifecycle.checkCompletions(); expect(inspections).toBeGreaterThan(first); expect(signals).toBe(1);
  });

});
