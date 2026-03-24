import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import type { SnapshotData } from "../src/domain/types.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, snapshotsSchema]);
  return db;
}

function sampleData(): SnapshotData {
  return {
    rig: { id: "rig-1", name: "r01", createdAt: "2026-03-23", updatedAt: "2026-03-23" },
    nodes: [],
    edges: [],
    sessions: [],
    checkpoints: {},
  };
}

describe("SnapshotRepository", () => {
  let db: Database.Database;
  let repo: SnapshotRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new SnapshotRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("createSnapshot persists and returns Snapshot with parsed data, status, createdAt", () => {
    const snap = repo.createSnapshot("rig-1", "manual", sampleData());

    expect(snap.id).toBeDefined();
    expect(snap.rigId).toBe("rig-1");
    expect(snap.kind).toBe("manual");
    expect(snap.status).toBe("complete");
    expect(snap.createdAt).toBeDefined();
    expect(snap.data.rig.name).toBe("r01");
    expect(snap.data.checkpoints).toEqual({});
  });

  it("getSnapshot returns snapshot with parsed SnapshotData + status + createdAt", () => {
    const created = repo.createSnapshot("rig-1", "manual", sampleData());
    const fetched = repo.getSnapshot(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.status).toBe("complete");
    expect(fetched!.createdAt).toBe(created.createdAt);
    expect(fetched!.data.rig.name).toBe("r01");
  });

  it("getSnapshot nonexistent -> null", () => {
    expect(repo.getSnapshot("nonexistent")).toBeNull();
  });

  it("getLatestSnapshot: explicit timestamps, returns newest", () => {
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("snap-old", "rig-1", "manual", JSON.stringify(sampleData()), "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("snap-new", "rig-1", "manual", JSON.stringify(sampleData()), "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("snap-mid", "rig-1", "manual", JSON.stringify(sampleData()), "2026-03-23 02:00:00");

    const latest = repo.getLatestSnapshot("rig-1");
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe("snap-new");
  });

  it("getLatestSnapshot with no snapshots -> null", () => {
    expect(repo.getLatestSnapshot("rig-1")).toBeNull();
  });

  it("listSnapshots returns in created_at DESC order (newest first)", () => {
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s1", "rig-1", "manual", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s2", "rig-1", "pre_restore", "{}", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s3", "rig-1", "manual", "{}", "2026-03-23 03:00:00");

    const all = repo.listSnapshots("rig-1");
    expect(all.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
  });

  it("listSnapshots filtered by kind preserves DESC order", () => {
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s1", "rig-1", "manual", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s2", "rig-1", "pre_restore", "{}", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s3", "rig-1", "manual", "{}", "2026-03-23 03:00:00");

    const manualOnly = repo.listSnapshots("rig-1", { kind: "manual" });
    expect(manualOnly.map((s) => s.id)).toEqual(["s3", "s1"]);

    const preRestore = repo.listSnapshots("rig-1", { kind: "pre_restore" });
    expect(preRestore).toHaveLength(1);
    expect(preRestore[0]!.id).toBe("s2");
  });

  it("listSnapshots with limit returns newest N in order", () => {
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s1", "rig-1", "manual", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s2", "rig-1", "manual", "{}", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s3", "rig-1", "manual", "{}", "2026-03-23 03:00:00");

    const limited = repo.listSnapshots("rig-1", { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((s) => s.id)).toEqual(["s3", "s2"]); // newest 2
  });

  it("pruneSnapshots keeps newest N, deletes oldest, returns deleted count", () => {
    for (let i = 1; i <= 5; i++) {
      db.prepare(
        "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(`s${i}`, "rig-1", "manual", "{}", `2026-03-23 0${i}:00:00`);
    }

    const deleted = repo.pruneSnapshots("rig-1", 2);
    expect(deleted).toBe(3);

    const remaining = repo.listSnapshots("rig-1");
    expect(remaining).toHaveLength(2);
    expect(remaining.map((s) => s.id)).toEqual(["s5", "s4"]); // newest 2 survive
  });
});
