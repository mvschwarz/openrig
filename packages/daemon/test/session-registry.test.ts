import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
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

  it("registerSession accepts r01-orchestrator (valid under relaxed pattern)", () => {
    expect(() =>
      registry.registerSession("node-1", "r01-orchestrator")
    ).not.toThrow();
  });

  it("registerSession rejects invalid session name (no rNN- prefix)", () => {
    expect(() =>
      registry.registerSession("node-1", "random-session-name")
    ).toThrow(/session name/i);

    expect(() =>
      registry.registerSession("node-1", "my-tmux-session")
    ).toThrow(/session name/i);

    // Missing rNN- prefix
    expect(() =>
      registry.registerSession("node-1", "orchestrator")
    ).toThrow(/session name/i);

    // Valid names should not throw
    expect(() =>
      registry.registerSession("node-2", "r01-dev1-impl")
    ).not.toThrow();
  });

  // NS-T04: updateResumeToken
  it("updateResumeToken persists type and token", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateResumeToken(session.id, "claude_id", "abc-123-def");

    const sessions = registry.getSessionsForRig("rig-1");
    const updated = sessions.find((s) => s.id === session.id);
    expect(updated!.resumeType).toBe("claude_id");
    expect(updated!.resumeToken).toBe("abc-123-def");
  });

  it("clearResumeToken clears stored resume metadata", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateResumeToken(session.id, "claude_id", "abc-123-def");

    registry.clearResumeToken(session.id);

    const sessions = registry.getSessionsForRig("rig-1");
    const updated = sessions.find((s) => s.id === session.id);
    expect(updated!.resumeType).toBeNull();
    expect(updated!.resumeToken).toBeNull();
  });

  it("registerSession accepts canonical session name with @", () => {
    const session = registry.registerSession("node-1", "dev-impl@auth-feats");
    expect(session.sessionName).toBe("dev-impl@auth-feats");
    expect(session.nodeId).toBe("node-1");
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

  // -- P2-T02b: Resume metadata mapping --

  it("registerSession returns session with default resume metadata", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    expect(session.resumeType).toBeNull();
    expect(session.resumeToken).toBeNull();
    expect(session.restorePolicy).toBe("resume_if_possible");
  });

  it("getSessionsForRig returns populated resume metadata after update", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    db.prepare(
      "UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?"
    ).run("claude_name", "my-session", "checkpoint_only", session.id);

    const sessions = registry.getSessionsForRig("rig-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.resumeType).toBe("claude_name");
    expect(sessions[0]!.resumeToken).toBe("my-session");
    expect(sessions[0]!.restorePolicy).toBe("checkpoint_only");
  });

  // -- P2-T07: Stale-state repair methods --

  it("clearBinding removes binding row for node", () => {
    registry.updateBinding("node-1", { tmuxSession: "r01-dev1-impl" });
    expect(registry.getBindingForNode("node-1")).not.toBeNull();

    registry.clearBinding("node-1");
    expect(registry.getBindingForNode("node-1")).toBeNull();
  });

  it("markSuperseded sets session status to 'superseded'", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateStatus(session.id, "running");

    registry.markSuperseded(session.id);

    const sessions = registry.getSessionsForRig("rig-1");
    expect(sessions[0]!.status).toBe("superseded");
  });
});
