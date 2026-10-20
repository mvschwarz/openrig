/**
 * Real daemon → MCP path for READ-ONLY queue status + events replay.
 * Uses the daemon EventBus/queue routes (not mock client.get).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createMcpServer } from "../src/mcp-server.js";
import { DaemonClient } from "../src/client.js";
import { createFullTestDb } from "../../daemon/test/helpers/test-app.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { eventsRoute } from "../../daemon/src/routes/events.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";

function parseToolJson(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("MCP read-only daemon path", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let queueRepo: QueueRepository;
  let rigRepo: RigRepository;
  let app: Hono;
  let mcpClient: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    db = createFullTestDb();
    eventBus = new EventBus(db);
    queueRepo = new QueueRepository(db, eventBus);
    rigRepo = new RigRepository(db);

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, eventBus);
      c.set("queueRepo" as never, queueRepo);
      c.set("rigRepo" as never, rigRepo);
      await next();
    });
    app.get("/healthz", (c) => c.json({ status: "ok" }));
    app.route("/api/events", eventsRoute);
    app.route("/api/queue", queueRoutes());

    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return app.request(url, init);
    };
    const daemonClient = new DaemonClient("http://127.0.0.1:9", { fetchImpl });
    const server = createMcpServer(daemonClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    cleanup = async () => {
      await mcpClient.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await cleanup();
    db.close();
  });

  it("rig_queue_status returns existing qitem and 404 for missing", async () => {
    const item = await queueRepo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "hello",
    });

    const ok = await mcpClient.callTool({
      name: "rig_queue_status",
      arguments: { qitemId: item.qitemId },
    });
    expect(ok.isError).toBeFalsy();
    const body = parseToolJson(ok);
    expect(body.qitemId).toBe(item.qitemId);
    expect(body.state).toBe(item.state);

    const missing = await mcpClient.callTool({
      name: "rig_queue_status",
      arguments: { qitemId: "qitem-does-not-exist" },
    });
    expect(missing.isError).toBe(true);
    const err = parseToolJson(missing);
    expect(err.error).toBe("qitem_not_found");
  });

  it("rig_events_replay filters by rigId, respects limit, and resumes via nextCursor", async () => {
    const rigA = rigRepo.createRig("ra");
    const rigB = rigRepo.createRig("rb");
    const a1 = eventBus.emit({ type: "rig.created", rigId: rigA.id });
    const a2 = eventBus.emit({ type: "node.added", rigId: rigA.id, nodeId: "n1", logicalId: "x" });
    eventBus.emit({ type: "rig.created", rigId: rigB.id });

    const limited = await mcpClient.callTool({
      name: "rig_events_replay",
      arguments: { since: 0, rigId: rigA.id, limit: 1 },
    });
    expect(limited.isError).toBeFalsy();
    const limBody = parseToolJson(limited) as {
      events: { seq: number; rigId?: string }[];
      nextCursor: number;
    };
    expect(limBody.events).toHaveLength(1);
    expect(limBody.events[0]!.seq).toBe(a1.seq);
    expect(limBody.events.every((e) => e.rigId === rigA.id)).toBe(true);

    const resume = await mcpClient.callTool({
      name: "rig_events_replay",
      arguments: { since: limBody.nextCursor, rigId: rigA.id },
    });
    const resumeBody = parseToolJson(resume) as {
      events: { seq: number }[];
      nextCursor: number;
    };
    expect(resumeBody.events.map((e) => e.seq)).toEqual([a2.seq]);

    const empty = await mcpClient.callTool({
      name: "rig_events_replay",
      arguments: { since: resumeBody.nextCursor, rigId: rigA.id },
    });
    const emptyBody = parseToolJson(empty) as { events: unknown[]; nextCursor: number };
    expect(emptyBody.events).toEqual([]);
    expect(emptyBody.nextCursor).toBe(resumeBody.nextCursor);
  });

  it("rig_events_replay has no duplicates within a supported poll", async () => {
    const rig = rigRepo.createRig("r01");
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    const e2 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });
    const e3 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n2", logicalId: "b" });

    const result = await mcpClient.callTool({
      name: "rig_events_replay",
      arguments: { since: 0, rigId: rig.id },
    });
    const body = parseToolJson(result) as { events: { seq: number }[] };
    const seqs = body.events.map((e) => e.seq);
    expect(seqs).toEqual([e1.seq, e2.seq, e3.seq]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("expired cursor → MCP isError with cursor_expired + resyncCursor", async () => {
    const rig = rigRepo.createRig("r01");
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n2", logicalId: "b" });
    eventBus.dropRetainedThrough(e1.seq);
    const oldest = eventBus.oldestSeq();

    const result = await mcpClient.callTool({
      name: "rig_events_replay",
      arguments: { since: 0, rigId: rig.id },
    });
    expect(result.isError).toBe(true);
    const body = parseToolJson(result);
    expect(body.error).toBe("cursor_expired");
    expect(body.oldestSeq).toBe(oldest);
    expect(body.resyncCursor).toBe(oldest - 1);
  });

  it("resync after expiry replays retained events only (no invented history)", async () => {
    const rig = rigRepo.createRig("r01");
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    const e2 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });
    const e3 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n2", logicalId: "b" });
    eventBus.dropRetainedThrough(e1.seq);

    const expired = await mcpClient.callTool({
      name: "rig_events_replay",
      arguments: { since: 0, rigId: rig.id },
    });
    expect(expired.isError).toBe(true);
    const { resyncCursor } = parseToolJson(expired) as { resyncCursor: number };

    const ok = await mcpClient.callTool({
      name: "rig_events_replay",
      arguments: { since: resyncCursor, rigId: rig.id },
    });
    expect(ok.isError).toBeFalsy();
    const body = parseToolJson(ok) as { events: { seq: number }[] };
    expect(body.events.map((e) => e.seq)).toEqual([e2.seq, e3.seq]);
    expect(body.events.map((e) => e.seq)).not.toContain(e1.seq);
    expect(new Set(body.events.map((e) => e.seq)).size).toBe(body.events.length);
  });
});
