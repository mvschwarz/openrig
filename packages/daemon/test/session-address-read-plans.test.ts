import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { resolveCurrentSessionAddress, SessionRegistry } from "../src/domain/session-registry.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(indexed = true) {
  const db = createDb(); databases.push(db);
  migrate(db, ALL_MIGRATIONS.filter(m => indexed || m.name !== "162_session_address_read_indexes.sql"));
  db.exec("INSERT INTO rigs(id,name) VALUES('r','team')");
  const node = db.prepare("INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES(?,'r',?,'claude-code')");
  const session = db.prepare("INSERT INTO sessions(id,node_id,session_name,status,created_at) VALUES(?,?,?,'running',?)");
  const binding = db.prepare("INSERT INTO bindings(id,node_id,tmux_session,attachment_type) VALUES(?,?,?,'tmux')");
  for (let n = 0; n < 4; n++) {
    node.run(`n${n}`, `dev.worker${n}`);
    for (let i = 0; i < 20; i++) session.run(`${n}-${String(i).padStart(3, '0')}`, `n${n}`, `native-${n}@team`, "2099-01-01");
    // Session id defines recency even when the wall clock moves backwards.
    session.run(`${n}-999`, `n${n}`, `native-${n}@team`, "2026-01-01");
    binding.run(`b${n}`, `n${n}`, `native-${n}@team`);
  }
  return db;
}

describe("current session address read cost", () => {
  it("seeks a physical name and the latest registration instead of scanning session history", () => {
    const db = fixture(), sql: string[] = [], prepare = db.prepare;
    db.prepare = function (text: string) { sql.push(text); return prepare.call(this, text); } as typeof db.prepare;
    try {
      expect(resolveCurrentSessionAddress(db, "native-0@team")?.nodeId).toBe("n0");
      expect(getNodeInventory(db, "r").map(n => n.canonicalSessionName)).toContain("native-0@team");
    } finally { db.prepare = prepare; }
    const address = sql.find(s => s.includes("AS senderAddress"))!;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${address}`).all("native-0@team", "native-0@team") as { detail: string }[];
    expect(plan.map(p => p.detail).join("\n")).toMatch(/SEARCH b USING INDEX idx_bindings_tmux_session/);
    expect(plan.map(p => p.detail).join("\n")).not.toMatch(/SCAN s\b/);
    const latest = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE node_id=? ORDER BY id DESC LIMIT 1").all("n0") as { detail: string }[];
    expect(latest.map(p => p.detail).join("\n")).not.toContain("TEMP B-TREE");
  });

  it("keeps exact-name priority, derived aliases, and fresh binding changes", () => {
    const db = fixture();
    expect(resolveCurrentSessionAddress(db, "dev-worker0@team")?.sessionName).toBe("native-0@team");
    // A physical spelling takes priority over another seat's derived spelling.
    db.prepare("UPDATE sessions SET session_name='dev-worker0@team' WHERE id='1-999'").run();
    db.prepare("UPDATE bindings SET tmux_session='dev-worker0@team' WHERE node_id='n1'").run();
    expect(resolveCurrentSessionAddress(db, "dev-worker0@team")?.nodeId).toBe("n1");
    db.prepare("UPDATE sessions SET status='exited' WHERE id='1-999'").run();
    // That other seat's saved spelling still reserves the name.
    expect(resolveCurrentSessionAddress(db, "dev-worker0@team")).toBeNull();
    db.prepare("UPDATE rigs SET archived_at='2026-01-02' WHERE id='r'").run();
    expect(resolveCurrentSessionAddress(db, "native-0@team")).toBeNull();
  });

  it("seeks the latest named registration when the generation reader resolves a session", () => {
    const db = fixture(), sql: string[] = [], prepare = db.prepare;
    db.prepare = function (text: string) { sql.push(text); return prepare.call(this, text); } as typeof db.prepare;
    try { new SessionRegistry(db).currentOccupantGenerationForSession("native-0@team"); }
    finally { db.prepare = prepare; }
    const read = sql.find(s => s.includes("SELECT node_id FROM sessions WHERE session_name"))!;
    expect(read).toBeDefined();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${read}`).all("native-0@team") as { detail: string }[];
    expect(plan.map(p => p.detail).join("\n")).toContain("SEARCH sessions USING INDEX idx_sessions_name_latest_id");
    expect(plan.map(p => p.detail).join("\n")).not.toContain("TEMP B-TREE");
  });

  it("upgrades populated databases without changing registrations or inventory", () => {
    const db = fixture(false);
    const before = { inventory: getNodeInventory(db, "r"),
      physical: resolveCurrentSessionAddress(db, "native-0@team"),
      alias: resolveCurrentSessionAddress(db, "dev-worker0@team"),
      registrations: db.prepare("SELECT * FROM sessions ORDER BY id").all() };
    migrate(db, ALL_MIGRATIONS);
    migrate(db, ALL_MIGRATIONS);
    expect({ inventory: getNodeInventory(db, "r"),
      physical: resolveCurrentSessionAddress(db, "native-0@team"),
      alias: resolveCurrentSessionAddress(db, "dev-worker0@team"),
      registrations: db.prepare("SELECT * FROM sessions ORDER BY id").all() }).toEqual(before);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
