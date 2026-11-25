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
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { getSelfHostId, setSelfHostId } from "../../daemon/src/domain/hosts/fanout-contract.js";
import { makeQueuePorts } from "../../daemon/src/domain/gateway/slack/queue-access.js";
import type { LoadResult } from "../../daemon/src/domain/gateway/human-registry.js";
import { addGrant, startMcpHttpServer } from "../src/mcp-http.js";

const LEAD = "lead@team";

describe("bounded rig_queue_show over HTTP", () => {
  let db: Database.Database;
  let home: string;
  let dbPath: string;
  let repo: QueueRepository;
  let bus: EventBus;
  let daemon: ServerType;
  let daemonUrl: string;
  let mcp: Awaited<ReturnType<typeof startMcpHttpServer>>;
  let client: Client;
  let token: string;
  let otherToken: string;
  let recipientRegistered: boolean;
  let registryUnreadable: boolean;
  let interceptDaemon: ((request: Request) => Promise<Response | undefined>) | undefined;
  const savedHome = process.env.OPENRIG_HOME;
  const savedDb = process.env.OPENRIG_DB;
  const savedSelf = getSelfHostId();

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-wait-"));
    process.env.OPENRIG_HOME = home;
    dbPath = path.join(home, "queue.sqlite");
    process.env.OPENRIG_DB = dbPath;
    db = createDb(dbPath);
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO self_host_identity VALUES (1, 'queue-wait-fixture', '', '')").run();
    setSelfHostId("queue-wait-fixture");
    bus = new EventBus(db);
    recipientRegistered = true;
    registryUnreadable = false;
    interceptDaemon = undefined;
    repo = makeRepo();
    daemon = await startDaemon(0);
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
    const tokenFile = path.join(home, "tokens.json");
    token = await addGrant(tokenFile, { name: "lead", seat: LEAD, rigs: [], roots: [], workspace: false, owner: false, person: "fixture-person" });
    otherToken = await addGrant(tokenFile, { name: "other", seat: "other@elsewhere", rigs: [], roots: [], workspace: false, owner: false });
    mcp = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile });
    client = new Client({ name: "wait-fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  });

  function loadPeople(): LoadResult {
    if (registryUnreadable) return { ok: false, error: "fixture registry unreadable" };
    return { ok: true, entities: recipientRegistered
      ? [{ entityId: "fixture-person", class: "human", address: "fixture-person@external", displayName: "Fixture Person",
        connectorBindings: [{ kind: "slack", connectorRef: "fixture", secretsRef: "fixture", role: "primary", handle: "U123456" }],
        prefs: { deliveryClass: "A" } }] : [] };
  }

  function makeRepo() {
    const queue = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: loadPeople });
    queue.attachOutbox(new OutboxHandler(db));
    return queue;
  }

  function startDaemon(port: number) {
    const { app } = createTestApp(db, { appDeps: { queueRepo: repo, eventBus: bus } });
    return new Promise<ServerType>(resolve => {
      const server = serve({ fetch: async (request, env) => {
        return await interceptDaemon?.(request) ?? app.fetch(request, env);
      }, port, hostname: "127.0.0.1" }, () => resolve(server));
    });
  }

  function stopDaemon() {
    return new Promise<void>(resolve => { daemon.closeAllConnections(); daemon.close(() => resolve()); });
  }

  afterEach(async () => {
    await client?.close();
    await mcp?.close();
    await stopDaemon();
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = savedHome;
    if (savedDb === undefined) delete process.env.OPENRIG_DB; else process.env.OPENRIG_DB = savedDb;
    setSelfHostId(savedSelf);
  });

  const create = (qitemId: string, destinationSession = LEAD) => repo.create({ qitemId, sourceSession: destinationSession, destinationSession, body: "Question", nudge: false });
  const answer = (qitemId: string) => repo.update({ qitemId, actorSession: LEAD, state: "done", closureReason: "no-follow-on", resolution: "The lead answer", nudge: false });
  const show = (qitemId: string, waitSeconds?: number, signal?: AbortSignal) => client.callTool({ name: "rig_queue_show", arguments: { qitemId, ...(waitSeconds === undefined ? {} : { waitSeconds }) } }, undefined, { signal });
  const raw = (key: string | undefined, body: unknown, signal?: AbortSignal) => fetch(mcp.url, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body), signal,
  });

  const lateQuestion = async (qitemId: string, expectedState = "waiting") => {
    const result = await client.callTool({ name: "rig_queue_create", arguments: {
      qitemId, destination: LEAD, body: "Question", lateAnswer: true,
    } });
    expect(result.isError, JSON.stringify(result.structuredContent ?? result.content)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ qitemId, lateAnswer: { state: expectedState } });
    return (result.structuredContent?.lateAnswer as { deliveryId: string }).deliveryId;
  };
  const lateAnswer = (qitemId: string, sender = LEAD) => fetch(`${daemonUrl}/api/queue/${qitemId}/update`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": sender },
    body: JSON.stringify({ state: "done", closureReason: "no-follow-on", resolution: "The lead answer" }),
  });
  const lateStatus = async (qitemId: string) => (await (await fetch(`${daemonUrl}/api/queue/${qitemId}`)).json()).lateAnswer;
  const stop = (id: string, principal = "lead", recipient = "fixture-person@external") => fetch(`${daemonUrl}/api/queue/${id}/wait-stopped`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": LEAD,
      "X-OpenRig-Principal": JSON.stringify({ source: "file", id: principal }) },
    body: JSON.stringify({ recipient }),
  });
  const rawWait = (qitemId: string, id: number, signal: AbortSignal) => raw(token, {
    jsonrpc: "2.0", id, method: "tools/call", params: { name: "rig_queue_show", arguments: { qitemId, waitSeconds: 50 } },
  }, signal).catch(() => undefined);
  const manualUpdate = (deliveryId: string, body = "Manual lead update") => fetch(`${daemonUrl}/api/queue/create`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": LEAD },
    body: JSON.stringify({ qitemId: deliveryId, destinationSession: "fixture-person@external", humanIntent: "update", body, summary: body }),
  });
  const gatewayNotices = () => makeQueuePorts(repo, { loadHumanRegistry: loadPeople }).listHumanAlerts({});

  it.each(["blocked", "handed-off"] as const)("records a normal %s wait return without an answer", async state => {
    const id = `qitem-late-return-${state}`;
    const deliveryId = await lateQuestion(id);
    const subscriptions = bus.subscriberCount;
    const waiting = show(id, 5);
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    if (state === "blocked") repo.update({ qitemId: id, actorSession: LEAD, state, blockedOn: "external:fixture-dependency" });
    else await repo.handoff({ qitemId: id, fromSession: LEAD, toSession: "other@team", nudge: false });

    expect((await waiting).structuredContent).toMatchObject({ item: { state }, followUp: "recorded" });
    const { followUpId } = await lateStatus(id);
    expect(repo.getById(followUpId)).toMatchObject({ destinationSession: LEAD, state: "pending" });
    expect(await gatewayNotices()).toEqual([]);
    if (state === "blocked") {
      expect((await lateAnswer(id)).status).toBe(200);
      expect(await gatewayNotices()).toEqual([expect.objectContaining({ qitemId: deliveryId, body: "The lead answer" })]);
    }
  });

  it("retries the same disconnected wait stop after two transient failures", async () => {
    const id = "qitem-late-retry-disconnect";
    await lateQuestion(id);
    let attempts = 0;
    interceptDaemon = async request => {
      if (new URL(request.url).pathname === `/api/queue/${id}/wait-stopped` && ++attempts <= 2) return new Response(null, { status: 503 });
      return undefined;
    };
    const subscriptions = bus.subscriberCount;
    const controller = new AbortController();
    const waiting = rawWait(id, 122, controller.signal);
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    controller.abort();
    await waiting;
    await expect.poll(() => lateStatus(id)).toMatchObject({ state: "waiting-for-answer", followUpId: expect.any(String) });
    expect(attempts).toBe(3);
  });

  it("queues one registered-person update when the caller hangs up before the lead answers", async () => {
    const id = "qitem-late-disconnect";
    const deliveryId = await lateQuestion(id);
    const subscriptions = bus.subscriberCount;
    const controller = new AbortController();
    const waiting = rawWait(id, 120, controller.signal);
    await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
    controller.abort();
    await waiting;
    await expect.poll(() => lateStatus(id)).toMatchObject({ deliveryId, state: "waiting-for-answer", followUpId: expect.any(String) });
    const { followUpId } = await lateStatus(id);
    expect(repo.getById(followUpId)).toMatchObject({ destinationSession: LEAD, state: "pending" });
    expect((await lateAnswer(id)).status).toBe(200);
    expect(await lateStatus(id)).toMatchObject({ deliveryId, state: "queued" });
    expect(repo.getById(deliveryId)).toMatchObject({ sourceSession: LEAD, destinationSession: "fixture-person@external",
      humanIntent: "update", body: "The lead answer" });
    expect(repo.getById(followUpId)?.state).toBe("done");
  });

  it("reconciles an already recorded answer when the caller's stop arrives afterward", async () => {
    const id = "qitem-late-reverse";
    const deliveryId = await lateQuestion(id);
    expect((await lateAnswer(id)).status).toBe(200);
    expect(repo.getById(deliveryId)).toBeNull();
    for (const response of await Promise.all([stop(id), stop(id)])) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ lateAnswer: { deliveryId, state: "queued" } });
    }
    expect(repo.getById(deliveryId)).toMatchObject({ humanIntent: "update", body: "The lead answer" });
  });

  it("queues the ready answer if the HTTP response is lost after the lead closes the question", async () => {
    const id = "qitem-late-lost-response";
    const deliveryId = await lateQuestion(id);
    const { promise, resolve: release } = Promise.withResolvers<void>();
    let readingTransitions = false;
    interceptDaemon = async request => {
      if (new URL(request.url).pathname !== `/api/queue/${id}/transitions`) return;
      readingTransitions = true;
      await promise;
    };
    const subscriptions = bus.subscriberCount;
    const controller = new AbortController();
    const waiting = rawWait(id, 121, controller.signal);
    try {
      await expect.poll(() => bus.subscriberCount).toBe(subscriptions + 1);
      expect((await lateAnswer(id)).status).toBe(200);
      await expect.poll(() => readingTransitions).toBe(true);
      expect(repo.getById(deliveryId)).toBeNull();
      controller.abort();
      await waiting;
      await expect.poll(() => lateStatus(id)).toMatchObject({ deliveryId, state: "queued" });
      expect(await gatewayNotices()).toEqual([expect.objectContaining({ qitemId: deliveryId, body: "The lead answer" })]);
    } finally {
      release();
    }
  });

  it("recovers a timed-out wait after reopening the daemon database and gives the gateway one stable update", async () => {
    const id = "qitem-late-restart";
    const deliveryId = await lateQuestion(id);
    expect((await show(id, 1)).structuredContent).toMatchObject({ waited: { outcome: "timeout", seconds: 1, followUp: "recorded" } });
    await stopDaemon();
    db.close();
    db = createDb(dbPath);
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = makeRepo();
    daemon = await startDaemon(0);
    daemonUrl = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
    expect(await lateStatus(id)).toMatchObject({ deliveryId, state: "waiting-for-answer" });
    expect((await lateAnswer(id)).status).toBe(200);
    expect((await stop(id)).status).toBe(200);
    expect(await gatewayNotices()).toEqual([expect.objectContaining({ qitemId: deliveryId, humanIntent: "update", body: "The lead answer" })]);
    expect(await lateStatus(id)).toMatchObject({ deliveryId, state: "queued", deliveryOutcome: null });
  });

  it.each(["manual", "automatic", "concurrent"])("coalesces the %s path and its retry into one gateway notice", async order => {
    const id = `qitem-late-race-${order}`;
    const deliveryId = await lateQuestion(id);
    expect((await stop(id)).status).toBe(200);
    const automatic = () => lateAnswer(id);
    const manual = () => manualUpdate(deliveryId);
    if (order === "concurrent") {
      expect((await Promise.all([manual(), automatic()])).map(reply => reply.status)).toEqual([201, 200]);
    } else if (order === "manual") {
      expect((await manual()).status).toBe(201);
      expect((await automatic()).status).toBe(200);
    } else {
      expect((await automatic()).status).toBe(200);
      expect((await manual()).status).toBe(201);
    }
    const retry = await manual();
    expect(await retry.json()).toMatchObject({ qitemId: deliveryId, humanIntent: "update" });
    const expectedBody = order === "manual" ? "Manual lead update" : order === "automatic" ? "The lead answer" : expect.any(String);
    expect(await gatewayNotices()).toEqual([expect.objectContaining({ qitemId: deliveryId, humanIntent: "update", body: expectedBody })]);
    const status = await lateStatus(id);
    const answerMatches = repo.getById(deliveryId)?.body === "The lead answer";
    expect(status).toMatchObject({ deliveryId, state: answerMatches ? "queued" : "manual-required" });
    expect(repo.getById(status.followUpId)?.state).toBe(answerMatches ? "done" : "pending");
  });

  it("treats a matching manual answer as queued and returns a reopened question to the lead", async () => {
    const id = "qitem-late-reopened";
    const deliveryId = await lateQuestion(id);
    expect((await manualUpdate(deliveryId, "The lead answer")).status).toBe(201);
    expect((await stop(id)).status).toBe(200);
    expect((await lateAnswer(id)).status).toBe(200);
    const { followUpId } = await lateStatus(id);
    expect(await lateStatus(id)).toMatchObject({ deliveryId, state: "queued" });
    expect(repo.getById(followUpId)?.state).toBe("done");
    repo.update({ qitemId: id, actorSession: LEAD, state: "pending", reopen: true, transitionNote: "Check the answer again" });
    expect(await lateStatus(id)).toMatchObject({ deliveryId, state: "manual-required", deliveryOutcome: null, followUpId });
    expect(repo.getById(followUpId)?.state).toBe("pending");
    expect((await lateAnswer(id)).status).toBe(200);
    expect(await lateStatus(id)).toMatchObject({ deliveryId, state: "manual-required" });
    expect(await gatewayNotices()).toEqual([expect.objectContaining({ qitemId: deliveryId, body: "The lead answer" })]);
  });

  it("keeps the question and the grant binding when the registry cannot be read", async () => {
    const id = "qitem-late-unreadable";
    registryUnreadable = true;
    const deliveryId = await lateQuestion(id, "manual-required");
    expect(await lateStatus(id)).toMatchObject({ deliveryId, recipient: "fixture-person@external", state: "manual-required" });
    expect((await stop(id)).status).toBe(200);
    expect((await lateAnswer(id)).status).toBe(200);
    const { followUpId } = await lateStatus(id);
    expect(repo.getById(followUpId)).toMatchObject({ destinationSession: LEAD, state: "pending" });
    expect(repo.getById(deliveryId)).toBeNull();
  });

  it("keeps the ordinary answer read and rejects a stop from another grant or recipient", async () => {
    const id = "qitem-late-normal";
    const deliveryId = await lateQuestion(id);
    expect((await stop(id, "other")).status).toBe(404);
    expect((await stop(id, "lead", "somebody-else@external")).status).toBe(404);
    expect((await lateAnswer(id)).status).toBe(200);
    expect((await show(id, 50)).structuredContent).toMatchObject({ item: { state: "done", resolution: "The lead answer" } });
    expect(await lateStatus(id)).toMatchObject({ deliveryId, state: "waiting" });
    expect(await gatewayNotices()).toEqual([]);
  });

  it("leaves work for the selected lead if the person is removed or a different actor supplies the resolution", async () => {
    for (const cause of ["recipient-removed", "other-actor"]) {
      const id = `qitem-late-${cause}`;
      recipientRegistered = true;
      const deliveryId = await lateQuestion(id);
      expect((await stop(id)).status).toBe(200);
      if (cause === "recipient-removed") recipientRegistered = false;
      expect((await lateAnswer(id, cause === "other-actor" ? "other@team" : LEAD)).status).toBe(200);
      const status = await lateStatus(id);
      expect(status).toMatchObject({ deliveryId, state: "manual-required", followUpId: expect.any(String) });
      expect(repo.getById(status.followUpId)).toMatchObject({ destinationSession: LEAD, state: "pending" });
      expect(repo.getById(deliveryId)).toBeNull();
    }
  });

  it("rejects the opt-in without the grant's registered person or an explicit lead", async () => {
    recipientRegistered = false;
    for (const destination of ["lead", LEAD]) {
      const id = `qitem-late-refused-${destination === LEAD ? "person" : "lead"}`;
      const result = await client.callTool({ name: "rig_queue_create", arguments: { qitemId: id, destination, body: "Question", lateAnswer: true } });
      expect(result.structuredContent).toMatchObject({ code: "late_answer_refused" });
      expect(repo.getById(id)).toBeNull();
    }
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
