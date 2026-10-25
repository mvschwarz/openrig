// Claude Code answers plan-mode turns with Sonnet when its model setting is exactly the alias `haiku` (its documented
// plan-mode upgrade; a full model id keeps its model). OpenRig's launch arguments are unchanged; a restore's result says so
// for that pairing, as a fresh launch's does (startup-orchestrator.test.ts) and rig seat status does (permission-account.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";

let savedHome: string | undefined;
let home: string;
beforeEach(() => { savedHome = process.env["OPENRIG_HOME"]; home = mkdtempSync(join(tmpdir(), "plan-alias-home-")); process.env["OPENRIG_HOME"] = home; });
afterEach(() => {
  if (savedHome === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

/** Restore one Claude seat whose saved model and permission mode are given; returns the result and the resume's arguments. */
async function restoreSeat(model: string, mode: string) {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const rig = rigRepo.createRig("plan-alias");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/workspace", model });
  const session = sessionRegistry.registerSession(node.id, "dev-impl@plan-alias");
  sessionRegistry.updateStatus(session.id, "running");
  sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
  sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@plan-alias", tmuxPane: "%old" });
  db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-1' WHERE id = ?").run(session.id);
  new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode }, "person@host", "careful review");
  const snapshot = snapshotCapture.captureSnapshot(rig.id, "manual");

  const claudeResume = { canResume: () => true, resume: vi.fn(async () => ({ ok: true, code: "resumed" })) } as unknown as ClaudeResumeAdapter;
  const codexResume = { canResume: () => false, resume: vi.fn() } as unknown as CodexResumeAdapter;
  const tmuxAdapter = {
    createSession: vi.fn(async () => ({ ok: true })), killSession: vi.fn(async () => ({ ok: true })), listSessions: vi.fn(async () => []),
    hasSession: vi.fn(async () => false), sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
    listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []), getPaneCommand: vi.fn(async () => "claude"),
    setSessionEnv: vi.fn(async () => {}), unsetSessionEnv: vi.fn(async () => {}),
  } as unknown as TmuxAdapter;
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter });
  const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore,
    nodeLauncher, tmuxAdapter, claudeResume, codexResume });
  const result = await restore.restore(snapshot.id);
  db.close();
  // (sessionName, resumeType, resumeToken, cwd, posture, model, permissionMode, ...)
  return { result, calls: (claudeResume.resume as unknown as { mock: { calls: unknown[][] } }).mock.calls };
}

describe("a restored Claude seat on the bare haiku alias in plan mode", () => {
  it.each([["haiku", "plan", true], ["claude-haiku-4-5", "plan", false], ["haiku", "acceptEdits", false]] as const)(
    "model %j with saved mode %j: the resume is unchanged, and its result names plan mode's Sonnet answer for the bare alias only",
    async (model, mode, named) => {
      const { result, calls } = await restoreSeat(model, mode);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(calls).toHaveLength(1);
      expect([calls[0]![5], calls[0]![6]]).toEqual([model, mode]);
      const warnings = (result as { result?: { warnings?: string[] } }).result?.warnings ?? [];
      expect(warnings.filter((w) => w.includes('alias "haiku"'))).toEqual(named ? ['dev-impl@plan-alias: Claude Code answers plan-mode turns '
        + 'with Sonnet when the model is the alias "haiku". To keep Haiku, set a full Haiku model id: rig seat set-model dev-impl@plan-alias '
        + '--model <full Haiku id> --reason "<why>".'] : []);
    });
});
