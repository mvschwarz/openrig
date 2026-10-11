import { Hono } from "hono";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
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

// #1077 through a real down/up: teardown, NodeLauncher, RestoreOrchestrator, the Claude adapter and
// the HTTP hook and clear-attention routes, with native observations as fixtures. Claude's
// SessionStart can land before the launch writes T1, while restore waits for readiness, or after
// it is done; each resume ordering ends verified, and a /clear in the same ordering stays refused.
// Derived from dev-review's reproduction of the early-hook gap in the first candidate.

// Shape of Fleet's Claude 2.1.220 auto-mode screen after full down/up:
// the header has scrolled out; the empty prompt and mode footer remain.
const autoScreen = "Restored conversation\n────────────────\n❯\u00a0\n────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n   ✘ Auto-update failed: no write permission to npm prefix · Run claude doctor\n  ● high · /effort\n";
// #1077 recovery boundaries, derived from dev-review's reproduction against e427a030: a resume hook
// that lands before any launch path records T1, on the managed path with native observations
// briefly unavailable (attention, which then stays: the launch never observed its process) and on
// the legacy (non-pod) restore path.
const token = "00000000-0000-4000-8000-000000000006";

describe("managed Claude full down/up", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  // legacy-replaced-after-proof (dev-review against 05b26c2f): the legacy resume's identity check
  // proves 102 on T1; 202 then replaces it and sends the late first hook. The launch's record must
  // stay the process its own check proved, not a later read.
  it.each(["managed-resume", "managed-delayed-ready-resume", "legacy-resume", "legacy-keep", "legacy-clear", "legacy-replaced-after-proof"])(
    "independent recovery boundary: %s", async (scenario) => {
      const legacy = scenario.startsWith("legacy");
      const delayed = scenario.includes("delayed-ready");
      const replacedAfterProof = scenario === "legacy-replaced-after-proof";
      const timing = scenario.endsWith("clear") ? "clear-before-ready" : replacedAfterProof ? "resume-after-ready" : "resume-before-ready";
      // The legacy resume's identity check takes the first two process samples.
      let nativeReads = 0;
      const replaced = () => replacedAfterProof && nativeReads > 2;
      let settling = delayed;
      const mode: string = "exact";
      const db = createFullTestDb(); dbs.push(db);
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
      const rig = rigRepo.createRig("restore-test");
      db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("restore-pod", rig.id, "Test");
      const node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code", podId: legacy ? undefined : "restore-pod" });
      new NativePermissionStore(db).write(node.id, { runtime: "claude-code", mode: "auto" }, "fixture", "retained Fleet posture");
      // A legacy (non-pod) node gets the legacy canonical name from NodeLauncher.
      const name = legacy ? "r00-restore-test-test_c" : "test-c@restore-test";
      const old = sessionRegistry.registerSession(node.id, name);
      sessionRegistry.updateStatus(old.id, "running");
      sessionRegistry.updateResumeToken(old.id, "claude_id", token, "scrape");
      sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%old" });
      if (!legacy) db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
      // legacy-keep: Claude resumes T1 and keeps its id.
      const rotated = scenario === "legacy-keep" ? token : "00000000-0000-4000-8000-000000001077";
      const activity = new AgentActivityStore({ db, eventBus });
      const hooks = new Hono();
      hooks.use("*", async (c, next) => {
        c.set("tmuxAdapter" as never, tmux as never);
        c.set("listProcesses" as never, hookProcesses as never);
        c.set("agentActivityStore" as never, activity as never);
        c.set("activityHookToken" as never, "fixture" as never);
        c.set("sessionRegistry" as never, sessionRegistry as never);
        c.set("eventBus" as never, eventBus as never);
        await next();
      });
      hooks.route("/api/activity", activityRoutes);
      const row = () => db.prepare("SELECT id, resume_token, resume_provenance, resume_rotated_from, startup_status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(node.id) as Record<string, unknown>;
      const hook = async () => {
        const response = await hooks.request("/api/activity/hooks", { method: "POST",
          headers: { "content-type": "application/json", "x-openrig-activity-token": "fixture" },
          body: JSON.stringify({ eventFamily: "session_identity", hookEvent: "SessionStart", sessionName: name, nodeId: node.id,
            runtime: "claude-code", generation: sessionRegistry.currentOccupantTenure(node.id)!.generationUuid,
            source: timing.startsWith("clear") ? "clear" : "resume", resumeLaunch: launchMarker, resumeLaunchFirst: true, hookPid: 111, sessionId: rotated }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ tokenPersisted: true });
      };
      // The relay forwards the marker the launched process's command carried, as the real one does.
      let launchMarker: string | undefined;
      const launched = (cmd: string) => { launchMarker = /OPENRIG_RESUME_LAUNCH='?([^' ]+)/.exec(cmd)?.[1]; };
      let live = true;
      const tmux = {
        hasSession: vi.fn(async () => live),
        probeSession: vi.fn(async () => ({ state: live ? "present" : "absent" })),
        killSession: vi.fn(async () => { live = false; return { ok: true }; }),
        createSession: vi.fn(async () => { live = true; return { ok: true }; }),
        listSessions: vi.fn(async () => live ? [{ name }] : []),
        listWindows: vi.fn(async () => []),
        listPanes: vi.fn(async () => {
          const current = row();
          if (timing === "resume-before-join" && current.id !== old.id && current.resume_token === token && current.startup_status === "ready") await hook();
          return ["%new"].map(id => ({ id, index: 0, cwd: "/", width: 80, height: 24, active: true }));
        }),
        getPanePid: vi.fn(async () => mode === "unobserved-pane-process" ? 999 : 100),
        getPaneCommand: vi.fn(async () => mode === "bare-shell" ? "bash" : "sh"),
        capturePaneContent: vi.fn(async () => autoScreen),
        sendText: vi.fn(async (_session: string, cmd: string) => { launched(cmd); return { ok: true }; }),
        sendShellCommand: vi.fn(async (_session: string, cmd: string) => { launched(cmd); if (timing.endsWith("before-ready")) await hook(); return { ok: true }; }),
        sendKeys: vi.fn(async () => ({ ok: true })),
      } as unknown as TmuxAdapter;
      const startedAt = "Thu Oct  1 05:53:16 2026";
      const paneRows = () => [
        { pid: 100, ppid: 1, pgid: 100, tpgid: mode === "bare-shell" ? 100 : 101, executableName: "bash", command: "-bash", startedAt },
        ...(mode === "bare-shell" ? [] : [{ pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh /tmp/fixture-launch.txt", startedAt }]),
        ...(mode === "bare-shell" ? [] : [{ pid: replaced() ? 202 : 102, ppid: 101, pgid: 101, tpgid: 101, executableName: mode === "native" ? "2.1.285" : "claude", command: `${mode === "native" ? "/fixture/.local/share/claude/versions/2.1.285" : "/opt/claude.exe"} --permission-mode auto --resume ${mode === "wrong-token" ? "different" : token} --name ${name}`, startedAt: replaced() ? "Thu Oct  1 06:10:00 2026" : startedAt }]),
      ];
      const listProcesses = async () => { if (settling) return []; nativeReads += 1; return paneRows(); };
      // The relay of a SessionStart hook runs under the launched Claude (102) through a shell.
      const hookProcesses = async () => [...paneRows(),
        { pid: 110, ppid: replaced() ? 202 : 102, pgid: 110, tpgid: 101, executableName: "sh", command: "/bin/sh -c node relay.cjs", startedAt },
        { pid: 111, ppid: 110, pgid: 110, tpgid: 101, executableName: "node", command: "node relay.cjs", startedAt }];
      // Real teardown captures the running occupant, exits the old row and clears bindings.
      const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux }).teardown(rig.id);
      expect(down.errors).toEqual([]);
      expect(down.sessionsKilled).toBe(1);
      expect(snapshotRepo.getSnapshot(down.snapshotId!)?.kind).toBe("auto-pre-down");
      expect(sessionRegistry.getBindingForNode(node.id)).toBeNull();
      const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {},
        claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[], env: Record<string, string> = {}) => [...Object.entries(env).map(([k, v]) => `${k}=${v}`), "claude", ...args].join(" "), assertCurrent: () => {}, configDir: "/fixture", executable: mode === "native" ? "/fixture/.local/share/claude/versions/2.1.285" : "/opt/claude.exe" }) } as unknown as ClaudeManagedLaunch,
        fsOps: {
        exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {},
      } });
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume: new ClaudeResumeAdapter(tmux, { listProcesses, maxWaitMs: 0, sleep: async () => {},
          claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[], env: Record<string, string> = {}) => [...Object.entries(env).map(([k, v]) => `${k}=${v}`), "claude", ...args].join(" "), assertCurrent: () => {}, configDir: "/fixture", executable: "/opt/claude.exe" }) } as unknown as ClaudeManagedLaunch }),
        codexResume: new CodexResumeAdapter(tmux), listProcesses });
      const up = await restore.restore(down.snapshotId!, { adapters: { "claude-code": adapter } });
      expect(up.ok).toBe(true);
      if (!up.ok) throw new Error(up.message);
      settling = false;
      if (timing.endsWith("after-ready")) await hook();
      await new SeatIdentityReconciler({ db, tmux, listProcesses }).reconcileAll();
      const identity = new SeatIdentityStore(db).getForNode(node.id);
      const clear = new SeatAttentionReconciler({ db, sessionRegistry, eventBus, agentActivityStore: activity, tmux, listProcesses,
        reconcileRestoreOutcome: (rigId, nodeId) => restore.reconcileNodeRuntimeTruth(rigId, nodeId),
        sendVerify: async () => { throw new Error("unexpected input from clear-attention"); } });
      const admin = new Hono();
      admin.use("*", async (c,next) => {
        c.set("seatAttentionReconciler" as never, clear as never);
        c.set("terminalBearerToken" as never, "fixture" as never); await next();
      });
      admin.route("/api/sessions", sessionAdminRoutes);
      const cleared = await admin.request(`/api/sessions/${encodeURIComponent(name)}/clear-attention`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture" }, body: "{}" });
      const clearBody = await cleared.json();
      const transport = new SessionTransport({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
      const sent = await transport.send(name, "isolated QA restore message");
      const resumed = timing.startsWith("resume");
      const kept = scenario === "legacy-keep";
      expect(up.result.nodes[0].status).toBe(resumed && !delayed ? "resumed" : "attention_required");
      expect(row()).toMatchObject(kept
        ? { resume_token: token, resume_rotated_from: null }
        : { resume_token: rotated, resume_provenance: "hook", resume_rotated_from: resumed ? token : null });
      // A delayed launch could not observe the process it started, so nothing ties the hook's process
      // to OpenRig's launch (a replacement's hook looks the same): the rotation stays unproved, as on
      // main, and the seat stays in attention.
      const proved = resumed && !delayed && !replacedAfterProof;
      expect(identity?.verdict).toBe(proved ? "verified" : "mismatch");
      // A resumed seat has nothing to clear; a /clear or unobserved-launch seat stays in attention.
      expect(cleared.status).toBe(proved ? 409 : 422);
      expect(clearBody).toMatchObject({ ok: false, ...(proved ? { code: "not_in_attention" } : {}) });
      expect(sent.ok).toBe(true);
      expect(String((sent as { warning?: string }).warning ?? "").includes("without verified native identity")).toBe(!proved);
    },
  );
});
