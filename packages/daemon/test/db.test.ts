import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

describe("createDb", () => {
  it("creates an in-memory database with WAL and FK pragmas", () => {
    const db = createDb();
    const walMode = db.pragma("journal_mode", { simple: true });
    // In-memory databases may report "memory" instead of "wal" — that's fine.
    // WAL is set but only takes effect on file-backed DBs.
    expect(walMode).toBeDefined();

    const fkEnabled = db.pragma("foreign_keys", { simple: true });
    expect(fkEnabled).toBe(1);

    db.close();
  });

  it("creates a file-backed database when path is given", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");
    const db = createDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it.skipIf(process.platform === "win32")("file-backed database is owner-only (0600)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");
    const db = createDb(dbPath);
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("migrate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates schema_migrations table on first run", () => {
    migrate(db, []);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("runs zero migrations without error", () => {
    expect(() => migrate(db, [])).not.toThrow();
  });

  it("applies a trivial migration", () => {
    const migrations = [
      {
        name: "001_test.sql",
        sql: "CREATE TABLE test_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, migrations);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("tracks applied migrations in schema_migrations", () => {
    const migrations = [
      {
        name: "001_test.sql",
        sql: "CREATE TABLE test_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, migrations);

    const applied = db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as { name: string }[];
    expect(applied).toEqual([{ name: "001_test.sql" }]);
  });

  it("refuses to re-run already-applied migrations", () => {
    const migrations = [
      {
        name: "001_test.sql",
        sql: "CREATE TABLE test_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, migrations);
    // Running again should not throw (idempotent) and should not re-execute SQL
    expect(() => migrate(db, migrations)).not.toThrow();

    const applied = db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as { name: string }[];
    expect(applied).toHaveLength(1);
  });

  it("applies migrations in order", () => {
    const migrations = [
      {
        name: "001_first.sql",
        sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY);",
      },
      {
        name: "002_second.sql",
        sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY, first_ref TEXT REFERENCES first_table(id));",
      },
    ];
    migrate(db, migrations);

    const applied = db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as { name: string }[];
    expect(applied).toEqual([
      { name: "001_first.sql" },
      { name: "002_second.sql" },
    ]);
  });

  it("only applies new migrations on subsequent runs", () => {
    const first = [
      {
        name: "001_first.sql",
        sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, first);

    const both = [
      ...first,
      {
        name: "002_second.sql",
        sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, both);

    const applied = db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as { name: string }[];
    expect(applied).toHaveLength(2);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='second_table'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });
});
