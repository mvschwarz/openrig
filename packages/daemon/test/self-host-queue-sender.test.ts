import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, stampSelfHostSuffix } from "../src/domain/queue-repository.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

// 51-09 increment 4 — the qitem sender identity carries the origin host TRIPLE,
// stamped ONCE at write (stored value IS the triple) so every read surface
// (list/show/cli) renders it with no render-time logic. Fail-open to today's
// 2-part when no self-id is reconciled.
describe("51-09 incr 4 — queue sender-identity triple (stamp-at-write)", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    repo = new QueueRepository(db, new EventBus(db));
    setSelfHostId(null);
  });
  afterEach(() => { setSelfHostId(null); db.close(); });

  it("stores source_session as the origin TRIPLE when a self-id is reconciled", async () => {
    setSelfHostId("mars-01");
    const item = await repo.create({
      sourceSession: "dev50-driver@v-openrig-build",
      destinationSession: "bob@rig-b",
      body: "x",
    });
    expect(item.sourceSession).toBe("dev50-driver@v-openrig-build@mars-01");
  });

  it("CONTROL: fails open to today's 2-part source_session when NO self-id is reconciled", async () => {
    // preserved-behavior control — passes at parent by construction (no self-id).
    setSelfHostId(null);
    const item = await repo.create({
      sourceSession: "dev50-driver@v-openrig-build",
      destinationSession: "bob@rig-b",
      body: "x",
    });
    expect(item.sourceSession).toBe("dev50-driver@v-openrig-build");
  });

  describe("stampSelfHostSuffix (the pure stamp convention)", () => {
    it("a bare member@rig + reconciled self-id -> the triple", () => {
      setSelfHostId("mars-01");
      expect(stampSelfHostSuffix("dev@rig")).toBe("dev@rig@mars-01");
    });
    it("no self-id -> unchanged (fail-open, no new failure mode)", () => {
      setSelfHostId(null);
      expect(stampSelfHostSuffix("dev@rig")).toBe("dev@rig");
    });
    it("already a triple -> unchanged (idempotent, never double-stamped)", () => {
      setSelfHostId("mars-01");
      expect(stampSelfHostSuffix("dev@rig@other-host")).toBe("dev@rig@other-host");
    });
    it("legacy no-@ session -> unchanged", () => {
      setSelfHostId("mars-01");
      expect(stampSelfHostSuffix("legacyname")).toBe("legacyname");
    });
    it("undefined -> undefined", () => {
      setSelfHostId("mars-01");
      expect(stampSelfHostSuffix(undefined)).toBeUndefined();
    });
  });
});
