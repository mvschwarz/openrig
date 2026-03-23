import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";

describe("005_checkpoints", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, checkpointsSchema]);
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("node-1", "rig-1", "worker");
  });

  afterEach(() => {
    db.close();
  });

  it("creates checkpoints table", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoints'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("can insert checkpoint for a node", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, current_task, next_step, blocked_on, key_artifacts, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("cp-1", "node-1", "Implemented auth module", "auth tests", "write integration tests", null, '["src/auth.ts"]', "high", "2026-03-23 01:00:00");

    const cp = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get("cp-1") as {
      summary: string; current_task: string; confidence: string; key_artifacts: string;
    };
    expect(cp.summary).toBe("Implemented auth module");
    expect(cp.current_task).toBe("auth tests");
    expect(cp.confidence).toBe("high");
    expect(JSON.parse(cp.key_artifacts)).toEqual(["src/auth.ts"]);
  });

  it("latest checkpoint per node: explicit timestamps, newest returned", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, created_at) VALUES (?, ?, ?, ?)"
    ).run("cp-old", "node-1", "first checkpoint", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, created_at) VALUES (?, ?, ?, ?)"
    ).run("cp-mid", "node-1", "second checkpoint", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, created_at) VALUES (?, ?, ?, ?)"
    ).run("cp-new", "node-1", "third checkpoint", "2026-03-23 03:00:00");

    const latest = db
      .prepare("SELECT id, summary FROM checkpoints WHERE node_id = ? ORDER BY created_at DESC LIMIT 1")
      .get("node-1") as { id: string; summary: string };
    expect(latest.id).toBe("cp-new");
    expect(latest.summary).toBe("third checkpoint");
  });

  it("multiple checkpoints per node: all returned in created_at order", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, created_at) VALUES (?, ?, ?, ?)"
    ).run("cp-3", "node-1", "third", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, created_at) VALUES (?, ?, ?, ?)"
    ).run("cp-1", "node-1", "first", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, created_at) VALUES (?, ?, ?, ?)"
    ).run("cp-2", "node-1", "second", "2026-03-23 02:00:00");

    const cps = db
      .prepare("SELECT id FROM checkpoints WHERE node_id = ? ORDER BY created_at")
      .all("node-1") as { id: string }[];
    expect(cps.map((c) => c.id)).toEqual(["cp-1", "cp-2", "cp-3"]);
  });

  it("FK enforced: checkpoint with invalid node_id rejected", () => {
    expect(() =>
      db.prepare(
        "INSERT INTO checkpoints (id, node_id, summary) VALUES (?, ?, ?)"
      ).run("cp-1", "nonexistent-node", "test")
    ).toThrow();
  });

  it("CASCADE: deleting node removes its checkpoints", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary) VALUES (?, ?, ?)"
    ).run("cp-1", "node-1", "test checkpoint");

    db.prepare("DELETE FROM nodes WHERE id = ?").run("node-1");

    const cps = db.prepare("SELECT * FROM checkpoints").all();
    expect(cps).toHaveLength(0);
  });

  it("key_artifacts stored as JSON string, queryable", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts) VALUES (?, ?, ?, ?)"
    ).run("cp-1", "node-1", "test", '["file-a.ts", "file-b.ts"]');

    const cp = db.prepare("SELECT key_artifacts FROM checkpoints WHERE id = ?").get("cp-1") as {
      key_artifacts: string;
    };
    const artifacts = JSON.parse(cp.key_artifacts);
    expect(artifacts).toEqual(["file-a.ts", "file-b.ts"]);
    expect(artifacts).toHaveLength(2);
  });

  it("index idx_checkpoints_node exists on (node_id, created_at)", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_checkpoints_node'")
      .all();
    expect(indexes).toHaveLength(1);
  });
});
