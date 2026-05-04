// PL-007 Workspace Primitive v0 — queue_items.target_repo round-trip
// tests.
//
// Pins:
//   - create with targetRepo persists + roundtrips through getById
//   - list filters by targetRepo
//   - handoff inherits source's targetRepo when not overridden
//   - handoff-and-complete inherits source's targetRepo when not
//     overridden; explicit override wins
//   - migration 038 column present after migrate runs

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

let db: Database.Database;
let repo: QueueRepository;

beforeEach(() => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
  repo = new QueueRepository(db, new EventBus(db));
});

describe("queue target_repo (PL-007)", () => {
  it("migration 038 adds target_repo column", () => {
    const cols = db.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "target_repo")).toBe(true);
  });

  it("create persists target_repo and getById roundtrips it", async () => {
    const created = await repo.create({
      sourceSession: "alice@rigA",
      destinationSession: "bob@rigA",
      body: "test",
      targetRepo: "openrig",
    });
    expect(created.targetRepo).toBe("openrig");
    const fetched = repo.getById(created.qitemId);
    expect(fetched?.targetRepo).toBe("openrig");
  });

  it("create without targetRepo persists null", async () => {
    const created = await repo.create({
      sourceSession: "alice@rigA",
      destinationSession: "bob@rigA",
      body: "test",
    });
    expect(created.targetRepo).toBeNull();
  });

  it("list filters by targetRepo", async () => {
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", targetRepo: "openrig" });
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "y", targetRepo: "internal" });
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "z" });
    const filtered = repo.list({ targetRepo: "openrig" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.targetRepo).toBe("openrig");
  });

  it("handoff inherits source's targetRepo when not overridden", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "openrig",
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
    });
    expect(result.created.targetRepo).toBe("openrig");
  });

  it("handoff explicit targetRepo overrides source", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "openrig",
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
      targetRepo: "internal",
    });
    expect(result.created.targetRepo).toBe("internal");
  });

  it("handoffAndComplete inherits source's targetRepo when not overridden", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "openrig",
    });
    const result = await repo.handoffAndComplete({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
    });
    expect(result.created.targetRepo).toBe("openrig");
    expect(result.closed.state).toBe("done");
  });

  it("legacy fixture without migration 038: degrades gracefully (target_repo NOT persisted, no throws)", async () => {
    const legacyDb = createDb();
    migrate(legacyDb, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    const legacyRepo = new QueueRepository(legacyDb, new EventBus(legacyDb));
    // The schema-detect should be false; INSERTs should run the legacy
    // statement; targetRepo input is silently dropped.
    const created = await legacyRepo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "openrig",
    });
    expect(created.targetRepo).toBeNull();
  });
});
