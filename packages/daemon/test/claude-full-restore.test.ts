import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Shape of Fleet's Claude 2.1.220 auto-mode screen after full down/up:
// the header has scrolled out; the empty prompt and mode footer remain.
const autoScreen = "Restored conversation\n────────────────\n❯\u00a0\n────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n   ✘ Auto-update failed: no write permission to npm prefix · Run claude doctor\n  ● high · /effort\n";
const token = "00000000-0000-4000-8000-000000000006";

describe("managed Claude full down/up", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it.each(["exact", "bare-shell", "wrong-token", "wrong-pane", "ambiguous"])(
    "retains native identity and ordinary delivery only for exact lineage: %s", async (mode) => {
      const db = createFullTestDb(); dbs.push(db);
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
      const rig = rigRepo.createRig("restore-test");
      db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("restore-pod", rig.id, "Test");
      const node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code", podId: "restore-pod" });
      new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: "auto" }, "fixture", "retained Fleet posture");
      const name = "test-c@restore-test";
      const old = sessionRegistry.registerSession(node.id, name);
      sessionRegistry.updateStatus(old.id, "running");
      sessionRegistry.updateResumeToken(old.id, "claude_id", token, "scrape");
      sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%old" });
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
      let live = true;
      const tmux = {
        hasSession: vi.fn(async () => live),
        probeSession: vi.fn(async () => ({ state: live ? "present" : "absent" })),
        killSession: vi.fn(async () => { live = false; return { ok: true }; }),
        createSession: vi.fn(async () => { live = true; return { ok: true }; }),
        listSessions: vi.fn(async () => live ? [{ name }] : []),
        listWindows: vi.fn(async () => []),
        listPanes: vi.fn(async () => (mode === "ambiguous" ? ["%new", "%other"] : ["%new"]).map(id => ({ id, index: 0, cwd: "/", width: 80, height: 24, active: true }))),
        getPanePid: vi.fn(async () => mode === "wrong-pane" ? 999 : 100),
        getPaneCommand: vi.fn(async () => "sh"),
        capturePaneContent: vi.fn(async () => autoScreen),
        sendText: vi.fn(async () => ({ ok: true })),
        sendShellCommand: vi.fn(async () => ({ ok: true })),
        sendKeys: vi.fn(async () => ({ ok: true })),
      } as unknown as TmuxAdapter;
      const startedAt = "Thu Oct  1 05:53:16 2026";
      const listProcesses = async () => [
        { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh /tmp/fixture-launch.txt", startedAt },
        ...(mode === "bare-shell" ? [] : [{ pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "claude", command: `/opt/claude.exe --permission-mode auto --resume ${mode === "wrong-token" ? "different" : token} --name ${name}`, startedAt }]),
      ];
      // Real teardown captures the running occupant, exits the old row and clears bindings.
      const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux }).teardown(rig.id);
      expect(down.errors).toEqual([]);
      expect(down.sessionsKilled).toBe(1);
      expect(snapshotRepo.getSnapshot(down.snapshotId!)?.kind).toBe("auto-pre-down");
      expect(sessionRegistry.getBindingForNode(node.id)).toBeNull();
      const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {},
        claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`, assertCurrent: () => {}, configDir: "/fixture" }) } as unknown as ClaudeManagedLaunch,
        fsOps: {
        exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {},
      } });
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume: new ClaudeResumeAdapter(tmux),
        codexResume: new CodexResumeAdapter(tmux), listProcesses });
      const up = await restore.restore(down.snapshotId!, { adapters: { "claude-code": adapter } });
      expect(up.ok).toBe(true);
      if (!up.ok) throw new Error(up.message);
      const latest = db.prepare("SELECT id, status, startup_status, resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(node.id);
      // Preserve the failed-state observation in a red run, before any later scrape.
      expect({ outcome: up.result.nodes[0], latest }).toMatchObject({
        // Without #264 the RC's joined restore verdict remains attention-only.
        // Native metadata and delivery after the next identity sweep are separate assertions.
        outcome: { status: "attention_required" },
        latest: mode === "exact"
          ? { status: "running", startup_status: "ready", resume_type: "claude_id", resume_token: token, resume_provenance: "scrape" }
          : { status: "running", startup_status: "attention_required", resume_token: token, resume_provenance: null },
      });
      expect(latest).not.toMatchObject({ id: old.id });
      expect(tmux.sendShellCommand).toHaveBeenCalledExactlyOnceWith(name, `claude --permission-mode auto --resume ${token} --name ${name}`, expect.any(Function));
      expect(db.prepare("SELECT status, resume_token FROM sessions WHERE id = ?").get(old.id)).toEqual({ status: "exited", resume_token: token });
      expect(tmux.sendText).not.toHaveBeenCalled();
      expect(tmux.sendKeys).not.toHaveBeenCalled();
      await new SeatIdentityReconciler({ db, tmux, listProcesses }).reconcileAll();
      vi.mocked(tmux.sendText).mockClear(); vi.mocked(tmux.sendKeys).mockClear();
      const transport = new SessionTransport({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
      const sent = await transport.send(name, "ordinary restored message");
      expect(sent, JSON.stringify(sent)).toMatchObject({ ok: mode === "exact" });
      if (mode !== "exact") expect(sent.reason).not.toBe("tmux_unavailable");
      expect(tmux.sendText).toHaveBeenCalledTimes(mode === "exact" ? 1 : 0);
      expect(tmux.sendKeys).toHaveBeenCalledTimes(mode === "exact" ? 1 : 0);
    },
  );
});
