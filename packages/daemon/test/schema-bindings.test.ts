import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";

function seedRigWithNode(db: Database.Database) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
    "rig-1",
    "test-rig"
  );
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run("node-1", "rig-1", "dev1-impl", "worker", "claude-code");
}

describe("002_bindings_sessions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, bindingsSessionsSchema, externalCliAttachmentSchema]);
  });

  afterEach(() => {
    db.close();
  });

  it("creates bindings and sessions tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("bindings");
    expect(names).toContain("sessions");
  });

  describe("bindings", () => {
    it("can insert a binding for a node", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
      ).run("bind-1", "node-1", "r01-dev1-impl");

      const binding = db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get("node-1") as { tmux_session: string };
      expect(binding.tmux_session).toBe("r01-dev1-impl");
    });

    it("binding is optional — node can exist without binding", () => {
      seedRigWithNode(db);
      const binding = db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get("node-1");
      expect(binding).toBeUndefined();
    });

    it("enforces one binding per node (UNIQUE node_id)", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
      ).run("bind-1", "node-1", "r01-dev1-impl");

      expect(() =>
        db
          .prepare(
            "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
          )
          .run("bind-2", "node-1", "r01-dev1-impl-2")
      ).toThrow();
    });

    it("allows updating a binding", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
      ).run("bind-1", "node-1", "r01-dev1-impl");

      db.prepare(
        "UPDATE bindings SET cmux_surface = ? WHERE node_id = ?"
      ).run("surface-42", "node-1");

      const binding = db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get("node-1") as { cmux_surface: string | null };
      expect(binding.cmux_surface).toBe("surface-42");
    });

    it("supports external_cli attachment without tmux session", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO bindings (id, node_id, attachment_type, external_session_name) VALUES (?, ?, ?, ?)"
      ).run("bind-1", "node-1", "external_cli", "orch.lead@host");

      const binding = db
        .prepare("SELECT attachment_type, tmux_session, external_session_name FROM bindings WHERE node_id = ?")
        .get("node-1") as { attachment_type: string; tmux_session: string | null; external_session_name: string | null };
      expect(binding.attachment_type).toBe("external_cli");
      expect(binding.tmux_session).toBeNull();
      expect(binding.external_session_name).toBe("orch.lead@host");
    });

    it("cascades on node delete", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
      ).run("bind-1", "node-1", "r01-dev1-impl");

      db.prepare("DELETE FROM nodes WHERE id = ?").run("node-1");
      const bindings = db.prepare("SELECT * FROM bindings").all();
      expect(bindings).toHaveLength(0);
    });
  });

  describe("sessions", () => {
    it("can insert a session for a node", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)"
      ).run("sess-1", "node-1", "r01-dev1-impl", "running");

      const session = db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get("sess-1") as { session_name: string; status: string };
      expect(session.session_name).toBe("r01-dev1-impl");
      expect(session.status).toBe("running");
    });

    it("defaults status to unknown", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)"
      ).run("sess-1", "node-1", "r01-dev1-impl");

      const session = db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get("sess-1") as { status: string };
      expect(session.status).toBe("unknown");
    });

    it("supports detached status", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)"
      ).run("sess-1", "node-1", "r01-dev1-impl", "running");

      db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(
        "detached",
        "sess-1"
      );

      const session = db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get("sess-1") as { status: string };
      expect(session.status).toBe("detached");
    });

    it("cascades on node delete", () => {
      seedRigWithNode(db);
      db.prepare(
        "INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)"
      ).run("sess-1", "node-1", "r01-dev1-impl");

      db.prepare("DELETE FROM nodes WHERE id = ?").run("node-1");
      const sessions = db.prepare("SELECT * FROM sessions").all();
      expect(sessions).toHaveLength(0);
    });

    it("does NOT include resume_token (deferred to Phase 2)", () => {
      const columns = db
        .prepare("PRAGMA table_info(sessions)")
        .all() as { name: string }[];
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).not.toContain("resume_token");
    });

    it("enforces FK: session must reference valid node", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)"
          )
          .run("sess-1", "nonexistent", "r01-dev1-impl")
      ).toThrow();
    });
  });
});
