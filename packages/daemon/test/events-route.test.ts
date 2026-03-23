import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { EventBus } from "../src/domain/event-bus.js";
import { createDaemon } from "../src/startup.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";

/**
 * Read SSE lines from a streaming response until we have enough or timeout.
 * Returns parsed SSE events as { id, data } objects.
 */
async function readSSEEvents(
  res: Response,
  count: number,
  timeoutMs = 500
): Promise<{ id: string; data: string }[]> {
  const events: { id: string; data: string }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const deadline = Date.now() + timeoutMs;

  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))
      ),
    ]);

    if (done && !value) break;
    if (value) buffer += decoder.decode(value, { stream: true });

    // Parse complete SSE blocks (separated by \n\n)
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop()!; // keep incomplete block

    for (const block of blocks) {
      if (!block.trim()) continue;
      let id = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (data) events.push({ id, data });
    }
  }

  reader.cancel().catch(() => {});
  return events;
}

describe("SSE events route", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    eventBus = setup.eventBus;
  });

  afterEach(() => {
    db.close();
  });

  it("connect to SSE -> receives content-type text/event-stream", async () => {
    const rig = rigRepo.createRig("r01");
    const res = await app.request(`/api/events?rigId=${rig.id}`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Cancel the stream
    res.body?.cancel();
  });

  it("emit event on bus -> received on stream as SSE data line with id field", async () => {
    const rig = rigRepo.createRig("r01");

    const res = await app.request(`/api/events?rigId=${rig.id}`);

    // Emit after connection
    setTimeout(() => {
      eventBus.emit({ type: "rig.created", rigId: rig.id });
    }, 10);

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBeDefined();
    expect(events[0]!.id).not.toBe("");
    const parsed = JSON.parse(events[0]!.data);
    expect(parsed.type).toBe("rig.created");
  });

  it("Last-Event-ID replay: connect with header, get missed events from DB", async () => {
    const rig = rigRepo.createRig("r01");

    // Pre-emit events before connecting
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    const e2 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "worker" });

    // Connect with Last-Event-ID = e1.seq (should replay e2 only)
    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": String(e1.seq) },
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]!.data);
    expect(parsed.type).toBe("node.added");
    expect(events[0]!.id).toBe(String(e2.seq));
  });

  it("no gap: event emitted during replay window delivered exactly once", async () => {
    const rig = rigRepo.createRig("r01");

    // Pre-emit 2 events
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });

    // Connect with Last-Event-ID = e1.seq
    // Then immediately emit another event that could land in the replay/live overlap
    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": String(e1.seq) },
    });

    // Emit during the replay window
    setTimeout(() => {
      eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n2", logicalId: "b" });
    }, 10);

    const events = await readSSEEvents(res, 3, 1000);

    // Should have exactly 2: the replayed e2 + the live e3
    // e2 should appear exactly once (dedup by seq)
    const seqs = events.map((e) => e.id);
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(seqs.length); // no duplicates
    expect(events.length).toBe(2);
  });

  it("client disconnect -> subscriber cleaned up (subscriberCount drops)", async () => {
    const rig = rigRepo.createRig("r01");
    const countBefore = eventBus.subscriberCount;

    const res = await app.request(`/api/events?rigId=${rig.id}`);

    // Give the stream a moment to establish the subscription
    await new Promise((r) => setTimeout(r, 50));
    expect(eventBus.subscriberCount).toBe(countBefore + 1);

    // Read one event then cancel (disconnect)
    setTimeout(() => {
      eventBus.emit({ type: "rig.created", rigId: rig.id });
    }, 10);
    await readSSEEvents(res, 1);

    // readSSEEvents calls reader.cancel() — give the stream time to clean up
    await new Promise((r) => setTimeout(r, 100));
    expect(eventBus.subscriberCount).toBe(countBefore);
  });

  it("rigId filter: only events for requested rig are streamed", async () => {
    const rig1 = rigRepo.createRig("r01");
    const rig2 = rigRepo.createRig("r02");

    const res = await app.request(`/api/events?rigId=${rig1.id}`);

    setTimeout(() => {
      eventBus.emit({ type: "rig.created", rigId: rig2.id }); // different rig
      eventBus.emit({ type: "rig.created", rigId: rig1.id }); // target rig
    }, 10);

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]!.data);
    expect(parsed.rigId).toBe(rig1.id);
  });

  it("missing rigId -> 400", async () => {
    const res = await app.request("/api/events");
    expect(res.status).toBe(400);
  });

  it("invalid Last-Event-ID (non-numeric) -> treated as 0, replays all", async () => {
    const rig = rigRepo.createRig("r01");
    eventBus.emit({ type: "rig.created", rigId: rig.id });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "worker" });

    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": "garbage" },
    });

    // Should replay all events (treating malformed as 0)
    const events = await readSSEEvents(res, 2);
    expect(events).toHaveLength(2);
  });

  it("SSE id field matches event seq number", async () => {
    const rig = rigRepo.createRig("r01");
    const emitted = eventBus.emit({ type: "rig.created", rigId: rig.id });

    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": "0" },
    });

    const events = await readSSEEvents(res, 1);
    expect(events[0]!.id).toBe(String(emitted.seq));
  });

  it("production app mounts /api/events (regression)", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app: prodApp, db: prodDb, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    const rig = deps.rigRepo.createRig("r01");

    const res = await prodApp.request(`/api/events?rigId=${rig.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    res.body?.cancel();

    prodDb.close();
  });
});
