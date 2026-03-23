import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema]);
  return db;
}

function seedRig(db: Database.Database) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
    "rig-1",
    "test-rig"
  );
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run("node-1", "rig-1", "dev1-impl", "worker", "claude-code");
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run("node-2", "rig-1", "dev1-qa", "qa", "codex");
}

describe("SessionRegistry", () => {
  let db: Database.Database;
  let registry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    registry = new SessionRegistry(db);
    seedRig(db);
  });

  afterEach(() => {
    db.close();
  });

  it("registerSession persists and returns typed Session", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.nodeId).toBe("node-1");
    expect(session.sessionName).toBe("r01-dev1-impl");
    expect(session.status).toBe("unknown");
    expect(session.createdAt).toBeDefined();
  });

  it("registerSession with invalid nodeId throws", () => {
    expect(() =>
      registry.registerSession("nonexistent", "r01-dev1-impl")
    ).toThrow();
  });

  it("registerSession rejects invalid session name", () => {
    // Phase 1 = Rigged-managed only. Names must match r{NN}-{cluster}{N}-{role}
    expect(() =>
      registry.registerSession("node-1", "random-session-name")
    ).toThrow(/session name/i);

    expect(() =>
      registry.registerSession("node-1", "my-tmux-session")
    ).toThrow(/session name/i);

    // Valid names should not throw
    expect(() =>
      registry.registerSession("node-1", "r01-dev1-impl")
    ).not.toThrow();
  });

  it("updateStatus changes status", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateStatus(session.id, "running");

    const rows = db
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(session.id) as { status: string };
    expect(rows.status).toBe("running");
  });

  it("markDetached sets status to detached", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateStatus(session.id, "running");
    registry.markDetached(session.id);

    const row = db
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(session.id) as { status: string };
    expect(row.status).toBe("detached");
  });

  it("getSessionsForRig returns all sessions across nodes in rig", () => {
    registry.registerSession("node-1", "r01-dev1-impl");
    registry.registerSession("node-2", "r01-dev1-qa");

    const sessions = registry.getSessionsForRig("rig-1");
    expect(sessions).toHaveLength(2);
    const names = sessions.map((s) => s.sessionName);
    expect(names).toContain("r01-dev1-impl");
    expect(names).toContain("r01-dev1-qa");
  });

  it("getBindingForNode returns null when unbound", () => {
    const binding = registry.getBindingForNode("node-1");
    expect(binding).toBeNull();
  });

  it("updateBinding inserts new binding, returns typed Binding", () => {
    const binding = registry.updateBinding("node-1", {
      tmuxSession: "r01-dev1-impl",
    });
    expect(binding.id).toBeDefined();
    expect(binding.nodeId).toBe("node-1");
    expect(binding.tmuxSession).toBe("r01-dev1-impl");
    expect(binding.cmuxSurface).toBeNull();
  });

  it("updateBinding partial update preserves existing fields", () => {
    // First: set tmux fields
    registry.updateBinding("node-1", {
      tmuxSession: "r01-dev1-impl",
      tmuxWindow: "0",
      tmuxPane: "%1",
    });

    // Second: set cmux fields only — tmux fields must survive
    const updated = registry.updateBinding("node-1", {
      cmuxWorkspace: "review",
      cmuxSurface: "surface-42",
    });

    expect(updated.tmuxSession).toBe("r01-dev1-impl");
    expect(updated.tmuxWindow).toBe("0");
    expect(updated.tmuxPane).toBe("%1");
    expect(updated.cmuxWorkspace).toBe("review");
    expect(updated.cmuxSurface).toBe("surface-42");
  });

  it("updateBinding keeps exactly one row per node after multiple upserts", () => {
    registry.updateBinding("node-1", { tmuxSession: "r01-dev1-impl" });
    registry.updateBinding("node-1", { cmuxSurface: "surface-42" });
    registry.updateBinding("node-1", { tmuxPane: "%3" });

    const rows = db
      .prepare("SELECT * FROM bindings WHERE node_id = ?")
      .all("node-1");
    expect(rows).toHaveLength(1);
  });
});
