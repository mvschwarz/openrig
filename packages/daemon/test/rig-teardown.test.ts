import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { startupContextSchema } from "../src/db/migrations/015_startup_context.js";
import { chatMessagesSchema } from "../src/db/migrations/016_chat_messages.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../src/db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
  discoverySchema, discoveryFkFix, agentspecRebootSchema,
  startupContextSchema, chatMessagesSchema, podNamespaceSchema, contextUsageSchema, externalCliAttachmentSchema,
];

function mockTmux(killResult?: { ok: boolean; code?: string; message?: string }): TmuxAdapter {
  return {
    killSession: vi.fn(async () => killResult ?? { ok: true }),
    createSession: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    getPanePid: vi.fn(async () => null),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => null),
  } as unknown as TmuxAdapter;
}

function mockSnapshotCapture(db: Database.Database): SnapshotCapture {
  return {
    captureSnapshot: vi.fn(() => ({ id: "snap-1", rigId: "x", kind: "manual", status: "complete", data: "{}", createdAt: new Date().toISOString() })),
    db,
  } as unknown as SnapshotCapture;
}

describe("RigTeardownOrchestrator", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => { db.close(); });

  function seedRig(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev");
    const session = sessionRegistry.registerSession(node.id, "r01-dev");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function buildTeardown(tmux?: TmuxAdapter) {
    return new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry,
      tmuxAdapter: tmux ?? mockTmux(),
      snapshotCapture: mockSnapshotCapture(db),
      eventBus,
    });
  }

  // T1: Kills tmux sessions
  it("teardown kills tmux sessions", async () => {
    const { rigId } = seedRig();
    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(rigId);

    expect(tmux.killSession).toHaveBeenCalledWith("r01-dev");
  });

  // T2: Bindings cleared
  it("bindings cleared after teardown", async () => {
    const { rigId, nodeId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const td = buildTeardown();

    await td.teardown(rigId);

    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
  });

  // T3: Sessions marked exited
  it("sessions marked exited", async () => {
    const { rigId, sessionId } = seedRig();
    const td = buildTeardown();

    await td.teardown(rigId);

    const sessions = sessionRegistry.getSessionsForRig(rigId);
    const latest = sessions.find((s) => s.id === sessionId);
    expect(latest?.status).toBe("exited");
  });

  // T4: Rig preserved
  it("rig record preserved without --delete", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    const result = await td.teardown(rigId);

    expect(result.deleted).toBe(false);
    expect(rigRepo.getRig(rigId)).toBeTruthy();
  });

  // T5: --delete removes rig
  it("--delete removes rig after stop", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    const result = await td.teardown(rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(rigRepo.getRig(rigId)).toBeNull();
  });

  // T6: --snapshot
  it("--snapshot captures before teardown", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    const result = await td.teardown(rigId, { snapshot: true });

    expect(result.snapshotId).toBe("snap-1");
  });

  it("refreshes resume metadata before snapshot capture", async () => {
    const { rigId } = seedRig();
    const refresh = vi.fn(async () => {});
    const td = new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry,
      tmuxAdapter: mockTmux(),
      snapshotCapture: mockSnapshotCapture(db),
      eventBus,
      resumeMetadataRefresher: { refresh } as unknown as import("../src/domain/resume-metadata-refresher.js").ResumeMetadataRefresher,
    });

    await td.teardown(rigId);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // T7: --force (same as default in v1)
  it("--force kills sessions", async () => {
    const { rigId } = seedRig();
    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(rigId, { force: true });

    expect(tmux.killSession).toHaveBeenCalled();
  });

  // T8: Nonexistent rig
  it("nonexistent rig throws", async () => {
    const td = buildTeardown();

    await expect(td.teardown("nonexistent")).rejects.toThrow(/not found/);
  });

  // T9: Already stopped
  it("already-stopped rig returns alreadyStopped=true", async () => {
    const { rigId, sessionId } = seedRig();
    sessionRegistry.updateStatus(sessionId, "exited"); // already stopped
    const td = buildTeardown();

    const result = await td.teardown(rigId);

    expect(result.alreadyStopped).toBe(true);
    expect(result.sessionsKilled).toBe(0);
  });

  // T10: rig.stopped event
  it("rig.stopped event emitted", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    await td.teardown(rigId);

    const events = db.prepare("SELECT type FROM events WHERE type = 'rig.stopped'").all() as Array<{ type: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  // T11: Multi-session node — only newest killed
  it("multiple session rows — only newest live session acted on", async () => {
    const rig = rigRepo.createRig("r11");
    const node = rigRepo.addNode(rig.id, "dev");
    // Old session (exited) - earlier timestamp + earlier id
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'exited', ?)")
      .run("sess-aaa", node.id, "r11-old", "2026-03-26 09:00:00");
    // New session (running) - later timestamp + later id
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'running', ?)")
      .run("sess-zzz", node.id, "r11-new", "2026-03-26 12:00:00");

    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(rig.id);

    // Only the new session should be killed
    expect(tmux.killSession).toHaveBeenCalledWith("r11-new");
    expect(tmux.killSession).toHaveBeenCalledTimes(1);
  });

  // T12: Kill failure + --delete -> blocked
  it("kill failure blocks --delete", async () => {
    const { rigId, nodeId } = seedRig();
    const tmux = mockTmux({ ok: false, code: "kill_failed", message: "tmux error" });
    const td = buildTeardown(tmux);

    const result = await td.teardown(rigId, { delete: true });

    expect(result.deleted).toBe(false);
    expect(result.errors.some((e) => e.includes("blocked"))).toBe(true);
    expect(rigRepo.getRig(rigId)).toBeTruthy();
    // Node should NOT be marked exited
    const sessions = sessionRegistry.getSessionsForRig(rigId);
    expect(sessions.some((s) => s.status === "running")).toBe(true);
  });

  // T13: Stale session (tmux gone) -> benign
  it("stale session (tmux already gone) treated as success", async () => {
    const { rigId } = seedRig();
    const tmux = mockTmux({ ok: false, code: "session_not_found" });
    const td = buildTeardown(tmux);

    const result = await td.teardown(rigId, { delete: true });

    expect(result.sessionsKilled).toBe(1);
    expect(result.deleted).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // T14: Per-node cleanup is atomic (status + binding together)
  it("per-node cleanup updates status and clears binding atomically", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const td = buildTeardown();

    await td.teardown(rigId);

    // Both should be updated (transaction succeeded)
    const sessions = sessionRegistry.getSessionsForRig(rigId);
    expect(sessions.find((s) => s.id === sessionId)?.status).toBe("exited");
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
  });

  // T15: --delete event sabotage -> rig not deleted
  it("rig.deleted event failure prevents rig deletion", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    // Sabotage event persistence
    const origPersist = eventBus.persistWithinTransaction.bind(eventBus);
    eventBus.persistWithinTransaction = (event) => {
      if (event.type === "rig.deleted") throw new Error("event persist failed");
      return origPersist(event);
    };

    // Teardown + delete should fail on the event
    const result = await td.teardown(rigId, { delete: true });

    // Sessions killed but rig NOT deleted (atomic delete + event rolled back)
    expect(result.sessionsKilled).toBe(1);
    expect(result.deleted).toBe(false);
    expect(rigRepo.getRig(rigId)).toBeTruthy();
    expect(result.errors.some((e) => e.includes("event persist failed") || e.includes("deletion"))).toBe(true);

    eventBus.persistWithinTransaction = origPersist;
  });
});
