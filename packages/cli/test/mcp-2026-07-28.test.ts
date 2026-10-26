// MCP clients on protocol 2026-07-28 reach the same durable work loop as 2025 clients: discovery, then a task created by
// one seat and claimed by another through the daemon's real queue routes, over Streamable HTTP and over stdio. A client
// pinned to 2026-07-28 never falls back to the 2025 initialize handshake, so it fails against a server that speaks only
// 2025. The 2025 suites (mcp-http-daemon, mcp-queue-daemon and the rest) keep proving the older clients.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { addGrant, startMcpHttpServer } from "../src/mcp-http.js";

const DESK = "desk@team";
const IMPL = "impl@team";
const PINNED = { versionNegotiation: { mode: { pin: "2026-07-28" } } } as const;

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; structured: Record<string, any>; text: string }>;

describe("MCP 2026-07-28 clients on the daemon's queue routes", () => {
  let db: Database.Database;
  let home: string;
  let repo: QueueRepository;
  let daemon: ServerType;
  let daemonUrl: string;
  const closers: Array<() => Promise<void>> = [];
  const saved = { home: process.env.OPENRIG_HOME, session: process.env.OPENRIG_SESSION_NAME };

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-2026-"));
    process.env.OPENRIG_HOME = home;
    delete process.env.OPENRIG_SESSION_NAME;
    const inert = async () => ({ ok: false, error: "inert fixture" });
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachOutbox(new OutboxHandler(db));
    const { app } = createTestApp(db, {
      appDeps: {
        sessionTransport: { resolveSessions: async () => ({ ok: false, code: "not_found", error: "inert fixture" }), send: inert, capture: inert, broadcast: inert } as never,
        queueRepo: repo,
      },
    });
    daemon = await new Promise<ServerType>((resolve) => { const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s)); });
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = saved.home;
    if (saved.session === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = saved.session;
  });

  async function connected(client: Client, transport: StreamableHTTPClientTransport | StdioClientTransport): Promise<Call> {
    await client.connect(transport);
    closers.push(() => client.close());
    return async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, structured: result.structuredContent as Record<string, any>, text: (result.content as Array<{ text: string }>)[0]?.text ?? "" };
    };
  }

  /** Creates a task from DESK to IMPL as `asDesk`, and claims it as `asImpl`; returns the task's id. */
  async function createAndClaim(asDesk: Call, asImpl: Call): Promise<string> {
    const created = await asDesk("rig_queue_create", { destination: IMPL, body: "build the thing" });
    expect(created.isError, created.text).toBe(false);
    const qitemId = created.structured.qitemId as string;
    const claimed = await asImpl("rig_queue_claim", { qitemId });
    expect(claimed.isError, claimed.text).toBe(false);
    expect(repo.getById(qitemId)).toMatchObject({ sourceSession: DESK, destinationSession: IMPL, state: "in-progress" });
    return qitemId;
  }

  it("over Streamable HTTP: a pinned or auto client is served 2026-07-28, a default client 2025, each as its grant's seat", async () => {
    const tokenFile = path.join(home, "mcp-http-tokens.json");
    const deskToken = await addGrant(tokenFile, { name: "desk", seat: DESK, rigs: ["team"], roots: [], workspace: false, owner: false });
    const implToken = await addGrant(tokenFile, { name: "impl", seat: IMPL, rigs: ["team"], roots: [], workspace: false, owner: false });
    const served = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile });
    closers.push(() => served.close());
    const over = (token: string) => new StreamableHTTPClientTransport(new URL(served.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });

    for (const [mode, options, era] of [
      ["pinned", PINNED, "modern"],
      ["auto", { versionNegotiation: { mode: "auto" } }, "modern"],
      ["default", {}, "legacy"],
    ] as const) {
      const deskClient = new Client({ name: `desk-${mode}`, version: "1.0.0" }, options);
      const asDesk = await connected(deskClient, over(deskToken));
      const implClient = new Client({ name: `impl-${mode}`, version: "1.0.0" }, options);
      const asImpl = await connected(implClient, over(implToken));
      expect([mode, deskClient.getProtocolEra(), implClient.getProtocolEra()]).toEqual([mode, era, era]);
      const tools = (await deskClient.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(["rig_queue_create", "rig_queue_claim", "rig_queue_list", "rig_queue_show"]));
      await createAndClaim(asDesk, asImpl);
    }
  });

  it("over HTTP, a bad credential is still refused for a pinned client, and loopback without auth still refuses a foreign Host", async () => {
    const tokenFile = path.join(home, "mcp-http-tokens.json");
    await addGrant(tokenFile, { name: "desk", seat: DESK, rigs: ["team"], roots: [], workspace: false, owner: false });
    const authed = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile });
    closers.push(() => authed.close());
    const stranger = new Client({ name: "stranger", version: "1.0.0" }, PINNED);
    await expect(stranger.connect(new StreamableHTTPClientTransport(new URL(authed.url), { requestInit: { headers: { Authorization: "Bearer not-a-grant" } } })))
      .rejects.toThrow(/401/);

    const open = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile: path.join(home, "none.json") });
    closers.push(() => open.close());
    const { port } = new URL(open.url);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: Number(port), path: "/mcp", method: "POST",
        headers: { Host: `rebound.example:${port}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } }, (res) => {
        let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: `Invalid Host header: rebound.example:${port}` }, id: null });
  });

  it("over stdio: a pinned client is served 2026-07-28 by rig mcp serve, as the env's seat", async () => {
    const source = new URL("../src/commands/mcp.ts", import.meta.url).href;
    const script = `import { mcpCommand } from ${JSON.stringify(source)}; await mcpCommand().parseAsync(["serve", "--port", ${JSON.stringify(new URL(daemonUrl).port)}], { from: "user" });`;
    const spawnAs = (seat: string) => new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "--input-type=module", "-e", script],
      env: { ...process.env as Record<string, string>, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: seat },
      stderr: "pipe",
    });
    const deskClient = new Client({ name: "desk-stdio", version: "1.0.0" }, PINNED);
    const asDesk = await connected(deskClient, spawnAs(DESK));
    const implClient = new Client({ name: "impl-stdio", version: "1.0.0" }, PINNED);
    const asImpl = await connected(implClient, spawnAs(IMPL));
    expect([deskClient.getProtocolEra(), implClient.getProtocolEra()]).toEqual(["modern", "modern"]);
    await createAndClaim(asDesk, asImpl);
  }, 30_000);
});
