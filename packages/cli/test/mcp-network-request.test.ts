// An MCP-only caller, the real HTTP request/queue routes and SQLite, with a deterministic hub peer.
// No model or installed CLI is used; the connector's existing reconciliation carries the peer answer back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { SessionRegistry } from "../../daemon/src/domain/session-registry.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { NetworkBindingStore, type NetworkBinding } from "../../daemon/src/domain/network/network-bindings.js";
import { networkRoutes } from "../../daemon/src/routes/network.js";
import { reconcileNetworkRequests } from "../../daemon/src/domain/network/network-requests.js";
import { HubError, type HubItem, type HubSession } from "../../daemon/src/domain/network/hub-client.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp-server.js";

const SEAT = "agent@lab", PEER = "peer@hub", PARTICIPANT = "member@hub";
const request = { requestId: "qitem-mcp-network", peer: PEER, body: "Review the release notes", summary: "Review notes" };

describe("MCP network request through the existing daemon route", () => {
  let db: Database.Database, home: string, queue: QueueRepository, bindings: NetworkBindingStore, binding: NetworkBinding;
  let server: ServerType, url: string, hub: HubSession;
  let hubRefusal: HubError | null, loseReply: boolean;
  const items = new Map<string, HubItem>();
  const closers: Array<() => Promise<void>> = [];
  let creates: number;

  beforeEach(async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", SEAT);
    vi.stubEnv("OPENRIG_NODE_ID", "");
    vi.stubEnv("RIGGED_NODE_ID", "");
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-network-"));
    vi.stubEnv("OPENRIG_HOME", home);
    queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    queue.attachOutbox(new OutboxHandler(db));
    const setup = createTestApp(db, { appDeps: { queueRepo: queue } });
    const rig = setup.rigRepo.createRig("lab");
    const node = setup.rigRepo.addNode(rig.id, "agent", { runtime: "codex" });
    setup.sessionRegistry.registerSession(node.id, SEAT);
    bindings = new NetworkBindingStore(db, home);
    binding = bindings.create({ session: SEAT, hubUrl: "https://hub.example/mcp", hubSeat: PARTICIPANT, token: "fixture-token" });
    items.clear(); creates = 0; hubRefusal = null; loseReply = false;
    hub = {
      offers: async () => true, listOwned: async () => [], claim: async () => {}, note: async () => {}, close: async () => {}, end: async () => {},
      team: async () => ({ seats: [{ session: PEER }] }),
      show: async (id) => { const item = items.get(id); if (!item) throw new HubError("refused", "No such item", "qitem_not_found"); return item; },
      create: async (input) => {
        if (hubRefusal) throw hubRefusal;
        let item = items.get(input.qitemId);
        if (!item) {
          creates++;
          item = { qitemId: input.qitemId, sourceSession: PARTICIPANT, destinationSession: input.destination,
            state: "pending", body: input.body, summary: input.summary ?? null, resolution: null, closureReason: null };
          items.set(item.qitemId, item);
        }
        if (loseReply) { loseReply = false; throw new HubError("unavailable", "Reply lost after create"); }
        return item;
      },
    };
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "required-fixture-bearer");
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("rigRepo" as never, setup.rigRepo as never); c.set("queueRepo" as never, queue as never); await next(); });
    app.route("/api/network", networkRoutes({ home, bearerToken: "required-fixture-bearer", hubConnect: async () => hub }));
    app.route("/", setup.app);
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close(); setSelfHostId(null); fs.rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs();
  });

  async function connect(options: Parameters<typeof createMcpServer>[1] = {}, daemon = new DaemonClient(url)) {
    const mcp = createMcpServer(daemon, options);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mcp-only", version: "1" });
    await mcp.connect(st); await client.connect(ct);
    closers.push(async () => { await client.close(); await mcp.close(); });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return { error: result.isError === true, data: result.structuredContent as Record<string, any>,
        text: (result.content as Array<{ text: string }>).map((c) => c.text).join("\n") };
    };
    return { client, call };
  }

  it("sends without a CLI on PATH, retries once, and reads the peer answer on the same OpenRig-owned row", async () => {
    const { call, client } = await connect();
    vi.stubEnv("PATH", "");
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === "rig_network_request")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["peer", "requestId", "body"]));
    expect(tool.description).toContain("rig_queue_update");
    expect(tool.description).toContain("external MCP client must check");
    const sent = await call("rig_network_request", request);
    expect(sent.error).toBe(false);
    expect(sent.data).toMatchObject({ localQitemId: request.requestId, state: "sent", sourceSession: SEAT });
    expect(sent.data.followUp).toContain("blockedOn");
    expect(queue.getById(request.requestId)).toMatchObject({ sourceSession: SEAT, destinationSession: "daemon@kernel", state: "blocked" });
    expect(queue.listTransitions(request.requestId)[0]).toMatchObject({ identityProvenance: "transport:v1" });
    expect((await call("rig_network_request", request)).data.hubQitemId).toBe(sent.data.hubQitemId);
    expect(creates).toBe(1); expect(items.size).toBe(1);
    expect((await call("rig_queue_create", { qitemId: "qitem-wait", destination: SEAT, body: "Report the peer answer" })).error).toBe(false);
    expect((await call("rig_queue_claim", { qitemId: "qitem-wait" })).error).toBe(false);
    expect((await call("rig_queue_update", { qitemId: "qitem-wait", state: "blocked", blockedOn: request.requestId, wakeAfterSeconds: 3600 })).error).toBe(false);
    expect(queue.getById("qitem-wait")?.state).toBe("blocked");
    Object.assign(items.get(sent.data.hubQitemId)!, { state: "done", resolution: "The release notes are accurate.", closureReason: "no-follow-on" });
    await reconcileNetworkRequests({ db, queueRepo: queue, bindings, home }, binding, hub);
    expect(queue.getById("qitem-wait")).toMatchObject({ state: "pending", blockedOn: null });
    const read = await call("rig_queue_show", { qitemId: request.requestId });
    expect(read.error).toBe(false);
    expect(read.data.item).toMatchObject({ state: "done", resolution: "The release notes are accurate.", destinationSession: "daemon@kernel" });
    expect(read.text).toContain(PEER);
    expect((await call("rig_network_request", request)).data.message).toContain("has closed");
    expect(creates).toBe(1);
  });

  it("keeps a recorded MCP caller distinct from the binding seat", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "caller@lab");
    const { call } = await connect();
    const result = await call("rig_network_request", { ...request, binding: binding.id });
    expect(result.error).toBe(false);
    expect(queue.getById(request.requestId)?.sourceSession).toBe("caller@lab");
  });

  it("reuses an issued conversation address and lets that conversation claim a question sent there (#4059)", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", undefined);
    const { call } = await connect({ conversationKey: () => "codex:network-test" });
    const first = await call("rig_network_request", { ...request, binding: binding.id });
    expect(first.error).toBe(false);
    const address = first.data.returnRoute;
    expect(address).toMatch(/^conversation-.*@kernel$/);
    expect(first.data).toMatchObject({ sourceSession: address, returnRouteBasis: "issued-actor" });
    expect(first.data.followUp).toContain("external MCP client must check");
    expect(queue.listTransitions(request.requestId)[0]).toMatchObject({ identityProvenance: "claimed:v1" });
    const second = await call("rig_network_request", { ...request, requestId: "qitem-next-request", binding: binding.id });
    expect(second.data.returnRoute).toBe(address);
    await queue.create({ qitemId: "qitem-question", sourceSession: SEAT, destinationSession: address, body: "Which notes?", nudge: false });
    expect((await call("rig_queue_claim", { qitemId: "qitem-question" })).error).toBe(false);
    expect(queue.getById("qitem-question")?.state).toBe("in-progress");
  });

  it("records an authenticated work caller's principal and lets it read its answer", async () => {
    // Principal headers travel only to this host's own daemon, identified as in the HTTP MCP fixtures.
    const identity = path.join(home, "identity.sqlite");
    const idDb = createDb(identity);
    idDb.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
    idDb.prepare("INSERT INTO self_host_identity VALUES (1, 'test-host')").run();
    idDb.close(); vi.stubEnv("OPENRIG_DB", identity); setSelfHostId("test-host");
    const seat = "caller@lab", principal = { source: "file", id: "work-caller" };
    const access = { principal: principal.id, owner: false, rigs: ["lab"], roots: [], workspace: false };
    const daemon = new DaemonClient(url, { sessionName: seat, principal });
    const { call } = await connect({ seat, access }, daemon);
    const sent = await call("rig_network_request", { ...request, binding: binding.id });
    expect(sent.error).toBe(false);
    expect(queue.getById(request.requestId)?.sourceSession).toBe(seat);
    expect(queue.listTransitions(request.requestId)[0]).toMatchObject({ identityProvenance: "principal:v1", identityPrincipal: JSON.stringify(principal) });
    expect((await call("rig_queue_show", { qitemId: request.requestId })).error).toBe(false);
  });

  it("keeps existing binding scope and read-only tool availability", async () => {
    const access = { principal: "other", owner: false, rigs: ["other"], roots: [], workspace: false };
    const { call } = await connect({ seat: "caller@other", access });
    const denied = await call("rig_network_request", { ...request, binding: binding.id });
    expect(denied.error).toBe(true); expect(denied.data.code).toBe("out_of_scope");
    expect(creates).toBe(0);
    const readOnly = await connect({ access: { ...access, owner: true, readOnly: true } });
    expect((await readOnly.client.listTools()).tools.some((t) => t.name === "rig_network_request")).toBe(false);
  });

  it.each(["earlier@lab", "ops-agent@lab"])("keeps binding scope consistent for the route's accepted name %s", async (ref) => {
    const registry = new SessionRegistry(db);
    registry.registerSession(binding.nodeId, "earlier@lab");
    registry.registerSession(binding.nodeId, SEAT);
    registry.updateBinding(binding.nodeId, { tmuxSession: SEAT });
    db.prepare("UPDATE nodes SET logical_id = 'ops.agent' WHERE id = ?").run(binding.nodeId);
    expect(bindings.find(ref)?.id).toBe(binding.id);
    expect(binding.localSession).not.toBe(ref);
    const access = { principal: "scoped", owner: false, rigs: ["other"], roots: [], workspace: false };
    const outside = await connect({ seat: "caller@other", access });
    const denied = await outside.call("rig_network_request", { ...request, binding: ref });
    expect(denied.error).toBe(true);
    expect(denied.data.code).toBe("out_of_scope");
    expect(creates).toBe(0);
    expect(queue.getById(request.requestId)).toBeNull();
    const allowed = await connect({ seat: "caller@lab", access: { ...access, rigs: ["lab"] } });
    expect((await allowed.call("rig_network_request", { ...request, binding: ref })).error).toBe(false);
    expect(creates).toBe(1);
  });

  it("keeps an unknown binding in the caller's scope readable as not found", async () => {
    const access = { principal: "scoped", owner: false, rigs: ["lab"], roots: [], workspace: false };
    const { call } = await connect({ seat: "caller@lab", access });
    const missing = await call("rig_network_request", { ...request, binding: "missing@lab" });
    expect(missing.error).toBe(true);
    expect(missing.data.code).toBe("binding_not_found");
    expect(creates).toBe(0);
  });

  it("recovers a lost hub reply using the same id, and refuses changed request text without a duplicate", async () => {
    const { call } = await connect(); loseReply = true;
    expect((await call("rig_network_request", request)).data.state).toBe("unknown");
    expect((await call("rig_network_request", request)).data.state).toBe("sent");
    const changed = await call("rig_network_request", { ...request, body: "Different work" });
    expect(changed.error).toBe(true); expect(changed.data.code).toBe("request_id_reused");
    expect(creates).toBe(1);
  });

  it("returns the existing missing-binding and authentication errors readably", async () => {
    const { call } = await connect();
    const missing = await call("rig_network_request", { ...request, binding: "missing" });
    expect(missing.error).toBe(true); expect(missing.data.code).toBe("binding_not_found");
    expect(missing.text).toContain("No network binding or connected seat is named 'missing'.");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "");
    const denied = await call("rig_network_request", request);
    const cliRoute = await fetch(`${url}/api/network/bindings/${binding.id}/requests`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    expect(denied.error).toBe(true); expect(denied.data.status).toBe(cliRoute.status);
    expect(JSON.parse(denied.text)).toEqual(await cliRoute.json());
    expect(creates).toBe(0);
  });

  it("keeps a hub out_of_scope refusal and marks the recorded request failed", async () => {
    const { call } = await connect(); hubRefusal = new HubError("refused", "Target is outside this connection's scope.", "out_of_scope");
    const denied = await call("rig_network_request", request);
    expect(denied.error).toBe(true); expect(JSON.parse(denied.text).state).toBe("refused");
    expect(denied.text).toContain("Target is outside this connection's scope.");
    expect(denied.text).toContain("out_of_scope");
    expect(queue.getById(request.requestId)?.state).toBe("failed");
  });

  it("keeps a transport failure uncertain and tells the caller to read and retry the same id", async () => {
    const daemon = new DaemonClient(url);
    vi.spyOn(daemon, "post").mockRejectedValue(new Error("connection lost"));
    const { call } = await connect({}, daemon);
    const result = await call("rig_network_request", request);
    expect(result.error).toBe(true);
    expect(result.data).toMatchObject({ outcome: "unknown", localQitemId: request.requestId });
    expect(result.text).toContain("rig_queue_show"); expect(result.text).toContain("same requestId");
  });
});
