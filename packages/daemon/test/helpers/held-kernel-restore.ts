// A kernel that a reboot left down, with daemon start's automatic restore of it held at a gate. Real
// SQLite, reconcile, restore and HTTP routes; terminal and provider I/O are fixtures.

import { expect, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./test-app.js";
import { Reconciler } from "../../src/domain/reconciler.js";
import { bootKernelIfNeeded } from "../../src/domain/kernel-boot.js";
import { restoreExistingRigUnattended } from "../../src/domain/existing-rig-restore.js";
import type { TmuxAdapter } from "../../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../../src/domain/seat-delivery-guard.js";
import { migrate } from "../../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../src/db/all-migrations.js";

export const name = "operator-agent@kernel";
export const token = "00000000-0000-4000-8000-000000001078";
export const corrected = "00000000-0000-4000-8000-000000001079";

/** A lost kernel whose automatic restore is held: before tmux creates the session (`at: "create"`),
 *  or once the new session row exists and the runtime is launching (`at: "launch"`). */
export async function heldRestore(opts: { at: "create" | "launch"; launchFails?: boolean }) {
  const db = createFullTestDb();
  // Including the seat delivery guard's tables, which the full test database leaves out.
  migrate(db, ALL_MIGRATIONS);
  const live = new Set([name]);
  let entered!: () => void, release!: () => void;
  const atGate = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const tmux = {
    hasSession: vi.fn(async (n: string) => live.has(n)),
    probeSession: vi.fn(async (n: string) => ({ state: live.has(n) ? "present" : "absent" })),
    listSessions: vi.fn(async () => [...live].map(name => ({ name }))),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => [{ id: "%1078", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 100),
    getPaneCommand: vi.fn(async () => "sh"),
    capturePaneContent: vi.fn(async () => "Claude Code\n❯ accept edits on"),
    createSession: vi.fn(async (n: string) => {
      if (opts.at === "create") { entered(); await gate; }
      if (opts.launchFails) return { ok: false, error: "fixture launch refused" };
      live.add(n);
      return { ok: true };
    }),
    killSession: vi.fn(async (n: string) => { live.delete(n); return { ok: true }; }),
    setSessionOption: vi.fn(async () => ({ ok: true })),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
  } as unknown as TmuxAdapter;
  // The production seat leases: a restore holds every seat's, and rebinds them as it launches.
  (tmux as { deliveryGuard?: SeatDeliveryGuard }).deliveryGuard = new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target));
  const listProcesses = async () => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt: "fixture-start" },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `claude --resume ${token}`, startedAt: "fixture-start" },
  ];
  const adapter = {
    runtime: "claude-code",
    project: async () => ({ applied: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: [], skipped: [], failed: [] }),
    launchHarness: async () => {
      if (opts.at === "launch") { entered(); await gate; }
      return { ok: true, resumeType: "claude_id", resumeToken: token };
    },
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
  snapshotCapture.captureSnapshot(rig.id, "manual");
  live.clear();
  await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(rig.id);

  let automatic!: Promise<{ errors: string[] }>;
  const tracker = await bootKernelIfNeeded({ rigRepo, sessionRegistry, eventBus, bootstrapOrchestrator: setup.bootstrapOrchestrator,
    specsDir: "/tmp", cwdOverride: "/tmp", degradedTimeoutMs: 0, probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }), log: () => {},
    restoreLostKernel: rigId => automatic = restoreExistingRigUnattended({ rigRepo, snapshotRepo, snapshotCapture, restoreOrchestrator,
      runtimeAdapters: { "claude-code": adapter } as never, tmuxAdapter: tmux }, rigId, () => true),
  });
  expect(tracker.getStatus().kernelState).toBe("booting");
  await atGate;

  const post = (path: string, body: Record<string, unknown>) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const up = (extra: Record<string, unknown> = {}) => post("/api/up", { sourceRef: "kernel", ...extra });
  /** A manual up made while the launch is held: whether it settled before release, then its answer. */
  const upWhileHeld = async () => {
    let settled = false;
    const manual = up().then((response) => { settled = true; return response; });
    await new Promise<void>(r => setTimeout(r, 20));
    const settledWhileHeld = settled;
    release();
    const response = await manual;
    return { settledWhileHeld, status: response.status, body: await response.json() };
  };
  const finish = async () => {
    release();
    await automatic;
    await new Promise<void>(r => setImmediate(r));
  };
  /** A later daemon start: whether it would restore the kernel again. */
  const bootAgain = async () => {
    const restoreLostKernel = vi.fn(async () => ({ errors: [] as string[] }));
    const again = await bootKernelIfNeeded({ rigRepo, sessionRegistry, eventBus, bootstrapOrchestrator: setup.bootstrapOrchestrator,
      specsDir: "/tmp", cwdOverride: "/tmp", degradedTimeoutMs: 0, probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }), log: () => {},
      restoreLostKernel });
    again.stop();
    return { kernelState: again.getStatus().kernelState, restoreLostKernel };
  };
  const reconcile = () => new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(rig.id);
  const close = () => { release(); tracker.stop(); db.close(); };
  return { db, tmux, rig, node, live, sessionRegistry, tracker, post, up, upWhileHeld, finish, close, bootAgain, reconcile,
    automatic: () => automatic, snapshots: () =>
    (db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n };
}
