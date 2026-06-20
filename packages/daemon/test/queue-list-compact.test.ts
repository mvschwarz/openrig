import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS queue_items (
    qitem_id TEXT PRIMARY KEY,
    ts_created TEXT NOT NULL,
    ts_updated TEXT NOT NULL,
    source_session TEXT NOT NULL,
    destination_session TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'normal',
    tier TEXT,
    tags TEXT,
    blocked_on TEXT,
    handed_off_to TEXT,
    handed_off_from TEXT,
    expires_at TEXT,
    chain_of_record TEXT,
    body TEXT NOT NULL DEFAULT '',
    closure_reason TEXT,
    closure_target TEXT,
    closure_required_at TEXT,
    claimed_at TEXT,
    last_nudge_attempt TEXT,
    last_nudge_result TEXT,
    last_heartbeat TEXT,
    resolution TEXT,
    target_repo TEXT
  )`);
  return db;
}

function seedItem(db: Database.Database, id: string, opts: {
  source: string;
  destination: string;
  state?: string;
  body?: string;
  tags?: string[];
  tsCreated?: string;
}) {
  const ts = opts.tsCreated ?? new Date().toISOString();
  db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, tags, chain_of_record)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, ts, ts, opts.source, opts.destination,
    opts.state ?? "pending",
    opts.body ?? `Body of ${id} - this is a long body that adds token weight and should be excluded in compact mode. `.repeat(10),
    opts.tags ? JSON.stringify(opts.tags) : null,
    JSON.stringify([`chain-${id}`]),
  );
}

describe("OPR.0.4.0.28 — queue list compact + scope-default", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new QueueRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("AC-1: compact list is materially smaller than full list", () => {
    for (let i = 0; i < 20; i++) {
      seedItem(db, `q-${i}`, {
        source: `seat-${i % 3}@rig-a`,
        destination: `seat-${(i + 1) % 3}@rig-a`,
        body: `Long body for item ${i}. `.repeat(50),
        tags: ["tag-a", "tag-b", "tag-c"],
      });
    }

    const full = repo.list({ limit: 20 });
    const compact = repo.list({ limit: 20, compact: true });

    expect(compact.length).toBe(full.length);

    const fullSize = JSON.stringify(full).length;
    const compactSize = JSON.stringify(compact).length;
    expect(compactSize).toBeLessThan(fullSize / 3);
  });

  it("AC-2: --all parity — full unscoped list matches today's default", () => {
    for (let i = 0; i < 5; i++) {
      seedItem(db, `q-${i}`, {
        source: `seat-${i}@rig-${i}`,
        destination: `seat-${i + 1}@rig-${i}`,
      });
    }

    const allItems = repo.list({ limit: 100 });
    expect(allItems.length).toBe(5);
    expect(allItems[0]!.body.length).toBeGreaterThan(0);
    expect(allItems[0]!.chainOfRecord).toBeDefined();
  });

  it("AC-3: caller-scoped default surfaces caller items even when older than fleet LIMIT", () => {
    const callerSession = "dev1-driver@openrig-delivery";

    // Caller's OLD item (created first, would be beyond LIMIT if unscoped)
    seedItem(db, "q-caller-old", {
      source: "orch-lead@openrig-delivery",
      destination: callerSession,
      state: "pending",
      tsCreated: "2026-06-01T00:00:00.000Z",
    });

    // 10 NEWER fleet items from other rigs (would push caller item beyond LIMIT 5)
    for (let i = 0; i < 10; i++) {
      seedItem(db, `q-fleet-${i}`, {
        source: `seat-${i}@other-rig`,
        destination: `seat-${i + 1}@other-rig`,
        state: "pending",
        tsCreated: `2026-06-19T${String(i).padStart(2, "0")}:00:00.000Z`,
      });
    }

    // Unscoped with small limit — caller item is dropped
    const unscoped = repo.list({ limit: 5 });
    const unscopedIds = unscoped.map((item) => item.qitemId);
    expect(unscopedIds).not.toContain("q-caller-old");

    // Scoped with same small limit — caller item appears (WHERE before LIMIT)
    const scoped = repo.list({ asSession: callerSession, limit: 5 });
    const scopedIds = scoped.map((item) => item.qitemId);
    expect(scopedIds).toContain("q-caller-old");
  });

  it("AC-3: asSession surfaces both destination AND source items", () => {
    const callerSession = "dev1-driver@openrig-delivery";

    seedItem(db, "q-to-me", {
      source: "orch-lead@openrig-delivery",
      destination: callerSession,
      state: "pending",
    });

    seedItem(db, "q-from-me", {
      source: callerSession,
      destination: "dev1-guard@openrig-delivery",
      state: "in-progress",
    });

    seedItem(db, "q-unrelated", {
      source: "rev1-r1@openrig-delivery",
      destination: "rev1-r2@openrig-delivery",
      state: "pending",
    });

    const scoped = repo.list({ asSession: callerSession });
    const ids = scoped.map((item) => item.qitemId);
    expect(ids).toContain("q-to-me");
    expect(ids).toContain("q-from-me");
    expect(ids).not.toContain("q-unrelated");
  });

  it("AC-4: compact excludes body and chainOfRecord", () => {
    seedItem(db, "q-1", {
      source: "a@rig",
      destination: "b@rig",
      body: "This body should be excluded in compact mode",
      tags: ["slice:OPR.0.4.0.28"],
    });

    const compact = repo.list({ compact: true });
    expect(compact.length).toBe(1);
    const item = compact[0]!;
    expect(item.qitemId).toBe("q-1");
    expect(item.state).toBeDefined();
    expect(item.sourceSession).toBeDefined();
    expect(item.destinationSession).toBeDefined();
    expect(item.priority).toBeDefined();
    expect(item.tier).toBeDefined();
    expect(item.tags).toBeDefined();
    // Compact excludes heavy fields
    expect(item.body).toBe("");
    expect(item.chainOfRecord).toBeNull();
  });

  it("AC-5: existing filters compose with asSession", () => {
    const callerSession = "dev1-driver@openrig-delivery";

    seedItem(db, "q-pending", {
      source: "orch@rig",
      destination: callerSession,
      state: "pending",
    });
    seedItem(db, "q-done", {
      source: "orch@rig",
      destination: callerSession,
      state: "done",
    });

    const scopedPending = repo.list({
      asSession: callerSession,
      state: "pending",
    });
    expect(scopedPending.length).toBe(1);
    expect(scopedPending[0]!.qitemId).toBe("q-pending");
  });

  it("active-first ordering: pending/in-progress before done items", () => {
    seedItem(db, "q-done-old", {
      source: "a@rig",
      destination: "b@rig",
      state: "done",
      tsCreated: "2026-06-19T00:00:00.000Z",
    });
    seedItem(db, "q-pending-new", {
      source: "a@rig",
      destination: "b@rig",
      state: "pending",
      tsCreated: "2026-06-18T00:00:00.000Z",
    });

    const items = repo.list({ asSession: "b@rig" });
    expect(items[0]!.qitemId).toBe("q-pending-new");
    expect(items[1]!.qitemId).toBe("q-done-old");
  });

  it("daemon API back-compat: no new params = full unscoped (today's behavior)", () => {
    seedItem(db, "q-1", {
      source: "a@rig",
      destination: "b@rig",
      body: "Full body preserved",
    });

    const items = repo.list({});
    expect(items.length).toBe(1);
    expect(items[0]!.body).toBe("Full body preserved");
    expect(items[0]!.chainOfRecord).toBeDefined();
  });
});
