import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("client disconnect during replay releases the subscription", async () => {
    const rig = rigRepo.createRig("r01");
    eventBus.emit({ type: "rig.created", rigId: rig.id });
    const countBefore = eventBus.subscriberCount;
    const res = await app.request(`/api/events?rigId=${rig.id}`);
    expect(eventBus.subscriberCount).toBe(countBefore + 1);
    await res.body?.cancel();
    await vi.waitFor(() => expect(eventBus.subscriberCount).toBe(countBefore), { timeout: 1000 });
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

  it("missing rigId -> global SSE stream (200)", async () => {
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Cancel the stream
    if (res.body) {
      const reader = res.body.getReader();
      reader.cancel().catch(() => {});
    }
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

  describe("replay without Last-Event-ID", () => {
    const emitMany = (rigId: string, count: number) =>
      Array.from({ length: count }, (_, i) => eventBus.emit({ type: "node.added", rigId, nodeId: `n${i}`, logicalId: `w${i}` }).seq);
    const ids = (events: { id: string }[]) => events.map((e) => Number(e.id));

    it("replays the whole log by default, as before", async () => {
      const rig = rigRepo.createRig("r01");
      const seqs = emitMany(rig.id, 103);
      const events = await readSSEEvents(await app.request(`/api/events?rigId=${rig.id}`), 103, 2000);
      expect(ids(events)).toEqual(seqs);
    });

    it("replay=<n> replays the newest n, replay=0 starts from now, replay=all replays the whole log", async () => {
      const rig = rigRepo.createRig("r01");
      const seqs = emitMany(rig.id, 5);
      expect(ids(await readSSEEvents(await app.request(`/api/events?rigId=${rig.id}&replay=2`), 5))).toEqual(seqs.slice(-2));
      expect(ids(await readSSEEvents(await app.request(`/api/events?replay=all`), 5))).toEqual(seqs);

      const live = await app.request(`/api/events?rigId=${rig.id}&replay=0`);
      setTimeout(() => eventBus.emit({ type: "rig.created", rigId: rig.id }), 10);
      const events = await readSSEEvents(live, 2);
      expect(events.map((e) => JSON.parse(e.data).type)).toEqual(["rig.created"]);
    });

    it("Last-Event-ID, which EventSource sends when it reconnects, wins over replay", async () => {
      const rig = rigRepo.createRig("r01");
      const seqs = emitMany(rig.id, 3);
      const res = await app.request(`/api/events?rigId=${rig.id}&replay=0`, { headers: { "Last-Event-ID": String(seqs[0]) } });
      expect(ids(await readSSEEvents(res, 3))).toEqual(seqs.slice(1));
    });

    it("a count beyond SQLite's integers replays the whole log", async () => {
      const rig = rigRepo.createRig("r01");
      const seqs = emitMany(rig.id, 3);
      for (const count of ["100000000000000000000", "9".repeat(400)]) {
        const res = await app.request(`/api/events?rigId=${rig.id}&replay=${count}`);
        expect(ids(await readSSEEvents(res, 3)), count).toEqual(seqs);
      }
    });

    it("a replay that fails to start releases its subscription", async () => {
      const rig = rigRepo.createRig("r01");
      emitMany(rig.id, 3);
      const countBefore = eventBus.subscriberCount;
      vi.spyOn(eventBus, "seqBeforeNewest").mockImplementation(() => {
        throw new Error("lookup failed");
      });
      const res = await app.request(`/api/events?rigId=${rig.id}&replay=2`);
      await readSSEEvents(res, 1, 200);
      await vi.waitFor(() => expect(eventBus.subscriberCount).toBe(countBefore), { timeout: 1000 });
    });

    it("replays the whole log, as before, for a replay that is neither a count nor all", async () => {
      const rig = rigRepo.createRig("r01");
      const seqs = emitMany(rig.id, 3);
      const values = ["-1", "1.5", "some", "", "%2B1", "%20", "1e2", "0x10", "ALL", "Infinity", "NaN", "%D9%A1", "1%0A"];
      for (const value of values) {
        const res = await app.request(`/api/events?rigId=${rig.id}&replay=${value}`);
        expect(res.status, value).toBe(200);
        expect(ids(await readSSEEvents(res, 3)), value).toEqual(seqs);
      }
      const duplicate = await app.request(`/api/events?rigId=${rig.id}&replay=some&replay=0`);
      expect(ids(await readSSEEvents(duplicate, 3))).toEqual(seqs);
    });

    it("Last-Event-ID resumes as before when replay is not recognized", async () => {
      const rig = rigRepo.createRig("r01");
      const seqs = emitMany(rig.id, 3);
      for (const value of ["some", "-1", ""]) {
        const res = await app.request(`/api/events?rigId=${rig.id}&replay=${value}`, { headers: { "Last-Event-ID": String(seqs[1]) } });
        expect(ids(await readSSEEvents(res, 3, 200)), value).toEqual(seqs.slice(2));
      }
      const unparsed = await app.request(`/api/events?rigId=${rig.id}&replay=some`, { headers: { "Last-Event-ID": "abc" } });
      expect(ids(await readSSEEvents(unparsed, 3))).toEqual(seqs);
    });

    it("streams a long replay a page at a time, every event once and in order", async () => {
      const rig = rigRepo.createRig("r01");
      const seqs = emitMany(rig.id, 1201);
      const replayAll = vi.spyOn(eventBus, "replayAll");
      const page = vi.spyOn(eventBus, "replayPage");
      const events = await readSSEEvents(await app.request(`/api/events?replay=all`), 1201, 5000);
      expect(ids(events)).toEqual(seqs);
      expect(replayAll).not.toHaveBeenCalled();
      expect(page.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it.each([
      ["replay=all", {}],
      ["Last-Event-ID", { "Last-Event-ID": "0" }],
    ])("a replay (%s) ends at the newest event stored as it connects, those arriving meanwhile sent once after it", async (_, headers) => {
      const rig = rigRepo.createRig("r01");
      const seqs = emitMany(rig.id, 1201);
      const replayPage = eventBus.replayPage.bind(eventBus);
      const emitted: number[] = [];
      const page = vi.spyOn(eventBus, "replayPage").mockImplementation((...args) => {
        emitted.push(eventBus.emit({ type: "rig.created", rigId: rig.id }).seq);
        return replayPage(...args);
      });
      const res = await app.request(`/api/events?rigId=${rig.id}&replay=all`, { headers });
      const events = await readSSEEvents(res, 1201 + 50, 1500);
      expect(page.mock.calls.length).toBeLessThanOrEqual(4);
      expect(ids(events)).toEqual([...seqs, ...emitted]);
    });
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
