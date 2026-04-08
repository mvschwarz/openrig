import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { chatMessagesSchema } from "../src/db/migrations/016_chat_messages.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ChatRepository } from "../src/domain/chat-repository.js";

describe("ChatRepository", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let chatRepo: ChatRepository;
  let rigId: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, chatMessagesSchema]);
    rigRepo = new RigRepository(db);
    chatRepo = new ChatRepository(db);
    const rig = rigRepo.createRig("test-rig");
    rigId = rig.id;
  });

  afterEach(() => {
    db.close();
  });

  it("send persists with ULID", () => {
    const msg = chatRepo.send(rigId, "alice", "hello world");
    expect(msg.id).toBeTruthy();
    expect(msg.id.length).toBe(26); // ULID is 26 chars
    expect(msg.rigId).toBe(rigId);
    expect(msg.sender).toBe("alice");
    expect(msg.body).toBe("hello world");
    expect(msg.kind).toBe("message");
    expect(msg.createdAt).toBeTruthy();
  });

  it("history returns chronological order", () => {
    chatRepo.send(rigId, "alice", "first");
    chatRepo.send(rigId, "bob", "second");
    chatRepo.send(rigId, "alice", "third");

    const messages = chatRepo.history(rigId);
    expect(messages).toHaveLength(3);
    expect(messages[0]!.body).toBe("first");
    expect(messages[1]!.body).toBe("second");
    expect(messages[2]!.body).toBe("third");
  });

  it("history --topic returns messages between topic marker and next topic marker", () => {
    chatRepo.send(rigId, "alice", "before topic");
    chatRepo.sendTopic(rigId, "alice", "deploy", "starting deploy");
    chatRepo.send(rigId, "bob", "deploy message");
    chatRepo.send(rigId, "alice", "another deploy msg");
    chatRepo.sendTopic(rigId, "bob", "standup", "daily standup");
    chatRepo.send(rigId, "bob", "standup message — should NOT appear");

    const messages = chatRepo.history(rigId, { topic: "deploy" });
    const bodies = messages.map((m) => m.body);
    // Should include the deploy topic marker and messages within that topic
    expect(bodies).toContain("starting deploy");
    expect(bodies).toContain("deploy message");
    expect(bodies).toContain("another deploy msg");
    // Should NOT include messages from the next topic
    expect(bodies).not.toContain("daily standup");
    expect(bodies).not.toContain("standup message — should NOT appear");
  });

  it("sendTopic creates topic-kind message", () => {
    const msg = chatRepo.sendTopic(rigId, "alice", "standup", "daily standup");
    expect(msg.kind).toBe("topic");
    expect(msg.topic).toBe("standup");
    expect(msg.body).toBe("daily standup");
    expect(msg.sender).toBe("alice");
  });

  // Clear tests
  it("clear removes all messages for the target rig", () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");
    chatRepo.send(rigId, "alice", "msg3");

    const result = chatRepo.clear(rigId);
    expect(result.deleted).toBe(3);
    expect(chatRepo.history(rigId)).toHaveLength(0);
  });

  it("clear returns 0 for empty room", () => {
    const result = chatRepo.clear(rigId);
    expect(result.deleted).toBe(0);
  });

  it("clear leaves other rigs' messages intact", () => {
    const otherRig = rigRepo.createRig("other-rig");
    const otherRigId = otherRig.id;
    chatRepo.send(rigId, "alice", "target rig msg");
    chatRepo.send(otherRigId, "bob", "other rig msg");

    chatRepo.clear(rigId);

    expect(chatRepo.history(rigId)).toHaveLength(0);
    expect(chatRepo.history(otherRigId)).toHaveLength(1);
    expect(chatRepo.history(otherRigId)[0]!.body).toBe("other rig msg");
  });

  // History filter tests
  it("history --sender returns only matching sender", () => {
    chatRepo.send(rigId, "alice", "alice msg 1");
    chatRepo.send(rigId, "bob", "bob msg 1");
    chatRepo.send(rigId, "alice", "alice msg 2");

    const result = chatRepo.history(rigId, { sender: "alice" });
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.sender === "alice")).toBe(true);
  });

  it("history --since returns only newer messages", () => {
    // Use a past timestamp to ensure messages created "now" are after it
    const pastCutoff = "2020-01-01T00:00:00Z";
    chatRepo.send(rigId, "alice", "msg after cutoff");
    chatRepo.send(rigId, "bob", "also after cutoff");

    const result = chatRepo.history(rigId, { since: pastCutoff });
    expect(result).toHaveLength(2);

    // Use a future timestamp to ensure nothing matches
    const futureCutoff = "2099-01-01T00:00:00Z";
    const futureResult = chatRepo.history(rigId, { since: futureCutoff });
    expect(futureResult).toHaveLength(0);
  });

  it("combined --sender + --after works", () => {
    const m1 = chatRepo.send(rigId, "alice", "alice before");
    chatRepo.send(rigId, "bob", "bob after");
    chatRepo.send(rigId, "alice", "alice after");

    const result = chatRepo.history(rigId, { after: m1.id, sender: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("alice after");
  });

  it("--topic + --after composable within topic window", () => {
    chatRepo.sendTopic(rigId, "host", "review");
    const m1 = chatRepo.send(rigId, "alice", "first review msg");
    chatRepo.send(rigId, "bob", "second review msg");

    const result = chatRepo.history(rigId, { topic: "review", after: m1.id });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("second review msg");
  });

  it("--topic + --sender composable within topic window", () => {
    chatRepo.send(rigId, "alice", "before topic");
    chatRepo.sendTopic(rigId, "host", "review");
    chatRepo.send(rigId, "alice", "alice review msg");
    chatRepo.send(rigId, "bob", "bob review msg");

    const result = chatRepo.history(rigId, { topic: "review", sender: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0]!.body).toBe("alice review msg");
  });
});
