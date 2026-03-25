import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema,
];

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

describe("P4-T00: Package storage schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: packages table has all specified columns
  it("packages table has all specified columns", () => {
    const cols = db.pragma("table_info(packages)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("name");
    expect(names).toContain("version");
    expect(names).toContain("source_kind");
    expect(names).toContain("source_ref");
    expect(names).toContain("manifest_hash");
    expect(names).toContain("summary");
    expect(names).toContain("created_at");
  });

  // Test 2: package_installs table has all columns
  it("package_installs table has all columns including lifecycle timestamps", () => {
    const cols = db.pragma("table_info(package_installs)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("package_id");
    expect(names).toContain("target_root");
    expect(names).toContain("scope");
    expect(names).toContain("status");
    expect(names).toContain("risk_tier");
    expect(names).toContain("created_at");
    expect(names).toContain("applied_at");
    expect(names).toContain("rolled_back_at");
  });

  // Test 3: install_journal table has all columns
  it("install_journal table has all columns including hashes", () => {
    const cols = db.pragma("table_info(install_journal)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("install_id");
    expect(names).toContain("action");
    expect(names).toContain("export_type");
    expect(names).toContain("classification");
    expect(names).toContain("target_path");
    expect(names).toContain("backup_path");
    expect(names).toContain("before_hash");
    expect(names).toContain("after_hash");
    expect(names).toContain("status");
    expect(names).toContain("created_at");
  });

  // Test 4: Insert package → query by name+version
  it("insert package and query by name+version", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");

    const row = db.prepare("SELECT * FROM packages WHERE name = ? AND version = ?")
      .get("test-pkg", "1.0.0") as { id: string; name: string; version: string };

    expect(row.id).toBe("pkg-1");
    expect(row.name).toBe("test-pkg");
    expect(row.version).toBe("1.0.0");
  });

  // Test 5: Insert install → query by package_id
  it("insert install and query by package_id", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");

    db.prepare(
      "INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)"
    ).run("inst-1", "pkg-1", "/tmp/repo", "project_shared");

    const rows = db.prepare("SELECT * FROM package_installs WHERE package_id = ?")
      .all("pkg-1") as Array<{ id: string; status: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("inst-1");
    expect(rows[0]!.status).toBe("planned");
  });

  // Test 6: Insert journal entry → query by install_id
  it("insert journal entry and query by install_id", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");
    db.prepare(
      "INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)"
    ).run("inst-1", "pkg-1", "/tmp/repo", "project_shared");

    db.prepare(
      "INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path, before_hash, after_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("j-1", "inst-1", 1, "copy", "skill", "safe_projection", ".claude/skills/foo/SKILL.md", null, "def456");

    const rows = db.prepare("SELECT * FROM install_journal WHERE install_id = ?")
      .all("inst-1") as Array<{ id: string; action: string; after_hash: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("copy");
    expect(rows[0]!.after_hash).toBe("def456");
  });

  // Test 7: UNIQUE constraint on packages(name, version)
  it("UNIQUE constraint on packages(name, version)", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");

    expect(() => {
      db.prepare(
        "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("pkg-2", "test-pkg", "1.0.0", "local_path", "/tmp/pkg2", "def456");
    }).toThrow(/UNIQUE/);
  });

  // Test 8: Package delete with existing installs → FK error, install row survives
  it("package delete with existing installs throws FK error and install survives", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");
    db.prepare(
      "INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)"
    ).run("inst-1", "pkg-1", "/tmp/repo", "project_shared");

    expect(() => {
      db.prepare("DELETE FROM packages WHERE id = ?").run("pkg-1");
    }).toThrow(/FOREIGN KEY/);

    // Install row must survive
    const install = db.prepare("SELECT * FROM package_installs WHERE id = ?").get("inst-1");
    expect(install).toBeDefined();
  });

  // Test 9: idx_installs_package index exists
  it("idx_installs_package index exists on package_installs", () => {
    const indexes = db.pragma("index_list(package_installs)") as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_installs_package");
  });

  // Test 10: idx_journal_install index exists
  it("idx_journal_install index exists on install_journal", () => {
    const indexes = db.pragma("index_list(install_journal)") as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_journal_install");
  });

  // Test 11: FK — insert install with nonexistent package_id fails
  it("insert install with nonexistent package_id throws FK error", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)"
      ).run("inst-1", "nonexistent-pkg", "/tmp/repo", "project_shared");
    }).toThrow(/FOREIGN KEY/);
  });

  // Test 12: FK — insert journal with nonexistent install_id fails
  it("insert journal with nonexistent install_id throws FK error", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("j-1", "nonexistent-inst", 1, "copy", "skill", "safe_projection", "/target");
    }).toThrow(/FOREIGN KEY/);
  });

  // Test 13: Startup wiring — createDaemon applies 008/009
  it("createDaemon creates packages + package_installs + install_journal tables", async () => {
    // Close the test DB — we'll use createDaemon's own DB
    db.close();

    const { createDaemon } = await import("../src/startup.js");
    const { db: daemonDb } = await createDaemon({ dbPath: ":memory:" });

    try {
      const tables = daemonDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      ).all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("packages");
      expect(tableNames).toContain("package_installs");
      expect(tableNames).toContain("install_journal");
    } finally {
      daemonDb.close();
    }
  });

  // Test 14: install_journal has seq column after 010
  it("install_journal has seq column", () => {
    const cols = db.pragma("table_info(install_journal)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("seq");
  });

  // Test 15: UNIQUE(install_id, seq) constraint on install_journal
  it("UNIQUE(install_id, seq) constraint enforced", () => {
    db.prepare("INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)").run("p1", "pkg", "1.0.0", "local_path", "/p", "h");
    db.prepare("INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)").run("i1", "p1", "/repo", "project_shared");
    db.prepare("INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)").run("j1", "i1", 1, "copy", "skill", "safe_projection", "/t1");

    expect(() => {
      db.prepare("INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)").run("j2", "i1", 1, "copy", "skill", "safe_projection", "/t2");
    }).toThrow(/UNIQUE/);
  });

  // Test 16: createDaemon applies 010 (seq column present via startup)
  it("createDaemon applies 010 migration (seq column in install_journal)", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { db: daemonDb } = await createDaemon({ dbPath: ":memory:" });

    try {
      const cols = daemonDb.pragma("table_info(install_journal)") as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("seq");
    } finally {
      daemonDb.close();
    }
  });
});
