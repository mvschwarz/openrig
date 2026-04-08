import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
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

  it("POST /send persists + returns", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "alice", body: "hello" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.sender).toBe("alice");
    expect(data.body).toBe("hello");
    expect(data.id).toBeTruthy();
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "alice", topic: "standup", body: "daily" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.kind).toBe("topic");
    expect(data.topic).toBe("standup");
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
