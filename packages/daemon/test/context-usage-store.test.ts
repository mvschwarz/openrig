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
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../src/db/migrations/018_context_usage.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ContextUsageStore, FRESHNESS_THRESHOLD_MS } from "../src/domain/context-usage-store.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
  discoverySchema, discoveryFkFix, agentspecRebootSchema, podNamespaceSchema,
  contextUsageSchema,
];

describe("ContextUsageStore", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let store: ContextUsageStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    store = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
  });

  afterEach(() => { db.close(); });

  function seedNode(logicalId = "dev.impl") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    return { rig, node };
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
    session_name: "dev-impl@test-rig",
    transcript_path: "/tmp/transcripts/test.log",
    sampled_at: new Date().toISOString(),
  };

  // T1: Valid sidecar normalizes into known ContextUsage
  it("valid sidecar JSON normalizes into known ContextUsage", () => {
    const usage = store.normalizeSample(VALID_SIDECAR);
    expect(usage.availability).toBe("known");
    expect(usage.reason).toBeNull();
    expect(usage.source).toBe("claude_statusline_json");
    expect(usage.usedPercentage).toBe(67);
    expect(usage.remainingPercentage).toBe(33);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.totalInputTokens).toBe(120000);
    expect(usage.totalOutputTokens).toBe(14000);
    expect(usage.currentUsage).toBe("67% used");
    expect(usage.sessionId).toBe("sess-123");
    expect(usage.sessionName).toBe("dev-impl@test-rig");
    expect(usage.transcriptPath).toBe("/tmp/transcripts/test.log");
    expect(usage.fresh).toBe(true);
  });

  // T2: Missing sidecar -> unknown with reason
  it("null raw produces unknown with missing_sidecar reason", () => {
    const usage = store.normalizeSample(null);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
    expect(usage.usedPercentage).toBeNull();
    expect(usage.fresh).toBe(false);
  });

  // T3: Invalid JSON (missing context_window) -> parse_error
  it("raw without context_window produces unknown with parse_error", () => {
    const usage = store.normalizeSample({ session_id: "x" } as any);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("parse_error");
  });

  // T4: Stale sample -> fresh=false but values retained
  it("stale sample has fresh=false but retains persisted values", () => {
    const stale = {
      ...VALID_SIDECAR,
      sampled_at: new Date(Date.now() - FRESHNESS_THRESHOLD_MS - 60_000).toISOString(),
    };
    const usage = store.normalizeSample(stale);
    expect(usage.availability).toBe("known");
    expect(usage.fresh).toBe(false);
    expect(usage.usedPercentage).toBe(67); // values retained, not erased
  });

  // T5: persist + getForNode round-trip
  it("persist upserts, getForNode retrieves with freshness", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const retrieved = store.getForNode(node.id, "dev-impl@test-rig");
    expect(retrieved.availability).toBe("known");
    expect(retrieved.usedPercentage).toBe(67);
    expect(retrieved.sessionName).toBe("dev-impl@test-rig");
  });

  // T6: getForNode on nonexistent node -> unknown
  it("getForNode on nonexistent node returns unknown", () => {
    const result = store.getForNode("nonexistent", "some-session");
    expect(result.availability).toBe("unknown");
    expect(result.reason).toBe("no_data");
  });

  // T7: unknownUsage factory
  it("unknownUsage produces correct shape", () => {
    const usage = store.unknownUsage("unsupported_runtime");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("unsupported_runtime");
    expect(usage.usedPercentage).toBeNull();
    expect(usage.fresh).toBe(false);
    expect(usage.source).toBeNull();
  });

  // T8: getSidecarPath returns path under stateDir/context/
  it("getSidecarPath returns path under stateDir/context/", () => {
    const path = store.getSidecarPath("dev-impl@test-rig");
    expect(path).toContain("context");
    expect(path).toContain("dev-impl@test-rig");
    expect(path.endsWith(".json")).toBe(true);
  });

  // T9: Freshness threshold is centralized
  it("FRESHNESS_THRESHOLD_MS is exported and used consistently", () => {
    expect(typeof FRESHNESS_THRESHOLD_MS).toBe("number");
    expect(FRESHNESS_THRESHOLD_MS).toBe(120_000);
  });

  // T10: context_usage row cascades on node delete
  it("context_usage cascades on node delete", () => {
    const { rig, node } = seedNode();
    store.persist(node.id, store.normalizeSample(VALID_SIDECAR));

    // Verify row exists
    const before = db.prepare("SELECT COUNT(*) as c FROM context_usage WHERE node_id = ?").get(node.id) as { c: number };
    expect(before.c).toBe(1);

    // Delete the node (cascade should remove context_usage)
    db.prepare("DELETE FROM nodes WHERE id = ?").run(node.id);

    const after = db.prepare("SELECT COUNT(*) as c FROM context_usage WHERE node_id = ?").get(node.id) as { c: number };
    expect(after.c).toBe(0);
  });

  // T11: getForNode session mismatch -> unknown
  it("getForNode returns unknown when session_name mismatches", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const result = store.getForNode(node.id, "different-session@new-rig");
    expect(result.availability).toBe("unknown");
    expect(result.reason).toBe("session_mismatch");
  });

  // T12: getForNodes batch session mismatch
  it("getForNodes returns unknown for mismatched sessions in batch", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: "different-session" },
    ]);

    expect(results.get(node.id)?.availability).toBe("unknown");
    expect(results.get(node.id)?.reason).toBe("session_mismatch");
  });

  // T12b: getForNodes with null currentSessionName -> not_managed
  it("getForNodes returns unknown for null currentSessionName", () => {
    const { node } = seedNode();
    store.persist(node.id, store.normalizeSample(VALID_SIDECAR));

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: null },
    ]);

    expect(results.get(node.id)?.availability).toBe("unknown");
    expect(results.get(node.id)?.reason).toBe("not_managed");
  });

  // T14: readSidecar missing file -> { ok: false, reason: 'missing_sidecar' }
  it("readSidecar returns missing_sidecar for nonexistent file", () => {
    const result = store.readSidecar("nonexistent-session");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_sidecar");
  });

  // T15: readSidecar invalid JSON file -> { ok: false, reason: 'parse_error' }
  it("readSidecar returns parse_error for invalid JSON sidecar file", () => {
    const tmpDir = join(tmpdir(), `context-test-${Date.now()}`);
    const contextDir = join(tmpDir, "context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "bad-session.json"), "this is not json {{{");

    const tmpStore = new ContextUsageStore(db, { stateDir: tmpDir });
    const result = tmpStore.readSidecar("bad-session");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parse_error");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // T16: readAndNormalize distinguishes missing vs parse_error through full path
  it("readAndNormalize produces missing_sidecar for missing file", () => {
    const usage = store.readAndNormalize("totally-missing");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
  });

  it("readAndNormalize produces parse_error for invalid JSON file", () => {
    const tmpDir = join(tmpdir(), `context-test-parse-${Date.now()}`);
    const contextDir = join(tmpDir, "context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "corrupt.json"), "not valid json!!!");

    const tmpStore = new ContextUsageStore(db, { stateDir: tmpDir });
    const usage = tmpStore.readAndNormalize("corrupt");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("parse_error");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // T13: getForNodes returns known for matching sessions
  it("getForNodes returns known for matching sessions in batch", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: "dev-impl@test-rig" },
    ]);

    expect(results.get(node.id)?.availability).toBe("known");
    expect(results.get(node.id)?.usedPercentage).toBe(67);
  });
});
