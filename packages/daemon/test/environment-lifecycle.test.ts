import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(attached = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "environment-lifecycle-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const resource = { id: "compute-one", name: "worker-one", workspace: "workspace", phase: "Ready", operationId: "create-one" };
  let present = true, running = true, unavailable = false, loseStop = false, stopCalls = 0, deleteCalls = 0, creates = 0;
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
  const f = createTestApp(db, { appDeps: { environmentDriver: driver, environmentArtifactRoot: join(root, "artifacts"), environmentStateRoot: join(root, "retained") } as never });
  const rig = f.rigRepo.createRig("lifecycle"), node = f.rigRepo.addNode(rig.id, "worker", { runtime: "openshell-claude", cwd: root });
  const request = async (path: string, body?: unknown) => { const res = await f.app.request(`/api/environments${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-openrig-session": "coordinator@lifecycle" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: res.status, body: await res.json() as Record<string, any> }; };
  const policy = join(root, "policy.yaml"); writeFileSync(policy, "version: 1\n");
  const input = { version: 1, bindingId: "binding-one", operationId: "create-one", nodeId: node.id, seat: "worker@lifecycle", baseRuntime: "claude-code", guestRoot: "/sandbox/openrig", guestBaseUrl: "http://guest.test:7433", placement: { gateway: "gateway", workspace: "workspace", name: "worker-one", image: `image@sha256:${"a".repeat(64)}`, provider: "provider", policy } };
  const created = await request(attached ? "/attach" : "/create", { ...input, ...(attached ? { resourceId: resource.id } : {}) }); expect(created.status).toBeLessThan(300);
  db.prepare("UPDATE environment_bindings SET generation='generation-one' WHERE binding_id='binding-one'").run();
  const receipt = { version: 1, bindingId: "binding-one", nodeId: node.id, resourceId: resource.id, ...native, activityGrantId: "grant-one" };
  db.prepare("INSERT INTO environment_operations(operation_id,binding_id,kind,request_json,state,receipt_json) VALUES ('launch-generation-one','binding-one','launch',?,'confirmed',?)").run(JSON.stringify(receipt), JSON.stringify(receipt));
  const effect = (name: string, operationId = "effect-one") => request("/binding-one/effect", { operationId, generation: "generation-one", effect: name });
  return { root, db, request, effect, resource, native, files, history, counts: () => ({ stopCalls, deleteCalls, creates }), loseStop: () => { loseStop = true; }, unavailable: () => { unavailable = true; }, dirtyCleanup: () => { dependents.volumes = true; } };
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
  it("rejects missing checkpoint state before creating successor compute", async () => {
    const f = await fixture(), result = await f.request("/binding-one/recreate", { operationId: "recreate-one", generation: "generation-two", checkpointId: "missing", resumeType: "community:openshell-claude", resumeToken: f.native.nativeId, placement: { ...f.resource, name: "worker-two" } });
    expect(result.status).toBe(409); expect(f.counts().creates).toBe(1);
  });
  it("refuses another native type without starting a fresh conversation", async () => {
    const f = await fixture(), result = await f.request("/binding-one/recreate", { operationId: "recreate-one", generation: "generation-two", checkpointId: "missing", resumeType: "codex_id", resumeToken: "foreign" });
    expect(result.status).toBe(409); expect(f.counts().creates).toBe(1);
  });
});
