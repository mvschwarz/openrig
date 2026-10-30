import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { EnvironmentPlatform } from "../../daemon/src/domain/environment-platform.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { addGrant, revokeGrant, startMcpHttpServer } from "../src/mcp-http.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (data: string) => createHash("sha256").update(data).digest("hex");

it("returns real artifact bytes under the authenticated work grant, refusing wrong seat and revoked credentials", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "environment-http-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createDb(":memory:"); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const identity = join(root, "identity.sqlite"), idDb = createDb(identity);
  idDb.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
  idDb.prepare("INSERT INTO self_host_identity VALUES (1, 'environment-test-host')").run(); idDb.close();
  vi.stubEnv("OPENRIG_DB", identity); setSelfHostId("environment-test-host");
  cleanup.push(() => { setSelfHostId(null); vi.unstubAllEnvs(); });
  const artifact = JSON.stringify({ task: "export-task", revision: 1, report: "useful bytes" });
  let downloads = 0;
  const resource = { id: "immutable-id", name: "worker-one", workspace: "workspace", phase: "Ready", operationId: "create-one" };
  const driver = { version: 1 as const, list: async () => ({ complete: true, resources: [] }), create: async (input: { operationId: string }) => { resource.operationId = input.operationId; return resource; },
    inspect: async () => resource, upload: async () => {}, read: async () => Buffer.alloc(0),
    download: async (_binding: unknown, _source: string, destination: string) => { downloads++; writeFileSync(destination, artifact); } };
  const queue = new QueueRepository(db, new EventBus(db)); queue.attachOutbox(new OutboxHandler(db));
  const fixture = createTestApp(db, { appDeps: { queueRepo: queue, environmentDriver: driver, environmentArtifactRoot: join(root, "artifacts") } as never });
  const rig = fixture.rigRepo.createRig("team"), node = fixture.rigRepo.addNode(rig.id, "team.worker", { runtime: "openshell-claude", cwd: root });
  fixture.sessionRegistry.registerSession(node.id, "worker@team");
  const policy = join(root, "policy.yaml"); writeFileSync(policy, "version: 1\n");
  const platform = new EnvironmentPlatform(db, driver);
  await platform.create({ version: 1, bindingId: "binding-one", operationId: "create-one", nodeId: node.id, seat: "worker@team", baseRuntime: "claude-code", guestRoot: "/sandbox/openrig", guestBaseUrl: "http://guest.test:7782",
    placement: { gateway: "gateway", workspace: "workspace", name: "worker-one", image: `image@sha256:${"a".repeat(64)}`, provider: "provider", policy } });
  await platform.project("binding-one", { operationId: "projection-one", generation: "generation-one", files: [] });
  // This is the existing queue writer, not a separate guest task store.
  const created = await fixture.app.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "coordinator@team" }, body: JSON.stringify({ qitemId: "export-task", destinationSession: "worker@team", body: "Return the selected report" }) });
  expect(created.status, JSON.stringify(await created.clone().json())).toBeLessThan(300);
  const daemon = await new Promise<ReturnType<typeof serve>>(resolve => {
    const server = serve({ fetch: fixture.app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(server));
  });
  cleanup.push(() => new Promise<void>(resolve => daemon.close(() => resolve())));
  const daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
  const tokenFile = join(root, "tokens.json");
  const token = await addGrant(tokenFile, { name: "worker-grant", seat: "worker@team", rigs: ["team"], roots: [join(root, "artifacts")], workspace: false, owner: false });
  const wrongToken = await addGrant(tokenFile, { name: "other-grant", seat: "other@team", rigs: ["team"], roots: [], workspace: false, owner: false });
  const mcp = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile }); cleanup.push(() => mcp.close());
  const connect = async (credential: string) => {
    const client = new Client({ name: "environment-proof", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${credential}`, "X-OpenRig-Principal": JSON.stringify({ source: "file", id: "forged" }) } } }));
    cleanup.push(() => client.close()); return client;
  };
  const bad = new Client({ name: "environment-invalid", version: "1" });
  await expect(bad.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: "Bearer invalid" } } }))).rejects.toThrow();
  await bad.close();
  const owner = await connect(token), other = await connect(wrongToken);
  const request = { bindingId: "binding-one", operationId: "export-one", taskId: "export-task", generation: "generation-one", path: "report.json", sha256: hash(artifact), bytes: Buffer.byteLength(artifact),
    schema: { format: "json-object/v1", fields: { task: "string", revision: "number", report: "string" }, required: ["task", "revision", "report"] }, context: { task: "export-task", revision: 1 } };
  const denied = await other.callTool({ name: "rig_environment_export", arguments: request }); expect(denied.isError).toBe(true); expect(downloads).toBe(0);
  const result = await owner.callTool({ name: "rig_environment_export", arguments: request }); expect(result.isError).not.toBe(true);
  const receipt = result.structuredContent as Record<string, any>;
  expect(receipt).toMatchObject({ actor: "worker@team", identityProvenance: "principal:v1", identityPrincipal: JSON.stringify({ source: "file", id: "worker-grant" }), sha256: hash(artifact) });
  expect(readFileSync(receipt.path, "utf8")).toBe(artifact); expect(downloads).toBe(1);
  const note = db.prepare("SELECT identity_provenance, identity_principal FROM queue_transitions WHERE qitem_id = 'export-task' ORDER BY transition_id DESC LIMIT 1").get();
  expect(note).toMatchObject({ identity_provenance: "principal:v1", identity_principal: JSON.stringify({ source: "file", id: "worker-grant" }) });
  expect(await revokeGrant(tokenFile, "worker-grant")).toBe(true);
  await expect(owner.callTool({ name: "rig_environment_export", arguments: request })).rejects.toThrow();
  expect(downloads).toBe(1);
});
