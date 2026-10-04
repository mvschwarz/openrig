import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";

let db: Database.Database;
let nodeId: string;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db);
  const rig = rigRepo.createRig("cursor-permissions");
  nodeId = rigRepo.addNode(rig.id, "dev.owner", { runtime: "cursor", cwd: "/inert/project" }).id;
});
afterEach(() => { if (db.open) db.close(); });

describe("cursor native permission store", () => {
  it("round-trips a cursor auto_review selection through the migrated table", () => {
    const store = new NativePermissionStore(db);
    store.write(nodeId, { runtime: "cursor", mode: "auto_review" }, "zach", "reviewer runs unattended");
    expect(store.read(nodeId)).toMatchObject({ runtime: "cursor", mode: "auto_review", actor: "zach" });
  });

  it("refuses a persisted cursor row with an unknown mode at launch", () => {
    db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES (?, 'cursor', 'plan', 'x', 'y')").run(nodeId);
    expect(() => new NativePermissionStore(db).read(nodeId)).toThrow(/Invalid persisted native permission selection/);
  });

  it("keeps refusing runtimes outside the constraint at the database", () => {
    expect(() => db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES (?, 'pi', 'floor', 'x', 'y')").run(nodeId))
      .toThrow(/CHECK constraint failed/);
  });
});

describe("migration 093 upgrade", () => {
  it("keeps existing codex and claude-code rows byte-identical, admits cursor, still refuses pi and cascades", () => {
    const up = new Database(":memory:");
    try {
      up.pragma("foreign_keys = ON");
      migrate(up, ALL_MIGRATIONS.filter((m) => !m.name.startsWith("093_")));
      const repo = new RigRepository(up);
      const rig = repo.createRig("upgrade-093");
      const codexNode = repo.addNode(rig.id, "codex.owner", { runtime: "codex", cwd: "/inert" }).id;
      const claudeNode = repo.addNode(rig.id, "claude.owner", { runtime: "claude-code", cwd: "/inert" }).id;
      const cursorNode = repo.addNode(rig.id, "cursor.owner", { runtime: "cursor", cwd: "/inert" }).id;
      const insert = up.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
      insert.run(codexNode, "codex", "full_bypass", "zach", "codex unattended", "2026-09-01 08:15:30");
      insert.run(claudeNode, "claude-code", "acceptEdits", "ops@rig", "claude edits", "2026-09-02 09:16:31");
      expect(() => insert.run(cursorNode, "cursor", "auto_review", "zach", "before 093", "2026-09-03 10:00:00")).toThrow(/CHECK constraint failed/);
      const rows = () => up.prepare("SELECT * FROM node_permission_selections ORDER BY node_id").all();
      const before = JSON.stringify(rows());

      migrate(up, ALL_MIGRATIONS);

      expect(JSON.stringify(rows())).toBe(before);
      expect(up.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name LIKE '093_%'").get()).toEqual({ n: 1 });
      insert.run(cursorNode, "cursor", "auto_review", "zach", "after 093", "2026-09-03 10:00:00");
      expect(new NativePermissionStore(up).read(cursorNode)).toMatchObject({ runtime: "cursor", mode: "auto_review" });
      const piNode = repo.addNode(rig.id, "pi.owner", { runtime: "pi", cwd: "/inert" }).id;
      expect(() => insert.run(piNode, "pi", "floor", "x", "y", "2026-09-04 00:00:00")).toThrow(/CHECK constraint failed/);

      up.prepare("DELETE FROM nodes WHERE id = ?").run(codexNode);
      expect(up.prepare("SELECT COUNT(*) n FROM node_permission_selections WHERE node_id = ?").get(codexNode)).toEqual({ n: 0 });
      expect(up.pragma("foreign_key_check")).toEqual([]);
    } finally {
      up.close();
    }
  });
});
