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
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";

const PRE_DISCOVERY_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
];

const ALL_MIGRATIONS = [...PRE_DISCOVERY_MIGRATIONS, discoverySchema];

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

describe("DS-T00: Discovery schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  // T1: discovered_sessions table created with all columns
  it("discovered_sessions table has all columns", () => {
    const cols = db.pragma("table_info(discovered_sessions)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("tmux_session");
    expect(names).toContain("tmux_window");
    expect(names).toContain("tmux_pane");
    expect(names).toContain("pid");
    expect(names).toContain("cwd");
    expect(names).toContain("active_command");
    expect(names).toContain("runtime_hint");
    expect(names).toContain("confidence");
    expect(names).toContain("evidence_json");
    expect(names).toContain("config_json");
    expect(names).toContain("status");
    expect(names).toContain("claimed_node_id");
    expect(names).toContain("first_seen_at");
    expect(names).toContain("last_seen_at");
  });

  // T2: Insert + query by status
  it("insert and query by status", () => {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint) VALUES (?, ?, ?, ?)"
    ).run("ds-1", "my-session", "%0", "claude-code");

    const rows = db.prepare("SELECT * FROM discovered_sessions WHERE status = ?")
      .all("active") as Array<{ id: string; runtime_hint: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("ds-1");
    expect(rows[0]!.runtime_hint).toBe("claude-code");
  });

  // T3: Unique constraint on tmux_session+pane
  it("unique constraint on tmux_session+pane rejects duplicates", () => {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane) VALUES (?, ?, ?)"
    ).run("ds-1", "sess-a", "%0");

    expect(() => {
      db.prepare(
        "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane) VALUES (?, ?, ?)"
      ).run("ds-2", "sess-a", "%0");
    }).toThrow(/UNIQUE/);
  });

  // T4: sessions.origin column added with default 'launched'
  it("sessions table has origin column with default launched", () => {
    const cols = db.pragma("table_info(sessions)") as Array<{ name: string; dflt_value: string | null }>;
    const originCol = cols.find((c) => c.name === "origin");
    expect(originCol).toBeDefined();
    expect(originCol!.dflt_value).toBe("'launched'");
  });

  // T5: Pre-existing sessions get origin='launched' via staged migration
  it("pre-existing sessions get origin=launched after migration 012", () => {
    // Use a fresh DB with only pre-012 migrations
    const stagedDb = createDb();
    migrate(stagedDb, PRE_DISCOVERY_MIGRATIONS);

    // Seed a rig + node + session BEFORE 012
    stagedDb.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
    stagedDb.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("node-1", "rig-1", "dev");
    stagedDb.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)").run("sess-1", "node-1", "r01-dev");

    // Now apply migration 012
    migrate(stagedDb, ALL_MIGRATIONS);

    // The existing session should have origin='launched'
    const row = stagedDb.prepare("SELECT origin FROM sessions WHERE id = ?")
      .get("sess-1") as { origin: string };
    expect(row.origin).toBe("launched");

    stagedDb.close();
  });

  // T6: claimed_node_id nullable
  it("claimed_node_id is nullable", () => {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane) VALUES (?, ?, ?)"
    ).run("ds-1", "sess", "%0");

    const row = db.prepare("SELECT claimed_node_id FROM discovered_sessions WHERE id = ?")
      .get("ds-1") as { claimed_node_id: string | null };
    expect(row.claimed_node_id).toBeNull();
  });

  // T7: Upsert on tmux identity — different id, same (tmux_session, tmux_pane)
  it("upsert via UNIQUE(tmux_session, tmux_pane) replaces on identity collision", () => {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, last_seen_at) VALUES (?, ?, ?, ?)"
    ).run("ds-1", "sess", "%0", "2026-03-26 10:00:00");

    // Different id, same tmux identity — UNIQUE drives the replacement
    db.prepare(
      "INSERT OR REPLACE INTO discovered_sessions (id, tmux_session, tmux_pane, last_seen_at) VALUES (?, ?, ?, ?)"
    ).run("ds-2", "sess", "%0", "2026-03-26 11:00:00");

    const rows = db.prepare("SELECT * FROM discovered_sessions WHERE tmux_session = ? AND tmux_pane = ?")
      .all("sess", "%0") as Array<{ id: string; last_seen_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("ds-2");
    expect(rows[0]!.last_seen_at).toBe("2026-03-26 11:00:00");
  });

  // T8: Status transitions
  it("status transitions: active → claimed, active → vanished", () => {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane) VALUES (?, ?, ?)"
    ).run("ds-1", "sess-a", "%0");
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane) VALUES (?, ?, ?)"
    ).run("ds-2", "sess-b", "%0");

    // Transition to claimed
    db.prepare("UPDATE discovered_sessions SET status = 'claimed' WHERE id = ?").run("ds-1");
    // Transition to vanished
    db.prepare("UPDATE discovered_sessions SET status = 'vanished' WHERE id = ?").run("ds-2");

    const claimed = db.prepare("SELECT status FROM discovered_sessions WHERE id = ?")
      .get("ds-1") as { status: string };
    expect(claimed.status).toBe("claimed");

    const vanished = db.prepare("SELECT status FROM discovered_sessions WHERE id = ?")
      .get("ds-2") as { status: string };
    expect(vanished.status).toBe("vanished");
  });

  // T9: claimed_node_id FK enforcement
  it("claimed_node_id FK rejects nonexistent node_id", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, claimed_node_id) VALUES (?, ?, ?, ?)"
      ).run("ds-1", "sess", "%0", "nonexistent-node");
    }).toThrow(/FOREIGN KEY/);
  });
});
