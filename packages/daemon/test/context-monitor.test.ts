import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../src/db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
  discoverySchema, discoveryFkFix, agentspecRebootSchema, podNamespaceSchema,
  contextUsageSchema, externalCliAttachmentSchema,
];

describe("ContextMonitor", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let store: ContextUsageStore;
  let monitor: ContextMonitor;
  let ensureContextCollectorSpy: ReturnType<typeof vi.fn>;
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    tmpDir = join(tmpdir(), `context-monitor-${Date.now()}`);
    mkdirSync(join(tmpDir, "context"), { recursive: true });
    store = new ContextUsageStore(db, { stateDir: tmpDir });
    ensureContextCollectorSpy = vi.fn();
    monitor = new ContextMonitor(db, store, {
      ensureContextCollector: ensureContextCollectorSpy,
    });
  });

  afterEach(() => {
    monitor.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedClaudeNode(logicalId = "dev.impl", sessionName = "dev.impl@test") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    // Mark as running so the monitor considers it eligible
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    return { rig, node, sessionName };
  }

  function seedCodexNode() {
    const rig = rigRepo.createRig("test-rig-2");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    sessionRegistry.registerSession(node.id, "dev.qa@test");
    return { rig, node };
  }

  function seedClaimedNode() {
    const rig = rigRepo.createRig("test-rig-3");
    const node = rigRepo.addNode(rig.id, "adopted.node", { runtime: "claude-code" });
    const session = sessionRegistry.registerClaimedSession(node.id, "adopted-session");
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    sessionRegistry.updateBinding(node.id, { tmuxSession: "adopted-session" });
    return { rig, node };
  }

  function seedExternalCliClaudeNode() {
    const rig = rigRepo.createRig("test-rig-4");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code" });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch.lead@test");
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    sessionRegistry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: "orch.lead@test" });
    return { rig, node };
  }

  function writeSidecar(sessionName: string, data: Record<string, unknown>) {
    const safeName = sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_");
    writeFileSync(join(tmpDir, "context", `${safeName}.json`), JSON.stringify(data));
  }

  const VALID_SIDECAR = {
    context_window: {
      context_window_size: 200000,
      used_percentage: 67,
      remaining_percentage: 33,
      total_input_tokens: 120000,
      total_output_tokens: 14000,
      current_usage: "67% used",
    },
    session_id: "sess-123",
    session_name: "dev.impl@test",
    transcript_path: "/tmp/test.log",
    sampled_at: new Date().toISOString(),
  };

  // T1: pollOnce discovers running Claude sessions and persists usage
  it("pollOnce discovers running Claude sessions and persists context usage", () => {
    const { node, sessionName } = seedClaudeNode();
    writeSidecar(sessionName, VALID_SIDECAR);

    monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(67);
    expect(ensureContextCollectorSpy).toHaveBeenCalledWith({
      cwd: undefined,
      tmuxSession: sessionName,
    });
  });

  // T2: pollOnce skips non-Claude runtimes
  it("pollOnce skips non-Claude runtimes", () => {
    const { node: codexNode } = seedCodexNode();

    monitor.pollOnce();

    const usage = store.getForNode(codexNode.id, "dev.qa@test");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("no_data");
  });

  // T3: pollOnce persists unknown for missing sidecar
  it("pollOnce persists unknown for missing sidecar files", () => {
    const { node, sessionName } = seedClaudeNode();
    // No sidecar file written

    monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
  });

  // T4: pollOnce handles malformed sidecar without crashing
  it("pollOnce handles malformed sidecar without crashing", () => {
    const { node, sessionName } = seedClaudeNode();
    writeSidecar(sessionName, { bad: "data" });

    monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("parse_error");
  });

  // T5: pollOnce with zero eligible sessions does nothing
  it("pollOnce with zero eligible sessions does nothing", () => {
    // No nodes seeded
    monitor.pollOnce(); // Should not throw
  });

  // T6: start/stop manages interval lifecycle
  it("start/stop manages interval lifecycle", () => {
    monitor.start(1000);
    monitor.start(1000); // Idempotent — no double interval
    monitor.stop();
    monitor.stop(); // Safe to call again
  });

  // T7: One bad session doesn't prevent polling other sessions
  it("one bad session does not prevent polling others", () => {
    const { node: node1, sessionName: s1 } = seedClaudeNode("dev.impl1", "impl1@test");
    const rig2 = rigRepo.createRig("rig2");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl2", { runtime: "claude-code" });
    const s2 = sessionRegistry.registerSession(node2.id, "impl2@test");
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(s2.id);

    // Write valid sidecar for node2 only; node1 has no sidecar
    writeSidecar("impl2@test", { ...VALID_SIDECAR, session_name: "impl2@test" });

    monitor.pollOnce();

    // node1 should have unknown, node2 should have known
    expect(store.getForNode(node1.id, "impl1@test").availability).toBe("unknown");
    expect(store.getForNode(node2.id, "impl2@test").availability).toBe("known");
  });

  // T8: Monitor uses existing node/session identity (not its own)
  it("monitor does not create its own node/session identity", () => {
    seedClaudeNode();
    monitor.pollOnce();

    // No new nodes or sessions should have been created
    const rig = rigRepo.getRig(rigRepo.listRigs()[0]!.id);
    expect(rig!.nodes).toHaveLength(1); // Only the one we seeded
  });

  // T9: Claimed/adopted Claude tmux sessions are polled
  it("claimed tmux sessions are polled", () => {
    const { node } = seedClaimedNode();
    writeSidecar("adopted-session", { ...VALID_SIDECAR, session_name: "adopted-session" });

    monitor.pollOnce();

    const usage = store.getForNode(node.id, "adopted-session");
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(67);
  });

  it("external_cli Claude sessions are not polled", () => {
    const { node } = seedExternalCliClaudeNode();
    writeSidecar("orch.lead@test", VALID_SIDECAR);

    monitor.pollOnce();

    const usage = store.getForNode(node.id, "orch.lead@test");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("no_data");
  });
});
