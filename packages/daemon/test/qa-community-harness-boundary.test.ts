import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { sessionAgentAppSchema as retainedSelectionSchema } from "../src/db/migrations/114_session_agent_app.js";
import { sessionCommunityHarnessSelect } from "../src/domain/session-registry.js";

const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const keep = (db: Database.Database) => { dbs.push(db); return db; };
const preset = (name: string) => `format: 1\nname: ${name}\ncommand: node harmless-fixture.mjs\nmaintainer: Independent QA\nlimits: [resume unsupported]\n`;

describe("independent community-harness interface boundaries", () => {
  it("discovers only the new preset directory through the mounted production API and leaves old input untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "qa-harness-boundary-")); roots.push(home);
    vi.stubEnv("OPENRIG_HOME", home);
    const newDir = join(home, "community-harnesses");
    const oldDir = join(home, ["agent", "apps"].join("-"));
    mkdirSync(newDir); mkdirSync(oldDir);
    writeFileSync(join(newDir, "new-qa.yaml"), preset("new-qa"));
    const oldPath = join(oldDir, "old-qa.yaml");
    writeFileSync(oldPath, preset("old-qa"));
    const before = readFileSync(oldPath);
    const { app } = createTestApp(keep(createFullTestDb()));
    const response = await app.request("/api/community-harnesses");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dir).toBe(newDir);
    expect(body.harnesses).toEqual([expect.objectContaining({ name: "new-qa", usable: true, maintainer: "Independent QA" })]);
    expect(Object.keys(body).sort()).toEqual(["dir", "harnesses"]);
    expect(readFileSync(oldPath)).toEqual(before);
    expect(existsSync(join(newDir, "old-qa.yaml"))).toBe(false);
    const oldRoute = ["agent", "apps"].join("-");
    expect((await app.request(`/api/${oldRoute}`)).status).toBe(404);
  });

  it("does not silently rediscover an old-directory-only preset", async () => {
    const home = mkdtempSync(join(tmpdir(), "qa-harness-old-only-")); roots.push(home);
    vi.stubEnv("OPENRIG_HOME", home);
    const oldDir = join(home, ["agent", "apps"].join("-")); mkdirSync(oldDir);
    const path = join(oldDir, "old-qa.yaml"); writeFileSync(path, preset("old-qa"));
    const before = readFileSync(path);
    const { app } = createTestApp(keep(createFullTestDb()));
    const response = await app.request("/api/community-harnesses");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dir: join(home, "community-harnesses"), harnesses: [] });
    expect(readFileSync(path)).toEqual(before);
  });

  it("applies the immutable selection migration once on a fresh minimal session table", () => {
    const db = keep(new Database(":memory:"));
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, marker TEXT); INSERT INTO sessions VALUES ('qa', 'preserve');");
    migrate(db, [retainedSelectionSchema]);
    expect(db.prepare("SELECT * FROM sessions").all()).toEqual([{ id: "qa", marker: "preserve", agent_app: null }]);
    expect(db.prepare("SELECT name FROM schema_migrations").all()).toEqual([{ name: "114_session_agent_app.sql" }]);
    expect((db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(row => row.name)).toEqual(["id", "marker", "agent_app"]);
  });

  it("skips an already-applied selection migration without rewriting its ledger or retained data", () => {
    const statements: string[] = [];
    const db = keep(new Database(":memory:", { verbose: (sql) => statements.push(String(sql)) }));
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, agent_app TEXT);
      INSERT INTO sessions VALUES ('selected', 'synth-qa'), ('builtin', NULL);
      CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('114_session_agent_app.sql', 'sentinel-original-timestamp');`);
    const rowsBefore = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    const ledgerBefore = db.prepare("SELECT * FROM schema_migrations").all();
    const schemaBefore = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    statements.length = 0;
    migrate(db, [retainedSelectionSchema]);
    expect(statements.filter(sql => /\b(?:ALTER|UPDATE|DELETE)\b/i.test(sql))).toEqual([]);
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(rowsBefore);
    expect(db.prepare("SELECT * FROM schema_migrations").all()).toEqual(ledgerBefore);
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(schemaBefore);
    expect(sessionCommunityHarnessSelect(db)).toBe("s.agent_app");
  });

  it("reads a partial pre-selection schema as NULL without opportunistically migrating it", () => {
    const db = keep(new Database(":memory:")); db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY);");
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get();
    expect(sessionCommunityHarnessSelect(db)).toBe("NULL");
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").all()).toEqual([]);
  });
});
