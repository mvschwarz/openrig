import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import type { SnapshotData, SnapshotOccupantState } from "../src/domain/types.js";

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

  it("ranks a rig's restore candidates without their data and reads only the snapshots it needs", () => {
    const first = repo.createSnapshot("rig-1", "manual", sampleData());
    const second = repo.createSnapshot("rig-1", "auto-pre-down", sampleData());
    const original = db.prepare;
    const statements: string[] = [];
    db.prepare = function(sql: string) { statements.push(sql); return original.call(this, sql); } as typeof db.prepare;
    let latest: string | undefined;
    let newer: string | null | undefined;
    try {
      latest = repo.findLatestRestoreUsable("rig-1")?.id;
      const selected = repo.selectRestoreUsable("rig-1", first.id);
      newer = selected.ok ? selected.selection.newerUsableAlternative?.snapshotId ?? null : undefined;
    } finally { db.prepare = original; }
    expect(latest).toBe(second.id);
    expect(newer).toBe(second.id);
    // A rig's whole history is ranked by id; snapshot data is read one row at a time.
    const rigWide = statements.filter((sql) => /WHERE rig_id = \?/.test(sql));
    expect(rigWide.length).toBeGreaterThan(0);
    for (const sql of rigWide) expect(sql).not.toMatch(/SELECT \*|\bdata\b/);
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

  it("same-second snapshots select and retain the last inserted capture", () => {
    const insert = db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, 'rig-1', 'auto-pre-down', ?, '2026-09-30 01:00:00')");
    insert.run("snap-z-first", JSON.stringify(sampleData()));
    insert.run("snap-a-second", JSON.stringify(sampleData()));
    expect(repo.getLatestSnapshot("rig-1")?.id).toBe("snap-a-second");
    expect(repo.findLatestAutoPreDown("rig-1")?.id).toBe("snap-a-second");
    expect(repo.findLatestRestoreUsable("rig-1")?.id).toBe("snap-a-second");
    expect(repo.listSnapshots("rig-1").map(s => s.id)).toEqual(["snap-a-second", "snap-z-first"]);
    expect(repo.pruneSnapshotsByKind("rig-1", "auto-pre-down", 1)).toBe(1);
    expect(repo.getSnapshot("snap-a-second")).not.toBeNull();
  });

  it("same-second explicit selection discloses a newer usable insertion", () => {
    const insert = db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, 'rig-1', 'manual', ?, '2026-09-30 01:00:00')");
    insert.run("snap-z-first", JSON.stringify(sampleData()));
    insert.run("snap-a-second", JSON.stringify(sampleData()));
    const outcome = repo.selectRestoreUsable("rig-1", "snap-z-first");
    expect(outcome.ok && outcome.selection.newerUsableAlternative?.snapshotId).toBe("snap-a-second");
  });

  it("same-second unscoped pruning also preserves the newest capture", () => {
    const insert = db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, 'rig-1', 'manual', ?, '2026-09-30 01:00:00')");
    insert.run("snap-z-first", JSON.stringify(sampleData()));
    insert.run("snap-a-second", JSON.stringify(sampleData()));
    expect(repo.pruneSnapshots("rig-1", 1)).toBe(1);
    expect(repo.getSnapshot("snap-a-second")).not.toBeNull();
  });

  it("restore selection skips malformed JSON without hiding corrupt generic reads", () => {
    const good = repo.createSnapshot("rig-1", "auto-pre-down", sampleData());
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES ('corrupt', 'rig-1', 'manual', '{broken', '2099-01-01 00:00:00')").run();
    const selection = repo.selectRestoreUsable("rig-1");
    expect(selection.ok && selection.snapshot.id).toBe(good.id);
    expect(selection.ok && selection.selection.newerUsableAlternative).toBeNull();
    expect(repo.selectRestoreUsable("rig-1", "corrupt")).toEqual(expect.objectContaining({ ok: false, code: "snapshot_unusable" }));
    expect(() => repo.listSnapshots("rig-1")).toThrow();
  });

  it("malformed nested roster data cannot throw or block a healthy fallback", () => {
    const good = repo.createSnapshot("rig-1", "manual", sampleData());
    db.prepare("UPDATE snapshots SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(good.id);
    const bad = repo.createSnapshot("rig-1", "auto-pre-down", { ...sampleData(), topologyRoster: null } as unknown as SnapshotData);
    expect(repo.findLatestRestoreUsable("rig-1")?.id).toBe(good.id);
    expect(repo.selectRestoreUsable("rig-1", bad.id)).toEqual(expect.objectContaining({ ok: false, code: "snapshot_unusable" }));
    expect(repo.selectRestoreUsable("rig-1").ok).toBe(true);
  });

  it("same-second alternative discovery skips damaged rows before and after the newest usable insertion", () => {
    const insert = db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, 'rig-1', 'manual', ?, '2026-09-30 01:00:00')");
    insert.run("snap-z-first", JSON.stringify(sampleData()));
    insert.run("broken-json-middle", "{broken");
    insert.run("bad-roster-middle", JSON.stringify({ ...sampleData(), topologyRoster: null }));
    insert.run("snap-a-second", JSON.stringify(sampleData()));
    insert.run("broken-json-last", "{broken");
    const explicit = repo.selectRestoreUsable("rig-1", "snap-z-first");
    expect(explicit.ok && explicit.selection.newerUsableAlternative?.snapshotId).toBe("snap-a-second");
    const automatic = repo.selectRestoreUsable("rig-1");
    expect(automatic.ok && automatic.snapshot.id).toBe("snap-a-second");
    expect(automatic.ok && automatic.selection.newerUsableAlternative).toBeNull();
    expect(() => repo.listSnapshots("rig-1")).toThrow();
  });

  it.each([false, true])("a second SQLite writer pruning the selected row preserves strict newer fallback (newer: %s)", (hasNewer) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-phase-"));
    const file = path.join(directory, "snapshots.db");
    const reader = createDb(file);
    const writer = createDb(file);
    const selectionRepo = new SnapshotRepository(reader);
    let restorePhase = () => {};
    try {
      migrate(reader, [coreSchema, snapshotsSchema]);
      writer.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r01')").run();
      const insert = writer.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, 'rig-1', ?, ?, ?)");
      insert.run("older-last", "manual", JSON.stringify(sampleData()), "2025-01-01 00:00:00");
      insert.run("older", "manual", JSON.stringify(sampleData()), "2026-01-01 00:00:00");
      insert.run("selected", "auto-pre-down", JSON.stringify(sampleData()), "2026-02-01 00:00:00");
      insert.run("same-second", "manual", JSON.stringify(sampleData()), "2026-02-01 00:00:00");
      if (hasNewer) insert.run("strictly-newer", "manual", JSON.stringify(sampleData()), "2026-03-01 00:00:00");
      const select = selectionRepo.findLatestRestoreUsable.bind(selectionRepo);
      const phase = vi.spyOn(selectionRepo, "findLatestRestoreUsable").mockImplementation((rigId) => {
        const actual = select(rigId);
        expect(actual?.id).toBe("selected");
        writer.prepare("DELETE FROM snapshots WHERE id = ?").run(actual!.id);
        return actual;
      });
      restorePhase = () => { phase.mockRestore(); };
      const outcome = selectionRepo.selectRestoreUsable("rig-1");
      expect(outcome.ok && outcome.snapshot.id).toBe("selected");
      expect(outcome.ok && outcome.selection.newerUsableAlternative?.snapshotId).toBe(hasNewer ? "strictly-newer" : undefined);
      expect(outcome.ok && outcome.selection.newerUsableAlternative).toEqual(hasNewer ? expect.objectContaining({ snapshotId: "strictly-newer" }) : null);
      expect(writer.prepare("SELECT id FROM snapshots WHERE id = 'selected'").get()).toBeUndefined();
    } finally {
      restorePhase();
      writer.close();
      reader.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
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

    it("selects an exact usable snapshot and discloses a newer alternative", () => {
      insertRaw("auto-old", "rig-1", "auto-pre-down", JSON.stringify(dataWithSession()), "2026-04-27 10:00:00");
      insertRaw("manual-new", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 10:00:00");

      const result = repo.selectRestoreUsable("rig-1", "manual-new", Date.parse("2026-04-29T10:00:00Z"));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.id).toBe("manual-new");
      expect(result.selection).toMatchObject({
        mode: "explicit",
        snapshotId: "manual-new",
        kind: "manual",
        ageMs: 24 * 60 * 60 * 1000,
        newerUsableAlternative: null,
      });
    });

    it("keeps automatic crash-insurance ranking and reports the newer manual alternative", () => {
      insertRaw("auto-old", "rig-1", "auto-pre-down", JSON.stringify(dataWithSession()), "2026-04-27 10:00:00");
      insertRaw("manual-new", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 10:00:00");

      const result = repo.selectRestoreUsable("rig-1", undefined, Date.parse("2026-04-29T10:00:00Z"));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.id).toBe("auto-old");
      expect(result.selection.mode).toBe("automatic");
      expect(result.selection.rationale).toMatch(/crash-insurance/i);
      expect(result.selection.newerUsableAlternative).toMatchObject({ snapshotId: "manual-new", kind: "manual" });
    });

    it("refuses wrong-rig and unusable exact snapshots", () => {
      insertRaw("other-rig", "rig-2", "manual", JSON.stringify(dataWithSession({ rigId: "rig-2" })), "2026-04-28 10:00:00");
      insertRaw("broken", "rig-1", "manual", "{}", "2026-04-28 11:00:00");

      expect(repo.selectRestoreUsable("rig-1", "other-rig")).toMatchObject({ ok: false, code: "snapshot_wrong_rig" });
      expect(repo.selectRestoreUsable("rig-1", "broken")).toMatchObject({ ok: false, code: "snapshot_unusable" });
    });

    it("refuses malformed explicit roster and occupant metadata", () => {
      insertRaw("bad-roster", "rig-1", "manual", JSON.stringify({
        ...dataWithSession(),
        topologyRoster: { version: 1, source: "operator_explicit", intendedNodeIds: ["missing-node"] },
      }), "2026-04-28 10:00:00");
      insertRaw("bad-occupant", "rig-1", "manual", JSON.stringify({
        ...dataWithSession(),
        activeOccupantsByNode: { "node-1": { kind: "resolved", sessionId: "" } },
      }), "2026-04-28 11:00:00");

      expect(repo.selectRestoreUsable("rig-1", "bad-roster")).toMatchObject({ ok: false, code: "snapshot_unusable" });
      expect(repo.selectRestoreUsable("rig-1", "bad-occupant")).toMatchObject({ ok: false, code: "snapshot_unusable" });
    });

    it("refuses explicit occupant metadata with missing or cross-node session evidence", () => {
      const data = dataWithSession();
      data.nodes = [{ id: "node-a", logicalId: "dev.a" } as SnapshotData["nodes"][number]];
      insertRaw("missing-occupant", "rig-1", "manual", JSON.stringify({
        ...data,
        activeOccupantsByNode: {},
      }), "2026-04-28 10:00:00");
      insertRaw("cross-node-occupant", "rig-1", "manual", JSON.stringify({
        ...data,
        activeOccupantsByNode: { "node-a": { kind: "resolved", sessionId: "missing-session" } },
      }), "2026-04-28 11:00:00");

      expect(repo.selectRestoreUsable("rig-1", "missing-occupant")).toMatchObject({ ok: false, code: "snapshot_unusable" });
      expect(repo.selectRestoreUsable("rig-1", "cross-node-occupant")).toMatchObject({ ok: false, code: "snapshot_unusable" });
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


describe("SnapshotRepository.selectComebackSnapshot: the snapshot a seat pool's comeback launches a retained node from", () => {
  const NODE = { id: "node-w1", logicalId: "dev.impl-s1" };
  let db: Database.Database;
  let repo: SnapshotRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new SnapshotRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  /** A capture of the rig: with or without the retained node, and with its session running or stopped at capture. */
  function capture(opts: { withNode: boolean; running?: boolean }): SnapshotData {
    const data = sampleData();
    if (!opts.withNode) return data;
    data.nodes = [{ id: NODE.id, rigId: "rig-1", logicalId: NODE.logicalId } as SnapshotData["nodes"][number]];
    data.sessions = [{
      id: "sess-w1", nodeId: NODE.id, sessionName: "dev-impl-s1@r01", status: opts.running ? "running" : "stopped",
      resumeType: "claude_id", resumeToken: "token-w1", restorePolicy: "resume_if_possible", lastSeenAt: null,
      createdAt: "2026-11-18T10:00:00Z", origin: "launched", startupStatus: "ready", startupCompletedAt: null,
    } as SnapshotData["sessions"][number]];
    data.activeOccupantsByNode = { [NODE.id]: opts.running ? { kind: "resolved", sessionId: "sess-w1" } : { kind: "absent" } };
    return data;
  }

  function insertAt(id: string, kind: string, data: SnapshotData | string, createdAt: string): void {
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, 'complete', ?, ?)")
      .run(id, "rig-1", kind, typeof data === "string" ? data : JSON.stringify(data), createdAt);
  }

  it("With an older `auto-periodic` snapshot A without the node, a pool capture B holding it running and a later `auto-periodic` C where it is absent, the selection picks B, reads C before it, and never reads A.", () => {
    insertAt("A", "auto-periodic", capture({ withNode: false }), "2026-11-18 09:00:00");
    insertAt("B", "auto-rehydrate", capture({ withNode: true, running: true }), "2026-11-18 10:00:00");
    insertAt("C", "auto-periodic", capture({ withNode: true, running: false }), "2026-11-18 11:00:00");
    // the automatic ranking prefers the periodic kind; the comeback does not
    expect(repo.findLatestRestoreUsable("rig-1")?.id).toBe("C");

    const selected = repo.selectComebackSnapshot("rig-1", NODE.id, NODE.logicalId);
    expect(selected.chosen?.id).toBe("B");
    expect(selected.chosen?.kind).toBe("auto-rehydrate");
    expect(selected.read).toBe(2);
    expect(selected.failed).toEqual([{ snapshotId: "C", condition: 3 }]);
  });

  it("With no snapshot holding the node running, nothing is chosen and each snapshot read is named with the condition it failed: 1 for data that can't be read or is not restore-usable, 2 for a snapshot without the node, 3 for one where it was not running.", () => {
    insertAt("A", "auto-periodic", capture({ withNode: false }), "2026-11-18 09:00:00");
    insertAt("B", "auto-rehydrate", "{broken", "2026-11-18 10:00:00");
    insertAt("E", "auto-rehydrate", "{}", "2026-11-18 10:30:00");
    insertAt("C", "auto-periodic", capture({ withNode: true, running: false }), "2026-11-18 11:00:00");

    expect(repo.selectComebackSnapshot("rig-1", NODE.id, NODE.logicalId)).toEqual({
      chosen: null,
      read: 4,
      failed: [
        { snapshotId: "C", condition: 3 },
        { snapshotId: "E", condition: 1 },
        { snapshotId: "B", condition: 1 },
        { snapshotId: "A", condition: 2 },
      ],
    });
  });

  it("A snapshot whose node has the same id under another logical id, or one that keeps the node out of its intended roster, fails condition 2.", () => {
    const renamed = capture({ withNode: true, running: true });
    renamed.nodes[0]!.logicalId = "dev.other";
    insertAt("R", "auto-rehydrate", renamed, "2026-11-18 10:00:00");
    const outOfRoster = capture({ withNode: true, running: true });
    outOfRoster.topologyRoster = { version: 1, source: "materialized_topology", intendedNodeIds: [] };
    outOfRoster.activeOccupantsByNode = {};
    insertAt("O", "auto-rehydrate", outOfRoster, "2026-11-18 10:30:00");

    expect(repo.selectComebackSnapshot("rig-1", NODE.id, NODE.logicalId)).toEqual({
      chosen: null, read: 2, failed: [{ snapshotId: "O", condition: 2 }, { snapshotId: "R", condition: 2 }],
    });
  });

  /** A capture holding the node with a second session row `sess-w1b` (status `second`), the first one running, and the
   *  node's occupant entry as given (`undefined` drops the entry). */
  function twoOccupants(second: string, occupant: SnapshotOccupantState | undefined, firstStatus = "running"): SnapshotData {
    const data = capture({ withNode: true, running: true });
    data.sessions[0]!.status = firstStatus;
    data.sessions.push({ ...data.sessions[0]!, id: "sess-w1b", sessionName: "dev-impl-s1@r01-b", status: second });
    data.activeOccupantsByNode = occupant === undefined ? {} : { [NODE.id]: occupant };
    return data;
  }
  const BOTH: SnapshotOccupantState = { kind: "ambiguous", candidateIds: ["sess-w1", "sess-w1b"] };

  it("A newer capture that recorded two live occupants for the node stops the selection: nothing is chosen, the conflict names that snapshot and both candidates, and the older single-occupant capture is never read.", () => {
    insertAt("B", "auto-rehydrate", capture({ withNode: true, running: true }), "2026-11-18 10:00:00");
    insertAt("D", "manual", twoOccupants("running", BOTH), "2026-11-18 11:00:00");

    expect(repo.selectComebackSnapshot("rig-1", NODE.id, NODE.logicalId)).toEqual({
      chosen: null, conflict: { snapshotId: "D", candidateIds: ["sess-w1", "sess-w1b"] }, read: 1, failed: [],
    });
  });

  it("A capture taken after the drain, with the node not running, falls through to the next capture; when that one is a recorded conflict newer than the qualifying capture, the conflict still stops the selection.", () => {
    insertAt("B", "auto-rehydrate", capture({ withNode: true, running: true }), "2026-11-18 10:00:00");
    insertAt("D", "manual", twoOccupants("running", BOTH), "2026-11-18 11:00:00");
    insertAt("C", "auto-periodic", capture({ withNode: true, running: false }), "2026-11-18 12:00:00");

    expect(repo.selectComebackSnapshot("rig-1", NODE.id, NODE.logicalId)).toEqual({
      chosen: null, conflict: { snapshotId: "D", candidateIds: ["sess-w1", "sess-w1b"] }, read: 2, failed: [{ snapshotId: "C", condition: 3 }],
    });
  });

  it.each([
    ["no entry for the node", () => twoOccupants("running", undefined)],
    ["a resolved occupant naming no session", () => twoOccupants("running", { kind: "resolved", sessionId: "sess-gone" })],
    ["a candidate that is a row of another node", () => {
      const data = twoOccupants("running", BOTH);
      data.nodes.push({ id: "node-x", rigId: "rig-1", logicalId: "dev.other" } as SnapshotData["nodes"][number]);
      data.sessions[1]!.nodeId = "node-x";
      data.activeOccupantsByNode!["node-x"] = { kind: "resolved", sessionId: "sess-w1b" };
      return data;
    }],
  ])("A newer capture whose occupant metadata for the node is incomplete (%s) fails condition 1, and the selection reaches the older single-occupant capture.", (_label, newer) => {
    insertAt("B", "auto-rehydrate", capture({ withNode: true, running: true }), "2026-11-18 10:00:00");
    insertAt("D", "manual", newer(), "2026-11-18 11:00:00");

    const selected = repo.selectComebackSnapshot("rig-1", NODE.id, NODE.logicalId);
    expect(selected.chosen?.id).toBe("B");
    expect(selected.conflict).toBeUndefined();
    expect(selected.read).toBe(2);
    expect(selected.failed).toEqual([{ snapshotId: "D", condition: 1 }]);
  });

  it.each([
    ["a legacy relation recording no single occupant", () => {
      const data = twoOccupants("running", undefined);
      delete data.activeOccupantsByNode;
      data.activeSessionIdByNode = { [NODE.id]: null };
      return data;
    }, "the snapshot recorded no single live occupant at capture (explicit null)"],
    ["candidates that were not running at capture, as after a reboot", () => twoOccupants("detached", BOTH, "detached"),
      "the snapshot recorded multiple live occupant candidates at capture"],
    ["only one candidate running at capture", () => twoOccupants("detached", BOTH),
      "the snapshot recorded multiple live occupant candidates at capture"],
  ])("A newer capture that can't tell which occupant was live (%s) is named with condition 3, its candidates and why, and the selection still reaches the older capture.", (_label, newer, detail) => {
    insertAt("B", "auto-rehydrate", capture({ withNode: true, running: true }), "2026-11-18 10:00:00");
    insertAt("D", "auto-rehydrate", newer(), "2026-11-18 11:00:00");

    const selected = repo.selectComebackSnapshot("rig-1", NODE.id, NODE.logicalId);
    expect(selected.chosen?.id).toBe("B");
    expect(selected.conflict).toBeUndefined();
    expect(selected.read).toBe(2);
    expect(selected.failed).toEqual([{ snapshotId: "D", condition: 3, unknown: { candidateIds: ["sess-w1", "sess-w1b"], detail } }]);
  });

  it("The selection ranks a rig's snapshots without their data, reads only its own rig, and changes nothing.", () => {
    insertAt("B", "auto-rehydrate", capture({ withNode: true, running: true }), "2026-11-18 10:00:00");
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES ('X', 'rig-2', 'auto-rehydrate', 'complete', ?, '2026-11-18 12:00:00')")
      .run(JSON.stringify(capture({ withNode: true, running: true })));
    const before = db.prepare("SELECT id, data FROM snapshots ORDER BY id").all();
    const original = db.prepare;
    const statements: string[] = [];
    db.prepare = function(sql: string) { statements.push(sql); return original.call(this, sql); } as typeof db.prepare;
    let selected: ReturnType<SnapshotRepository["selectComebackSnapshot"]>;
    try {
      selected = repo.selectComebackSnapshot("rig-1", NODE.id, NODE.logicalId);
    } finally { db.prepare = original; }
    expect(selected.chosen?.id).toBe("B");
    expect(selected.read).toBe(1);
    const rigWide = statements.filter((sql) => /WHERE rig_id = \?/.test(sql));
    expect(rigWide.length).toBeGreaterThan(0);
    for (const sql of rigWide) expect(sql).not.toMatch(/SELECT \*|\bdata\b/);
    expect(statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
    expect(db.prepare("SELECT id, data FROM snapshots ORDER BY id").all()).toEqual(before);
  });
});

describe("snapshot pruning above SQLite's parameter limit", () => {
  it.each(["all", "kind"] as const)("prunes %s history without one bind parameter per discarded snapshot", mode => {
    const db = setupDb();
    try {
      const repo = new SnapshotRepository(db);
      const insert = db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)");
      const data = JSON.stringify(sampleData());
      db.transaction(() => {
        for (let i = 0; i < 40000; i++) insert.run(`history-${i}`, "large-rig", "auto-periodic", data, "2026-03-23 12:00:00");
        insert.run("manual-control", "large-rig", "manual", data, "2026-03-22 12:00:00");
        insert.run("other-rig-control", "other-rig", "auto-periodic", data, "2026-03-22 12:00:00");
      })();
      const expectedDeleted = mode === "kind" ? 39990 : 39991;
      expect(mode === "kind" ? repo.pruneSnapshotsByKind("large-rig", "auto-periodic", 10) : repo.pruneSnapshots("large-rig", 10)).toBe(expectedDeleted);
      expect(repo.listSnapshots("large-rig", { kind: "auto-periodic" }).map(r => r.id)).toEqual(Array.from({length:10}, (_,i)=>`history-${39999-i}`));
      expect(repo.getSnapshot("other-rig-control")).not.toBeNull();
      expect(repo.getSnapshot("manual-control") === null).toBe(mode === "all");
    } finally { db.close(); }
  });
});
