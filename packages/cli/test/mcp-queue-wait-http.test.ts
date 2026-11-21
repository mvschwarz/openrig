// Real MCP HTTP -> DaemonClient -> daemon routes -> migrated SQLite/event bus.
// Only synthetic grants and rows; no live daemon, model, or seat wake.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { addGrant, startMcpHttpServer } from "../src/mcp-http.js";

const LEAD = "lead@team";

describe("bounded rig_queue_show over HTTP", () => {
  let db: Database.Database;
  let home: string;
  let repo: QueueRepository;
  let bus: EventBus;
  let daemon: ServerType;
  let daemonUrl: string;
  let mcp: Awaited<ReturnType<typeof startMcpHttpServer>>;
  let client: Client;
  let token: string;
  let otherToken: string;
  const savedHome = process.env.OPENRIG_HOME;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-wait-"));
    process.env.OPENRIG_HOME = home;
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    const { app } = createTestApp(db, { appDeps: { queueRepo: repo, eventBus: bus } });
    daemon = await new Promise<ServerType>(resolve => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(server));
    });
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
    const tokenFile = path.join(home, "tokens.json");
    token = await addGrant(tokenFile, { name: "lead", seat: LEAD, rigs: [], roots: [], workspace: false, owner: false });
    otherToken = await addGrant(tokenFile, { name: "other", seat: "other@elsewhere", rigs: [], roots: [], workspace: false, owner: false });
    mcp = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile });
    client = new Client({ name: "wait-fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  });

  afterEach(async () => {
    await client?.close();
    await mcp?.close();
    await new Promise<void>(resolve => { daemon.closeAllConnections(); daemon.close(() => resolve()); });
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = savedHome;
  });

  const create = (qitemId: string, destinationSession = LEAD) => repo.create({ qitemId, sourceSession: destinationSession, destinationSession, body: "Question", nudge: false });
  const answer = (qitemId: string) => repo.update({ qitemId, actorSession: LEAD, state: "done", closureReason: "no-follow-on", resolution: "The lead answer", nudge: false });
  const show = (qitemId: string, waitSeconds?: number, signal?: AbortSignal) => client.callTool({ name: "rig_queue_show", arguments: { qitemId, ...(waitSeconds === undefined ? {} : { waitSeconds }) } }, undefined, { signal });
  const raw = (key: string | undefined, body: unknown, signal?: AbortSignal) => fetch(mcp.url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body), signal,
  });

  it("returns the answer when its pending item completes during the same call", async () => {
    await create("qitem-during");
    const subscriptions = bus.subscriberCount;
    const timer = setTimeout(() => answer("qitem-during"), 150);
    try {
      const result = await show("qitem-during", 2);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ item: { qitemId: "qitem-during", state: "done", resolution: "The lead answer", closureReason: "no-follow-on" } });
      expect(result.structuredContent).not.toHaveProperty("waited");
      expect(bus.subscriberCount).toBe(subscriptions);
    } finally { clearTimeout(timer); }
  });

  it("keeps omitted/zero waits immediate and returns a ready answer without waiting", async () => {
    await create("qitem-now");
    for (const seconds of [undefined, 0]) {
      const result = await show("qitem-now", seconds);
      expect(result.structuredContent).toMatchObject({ item: { state: "pending" } });
      expect(result.structuredContent).not.toHaveProperty("waited");
    }
    answer("qitem-now");
    expect((await show("qitem-now", 50)).structuredContent).toMatchObject({ item: { state: "done", resolution: "The lead answer" } });
  });

  it("ignores a claim, progress and another item's completion, then reports an honest timeout", async () => {
    await create("qitem-still");
    await create("qitem-unrelated");
    const subscriptions = bus.subscriberCount;
    const waiting = show("qitem-still", 1);
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    repo.claim({ qitemId: "qitem-still", destinationSession: LEAD });
    repo.update({ qitemId: "qitem-still", actorSession: LEAD, transitionNote: "Working", nudge: false });
    answer("qitem-unrelated");
    const result = await waiting;
    expect(result.structuredContent).toMatchObject({ item: { qitemId: "qitem-still", state: "in-progress", resolution: null }, waited: { outcome: "timeout", seconds: 1 } });
    expect(result.structuredContent).not.toHaveProperty("item.waited");
    expect(bus.subscriberCount).toBe(subscriptions);
  });

  it("cancels the daemon subscription when the HTTP client cancels the call", async () => {
    await create("qitem-cancel");
    const subscriptions = bus.subscriberCount;
    const controller = new AbortController();
    const waiting = show("qitem-cancel", 50, controller.signal).catch((error: unknown) => error);
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    controller.abort();
    await waiting;
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions);
    expect(repo.getById("qitem-cancel")?.state).toBe("pending");
  });

  it("releases on HTTP disconnect without changing the durable task", async () => {
    await create("qitem-disconnect");
    const subscriptions = bus.subscriberCount;
    const controller = new AbortController();
    const waiting = raw(token, { jsonrpc: "2.0", id: 80, method: "tools/call", params: { name: "rig_queue_show", arguments: { qitemId: "qitem-disconnect", waitSeconds: 50 } } }, controller.signal).catch(() => undefined);
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    controller.abort();
    await waiting;
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions);
    expect(repo.getById("qitem-disconnect")?.state).toBe("pending");
  });

  it("does not let another credential cancel a wait with the same RPC id", async () => {
    await create("qitem-cancel-scope");
    const subscriptions = bus.subscriberCount;
    const waiting = raw(token, { jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "rig_queue_show", arguments: { qitemId: "qitem-cancel-scope", waitSeconds: 50 } } });
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    const notification = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 81 } };
    await (await raw(otherToken, notification)).arrayBuffer();
    expect(bus.subscriberCount).toBe(subscriptions + 1);
    await (await raw(token, notification)).arrayBuffer();
    await (await waiting).arrayBuffer();
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions);
  });

  it("requires authentication and refuses another grant's task before parking", async () => {
    await create("qitem-private", "other@elsewhere");
    const subscriptions = bus.subscriberCount;
    const body = { jsonrpc: "2.0", id: 82, method: "tools/call", params: { name: "rig_queue_show", arguments: { qitemId: "qitem-private", waitSeconds: 50 } } };
    for (const key of [undefined, "invalid"]) {
      const response = await raw(key, body);
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    const refused = await show("qitem-private", 50);
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "out_of_scope" });
    expect(bus.subscriberCount).toBe(subscriptions);
    expect((await show("qitem-missing", 50)).structuredContent).toMatchObject({ code: "qitem_not_found" });
  });

  it.each(["blocked", "failed", "denied", "canceled"] as const)("returns %s distinctly, both during and before a wait", async state => {
    const id = `qitem-${state}`;
    await create(id);
    const subscriptions = bus.subscriberCount;
    const waiting = show(id, 50);
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    repo.update({ qitemId: id, actorSession: LEAD, state, ...(state === "blocked" ? { blockedOn: "external:fixture" } : {}), nudge: false });
    for (const result of [await waiting, await show(id, 50)]) {
      expect(result.structuredContent).toMatchObject({ item: { qitemId: id, state } });
      expect(result.structuredContent).not.toHaveProperty("waited");
    }
    expect(bus.subscriberCount).toBe(subscriptions);
  });

  it("returns a handoff and its scope-filtered successor without waiting on that successor", async () => {
    await create("qitem-handoff");
    const subscriptions = bus.subscriberCount;
    const waiting = show("qitem-handoff", 50);
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    const response = await fetch(`${daemonUrl}/api/queue/qitem-handoff/handoff`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": LEAD }, body: JSON.stringify({ toSession: "next@team", nudge: false }) });
    expect(response.status).toBe(201);
    const result = await waiting;
    expect(result.structuredContent).toMatchObject({ item: { state: "handed-off", closureReason: "handed_off_to" }, successor: { unknown: true, code: "out_of_scope" } });
    expect(result.structuredContent).not.toHaveProperty("waited");
    expect(bus.subscriberCount).toBe(subscriptions);
  });

  it("survives the ordinary five-second daemon deadline using only a per-call override", async () => {
    await create("qitem-long");
    const timer = setTimeout(() => answer("qitem-long"), 5_300);
    try {
      const result = await show("qitem-long", 8);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ item: { state: "done", resolution: "The lead answer" } });
    } finally { clearTimeout(timer); }
  });

  it("supports bounded reads and cancellation on protocol2026-07-28", async () => {
    const modern = new ModernClient({ name: "modern-wait", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await modern.connect(new ModernTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      await create("qitem-modern");
      const subscriptions = bus.subscriberCount;
      const waiting = modern.callTool({ name: "rig_queue_show", arguments: { qitemId: "qitem-modern", waitSeconds: 50 } });
      await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
      answer("qitem-modern");
      expect((await waiting).structuredContent).toMatchObject({ item: { state: "done", resolution: "The lead answer" } });
      await create("qitem-modern-cancel");
      const controller = new AbortController();
      const canceled = modern.callTool({ name: "rig_queue_show", arguments: { qitemId: "qitem-modern-cancel", waitSeconds: 50 } }, { signal: controller.signal }).catch(() => undefined);
      await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
      controller.abort();
      await canceled;
      await expect.poll(() => bus.subscriberCount).toBe(subscriptions);
    } finally { await modern.close(); }
  });

  it("rejects invalid bounds on both MCP and daemon HTTP surfaces", async () => {
    await create("qitem-bounds");
    for (const seconds of [-1, 51, 0.5]) {
      expect((await show("qitem-bounds", seconds)).isError).toBe(true);
      const response = await fetch(`${daemonUrl}/api/queue/qitem-bounds?waitSeconds=${seconds}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_wait_seconds" });
    }
  });
});
