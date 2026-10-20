import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { EventBus } from "../src/domain/event-bus.js";

async function readSSEEvents(
  res: Response,
  count: number,
  timeoutMs = 500,
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
        setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (done && !value) break;
    if (value) buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop()!;
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

describe("Durable event cursor contract (Phase 4)", () => {
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

  it("JSON replay returns nextCursor and dedups by seq", async () => {
    const rig = rigRepo.createRig("r01");
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    const e2 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });

    const res = await app.request(`/api/events/replay?rigId=${rig.id}&since=0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { seq: number }[];
      nextCursor: number;
    };
    expect(body.events.map((e) => e.seq)).toEqual([e1.seq, e2.seq]);
    expect(body.nextCursor).toBe(e2.seq);

    const again = await app.request(`/api/events/replay?rigId=${rig.id}&since=${e2.seq}`);
    const body2 = (await again.json()) as { events: unknown[]; nextCursor: number };
    expect(body2.events).toEqual([]);
    expect(body2.nextCursor).toBe(e2.seq);
  });

  it("expired cursor (behind retained frontier) → 410 on JSON replay", async () => {
    const rig = rigRepo.createRig("r01");
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n2", logicalId: "b" });
    eventBus.dropRetainedThrough(e1.seq);
    const oldest = eventBus.oldestSeq();
    expect(oldest).toBeGreaterThan(e1.seq);

    const res = await app.request(`/api/events/replay?rigId=${rig.id}&since=0`);
    expect(res.status).toBe(410);
    const body = (await res.json()) as {
      error: string;
      oldestSeq: number;
      resyncCursor: number;
    };
    expect(body.error).toBe("cursor_expired");
    expect(body.oldestSeq).toBe(oldest);
    expect(body.resyncCursor).toBe(oldest - 1);
  });

  it("expired Last-Event-ID → 410 on SSE subscribe", async () => {
    const rig = rigRepo.createRig("r01");
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });
    eventBus.dropRetainedThrough(e1.seq);

    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": "0" },
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cursor_expired");
  });

  it("resync cursor after expiry replays retained events without duplicates", async () => {
    const rig = rigRepo.createRig("r01");
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    const e2 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });
    const e3 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n2", logicalId: "b" });
    eventBus.dropRetainedThrough(e1.seq);

    const bad = await app.request(`/api/events/replay?rigId=${rig.id}&since=0`);
    expect(bad.status).toBe(410);
    const { resyncCursor } = (await bad.json()) as { resyncCursor: number };

    const ok = await app.request(`/api/events/replay?rigId=${rig.id}&since=${resyncCursor}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { events: { seq: number }[] };
    expect(body.events.map((e) => e.seq)).toEqual([e2.seq, e3.seq]);
    expect(new Set(body.events.map((e) => e.seq)).size).toBe(body.events.length);
  });

  it("SSE replay with valid cursor still dedups live overlap", async () => {
    const rig = rigRepo.createRig("r01");
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });

    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": String(e1.seq) },
    });
    setTimeout(() => {
      eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n2", logicalId: "b" });
    }, 10);
    const events = await readSSEEvents(res, 3, 1000);
    const seqs = events.map((e) => e.id);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.length).toBe(2);
  });
});
