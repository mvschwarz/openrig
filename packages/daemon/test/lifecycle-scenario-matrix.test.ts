// Tier 1 in-process foundation proof for the lifecycle reboot/recovery
// scenario matrix. One suite per scenario. Mocks tmuxExec/cmuxExec at the
// adapter boundary; in-memory SQLite via createDaemon/createFullTestDb.
//
// Slice packet:
//   substrate/shared-docs/openrig-work/missions/primitive-hardening/
//   slices/lifecycle-reboot-recovery-scenario-matrix/

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { TmuxAdapter, type ExecFn } from "../src/adapters/tmux.js";
import type { ResumeResult } from "../src/adapters/claude-resume.js";
import { createFullTestDb } from "./helpers/test-app.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function seedDbWithStaleSessions(
  dbPath: string,
  rigs: { rigName: string; logicalId: string; sessionName: string }[],
): void {
  const db = createDb(dbPath);
  migrate(db, [
    coreSchema,
    bindingsSessionsSchema,
    eventsSchema,
    nodeSpecFieldsSchema,
    checkpointsSchema,
    agentspecRebootSchema,
  ]);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  for (const r of rigs) {
    const rig = rigRepo.createRig(r.rigName);
    const node = rigRepo.addNode(rig.id, r.logicalId);
    const session = sessionRegistry.registerSession(node.id, r.sessionName);
    sessionRegistry.updateStatus(session.id, "running");
  }
  db.close();
}

function unavailableCmuxExec(): ExecFn {
  return async () => {
    throw Object.assign(new Error(""), { code: "ENOENT" });
  };
}

function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return (async () => {
    try {
      const value = await fn();
      return { value, lines };
    } finally {
      logSpy.mockRestore();
    }
  })();
}

function mockTmuxForRestore(overrides?: Partial<{
  hasSession: boolean | (() => Promise<boolean>);
  paneCommand: string;
  paneContent: string;
}>): TmuxAdapter {
  const hasSessionVal = overrides?.hasSession ?? true;
  const hasSessionFn = typeof hasSessionVal === "function"
    ? hasSessionVal
    : async () => hasSessionVal;
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => overrides?.paneCommand ?? "claude"),
    capturePaneContent: vi.fn(async () => overrides?.paneContent ?? ""),
    hasSession: vi.fn(hasSessionFn),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
  } as unknown as TmuxAdapter;
}

function mockClaudeResumeReturning(result: ResumeResult): ClaudeResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
    resume: vi.fn(async () => result),
  } as unknown as ClaudeResumeAdapter;
}

function mockCodexResumeReturning(result: ResumeResult): CodexResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "codex_id" || type === "codex_last"),
    resume: vi.fn(async () => result),
  } as unknown as CodexResumeAdapter;
}

// ---------------------------------------------------------------------------
// Scenario suites
// ---------------------------------------------------------------------------

