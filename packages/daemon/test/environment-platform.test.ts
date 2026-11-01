import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { EventBus } from "../src/domain/event-bus.js";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentError, EnvironmentPlatform } from "../src/domain/environment-platform.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

// The real daemon routes, SQLite and host filesystem; only the provider transport is fake.
// These checks never launch OpenShell or a native agent.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "environment-platform-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const resources: Array<Record<string, unknown>> = [], files = new Map<string, string>();
  let creates = 0, downloads = 0, loseCreate = false;
  const driver = {
    version: 1,
    async list() { return { complete: true, resources: [...resources] }; },
    async create(input: { operationId: string; placement: { name: string; workspace: string } }) {
      creates++;
      expect(db.prepare("SELECT count(*) AS n FROM environment_operations WHERE effect_id = ?").get(input.operationId)).toMatchObject({ n: 1 });
      const resource = { id: "immutable-resource-1", name: input.placement.name, workspace: input.placement.workspace,
        phase: "Ready", fingerprint: "host-key-1", operationId: input.operationId };
      resources.push(resource);
      if (loseCreate) throw new Error("response lost after create");
      return resource;
    },
    async inspect() { if (!resources.length) throw new Error("provider unavailable"); return { ...resources[0] }; },
    async upload(_binding: unknown, local: string, destination: string) { files.set(destination, readFileSync(local, "utf8")); },
    async read(_binding: unknown, destination: string) { if (!files.has(destination)) throw new EnvironmentError("environment_file_missing", "Guest file is missing"); return Buffer.from(files.get(destination)!); },
    async download(_binding: unknown, source: string, destination: string) { downloads++; if (!files.has(source)) throw new Error("guest unavailable"); writeFileSync(destination, files.get(source)!); },
  };
  const queue = new QueueRepository(db, new EventBus(db)); queue.attachOutbox(new OutboxHandler(db));
  const build = () => createTestApp(db, { appDeps: { queueRepo: queue, environmentDriver: driver, environmentArtifactRoot: join(root, "exports") } as never });
  let f = build();
  const rig = f.rigRepo.createRig("environment-fixture");
  const node = f.rigRepo.addNode(rig.id, "worker", { runtime: "openshell-claude", cwd: root });
  const request = async (path: string, body?: unknown) => {
    const res = await f.app.request(`/api/environments${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-openrig-session": "coordinator@environment-fixture" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const input = { version: 1, bindingId: "binding-one", operationId: "create-one", nodeId: node.id,
    seat: "worker@environment-fixture", baseRuntime: "claude-code", guestRoot: "/sandbox/openrig", guestBaseUrl: "http://host.test:7782",
    placement: { gateway: "gateway", workspace: "workspace", name: "worker-one", image: `image@sha256:${"a".repeat(64)}`, provider: "provider-ref", policy: join(root, "policy.yaml") } };
  writeFileSync(input.placement.policy, "version: 1\n"); mkdirSync(join(root, "exports"));
  const project = async (body: any) => {
    try { return { status: 200, body: await new EnvironmentPlatform(db, driver as never).project("binding-one", body) }; }
    catch (error) { return { status: error instanceof EnvironmentError ? error.status : 503, body: {} }; }
  };
  const create = () => request("/create", input);
  const task = async () => {
    const response = await f.app.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "coordinator@environment-fixture" },
      body: JSON.stringify({ qitemId: "task-one", destinationSession: "worker@environment-fixture", body: "Produce the selected artifact" }) });
    expect(response.status, JSON.stringify(await response.clone().json())).toBeLessThan(300);
  };
  return { root, db, resources, files, driver, input, request, create, task, project, health: () => f.app.request("/healthz"),
    counts: () => ({ creates, downloads }), loseCreate: () => { loseCreate = true; }, restart: () => { f = build(); } };
}

describe("maintained environment binding and projection", () => {
  it("journals create intent before the provider effect and persists the immutable owned receipt", async () => {
    const f = fixture(), result = await f.create();
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ version: 1, bindingId: "binding-one", ownership: "owned", nodeId: f.input.nodeId,
      resource: { id: "immutable-resource-1", workspace: "workspace" } });
    expect(f.counts().creates).toBe(1);
    expect((await f.request("/binding-one")).body).toMatchObject({ bindingId: "binding-one", ownership: "owned" });
  });

  it("reconciles a lost create response after daemon reconstruction without another create", async () => {
    const f = fixture(); f.loseCreate();
    expect((await f.create()).status).toBe(202);
    f.restart();
    const result = await f.create();
    expect(result.status).toBe(200);
    expect(result.body.resource.id).toBe("immutable-resource-1");
    expect(f.counts().creates).toBe(1);
  });

  it("keeps an unresolved create intent when the provider cannot establish absence", async () => {
    const f = fixture(); f.loseCreate();
    expect((await f.create()).status).toBe(202);
    f.driver.list = async () => ({ complete: false, resources: [] });
    expect((await f.create()).status).toBe(202);
    expect(f.counts().creates).toBe(1);
  });

  it("refuses duplicate matches instead of choosing a resource or repeating create", async () => {
    const f = fixture(); f.loseCreate();
    expect((await f.create()).status).toBe(202);
    f.resources.push({ ...f.resources[0], id: "conflicting-resource" });
    expect((await f.create()).status).toBe(409);
    expect(f.counts().creates).toBe(1);
  });

  it("does not adopt a different daemon's resource with the same user operation name", async () => {
    const f = fixture();
    f.resources.push({ id: "foreign-resource", name: "worker-one", workspace: "workspace", phase: "Ready", operationId: "create-one" });
    expect((await f.create()).status).toBe(409); expect(f.counts().creates).toBe(0);
    expect((await f.request("/binding-one")).body.resource).toBeNull();
  });

  it("does not reuse an operation identity with different placement", async () => {
    const f = fixture(); expect((await f.create()).status).toBe(201);
    expect((await f.request("/create", { ...f.input, placement: { ...f.input.placement, name: "different" } })).status).toBe(409);
    expect(f.counts().creates).toBe(1);
  });

  it("attaches only the exact live ID and retains external ownership", async () => {
    const f = fixture(); f.resources.push({ id: "external-id", name: "worker-one", workspace: "workspace", fingerprint: "host-key-1", phase: "Ready" });
    const result = await f.request("/attach", { ...f.input, operationId: "attach-one", resourceId: "external-id", fingerprint: "host-key-1" });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ ownership: "attached", resource: { id: "external-id" } });
    expect(f.counts().creates).toBe(0);
    f.db.prepare("UPDATE environment_bindings SET generation='attached-generation' WHERE binding_id='binding-one'").run();
    const denied = await f.request("/binding-one/effect", { operationId: "attached-delete", generation: "attached-generation", effect: "delete-owned" });
    expect(denied.status).toBe(409); expect(denied.body.code).toBe("environment_attached_preserved");
    expect(f.resources[0].id).toBe("external-id");
  });

  it("refuses a reused resource name with a different immutable ID", async () => {
    const f = fixture(); f.resources.push({ id: "reused-id", name: "worker-one", workspace: "workspace", phase: "Ready", fingerprint: "host-key-1" });
    const result = await f.request("/attach", { ...f.input, operationId: "attach-one", resourceId: "expected-id", fingerprint: "host-key-1" });
    expect(result.status).toBe(409); expect(f.counts().creates).toBe(0);
  });

  it("verifies explicit destination bytes and refuses a changed required projection", async () => {
    const f = fixture(); expect((await f.create()).status).toBe(201);
    const local = join(f.root, "role.md"); writeFileSync(local, "current guidance");
    const result = await f.project({ operationId: "projection-one", generation: "generation-one",
      files: [{ source: local, path: "work/CLAUDE.md", sha256: hash("current guidance"), required: true }] });
    expect(result.status).toBe(200);
    f.files.set("/sandbox/openrig/work/CLAUDE.md", "changed after projection");
    expect((await f.request("/binding-one/validate", { generation: "generation-one" })).status).toBe(409);
  });

  it("preserves an unmanaged destination conflict without publishing a prepared latch", async () => {
    const f = fixture(); expect((await f.create()).status).toBe(201);
    const local = join(f.root, "role.md"); writeFileSync(local, "current guidance");
    f.files.set("/sandbox/openrig/work/CLAUDE.md", "owner content");
    expect((await f.project({ operationId: "projection-one", generation: "generation-one",
      files: [{ source: local, path: "work/CLAUDE.md", sha256: hash("current guidance"), required: true }] })).status).toBe(409);
    expect(f.files.get("/sandbox/openrig/work/CLAUDE.md")).toBe("owner content");
  });

  it("rejects projection traversal before a provider write", async () => {
    const f = fixture(); expect((await f.create()).status).toBe(201);
    const local = join(f.root, "role.md"); writeFileSync(local, "current guidance");
    expect((await f.project({ operationId: "projection-one", generation: "generation-one",
      files: [{ source: local, path: "../outside", sha256: hash("current guidance"), required: true }] })).status).toBe(400);
    expect(f.files.size).toBe(0);
  });

  it("keeps the ordinary host health route available without an environment selection", async () => {
    const f = fixture(); expect((await f.health()).status).toBe(200); expect((await f.request("/missing")).status).toBe(404);
  });
});


describe("managed environment artifact return", () => {
  async function prepared() {
    const f = fixture(); expect((await f.create()).status).toBe(201); await f.task();
    expect((await f.project({ operationId: "projection-one", generation: "generation-one", files: [] })).status).toBe(200);
    const body = JSON.stringify({ task: "task-one", revision: 2, report: "actual artifact bytes" });
    f.files.set("/sandbox/openrig/work/artifacts/report.json", body);
    const input = { operationId: "export-one", taskId: "task-one", generation: "generation-one", path: "report.json", sha256: hash(body), bytes: Buffer.byteLength(body),
      schema: { format: "json-object/v1", fields: { task: "string", revision: "number", report: "string" }, required: ["task", "revision", "report"] },
      context: { task: "task-one", revision: 2 } };
    return { ...f, body, exportInput: input, export: () => f.request("/binding-one/export", input) };
  }
  it("publishes verified bytes once and appends a durable receipt to the same work row", async () => {
    const f = await prepared(), result = await f.export();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ version: 1, bindingId: "binding-one", taskId: "task-one", generation: "generation-one",
      sha256: hash(f.body), bytes: Buffer.byteLength(f.body), actor: "coordinator@environment-fixture" });
    expect(readFileSync(result.body.path, "utf8")).toBe(f.body);
    const notes = f.db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = 'task-one'").all() as { transition_note: string }[];
    expect(notes.filter(n => n.transition_note.includes("export-one"))).toHaveLength(1);
    const replay = await f.export(); expect(replay.status).toBe(200);
    expect(replay.body).toEqual(result.body); expect(f.counts().downloads).toBe(1);
  });
  it("reconciles host publication before receipt after restart without requiring the guest", async () => {
    const f = await prepared();
    const canonical = (value: unknown) => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
    f.db.prepare("INSERT INTO environment_operations(operation_id,binding_id,kind,request_json,state) VALUES ('export-one','binding-one','export',?,'requested')").run(canonical(f.exportInput));
    mkdirSync(join(f.root, "exports", "binding-one"));
    writeFileSync(join(f.root, "exports", "binding-one", "task-one-export-one.json"), f.body);
    f.files.clear(); f.restart();
    const result = await f.export(); expect(result.status).toBe(200);
    expect(result.body.sha256).toBe(hash(f.body)); expect(f.counts().downloads).toBe(0);
    const notes = f.db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = 'task-one'").all() as { transition_note: string }[];
    expect(notes.filter(n => n.transition_note.includes("export-one"))).toHaveLength(1);
  });
  it("refuses changed host bytes on replay rather than overwriting them", async () => {
    const f = await prepared(); const first = await f.export(); expect(first.status).toBe(200);
    writeFileSync(first.body.path, "changed owner bytes");
    expect((await f.export()).status).toBe(409); expect(readFileSync(first.body.path, "utf8")).toBe("changed owner bytes");
  });
  it("refuses a matching hash whose task context does not match the selected contract", async () => {
    const f = await prepared(); f.exportInput.context.revision = 3;
    expect((await f.export()).status).toBe(409);
    expect(f.db.prepare("SELECT receipt_json FROM environment_operations WHERE operation_id='export-one'").get()).toMatchObject({ receipt_json: null });
  });
  it("refuses stale generation before download or publication", async () => {
    const f = await prepared(); f.exportInput.generation = "older-generation";
    expect((await f.export()).status).toBe(409); expect(f.counts().downloads).toBe(0);
  });
  it("never exports native state or a path outside the artifact root", async () => {
    const f = await prepared(); f.exportInput.path = "../../native/history.jsonl";
    expect((await f.export()).status).toBe(400); expect(f.counts().downloads).toBe(0);
  });
});

it("allows a corrected attach after a refused immutable identity", async () => {
  const f = fixture(); f.resources.push({ id: "correct-id", name: "worker-one", workspace: "workspace", phase: "Ready" });
  expect((await f.request("/attach", { ...f.input, operationId: "bad-attach", resourceId: "wrong-id" })).status).toBe(409);
  const result = await f.request("/attach", { ...f.input, operationId: "correct-attach", resourceId: "correct-id" });
  expect(result.status).toBe(201); expect(result.body.resource.id).toBe("correct-id");
});
it("allows a corrected create when the old binding has never requested a provider effect", async () => {
  const f = fixture(); f.resources.push({ id: "foreign", name: "worker-one", workspace: "workspace", phase: "Ready" });
  expect((await f.create()).status).toBe(409);
  const result = await f.request("/create", { ...f.input, operationId: "correct-create", placement: { ...f.input.placement, name: "worker-two" } });
  expect(result.status).toBe(201); expect(f.counts().creates).toBe(1);
});
it("reports an already-bound seat as a typed conflict", async () => {
  const f = fixture(); expect((await f.create()).status).toBe(201);
  const result = await f.request("/create", { ...f.input, bindingId: "other-binding", operationId: "other-create" });
  expect(result.status).toBe(409); expect(result.body.code).toBe("environment_seat_bound");
});
