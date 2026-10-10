import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { SSEStreamingApi } from "hono/streaming";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { chatMessagesSchema } from "../src/db/migrations/016_chat_messages.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ChatRepository } from "../src/domain/chat-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { chatRoutes } from "../src/routes/chat.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, chatMessagesSchema]);
  return db;
}

function createApp(opts: { db: Database.Database; chatRepo: ChatRepository; eventBus: EventBus }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("chatRepo" as never, opts.chatRepo);
    c.set("eventBus" as never, opts.eventBus);
    await next();
  });
  // Mount with rigId as param
  app.route("/api/rigs/:rigId/chat", chatRoutes());
  return app;
}

describe("chat routes", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let chatRepo: ChatRepository;
  let eventBus: EventBus;
  let app: Hono;
  let rigId: string;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    chatRepo = new ChatRepository(db);
    eventBus = new EventBus(db);
    app = createApp({ db, chatRepo, eventBus });
    const rig = rigRepo.createRig("test-rig");
    rigId = rig.id;
  });

  afterEach(() => {
    db.close();
  });

  it.each([
    ["send", null], ["send", []], ["send", "text"], ["send", { body: 42 }],
    ["send", { body: "message", sender: 42 }],
    ["topic", null], ["topic", []], ["topic", { topic: 42 }],
    ["topic", { topic: "discussion", body: 42 }],
    ["topic", { topic: "discussion", sender: 42 }],
  ])("rejects malformed %s payload before persistence or emission: %j", async (route, payload) => {
    const emit = vi.spyOn(eventBus, "emit");
    const response = await app.request(`/api/rigs/${rigId}/chat/${route}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "wire@rig" },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(400);
    expect(chatRepo.history(rigId)).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("keeps optional empty topic body and transport sender precedence: %s", async body => {
    const response = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "wire@rig" },
      body: JSON.stringify({ topic: "discussion", sender: "claimed@rig", body }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sender: "wire@rig", topic: "discussion", body: "" });
  });

  it.each([false, true])("watch drains buffered messages before switching to live delivery (late arrival: %s)", async lateArrival => {
    const history = [chatRepo.send(rigId, "alice", "history one"), chatRepo.send(rigId, "alice", "history two")];
    const expected = [...history];
    const send = (body: string) => {
      const message = chatRepo.send(rigId, "bob", body);
      expected.push(message);
      eventBus.emit({ type: "chat.message", rigId, messageId: message.id, sender: message.sender,
        kind: message.kind, body: message.body });
    };
    const original = SSEStreamingApi.prototype.writeSSE;
    let initialInjected = false;
    let lateInjected = false;
    // Observe real Hono writes, retaining its TransformStream/backpressure.
    // Schedule arrivals at replay and drain boundaries instead of racing sleeps.
    const writes = vi.spyOn(SSEStreamingApi.prototype, "writeSSE").mockImplementation(function (message) {
      const body = JSON.parse(String(message.data)).body;
      const writing = original.call(this, message);
      if (!initialInjected) {
        initialInjected = true;
        send("buffered one");
        send("buffered two");
      } else if (lateArrival && body === "buffered one" && !lateInjected) {
        lateInjected = true;
        send("arrived during drain");
      }
      return writing;
    });
    const before = eventBus.subscriberCount;
    const response = await app.request(`/api/rigs/${rigId}/chat/watch`);
    const reader = response.body!.getReader();
    const observed: string[] = [];
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      while (observed.length < (lateArrival ? 5 : 4)) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop()!;
        for (const frame of frames) {
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) observed.push(JSON.parse(data.slice(6)).id);
        }
      }
      expect(observed).toEqual(expected.map(message => message.id));
      expect(new Set(observed).size).toBe(observed.length);
      expect(chatRepo.history(rigId).map(message => message.id)).toEqual(observed);
    } finally {
      await reader.cancel();
      reader.releaseLock();
      writes.mockRestore();
      await vi.waitFor(() => expect(eventBus.subscriberCount).toBe(before));
    }
  });

  it("watch disconnect during history releases the subscription", async () => {
    chatRepo.send(rigId, "alice", "existing history");
    const before = eventBus.subscriberCount;
    const res = await app.request(`/api/rigs/${rigId}/chat/watch`);
    expect(eventBus.subscriberCount).toBe(before + 1);
    await res.body?.cancel();
    await vi.waitFor(() => expect(eventBus.subscriberCount).toBe(before), { timeout: 1000 });
  });

  it("history returns same-day rows after an ISO UTC cutoff", async () => {
    const message = chatRepo.send(rigId, "alice", "same day");
    db.prepare("UPDATE chat_messages SET created_at = '2026-09-30 12:00:00' WHERE id = ?").run(message.id);
    const response = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("2026-09-30T11:00:00Z")}`);
    expect(response.status).toBe(200);
    expect((await response.json()).map((row: { id: string }) => row.id)).toEqual([message.id]);
  });

  it("POST /send persists + returns", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" }, // P21 I5: sender from the transport header (equal body claim tolerated)
      body: JSON.stringify({ sender: "alice", body: "hello" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.sender).toBe("alice");
    expect(data.body).toBe("hello");
    expect(data.id).toBeTruthy();
  });

  // P21 I5 — chat send derives the sender from the transport header (X-OpenRig-Session), never
  // body.sender (the `?? "anonymous"` silent default was the worst-validated site in the census).
  // Chat is not a founder-visible-flow-breaking surface → refuse-loud is the default (no deferral).
  it("send — header absent + body sender → delivers under the claimed actor (201), sender alice", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "alice", body: "hi" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("send — header present + differing body sender → wire supersedes (sender alice, 201); 409 retired", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" },
      body: JSON.stringify({ sender: "mallory", body: "hi" }), // superseded by the wire identity
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("send — derives the sender from the header, never the body (body sender absent)", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" },
      body: JSON.stringify({ body: "hi" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("GET /history returns messages", async () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    const res = await app.request(`/api/rigs/${rigId}/chat/history`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].body).toBe("msg1");
    expect(data[1].body).toBe("msg2");
  });

  it("GET /history?topic=X filters", async () => {
    chatRepo.send(rigId, "alice", "before topic");
    chatRepo.sendTopic(rigId, "alice", "deploy");
    chatRepo.send(rigId, "bob", "deploy msg");

    const res = await app.request(`/api/rigs/${rigId}/chat/history?topic=deploy`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(1);
    const bodies = data.map((m: { body: string }) => m.body);
    expect(bodies).toContain("deploy msg");
  });

  it("POST /topic creates marker", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" }, // P21 I5: topic sender from the transport header
      body: JSON.stringify({ sender: "alice", topic: "standup", body: "daily" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.kind).toBe("topic");
    expect(data.topic).toBe("standup");
  });

  it("topic — header absent + body sender → delivers under the claimed actor (201), sender alice", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "alice", topic: "standup", body: "daily" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("topic — header present + differing body sender → wire supersedes (sender alice, 201); 409 retired", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" },
      body: JSON.stringify({ sender: "mallory", topic: "standup", body: "daily" }), // superseded by the wire identity
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("topic — derives the sender from the header, never the body (body sender absent)", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" },
      body: JSON.stringify({ topic: "standup", body: "daily" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("GET /watch SSE stream delivers initial batch + new messages", async () => {
    // Seed some messages
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    const res = await app.request(`/api/rigs/${rigId}/chat/watch`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read all available chunks from stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";

    // Read chunks until we have both messages or 5 reads
    for (let i = 0; i < 10; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (output.includes("msg1") && output.includes("msg2")) break;
    }

    // Should contain our seeded messages in SSE data lines
    expect(output).toContain("msg1");
    expect(output).toContain("msg2");

    reader.cancel();
  });

  it("GET /history?sender=X filters by sender", async () => {
    chatRepo.send(rigId, "alice", "alice msg");
    chatRepo.send(rigId, "bob", "bob msg");

    const res = await app.request(`/api/rigs/${rigId}/chat/history?sender=alice`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].sender).toBe("alice");
  });

  it("GET /history?since=X filters by timestamp", async () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    // Future cutoff — no messages
    const res = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("2099-01-01T00:00:00Z")}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(0);

    // Past cutoff — all messages
    const res2 = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("2020-01-01T00:00:00Z")}`);
    const data2 = await res2.json();
    expect(data2).toHaveLength(2);
  });

  it("GET /history?since refuses an unparseable cutoff instead of silently returning no rows", async () => {
    chatRepo.send(rigId, "alice", "msg1");

    // julianday('garbage') is NULL, so this used to report success with zero
    // rows — indistinguishable from a genuinely empty room.
    const res = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("garbage")}`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(String(data.error)).toContain("since");

    const res2 = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("not a timestamp")}`);
    expect(res2.status).toBe(400);
  });

  it("GET /history?since keeps an empty value as no filter and refuses whitespace", async () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    // An empty value never filtered (the repository skips a falsy since), so it
    // must keep returning the whole history rather than becoming a 400.
    const empty = await app.request(`/api/rigs/${rigId}/chat/history?since=`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toHaveLength(2);

    // Whitespace is not empty: it was unparseable before and matched no rows.
    const blank = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("   ")}`);
    expect(blank.status).toBe(400);
  });

  it("GET /history?since escapes control characters in the rejected value", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("a\nb\x1bc")}`);
    expect(res.status).toBe(400);
    const data = await res.json();
    // The CLI prints this message verbatim, so a raw newline or ESC would reach
    // the terminal; they must appear as visible escapes instead.
    expect(String(data.error)).toContain("a\\x0ab\\x1bc");
    expect(String(data.error)).not.toContain("\n");
  });

  it("GET /history?since escapes C1 control characters and keeps other non-ASCII text", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("a\u009bbéc")}`);
    expect(res.status).toBe(400);
    const data = await res.json();
    // U+009B is a single-byte CSI that some terminals act on; an accented letter is ordinary text.
    expect(String(data.error)).toContain("a\\x9bbéc");
    expect(String(data.error)).not.toContain("\u009b");
  });

  it("GET /history?since still accepts the cutoff formats SQLite parses", async () => {
    chatRepo.send(rigId, "alice", "msg1");

    // A past cutoff deterministically includes the just-sent row.
    for (const since of ["2020-01-01", "2020-01-01 00:00:00"]) {
      const res = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent(since)}`);
      expect(res.status, `since=${since}`).toBe(200);
      const data = await res.json();
      expect(data.length, `since=${since}`).toBeGreaterThanOrEqual(1);
    }

    // 'now' parses, so the guard must keep accepting it; row visibility at a
    // subsecond cutoff depends on the second-precision created_at stamp, so
    // only the status is asserted here.
    const res = await app.request(`/api/rigs/${rigId}/chat/history?since=now`);
    expect(res.status).toBe(200);
  });

  it("POST /clear removes messages and returns count", async () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    const res = await app.request(`/api/rigs/${rigId}/chat/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(2);

    // Verify room is empty
    const historyRes = await app.request(`/api/rigs/${rigId}/chat/history`);
    const history = await historyRes.json();
    expect(history).toHaveLength(0);
  });

  it("POST /clear on empty room returns deleted: 0", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(0);
  });

  it("POST /clear leaves other rigs' messages intact", async () => {
    const otherRig = rigRepo.createRig("other-rig");
    chatRepo.send(rigId, "alice", "target msg");
    chatRepo.send(otherRig.id, "bob", "other msg");

    await app.request(`/api/rigs/${rigId}/chat/clear`, { method: "POST" });

    const targetHistory = await (await app.request(`/api/rigs/${rigId}/chat/history`)).json();
    const otherHistory = await (await app.request(`/api/rigs/${otherRig.id}/chat/history`)).json();
    expect(targetHistory).toHaveLength(0);
    expect(otherHistory).toHaveLength(1);
  });
});
