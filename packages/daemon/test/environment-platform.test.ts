import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

// The real daemon routes, SQLite and host filesystem; only the provider transport is fake.
// These checks never launch OpenShell or a native agent.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "environment-platform-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const resources: Array<Record<string, unknown>> = [], files = new Map<string, string>();
  let creates = 0, downloads = 0, loseCreate = false;
  const driver = {
    version: 1,
    async list() { return { complete: true, resources: [...resources] }; },
    async create(input: { operationId: string; placement: { name: string; workspace: string } }) {
      creates++;
      expect(db.prepare("SELECT count(*) AS n FROM environment_operations WHERE operation_id = ?").get(input.operationId)).toMatchObject({ n: 1 });
      const resource = { id: "immutable-resource-1", name: input.placement.name, workspace: input.placement.workspace,
        phase: "Ready", fingerprint: "host-key-1", operationId: input.operationId };
      resources.push(resource);
      if (loseCreate) throw new Error("response lost after create");
      return resource;
    },
    async inspect() { if (!resources.length) throw new Error("provider unavailable"); return { ...resources[0] }; },
    async upload(_binding: unknown, local: string, destination: string) { files.set(destination, readFileSync(local, "utf8")); },
    async read(_binding: unknown, destination: string) { if (!files.has(destination)) throw new Error("missing destination"); return Buffer.from(files.get(destination)!); },
    async download(_binding: unknown, source: string, destination: string) { downloads++; if (!files.has(source)) throw new Error("guest unavailable"); writeFileSync(destination, files.get(source)!); },
  };
  const build = () => createTestApp(db, { appDeps: { environmentDriver: driver, environmentArtifactRoot: join(root, "exports") } as never });
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
    seat: "worker@environment-fixture", baseRuntime: "claude-code", guestRoot: "/sandbox/openrig", guestBaseUrl: "http://host.test:7433",
    placement: { gateway: "gateway", workspace: "workspace", name: "worker-one", image: `image@sha256:${"a".repeat(64)}`, provider: "provider-ref", policy: join(root, "policy.yaml") } };
  writeFileSync(input.placement.policy, "version: 1\n"); mkdirSync(join(root, "exports"));
  const create = () => request("/create", input);
  return { root, db, resources, files, driver, input, request, create, health: () => f.app.request("/healthz"),
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
    expect((await f.request("/binding-one/effect", { effect: "delete_environment" })).status).toBe(409);
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
    const result = await f.request("/binding-one/project", { operationId: "projection-one", generation: "generation-one",
      files: [{ source: local, path: "work/CLAUDE.md", sha256: hash("current guidance"), required: true }] });
    expect(result.status).toBe(200);
    f.files.set("/sandbox/openrig/work/CLAUDE.md", "changed after projection");
    expect((await f.request("/binding-one/validate", { generation: "generation-one" })).status).toBe(409);
  });

  it("preserves an unmanaged destination conflict without publishing a prepared latch", async () => {
    const f = fixture(); expect((await f.create()).status).toBe(201);
    const local = join(f.root, "role.md"); writeFileSync(local, "current guidance");
    f.files.set("/sandbox/openrig/work/CLAUDE.md", "owner content");
    expect((await f.request("/binding-one/project", { operationId: "projection-one", generation: "generation-one",
      files: [{ source: local, path: "work/CLAUDE.md", sha256: hash("current guidance"), required: true }] })).status).toBe(409);
    expect(f.files.get("/sandbox/openrig/work/CLAUDE.md")).toBe("owner content");
  });

  it("rejects projection traversal before a provider write", async () => {
    const f = fixture(); expect((await f.create()).status).toBe(201);
    const local = join(f.root, "role.md"); writeFileSync(local, "current guidance");
    expect((await f.request("/binding-one/project", { operationId: "projection-one", generation: "generation-one",
      files: [{ source: local, path: "../outside", sha256: hash("current guidance"), required: true }] })).status).toBe(400);
    expect(f.files.size).toBe(0);
  });

  it("keeps the ordinary host health route available without an environment selection", async () => {
    const f = fixture(); expect((await f.health()).status).toBe(200); expect((await f.request("/missing")).status).toBe(404);
  });
});