describe("Lifecycle reboot/recovery scenario matrix (Tier 1)", () => {
  describe("Scenario 1: Clean start (empty DB, no rigs)", () => {
    it("daemon comes up; reconciliation summary line reads rigs=0 checked=0 detached=0 errors=0", async () => {
      const tmuxExec: ExecFn = async () => "";
      const cmuxExec = unavailableCmuxExec();

      const { value, lines } = await captureLog(async () =>
        createDaemon({ tmuxExec, cmuxExec }),
      );

      const summary = lines.find((line) => line.startsWith("startup reconcile:"));
      expect(summary).toBeDefined();
      expect(summary).toMatch(/rigs=0\b/);
      expect(summary).toMatch(/checked=0\b/);
      expect(summary).toMatch(/detached=0\b/);
      expect(summary).toMatch(/errors=0\b/);

      // No spurious session.detached events on a clean start.
      const detachedEvents = value.db
        .prepare("SELECT type FROM events WHERE type = 'session.detached'")
        .all();
      expect(detachedEvents).toHaveLength(0);

      value.db.close();
    });
  });

  describe("Scenario 2: Warm resume (daemon restart, tmux still alive)", () => {
    it("live tmux session is NOT marked detached; summary shows detached=0", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-matrix-warm-"));
      const dbPath = path.join(tmpDir, "warm.sqlite");
      seedDbWithStaleSessions(dbPath, [
        { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
      ]);

      // tmux is alive; has-session returns success (stdout empty, no throw).
      const tmuxExec: ExecFn = async () => "";
      const cmuxExec = unavailableCmuxExec();

      const { value, lines } = await captureLog(async () =>
        createDaemon({ dbPath, tmuxExec, cmuxExec }),
      );

      const sessions = value.db
        .prepare("SELECT status FROM sessions")
        .all() as { status: string }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.status).toBe("running");

      const detachedEvents = value.db
        .prepare("SELECT type FROM events WHERE type = 'session.detached'")
        .all();
      expect(detachedEvents).toHaveLength(0);

      const summary = lines.find((line) => line.startsWith("startup reconcile:"));
      expect(summary).toMatch(/detached=0\b/);
      expect(summary).toMatch(/errors=0\b/);

      value.db.close();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe("Scenario 3: Host reboot / tmux socket absence (postmortem fixes #1, #2)", () => {
    // Each absence-class error must classify as missing session, NOT crash and
    // NOT silently leave the row marked running.
    it.each([
      ["error connecting to /private/tmp/tmux-501/default (No such file or directory)"],
      ["error connecting to /private/tmp/tmux-501/default (Connection refused)"],
      ["no server running on /private/tmp/tmux-501/default"],
      ["can't find session: r01-dev1-impl"],
      ["session not found"],
    ])("classifies %s as absence; session marked detached and event emitted", async (errMsg) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-matrix-reboot-"));
      const dbPath = path.join(tmpDir, "reboot.sqlite");
      seedDbWithStaleSessions(dbPath, [
        { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
      ]);

      const tmuxExec: ExecFn = async (cmd: string) => {
        if (cmd.includes("has-session")) throw new Error(errMsg);
        return "";
      };
      const cmuxExec = unavailableCmuxExec();

      const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

      const sessions = db.prepare("SELECT status FROM sessions").all() as { status: string }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.status).toBe("detached");

      const detachedEvents = db
        .prepare("SELECT type FROM events WHERE type = 'session.detached'")
        .all();
      expect(detachedEvents).toHaveLength(1);

      db.close();
      fs.rmSync(tmpDir, { recursive: true });
    });

    // Negative case: permission-denied tmux probe must NOT be classified as
    // absence. Session stays running (fail-closed) and the unexpected probe
    // error is recorded in the summary's errors=N count plus a warning line.
    it("permission-denied tmux probe stays NOT-detached (fail-closed) and surfaces warning", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-matrix-permerr-"));
      const dbPath = path.join(tmpDir, "permerr.sqlite");
      seedDbWithStaleSessions(dbPath, [
        { rigName: "r02", logicalId: "dev2-impl", sessionName: "r02-dev2-impl" },
      ]);

      const tmuxExec: ExecFn = async (cmd: string) => {
        if (cmd.includes("has-session")) {
          throw new Error("error: permission denied (EACCES)");
        }
        return "";
      };
      const cmuxExec = unavailableCmuxExec();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { value, lines } = await captureLog(async () =>
        createDaemon({ dbPath, tmuxExec, cmuxExec }),
      );

      try {
        // Session must NOT be marked detached on ambiguous probe failure.
        const sessions = value.db
          .prepare("SELECT status FROM sessions")
          .all() as { status: string }[];
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.status).toBe("running");

        // No detached event.
        const detached = value.db
          .prepare("SELECT type FROM events WHERE type = 'session.detached'")
          .all();
        expect(detached).toHaveLength(0);

        // Summary records the error count.
        const summary = lines.find((line) => line.startsWith("startup reconcile:"));
        expect(summary).toMatch(/errors=1\b/);
        expect(summary).toMatch(/detached=0\b/);

        // Per-session warning line emitted.
        const warnCalls = warnSpy.mock.calls.map((c) => String(c[0] ?? ""));
        const sessWarn = warnCalls.find((line) =>
          line.startsWith("startup reconcile warning:") && line.includes("session="),
        );
        expect(sessWarn).toBeDefined();
        expect(sessWarn).toContain("permission denied");

        value.db.close();
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe("Scenario 4: Provider auth loss", () => {
    // Helper: build orchestrator + seed a snapshot with a Claude node that
    // requests resume via claude_name (legacy resume path).
    function setupClaudeAttentionRequiredScenario(opts: {
      claudeResult: ResumeResult;
    }) {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore({ hasSession: false }); // session does not exist yet
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning(opts.claudeResult),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      // Seed rig + node + snapshot with a resumable session.
      const rig = rigRepo.createRig("r88");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
      // Patch the persisted snapshot to embed a resume_token so the orchestrator
      // exercises the legacy resume path with non-pod-aware nodes.
      const fullSnap = snapshotRepo.getSnapshot(snap.id)!;
      const data = JSON.parse(JSON.stringify(fullSnap.data));
      data.sessions = [{
        id: "sess-1",
        nodeId: node.id,
        sessionName: "r88-worker",
        status: "running",
        resumeType: "claude_name",
        resumeToken: "tok-abc",
        restorePolicy: "resume_if_possible",
      }];
      db.prepare("UPDATE snapshots SET data = ? WHERE id = ?")
        .run(JSON.stringify(data), snap.id);

      return { db, rigRepo, sessionRegistry, eventBus, snapshotRepo, orchestrator, rig, node, snapshotId: snap.id };
    }

    it("Claude resume returning attention_required → node status=attention_required with prompt evidence", async () => {
      const ctx = setupClaudeAttentionRequiredScenario({
        claudeResult: {
          ok: false,
          code: "attention_required",
          message: "Claude is at a resume-selection prompt; an operator must choose the conversation to continue.",
          evidence: "Choose a conversation to resume:\n  1. project-foo\n  2. project-bar",
        },
      });

      const outcome = await ctx.orchestrator.restore(ctx.snapshotId);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);

      // Per-node status carries attention_required (NOT failed).
      const workerNode = outcome.result.nodes.find((n) => n.nodeId === ctx.node.id);
      expect(workerNode?.status).toBe("attention_required");
      // Evidence is preserved on the node result.
      expect(workerNode?.attentionEvidence).toBeDefined();
      expect(workerNode?.attentionEvidence).toContain("Choose a conversation");

      // Rig-level rollup: any attention_required (with at least one
      // not-failed) yields partially_restored, NOT failed.
      expect(outcome.result.rigResult).toBe("partially_restored");

      ctx.db.close();
    });

    // Codex side — closes the false-positive `resumed` shape that fire-and-
    // forget left open. Driver patch (this slice) added Codex verifyResume
    // mirroring Claude using existing native-resume-probe Codex outcomes.
    describe("Codex verifyResume (driver patch in this slice)", () => {
      // Use the real CodexResumeAdapter against a controlled tmux mock so we
      // verify the patch wires probe + tmux honestly. No new probe patterns.
      const fastOptions = { pollMs: 1, maxWaitMs: 5, sleep: async () => {} };

      it("probe sees codex foreground process → {ok: true}", async () => {
        const tmux = mockTmuxForRestore({ paneCommand: "codex", paneContent: "" });
        const adapter = new CodexResumeAdapter(tmux, fastOptions);

        const r = await adapter.resume("r99-worker", "codex_id", "tok-abc", "/tmp");

        expect(r).toEqual({ ok: true });
      });

      it("probe sees `No saved session found` → {ok:false, code:'retry_fresh'} (NOT silent ok:true)", async () => {
        const tmux = mockTmuxForRestore({
          paneCommand: "codex",
          paneContent: "Error: No saved session found for that token.",
        });
        const adapter = new CodexResumeAdapter(tmux, fastOptions);

        const r = await adapter.resume("r99-worker", "codex_id", "tok-abc", "/tmp");

        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("retry_fresh");
      });

      it("pane returns to shell → {ok:false, code:'retry_fresh'} (NOT silent ok:true)", async () => {
        const tmux = mockTmuxForRestore({ paneCommand: "zsh", paneContent: "" });
        const adapter = new CodexResumeAdapter(tmux, fastOptions);

        const r = await adapter.resume("r99-worker", "codex_id", "tok-abc", "/tmp");

        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("retry_fresh");
      });

      // Codex auth-refusal → attention_required end-to-end. Closes the
      // deferral previously documented in this file. Implemented by the
      // codex-auth-refusal-attention-required slice via:
      //   (a) `looksLikeCodexAuthRefusal` in native-resume-probe.ts;
      //   (b) `attention_required` pass-through in codex-resume.ts;
      //   (c) Codex-branch translation in restore-orchestrator.ts:944-960.
      // The runtime-agnostic per-node mapping at restore-orchestrator.ts:725-735
      // emits `status: "attention_required"` with `attentionEvidence` for
      // both runtimes — no further wiring needed.
      it("Codex auth-refusal → node status=attention_required with auth-refusal pane evidence", async () => {
        const db = createFullTestDb();
        const rigRepo = new RigRepository(db);
        const sessionRegistry = new SessionRegistry(db);
        const eventBus = new EventBus(db);
        const snapshotRepo = new SnapshotRepository(db);
        const checkpointStore = new CheckpointStore(db);
        const snapshotCapture = new SnapshotCapture({
          db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
        });
        const tmux = mockTmuxForRestore({ hasSession: false });
        const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

        // Codex adapter stub returns the same shape the real adapter would
        // emit for auth-refusal: { ok: false, code: "attention_required",
        // message, evidence } where evidence is the last 12 lines of pane
        // content. Exercises restore-orchestrator's Codex branch translation
        // patched in this slice.
        const refusalEvidence = [
          "$ codex resume tok-codex",
          "Error: Your access token could not be refreshed because you have since",
          "logged out or signed in to another account. Please sign in again.",
        ].join("\n");
        const codexAttentionResult: ResumeResult = {
          ok: false,
          code: "attention_required",
          message: "Codex could not refresh the stored access token; an operator must sign in again before the session can resume.",
          evidence: refusalEvidence,
        };
        const orchestrator = new RestoreOrchestrator({
          db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
          checkpointStore, nodeLauncher, tmuxAdapter: tmux,
          claudeResume: mockClaudeResumeReturning({ ok: true }),
          codexResume: mockCodexResumeReturning(codexAttentionResult),
        });

        const rig = rigRepo.createRig("r97");
        const node = rigRepo.addNode(rig.id, "codex-worker", { role: "worker", runtime: "codex", cwd: "/tmp" });
        const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
        const fullSnap = snapshotRepo.getSnapshot(snap.id)!;
        const data = JSON.parse(JSON.stringify(fullSnap.data));
        data.sessions = [{
          id: "sess-codex-1",
          nodeId: node.id,
          sessionName: "r97-codex-worker",
          status: "running",
          resumeType: "codex_id",
          resumeToken: "tok-codex",
          restorePolicy: "resume_if_possible",
        }];
        db.prepare("UPDATE snapshots SET data = ? WHERE id = ?")
          .run(JSON.stringify(data), snap.id);

        const outcome = await orchestrator.restore(snap.id);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);

        // Per-node status: attention_required (NOT failed, NOT resumed).
        const codexNode = outcome.result.nodes.find((n) => n.nodeId === node.id);
        expect(codexNode?.status).toBe("attention_required");
        // Evidence preserved on the node result via the runtime-agnostic
        // mapping at restore-orchestrator.ts:725-735.
        expect(codexNode?.attentionEvidence).toBeDefined();
        expect(codexNode?.attentionEvidence).toContain("access token could not be refreshed");
        expect(codexNode?.attentionEvidence).toContain("Please sign in again");

        // Rig-level rollup: single attention_required node → partially_restored
        // (NOT failed). Aggregation at restore-orchestrator.ts:65 already
        // includes attention_required in the mixed-status set; this test
        // confirms Codex participates honestly.
        expect(outcome.result.rigResult).toBe("partially_restored");

        db.close();
      });

      // Pod-aware Codex auth-refusal end-to-end. The production resume path
      // for pod-aware Codex nodes flows through `launchHarness` →
      // `verifyResumeLaunch` → probe → `recovery: "attention_required"` →
      // startup-orchestrator returns `startupStatus: "attention_required"` →
      // restore-orchestrator's hoisted pod-aware mapping surfaces
      // `status: "attention_required"` with `attentionEvidence`.
      // Closes the gap guard caught in revision 1 (commit 63ee206 only
      // covered the legacy CodexResumeAdapter path).
      it("pod-aware Codex auth-refusal → node status=attention_required (production path)", async () => {
        const db = createFullTestDb();
        const rigRepo = new RigRepository(db);
        const sessionRegistry = new SessionRegistry(db);
        const eventBus = new EventBus(db);
        const snapshotRepo = new SnapshotRepository(db);
        const checkpointStore = new CheckpointStore(db);
        const snapshotCapture = new SnapshotCapture({
          db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
        });
        const tmux = mockTmuxForRestore();
        const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

        const rig = rigRepo.createRig("r96");
        // Pod-aware setup mirrors restore-orchestrator.test.ts:1296-1362
        // pattern (pods row + node.podId + node_startup_context + snapshot).
        db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)")
          .run("pod-codex-attention", rig.id, "Codex");
        const node = rigRepo.addNode(rig.id, "dev.qa", {
          role: "worker", runtime: "codex", podId: "pod-codex-attention",
        });
        const session = sessionRegistry.registerSession(node.id, "dev-qa@r96");
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateResumeToken(session.id, "codex_id", "stale-codex-token");
        db.prepare(
          "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
        ).run(node.id, "[]", "[]", "[]", "codex");
        const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
        // Reset to "exited" so restore actually attempts launch.
        sessionRegistry.updateStatus(session.id, "exited");
        db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

        // The Codex runtime adapter's launchHarness returns the new shape
        // landed in this revision: ok:false with recovery: "attention_required"
        // and last-12-line pane evidence.
        const refusalEvidence = [
          "$ codex resume stale-codex-token",
          "Error: Your access token could not be refreshed because you have since",
          "logged out or signed in to another account. Please sign in again.",
        ].join("\n");
        const codexLaunchAttentionResult = {
          ok: false as const,
          error: "Codex could not refresh the stored access token; an operator must sign in again before the session can resume.",
          recovery: "attention_required" as const,
          evidence: refusalEvidence,
        };
        const launchHarness = vi.fn().mockResolvedValue(codexLaunchAttentionResult);
        const mockCodexAdapter = {
          runtime: "codex",
          listInstalled: vi.fn(async () => []),
          project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
          deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
          checkReady: vi.fn(async () => ({ ready: true })),
          launchHarness,
        };

        const orchestrator = new RestoreOrchestrator({
          db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
          checkpointStore, nodeLauncher, tmuxAdapter: tmux,
          claudeResume: mockClaudeResumeReturning({ ok: true }),
          codexResume: mockCodexResumeReturning({ ok: true }),
        });

        const outcome = await orchestrator.restore(snap.id, {
          adapters: { codex: mockCodexAdapter },
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);

        const codexNode = outcome.result.nodes.find((n) => n.nodeId === node.id);
        expect(codexNode?.status).toBe("attention_required");
        expect(codexNode?.attentionEvidence).toBeDefined();
        expect(codexNode?.attentionEvidence).toContain("access token could not be refreshed");
        expect(codexNode?.attentionEvidence).toContain("Please sign in again");

        // Rig-level rollup: single attention_required node → partially_restored.
        expect(outcome.result.rigResult).toBe("partially_restored");

        // launchHarness called ONCE — fresh-fallback was NOT triggered for
        // attention_required (auth-refusal is operator-recoverable, not a
        // stale-token signal). The startup orchestrator's new branch
        // distinguishes recovery: "attention_required" from "retry_fresh".
        expect(launchHarness).toHaveBeenCalledTimes(1);

        db.close();
      });
    });
  });

  describe("Scenario 5: Partial boot", () => {
    function buildOrchestratorWithMixedNodes() {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });

      // Mocked Claude returns attention_required for one node, success for
      // another. Codex returns failed for the third. We seed three nodes
      // sharing one snapshot.
      const tmux = mockTmuxForRestore({ hasSession: false });
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      // Dispatch by sessionName so test doesn't depend on iteration order.
      const claudeStub = {
        canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
        resume: vi.fn(async (sessionName: string) => {
          if (sessionName.includes("claude-ok")) return { ok: true as const };
          return {
            ok: false as const,
            code: "attention_required",
            message: "Claude resume-selection prompt",
            evidence: "Choose a conversation:\n  1. foo",
          };
        }),
      } as unknown as ClaudeResumeAdapter;
      const codexStub = {
        canResume: vi.fn((type: string | null) => type === "codex_id" || type === "codex_last"),
        resume: vi.fn(async () => ({
          ok: false,
          code: "resume_failed",
          message: "Codex resume failed: timed out",
        })),
      } as unknown as CodexResumeAdapter;

      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: claudeStub, codexResume: codexStub,
      });

      const rig = rigRepo.createRig("r77");
      const claudeOk = rigRepo.addNode(rig.id, "claude-ok", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const claudeAtt = rigRepo.addNode(rig.id, "claude-att", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const codexFail = rigRepo.addNode(rig.id, "codex-fail", { role: "worker", runtime: "codex", cwd: "/tmp" });
      const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
      const fullSnap = snapshotRepo.getSnapshot(snap.id)!;
      const data = JSON.parse(JSON.stringify(fullSnap.data));
      data.sessions = [
        { id: "s-ok", nodeId: claudeOk.id, sessionName: "r77-claude-ok",
          status: "running", resumeType: "claude_name", resumeToken: "t1",
          restorePolicy: "resume_if_possible" },
        { id: "s-att", nodeId: claudeAtt.id, sessionName: "r77-claude-att",
          status: "running", resumeType: "claude_name", resumeToken: "t2",
          restorePolicy: "resume_if_possible" },
        { id: "s-fail", nodeId: codexFail.id, sessionName: "r77-codex-fail",
          status: "running", resumeType: "codex_id", resumeToken: "t3",
          restorePolicy: "resume_if_possible" },
      ];
      db.prepare("UPDATE snapshots SET data = ? WHERE id = ?")
        .run(JSON.stringify(data), snap.id);

      return { db, orchestrator, rig, snapshotId: snap.id, nodeIds: { claudeOk: claudeOk.id, claudeAtt: claudeAtt.id, codexFail: codexFail.id } };
    }

    it("mixed resumed + attention_required + failed → rigResult=partially_restored", async () => {
      const ctx = buildOrchestratorWithMixedNodes();

      const outcome = await ctx.orchestrator.restore(ctx.snapshotId);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);

      expect(outcome.result.rigResult).toBe("partially_restored");

      // Per-node statuses preserved in the restore.completed payload.
      const map = Object.fromEntries(outcome.result.nodes.map((n) => [n.nodeId, n.status]));
      expect(map[ctx.nodeIds.claudeOk]).toBe("resumed");
      expect(map[ctx.nodeIds.claudeAtt]).toBe("attention_required");
      expect(map[ctx.nodeIds.codexFail]).toBe("failed");

      // restore.completed event payload preserves per-node discrimination.
      const completedRow = ctx.db
        .prepare("SELECT payload FROM events WHERE type = 'restore.completed' ORDER BY seq DESC LIMIT 1")
        .get() as { payload: string };
      const parsed = JSON.parse(completedRow.payload) as { result: { rigResult: string; nodes: Array<{ nodeId: string; status: string }> } };
      expect(parsed.result.rigResult).toBe("partially_restored");
      expect(parsed.result.nodes.find((n) => n.nodeId === ctx.nodeIds.claudeAtt)?.status).toBe("attention_required");

      ctx.db.close();
    });

    it("all-failed → rigResult=failed (NOT partially_restored)", async () => {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore({ hasSession: false });
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning({ ok: false, code: "resume_failed", message: "boom" }),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      const rig = rigRepo.createRig("r66");
      const a = rigRepo.addNode(rig.id, "a", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const b = rigRepo.addNode(rig.id, "b", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
      const fullSnap = snapshotRepo.getSnapshot(snap.id)!;
      const data = JSON.parse(JSON.stringify(fullSnap.data));
      data.sessions = [
        { id: "s-a", nodeId: a.id, sessionName: "r66-a", status: "running",
          resumeType: "claude_name", resumeToken: "ta", restorePolicy: "resume_if_possible" },
        { id: "s-b", nodeId: b.id, sessionName: "r66-b", status: "running",
          resumeType: "claude_name", resumeToken: "tb", restorePolicy: "resume_if_possible" },
      ];
      db.prepare("UPDATE snapshots SET data = ? WHERE id = ?")
        .run(JSON.stringify(data), snap.id);

      const outcome = await orchestrator.restore(snap.id);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);
      expect(outcome.result.rigResult).toBe("failed");

      db.close();
    });
  });

  describe("Scenario 6: Operator recovery (reconcileNodeRuntimeTruth)", () => {
    function setupForReconcile(opts: {
      runtime: "claude-code" | "codex";
      restoreOutcome: "failed" | "attention_required";
      withResumeToken?: boolean;
      paneCommand?: string;
      paneContent?: string;
      hasSession?: boolean;
    }) {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore({
        hasSession: opts.hasSession ?? true,
        paneCommand: opts.paneCommand ?? (opts.runtime === "codex" ? "codex" : "claude"),
        paneContent: opts.paneContent ?? "",
      });
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning({ ok: true }),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      const rig = rigRepo.createRig(`r${Math.floor(Math.random() * 90) + 10}`);
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: opts.runtime });
      sessionRegistry.updateBinding(node.id, { tmuxSession: `${rig.name}-worker` });
      const sess = sessionRegistry.registerSession(node.id, `${rig.name}-worker`);
      if (opts.withResumeToken ?? true) {
        db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ? WHERE id = ?").run(
          opts.runtime === "codex" ? "codex_id" : "claude_id",
          "tok-abc",
          sess.id,
        );
      }
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-recon" });
      eventBus.emit({
        type: "restore.completed",
        rigId: rig.id,
        snapshotId: "snap-recon",
        result: {
          snapshotId: "snap-recon",
          preRestoreSnapshotId: null,
          rigResult: "partially_restored",
          nodes: [{ nodeId: node.id, logicalId: "worker", status: opts.restoreOutcome }],
          warnings: [],
        },
      });

      return { db, orchestrator, rig, nodeId: node.id };
    }

    it("upgrades failed → operator_recovered when ALL four preconditions hold; emits restore.outcome_reconciled", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code",
        restoreOutcome: "failed",
        paneContent: "Claude Code v2.1.89\n ❯ accept edits on",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.from).toBe("failed");
        expect(result.to).toBe("operator_recovered");
        expect(result.evidence).toEqual({
          tmux: true, fgProcess: "claude", resumeTokenUsed: true, paneState: "usable",
        });
      }

      const reconciled = ctx.db
        .prepare("SELECT type FROM events WHERE rig_id = ? AND type = 'restore.outcome_reconciled'")
        .all(ctx.rig.id);
      expect(reconciled).toHaveLength(1);

      // Original failure event NOT mutated/deleted (load-bearing invariant).
      const completed = ctx.db
        .prepare("SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.completed'")
        .all(ctx.rig.id) as { payload: string }[];
      expect(completed).toHaveLength(1);
      const parsed = JSON.parse(completed[0]!.payload) as { result: { nodes: Array<{ status: string }> } };
      expect(parsed.result.nodes[0]!.status).toBe("failed");

      ctx.db.close();
    });

    // Codex foreground recognition is load-bearing per planner research gap
    // (`paneCommand.startsWith("codex")` at restore-orchestrator.ts:1038).
    it("recognizes Codex foreground process: paneCommand='codex' → operator_recovered with fgProcess='codex'", async () => {
      const ctx = setupForReconcile({
        runtime: "codex",
        restoreOutcome: "failed",
        paneCommand: "codex",
        paneContent: "OpenAI Codex (v0.42.0)\n  ›  ready\n  gpt-5 · context",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.evidence.fgProcess).toBe("codex");
      }

      ctx.db.close();
    });

    it("NEVER produces 'ready' as terminal outcome; only operator_recovered", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code",
        restoreOutcome: "failed",
        paneContent: "Claude Code v2.1.89\n ❯ accept edits on",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      if (result.ok) {
        expect(result.to).toBe("operator_recovered");
        expect((result.to as string)).not.toBe("ready");
      }
      const rows = ctx.db
        .prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'")
        .all() as { payload: string }[];
      for (const row of rows) {
        const parsed = JSON.parse(row.payload) as { to: string };
        expect(parsed.to).toBe("operator_recovered");
      }
      ctx.db.close();
    });

    // Per-precondition refusal codes (load-bearing for honest UX).
    it("refuses upgrade with code=tmux_session_missing when tmux probe says false", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code", restoreOutcome: "failed", hasSession: false,
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("tmux_session_missing");
      ctx.db.close();
    });

    it("refuses upgrade with code=fg_process_not_runtime when pane is in shell", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code", restoreOutcome: "failed",
        paneCommand: "zsh", paneContent: "$ ",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("fg_process_not_runtime");
      ctx.db.close();
    });

    it("refuses upgrade with code=resume_token_not_used when no token recorded", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code", restoreOutcome: "failed",
        withResumeToken: false,
        paneContent: "Claude Code v2.1.89\n ❯ accept edits on",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_token_not_used");
      ctx.db.close();
    });

    it("refuses upgrade with code=pane_not_usable when pane is at Claude resume-selection prompt", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code", restoreOutcome: "attention_required",
        paneContent: "Choose a conversation to resume:\n  1. project-foo\n  2. project-bar",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("pane_not_usable");
      ctx.db.close();
    });

    it("refuses upgrade with code=outcome_not_upgradable for an already-resumed outcome", async () => {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore();
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning({ ok: true }),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      const rig = rigRepo.createRig("r55");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      sessionRegistry.updateBinding(node.id, { tmuxSession: "r55-worker" });
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-x" });
      eventBus.emit({
        type: "restore.completed",
        rigId: rig.id,
        snapshotId: "snap-x",
        result: {
          snapshotId: "snap-x",
          preRestoreSnapshotId: null,
          rigResult: "fully_restored",
          nodes: [{ nodeId: node.id, logicalId: "worker", status: "resumed" }],
          warnings: [],
        },
      });

      const result = await orchestrator.reconcileNodeRuntimeTruth(rig.id, node.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("outcome_not_upgradable");

      db.close();
    });

    it("refuses upgrade with code=no_attempt when no restore.started exists for the rig", async () => {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore();
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning({ ok: true }),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      const rig = rigRepo.createRig("r44");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });

      const result = await orchestrator.reconcileNodeRuntimeTruth(rig.id, node.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_attempt");

      db.close();
    });
  });
});
