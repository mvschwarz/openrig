// OPR.0.5.7.1 — D1 ORDERING HOLE (R2 bought blocker, baton 0efd154d):
// restoreNodeWithCompensation consults continuity_state BEFORE the D1
// active-occupant resolution. A pod node with continuity_state=restoring
// short-circuits to status "fresh" with a skip warning, so a PRESENT
// authoritative relation in null/missing/dangling state is never resolved —
// and launchStatusIsRunning classifies "fresh" as running. That silently
// bypasses A1's loud-failure semantics: the seat reads healthy while the
// occupant truth is ambiguous. This fixture pins the required order: the
// A1 ambiguity failure fires FIRST — shared wording, zero resume, zero
// NodeLauncher, zero replacement occupant.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter, ResumeResult } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { createFullTestDb } from "./helpers/test-app.js";

const ULID_OLD = "01ARZ3NDEKTSV4RRFFQ69G5AAA";
const ULID_NEW = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockClaudeResume(result?: ResumeResult): ClaudeResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
    resume: vi.fn(async () => result ?? { ok: true as const }),
  } as unknown as ClaudeResumeAdapter;
}

function mockCodexResume(): CodexResumeAdapter {
  return {
    canResume: vi.fn(() => false),
    resume: vi.fn(async () => ({ ok: true as const })),
  } as unknown as CodexResumeAdapter;
}

describe("OPR.0.5.7.1 — D1 ambiguity precedes the continuity_state=restoring skip", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  it("pod node with continuity_state=restoring AND a present ambiguous relation fails LOUDLY — never a silent 'fresh' skip", async () => {
    const rig = rigRepo.createRig("r77");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-r77", rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "seat", { role: "worker", runtime: "claude-code", podId: "pod-r77" });
    const sess = sessionRegistry.registerSession(node.id, "r77-seat");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-seed", "resume_if_possible", sess.id);
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    sessionRegistry.updateStatus(sess.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    // The live continuity state that triggers the bypass under repair.
    db.prepare("INSERT INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, 'restoring')")
      .run("pod-r77", node.id);

    // A PRESENT authoritative relation in an ambiguous state: two running
    // rows, explicit null (the A1 loud case).
    const data = JSON.parse(JSON.stringify(snap.data));
    const template = data.sessions.find((s: { nodeId: string }) => s.nodeId === node.id);
    data.sessions = [
      { ...template, id: ULID_OLD, status: "running", resumeToken: "tok-a" },
      { ...template, id: ULID_NEW, status: "running", resumeToken: "tok-b" },
    ];
    data.activeSessionIdByNode = { [node.id]: null };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

    const tmux = mockTmux();
    const claude = mockClaudeResume();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const orch = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: claude, codexResume: mockCodexResume(),
    });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const seat = result.result.nodes.find((n) => n.logicalId === "seat");
      // base: the restoring short-circuit returns status "fresh" + a skip
      // warning before the resolver ever runs (candidate ~:796-816).
      expect(seat?.status).toBe("failed");
      const err = seat && "error" in seat ? String(seat.error) : "";
      expect(err).toMatch(/Active-occupant ambiguity/); // the SHARED wording
      expect(err).toContain(ULID_OLD);
      expect(err).toContain(ULID_NEW);
    }
    // Zero resume, zero NodeLauncher, zero replacement occupant.
    expect(claude.resume).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });
});
