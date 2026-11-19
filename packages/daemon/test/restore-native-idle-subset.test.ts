import { expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";

it.each(["idle", "unverified", "unavailable"])("native subset restore preserves an existing shell: %s", async kind => {
  const db = createFullTestDb();
  try {
    const tmux = mockTmuxAdapter();
    Object.assign(tmux, { isNativeWindows: true, hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "PowerShell.EXE"), listPanes: vi.fn(async () => [{ id: "%owned" }]),
      killSession: vi.fn(), createSession: vi.fn() });
    const t = createTestApp(db, { tmux });
    const nativeIdleShell = vi.fn(async () => { if (kind === "unavailable") throw Error("owned observation unavailable"); return kind === "idle"; });
    const restore = new RestoreOrchestrator({ ...t, db, tmuxAdapter: tmux, nativeIdleShell,
      claudeResume: {} as never, codexResume: {} as never });
    const rig = t.rigRepo.createRig("native-idle-subset");
    const node = t.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    const session = t.sessionRegistry.registerSession(node.id, "worker@native-idle-subset");
    t.sessionRegistry.updateStatus(session.id, "running");
    t.sessionRegistry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%owned" });
    const snapshot = t.snapshotCapture.captureSnapshot(rig.id, "manual");
    const result = await restore.launchNodeSubset(rig.id, ["worker"], { snapshotId: snapshot.id });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(nativeIdleShell).toHaveBeenCalledWith("%owned");
    expect(result.alreadyRunning).toHaveLength(kind === "idle" ? 0 : 1);
    expect(result.failedTargets).toHaveLength(0);
    expect(result.launched).toHaveLength(kind === "idle" ? 1 : 0);
    if (kind === "idle") expect(result.launched![0]).toMatchObject({ status: "attention_required", error: expect.stringContaining("holds an idle shell") });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(t.sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%owned");
  } finally { db.close(); }
});
