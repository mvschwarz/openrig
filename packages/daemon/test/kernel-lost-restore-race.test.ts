// #1078 — the real restore pipeline behind automatic kernel restore: from a saved snapshot, from
// eligible current state (auto-rehydrate), and racing a manual `rig up kernel --existing` either way
// round; only one session launches. Contributed by dev-review in its review of ed95ff48.

import { describe, it, expect, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { bootKernelIfNeeded } from "../src/domain/kernel-boot.js";
import { restoreExistingRigUnattended } from "../src/domain/existing-rig-restore.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

describe("real automatic kernel restore and manual-up race", () => {
  it.each(["auto-first", "manual-first", "auto-rehydrate", "auto-first-fresh"])("restores once: %s", async mode => {
    const db = createFullTestDb();
    const name = "operator-agent@kernel", token = "00000000-0000-4000-8000-000000001078";
    const live = new Set([name]);
    let entered!: () => void, release!: () => void;
    const atLaunch = new Promise<void>(r => { entered = r; });
    const launchGate = new Promise<void>(r => { release = r; });
    const tmux = {
      hasSession: vi.fn(async (n: string) => live.has(n)),
      probeSession: vi.fn(async (n: string) => ({ state: live.has(n) ? "present" : "absent" })),
      listSessions: vi.fn(async () => [...live].map(name => ({ name }))),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => [{ id: "%1078", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
      getPanePid: vi.fn(async () => 100),
      getPaneCommand: vi.fn(async () => "sh"),
      capturePaneContent: vi.fn(async () => "Claude Code\n❯ accept edits on"),
      createSession: vi.fn(async (n: string) => { entered(); await launchGate; live.add(n); return { ok: true }; }),
      killSession: vi.fn(async (n: string) => { live.delete(n); return { ok: true }; }),
      setSessionOption: vi.fn(async () => ({ ok: true })),
      sendText: vi.fn(async () => ({ ok: true })),
      sendKeys: vi.fn(async () => ({ ok: true })),
    } as unknown as TmuxAdapter;
    const listProcesses = async () => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt: "fixture-start" },
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `claude --resume ${token}`, startedAt: "fixture-start" },
    ];
    const adapter = {
      runtime: "claude-code",
      project: async () => ({ applied: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: [], skipped: [], failed: [] }),
      launchHarness: async () => ({ ok: true, resumeType: "claude_id", resumeToken: token }),
      checkReady: async () => ({ ready: true }),
    };
    const setup = createTestApp(db, { tmux, listProcesses, adapters: { "claude-code": adapter } as never });
    const { rigRepo, sessionRegistry, snapshotRepo, snapshotCapture, restoreOrchestrator, eventBus, app } = setup;
    const rig = rigRepo.createRig("kernel");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod1078", rig.id, "Kernel");
    const node = rigRepo.addNode(rig.id, "operator.agent", { runtime: "claude-code", cwd: "/tmp", podId: "pod1078" });
    const old = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(old.id, "running");
    sessionRegistry.updateStartupStatus(old.id, "ready");
    sessionRegistry.updateResumeToken(old.id, "claude_id", token, "scrape");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1078" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
      .run(node.id, "[]", "[]", "[]", "claude-code");
    if (mode !== "auto-rehydrate") snapshotCapture.captureSnapshot(rig.id, "manual");
    live.clear();
    await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(rig.id);
    let automatic!: Promise<{ errors: string[] }>;
    const boot = () => bootKernelIfNeeded({ rigRepo, sessionRegistry, eventBus, bootstrapOrchestrator: setup.bootstrapOrchestrator,
      specsDir: "/tmp", cwdOverride: "/tmp", degradedTimeoutMs: 0, probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }), log: () => {},
      restoreLostKernel: rigId => automatic = restoreExistingRigUnattended({ rigRepo, snapshotRepo, snapshotCapture, restoreOrchestrator,
        runtimeAdapters: { "claude-code": adapter } as never }, rigId, () => true),
    });
    const up = (extra: Record<string, unknown> = {}) => app.request("/api/up", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceRef: "kernel", ...extra }) });
    let tracker;
    try {
      if (mode === "manual-first") {
        const manual = up();
        await atLaunch;
        tracker = await boot();
        expect(automatic).toBeUndefined();
        expect(tracker.getStatus().kernelState).toBe("skipped");
        release();
        const result = await manual;
        expect(result.status, JSON.stringify(await result.clone().json())).toBe(200);
        expect(await result.json()).toMatchObject({ rigResult: "fully_restored" });
      } else {
        tracker = await boot();
        expect(tracker.getStatus().kernelState).toBe("booting");
        await atLaunch;
        if (mode === "auto-first-fresh") {
          // A request for a different restore is not merged into the running one.
          const collision = await up({ freshLogicalIds: ["operator.agent"] });
          expect(collision.status).toBe(400);
          expect(await collision.json()).toMatchObject({ code: "restore_in_progress" });
          release();
        } else {
          // The same restore, asked for by hand: it waits for the running one instead of colliding.
          let settled = false;
          const manual = up().then((response) => { settled = true; return response; });
          await new Promise<void>(r => setTimeout(r, 20));
          expect(settled).toBe(false);
          release();
          const response = await manual;
          const body = await response.json();
          expect(response.status, JSON.stringify(body)).toBe(200);
          expect(body).toMatchObject({ status: "restored", rigResult: "fully_restored" });
          expect(body.warnings[0]).toContain("no second restore was started");
          expect(JSON.stringify(body)).not.toMatch(/rig down|guard_target_changed|rig_not_stopped/);
        }
        expect(await automatic).toEqual({ errors: [] });
      }
      await new Promise<void>(r => setImmediate(r));
      const status = tracker.getStatus();
      expect(status.kernelState).toBe(mode === "manual-first" ? "skipped" : "ready");
      expect(tmux.createSession).toHaveBeenCalledTimes(1);
      expect(sessionRegistry.getSessionsForRig(rig.id).filter(s => s.status === "running")).toHaveLength(1);
      if (mode === "auto-rehydrate") {
        expect(db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE kind = 'auto-rehydrate'").get()).toEqual({ n: 1 });
      }
    } finally { release(); tracker?.stop(); db.close(); }
  });
});
