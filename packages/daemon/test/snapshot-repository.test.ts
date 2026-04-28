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

  // L3b: findLatestRestoreUsable
  describe("findLatestRestoreUsable (L3b)", () => {
    function dataWithSession(opts?: { sessionName?: string; nodeId?: string; rigId?: string }): SnapshotData {
      return {
        rig: { id: opts?.rigId ?? "rig-1", name: "r01", createdAt: "2026-04-28", updatedAt: "2026-04-28" },
        nodes: [],
        edges: [],
        sessions: [{
          id: "sess-1",
          nodeId: opts?.nodeId ?? "node-a",
          sessionName: opts?.sessionName ?? "r01-worker",
          status: "detached",
          resumeType: null,
          resumeToken: null,
          restorePolicy: "resume_if_possible",
          lastSeenAt: null,
          createdAt: "2026-04-28T00:00:00Z",
          origin: "launched",
          startupStatus: "ready",
          startupCompletedAt: null,
        }],
        checkpoints: {},
      };
    }

    function insertRaw(id: string, rigId: string, kind: string, dataJson: string, createdAt: string): void {
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, rigId, kind, "complete", dataJson, createdAt);
    }

    it("returns auto-pre-down when one exists (preference signal)", () => {
      repo.createSnapshot("rig-1", "manual", dataWithSession());
      const auto = repo.createSnapshot("rig-1", "auto-pre-down", dataWithSession());

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(auto.id);
      expect(result!.kind).toBe("auto-pre-down");
    });

    it("returns latest manual when no auto-pre-down exists", () => {
      const m = repo.createSnapshot("rig-1", "manual", dataWithSession());

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(m.id);
      expect(result!.kind).toBe("manual");
    });

    it("returns latest manual when multiple manuals exist (created_at DESC, id DESC)", () => {
      insertRaw("s1", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-27 10:00:00");
      insertRaw("s2", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 10:00:00");
      insertRaw("s3", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 09:00:00");

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result!.id).toBe("s2"); // newest by created_at
    });

    it("prefers auto-pre-down over a newer manual snapshot", () => {
      insertRaw("auto-old", "rig-1", "auto-pre-down", JSON.stringify(dataWithSession()), "2026-04-27 10:00:00");
      insertRaw("manual-new", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 10:00:00");

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result!.id).toBe("auto-old");
      expect(result!.kind).toBe("auto-pre-down");
    });

    it("returns null when no snapshot exists", () => {
      expect(repo.findLatestRestoreUsable("rig-1")).toBeNull();
    });

    it("skips a corrupted-JSON snapshot and considers next candidate", () => {
      insertRaw("s-broken", "rig-1", "manual", "{ this is not valid json", "2026-04-28 11:00:00");
      const good = repo.createSnapshot("rig-1", "manual", dataWithSession());
      // Force ordering: re-insert good with older created_at so corrupt is "newest"
      db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 10:00:00", good.id);
      db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 11:00:00", "s-broken");

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(good.id);
    });

    it("skips a snapshot with missing sessionName on a session and considers next", () => {
      const broken = JSON.parse(JSON.stringify(dataWithSession()));
      broken.sessions[0].sessionName = "";
      insertRaw("s-no-session-name", "rig-1", "manual", JSON.stringify(broken), "2026-04-28 11:00:00");
      const good = repo.createSnapshot("rig-1", "manual", dataWithSession());
      db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 10:00:00", good.id);

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result!.id).toBe(good.id);
    });

    it("skips a snapshot with missing nodeId on a session and considers next", () => {
      const broken = JSON.parse(JSON.stringify(dataWithSession()));
      delete broken.sessions[0].nodeId;
      insertRaw("s-no-node-id", "rig-1", "manual", JSON.stringify(broken), "2026-04-28 11:00:00");
      const good = repo.createSnapshot("rig-1", "manual", dataWithSession());
      db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 10:00:00", good.id);

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result!.id).toBe(good.id);
    });

    it("returns null when no snapshot has restore-usable structural metadata", () => {
      const noRig = JSON.stringify({ nodes: [], edges: [], sessions: [], checkpoints: {} });
      const noNodes = JSON.stringify({ rig: { id: "x", name: "r", createdAt: "", updatedAt: "" }, edges: [], sessions: [], checkpoints: {} });
      insertRaw("s-no-rig", "rig-1", "manual", noRig, "2026-04-28 11:00:00");
      insertRaw("s-no-nodes", "rig-1", "manual", noNodes, "2026-04-28 12:00:00");

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).toBeNull();
    });

    it("accepts a snapshot with empty sessions array (matches validatePreRestore)", () => {
      // RestoreOrchestrator.validatePreRestore allows an empty sessions array
      // (only missing/non-array is rejected). The helper must match.
      const empty = sampleData();
      const s = repo.createSnapshot("rig-1", "manual", empty);

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(s.id);
    });

    it("regression: findLatestAutoPreDown unchanged (still returns auto-pre-down only, no kind fallback)", () => {
      repo.createSnapshot("rig-1", "manual", dataWithSession());
      // No auto-pre-down: findLatestAutoPreDown returns null even though a
      // valid manual exists. findLatestRestoreUsable would return the manual.
      expect(repo.findLatestAutoPreDown("rig-1")).toBeNull();
      expect(repo.findLatestRestoreUsable("rig-1")).not.toBeNull();
    });
  });
});
