import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { LegacyRigSpecSchema as RigSpecSchema } from "../src/domain/rigspec-schema.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { LegacyRigSpecCodec as RigSpecCodec } from "../src/domain/rigspec-codec.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { RigNotFoundError } from "../src/domain/errors.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, resumeMetadataSchema, checkpointsSchema, nodeSpecFieldsSchema, agentspecRebootSchema]);
  return db;
}

describe("RigSpecExporter", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let exporter: RigSpecExporter;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    exporter = new RigSpecExporter({ rigRepo, sessionRegistry });
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("r99");
    const n1 = rigRepo.addNode(rig.id, "orchestrator", {
      role: "orchestrator",
      runtime: "claude-code",
      model: "opus",
      cwd: "/repo",
      surfaceHint: "tab:main",
      workspace: "review",
      packageRefs: ["github:example/pkg@v1"],
    });
    const n2 = rigRepo.addNode(rig.id, "worker", {
      role: "worker",
      runtime: "codex",
      cwd: "/repo",
    });
    rigRepo.addEdge(rig.id, n1.id, n2.id, "delegates_to");
    // Add a binding to n1 (should be excluded from export)
    sessionRegistry.updateBinding(n1.id, { tmuxSession: "r99-orchestrator", cmuxSurface: "s-1" });
    return { rig, n1, n2 };
  }

  it("export rig with nodes and edges -> valid RigSpec", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);

    expect(spec.name).toBe("r99");
    expect(spec.schemaVersion).toBe(1);
    expect(spec.nodes).toHaveLength(2);
    expect(spec.edges).toHaveLength(1);
  });

  it("exported spec passes schema validation", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);

    const result = RigSpecSchema.validate(RigSpecCodec.parse(RigSpecCodec.serialize(spec)));
    expect(result.valid).toBe(true);
  });

  it("exported node ids are logical_ids (not DB PKs)", () => {
    const { rig, n1 } = seedRig();
    const spec = exporter.exportRig(rig.id);

    // Node ids should be logical_ids like "orchestrator", not ULIDs
    expect(spec.nodes[0]!.id).toBe("orchestrator");
    expect(spec.nodes[1]!.id).toBe("worker");
    // Definitely not DB primary keys
    expect(spec.nodes[0]!.id).not.toBe(n1.id);
  });

  it("exported edges use logical_ids for from/to", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);

    expect(spec.edges[0]!.from).toBe("orchestrator");
    expect(spec.edges[0]!.to).toBe("worker");
    expect(spec.edges[0]!.kind).toBe("delegates_to");
  });

  it("export excludes session IDs, resume tokens, binding data", () => {
    const { rig, n1 } = seedRig();
    // Add a session with resume data
    const sess = sessionRegistry.registerSession(n1.id, "r99-orchestrator");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ? WHERE id = ?")
      .run("claude_name", "secret-token", sess.id);

    const spec = exporter.exportRig(rig.id);
    const yaml = RigSpecCodec.serialize(spec);

    // None of these should appear in the exported spec
    expect(yaml).not.toContain("secret-token");
    expect(yaml).not.toContain(sess.id);
    expect(yaml).not.toContain("tmux_session");
    expect(yaml).not.toContain("cmux_surface");
    expect(yaml).not.toContain(n1.id); // DB PK
  });

  it("export includes role, runtime, model, cwd, surfaceHint, packageRefs", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);

    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    expect(orch.role).toBe("orchestrator");
    expect(orch.runtime).toBe("claude-code");
    expect(orch.model).toBe("opus");
    expect(orch.cwd).toBe("/repo");
    expect(orch.surfaceHint).toBe("tab:main");
    expect(orch.packageRefs).toEqual(["github:example/pkg@v1"]);
  });

  it("export includes restorePolicy from latest session (newest wins)", () => {
    const { rig, n1 } = seedRig();
    // Add two sessions with explicit timestamps and different policies
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("sess-old", n1.id, "r99-orchestrator", "exited", "relaunch_fresh", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("sess-new", n1.id, "r99-orchestrator", "running", "checkpoint_only", "2026-03-23 02:00:00");

    const spec = exporter.exportRig(rig.id);
    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    expect(orch.restorePolicy).toBe("checkpoint_only"); // newest session wins
  });

  it("export restorePolicy falls back to node.restore_policy when no session", () => {
    const rig = rigRepo.createRig("r98");
    rigRepo.addNode(rig.id, "worker", {
      runtime: "codex",
      restorePolicy: "relaunch_fresh",
    });

    const spec = exporter.exportRig(rig.id);
    expect(spec.nodes[0]!.restorePolicy).toBe("relaunch_fresh");
  });

  it("export with multiple sessions: latest by createdAt wins", () => {
    const { rig, n2 } = seedRig();
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s1", n2.id, "r99-worker", "exited", "checkpoint_only", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s2", n2.id, "r99-worker", "running", "relaunch_fresh", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s3", n2.id, "r99-worker", "idle", "resume_if_possible", "2026-03-23 02:00:00");

    const spec = exporter.exportRig(rig.id);
    const worker = spec.nodes.find((n) => n.id === "worker")!;
    expect(worker.restorePolicy).toBe("relaunch_fresh"); // s2 is newest
  });

  it("same-second sessions: tiebreaker by id (ULID) for deterministic result", () => {
    const { rig, n1 } = seedRig();
    // Two sessions with identical createdAt but different IDs and policies
    // ULID "B..." sorts after "A..." so sess-b is the "latest"
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("AAAA_sess_first", n1.id, "r99-orchestrator", "running", "relaunch_fresh", "2026-03-23 05:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("ZZZZ_sess_second", n1.id, "r99-orchestrator", "running", "checkpoint_only", "2026-03-23 05:00:00");

    const spec = exporter.exportRig(rig.id);
    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    // ZZZZ sorts after AAAA, so checkpoint_only should win
    expect(orch.restorePolicy).toBe("checkpoint_only");
  });

  it("export nonexistent rig -> throws RigNotFoundError", () => {
    expect(() => exporter.exportRig("nonexistent")).toThrow(RigNotFoundError);
  });

  it("export node with null runtime -> throws explicit error", () => {
    const rig = rigRepo.createRig("r97");
    // Insert node with no runtime via raw SQL to bypass addNode defaults
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)")
      .run("node-no-rt", rig.id, "broken-node");

    expect(() => exporter.exportRig(rig.id)).toThrow(/runtime.*required/i);
  });

  it("export edge with unmapped sourceId -> throws", () => {
    const rig = rigRepo.createRig("r96");
    const n1 = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    // Temporarily disable FK to insert corrupted edge
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)")
      .run("bad-edge", rig.id, "nonexistent-source", n1.id, "delegates_to");
    db.pragma("foreign_keys = ON");

    expect(() => exporter.exportRig(rig.id)).toThrow(/unmapped.*source/i);
  });

  it("export edge with unmapped targetId -> throws", () => {
    const rig = rigRepo.createRig("r95");
    const n1 = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)")
      .run("bad-edge", rig.id, n1.id, "nonexistent-target", "delegates_to");
    db.pragma("foreign_keys = ON");

    expect(() => exporter.exportRig(rig.id)).toThrow(/unmapped.*target/i);
  });

  it("round-trip: export -> serialize -> parse -> validate all pass", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);
    const yaml = RigSpecCodec.serialize(spec);
    const parsed = RigSpecCodec.parse(yaml);
    const result = RigSpecSchema.validate(parsed);
    expect(result.valid).toBe(true);
  });

  it("constructor throws on mismatched db handles", () => {
    const otherDb = setupDb();
    const otherRepo = new RigRepository(otherDb);

    expect(() => new RigSpecExporter({ rigRepo: otherRepo, sessionRegistry }))
      .toThrow(/same db handle/);

    otherDb.close();
  });
});
