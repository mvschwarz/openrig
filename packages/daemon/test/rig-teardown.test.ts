import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { noServerTerminal } from "./helpers/no-server-terminal.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRunningNameGuard, makeRunningSessionCounter, confirmStoppedGenerations } from "../src/domain/running-name-guard.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { managedBlockText, mergeManagedBlock } from "../src/domain/managed-blocks.js";
import { SEAT_SKILLS_BOOTSTRAP_LINE } from "../src/domain/seat-skill-storage.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { replaceFile } from "../src/adapters/replace-file.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { claudeActivityRelayPath } from "../src/domain/claude-activity-hooks.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { setDaemonTmuxServer } from "../src/adapters/tmux-server.js";


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
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rig-teardown-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("community contract: stop and down remove only their panes, leaving a sibling session untouched", async () => {
    // Stay inside CI's IPC allowlist, with a short path for macOS sockaddr_un.
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "h1-"));
    const socket = "community";
    const env = { ...process.env, TMUX_TMPDIR: socketDir };
    delete env.TMUX;
    const exec = promisify(execFile);
    const tmux = async (...args: string[]) => (await exec("tmux", ["-L", socket, "-f", "/dev/null", ...args], { env, timeout: 3000 })).stdout;
    const adapter = new TmuxAdapter(async () => { throw new Error("unexpected shell execution"); }, undefined,
      async argv => tmux(...argv.slice(1)));
    try {
      const targetRig = rigRepo.createRig("community-target");
      const siblingRig = rigRepo.createRig("community-sibling");
      const seed = async (rigId: string, name: string) => {
        const node = rigRepo.addNode(rigId, "dev.worker", { runtime: "synth", cwd: tmpDir });
        const session = sessionRegistry.registerSession(node.id, name);
        sessionRegistry.recordCommunityHarnessSelection(session.id, "synth");
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: name });
        await tmux("new-session", "-d", "-s", name, "sleep 60");
        return { node, session };
      };
      const target = await seed(targetRig.id, "worker@community-target");
      const sibling = await seed(siblingRig.id, "worker@community-sibling");
      const siblingBefore = db.prepare("SELECT * FROM sessions WHERE id=?").get(sibling.session.id);
      const lifecycle = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: adapter });
      expect(await lifecycle.stopSeat({ seatRef: "worker@community-target", reason: "contract stop test" })).toMatchObject({ ok: true });
      expect(await adapter.hasSession("worker@community-target")).toBe(false);
      expect(await adapter.hasSession("worker@community-sibling")).toBe(true);
      // A later normal down of the target rig must have the same ownership boundary.
      await tmux("new-session", "-d", "-s", "worker@community-target", "sleep 60");
      sessionRegistry.updateStatus(target.session.id, "running");
      sessionRegistry.updateBinding(target.node.id, { attachmentType: "tmux", tmuxSession: "worker@community-target" });
      const teardown = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus,
        tmuxAdapter: adapter, snapshotCapture: mockSnapshotCapture(db) });
      expect(await teardown.teardown(targetRig.id, { snapshot: false })).toMatchObject({ errors: [], sessionsKilled: 1,
        paneOnly: ["worker@community-target"] });
      expect(await adapter.hasSession("worker@community-target")).toBe(false);
      expect(await adapter.hasSession("worker@community-sibling")).toBe(true);
      expect(db.prepare("SELECT * FROM sessions WHERE id=?").get(sibling.session.id)).toEqual(siblingBefore);
    } finally {
      try { await tmux("kill-server"); }
      catch (error) {
        if (!/no server running|No such file or directory/.test(String((error as { stderr?: string }).stderr))) throw error;
      }
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  function seedRig(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev");
    const session = sessionRegistry.registerSession(node.id, "r01-dev");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function seedRigWithNode(opts: { runtime: string; cwd: string; sessionStatus?: string }): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev", { runtime: opts.runtime, cwd: opts.cwd });
    const session = sessionRegistry.registerSession(node.id, "r01-dev");
    sessionRegistry.updateStatus(session.id, opts.sessionStatus ?? "running");
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
  it.each([true, false])("reports service project retention with live sessions=%s", async (live) => {
    const rigId = live ? seedRig().rigId : rigRepo.createRig("archived").id;
    const kept = "kept project shared: still used by rig successor (rig-2)";
    const td = new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux(), snapshotCapture: mockSnapshotCapture(db), eventBus,
      serviceOrchestrator: { teardown: async () => ({ ok: true, kept }) } as never,
    });
    expect((await td.teardown(rigId)).errors).toContain(kept);
  });

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

  it.each([true, false])("keeps the existing teardown result when additional intent bookkeeping throws (live=%s)", async live => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    if (!live) sessionRegistry.markDetached(sessionId);
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: live ? "present" : "absent" }));
    const prepare = db.prepare.bind(db);
    const fault = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("s.intentionally_stopped = 0")) throw new Error("fixture eligibility query failed");
      return prepare(sql);
    });
    try {
      expect(await buildTeardown(tmux).teardown(rigId)).toEqual({
        rigId, sessionsKilled: live ? 1 : 0, snapshotId: live ? "snap-1" : null,
        deleted: false, deleteBlocked: false, alreadyStopped: !live, errors: [],
      });
      expect(sessionRegistry.getBindingForNode(nodeId) === null).toBe(live);
      expect(tmux.killSession).toHaveBeenCalledTimes(live ? 1 : 0);
    } finally {
      fault.mockRestore();
    }
  });

  it("kills live sessions before probing already-detached seats", async () => {
    const { rigId } = seedRig();
    const detached = rigRepo.addNode(rigId, "old");
    const session = sessionRegistry.registerSession(detached.id, "r01-old");
    sessionRegistry.markDetached(session.id);
    const calls: string[] = [];
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async name => {
      calls.push(`probe ${name}`);
      return { state: name === "r01-dev" ? "present" : "absent" };
    });
    tmux.killSession = vi.fn(async name => { calls.push(`kill ${name}`); return { ok: true }; });
    await buildTeardown(tmux).teardown(rigId);
    expect(calls).toEqual(["probe r01-dev", "kill r01-dev", "probe r01-old"]);
  });

  it("records stop intent only for a confirmed successful teardown", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    await buildTeardown().teardown(rigId);
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    // Repeating down must not turn a deliberate stop into an ordinary exit.
    await buildTeardown().teardown(rigId);
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ intentionally_stopped: 1 });
  });

  it.each(["detached", "exited"])("records explicit down of an unbound %s seat only after confirmed absence", async status => {
    const { rigId, sessionId } = seedRig();
    sessionRegistry.updateStatus(sessionId, status);
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ intentionally_stopped: 0 });
    expect(await buildTeardown(tmux).teardown(rigId)).toMatchObject({ alreadyStopped: true, sessionsKilled: 0 });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
  });

  // A failed start rolls its blank provisional session back to `superseded`. That row is the seat's newest, so
  // `rig start --last` reads it; restore skips it and keeps reading the seat's own older session.
  function seedRolledBackStart(): { rigId: string; nodeId: string; historyId: string; rollbackId: string } {
    const { rigId, nodeId, sessionId: historyId } = seedRig();
    sessionRegistry.updateStatus(historyId, "exited");
    sessionRegistry.updateResumeToken(historyId, "claude_id", "native-history");
    db.prepare("UPDATE sessions SET created_at = '2000-01-01' WHERE id = ?").run(historyId);
    const rollback = sessionRegistry.registerSession(nodeId, "r01-dev");
    sessionRegistry.updateStatus(rollback.id, "superseded");
    return { rigId, nodeId, historyId, rollbackId: rollback.id };
  }
  const sessionRow = (id: string) => db.prepare("SELECT status, intentionally_stopped, resume_token FROM sessions WHERE id = ?").get(id);

  it("records explicit down of a failed start's rolled-back session and keeps it superseded", async () => {
    const { rigId, historyId, rollbackId } = seedRolledBackStart();
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    expect(await buildTeardown(tmux).teardown(rigId)).toMatchObject({ alreadyStopped: true, sessionsKilled: 0 });
    expect(sessionRow(rollbackId)).toEqual({ status: "superseded", intentionally_stopped: 1, resume_token: null });
    // The seat's own history is untouched, so a later restore still resumes it.
    expect(sessionRow(historyId)).toEqual({ status: "exited", intentionally_stopped: 0, resume_token: "native-history" });
    // What `rig start --last` reads for the seat: the newest session, now recorded as stopped on purpose.
    expect(getNodeInventory(db, rigId)[0]).toMatchObject({ sessionStatus: "superseded", intentionallyStopped: true });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it("leaves a rolled-back session unmarked while its tmux session is present or its binding changes", async () => {
    for (const kind of ["present", "binding"] as const) {
      const { rigId, nodeId, rollbackId } = seedRolledBackStart();
      const tmux = mockTmux();
      tmux.probeSession = vi.fn(async () => {
        if (kind === "binding") sessionRegistry.updateBinding(nodeId, { tmuxSession: "new-owner", tmuxPane: "%new" });
        return { state: kind === "present" ? "present" : "absent" };
      });
      await buildTeardown(tmux).teardown(rigId);
      expect(sessionRow(rollbackId)).toEqual({ status: "superseded", intentionally_stopped: 0, resume_token: null });
      expect(tmux.killSession).not.toHaveBeenCalled();
    }
  });

  it("does not record a stop for a rolled-back session without an explicit down", async () => {
    const { rigId, rollbackId } = seedRolledBackStart();
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    const { Reconciler } = await import("../src/domain/reconciler.js");
    await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(rigId);
    expect(sessionRow(rollbackId)).toEqual({ status: "superseded", intentionally_stopped: 0, resume_token: null });
  });

  it("records down after reconciliation leaves a detached session's original binding", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev", tmuxPane: "%1" });
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    const { Reconciler } = await import("../src/domain/reconciler.js");
    await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }).reconcile(rigId);
    expect(sessionRegistry.getBindingForNode(nodeId)).not.toBeNull();
    await buildTeardown(tmux).teardown(rigId);
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it("explicit down of a non-kernel rig starts only an empty server before recording absence", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev", tmuxPane: "%1" });
    sessionRegistry.markDetached(sessionId);
    const terminal = noServerTerminal();
    const tmux = mockTmux();
    tmux.probeSession = terminal.probeSession;
    tmux.startServer = terminal.startServer;
    expect(await buildTeardown(tmux).teardown(rigId)).toMatchObject({ alreadyStopped: true, sessionsKilled: 0, errors: [] });
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    expect(terminal.startServer).toHaveBeenCalledTimes(1);
    expect(terminal.serverRunning()).toBe(true);
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it.each(["failed-start", "throw-start", "second-permission", "second-unreadable", "second-present", "initial-unreadable", "initial-permission", "mixed-permission"])("no-server stop bookkeeping preserves state on %s", async fault => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.markDetached(sessionId);
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev", tmuxPane: "%1" });
    const before = sessionRegistry.getBindingForNode(nodeId);
    const tmux = mockTmux();
    let calls = 0;
    tmux.probeSession = vi.fn(async () => {
      calls++;
      if (fault === "initial-permission" || (calls === 2 && fault === "second-permission")) throw new Error("permission denied");
      if (fault === "initial-unreadable" || (calls === 2 && fault === "second-unreadable")) return { state: "transport_unavailable", cause: "fixture unreadable" };
      if (fault === "mixed-permission") return { state: "transport_unavailable", cause: "no server running: permission denied" };
      if (calls === 1) return { state: "transport_unavailable", cause: "no server running on /tmp/tmux-1000/default" };
      return { state: "present" };
    });
    tmux.startServer = vi.fn(async () => {
      if (fault === "throw-start") throw new Error("fixture start unreadable");
      return fault === "failed-start" ? { ok: false, code: "tmux_unavailable" } : { ok: true };
    });
    await buildTeardown(tmux).teardown(rigId);
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId)).toEqual({ status: "detached", intentionally_stopped: 0 });
    expect(sessionRegistry.getBindingForNode(nodeId)).toEqual(before);
    expect(tmux.startServer).toHaveBeenCalledTimes(fault.startsWith("initial-") || fault === "mixed-permission" ? 0 : 1);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it.each([["probe", "binding"], ["probe", "latest"], ["start", "binding"], ["start", "latest"], ["reprobe", "binding"], ["reprobe", "latest"]] as const)("rechecks the %s await against a changed %s before recording a no-server stop", async (phase, kind) => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.markDetached(sessionId);
    db.prepare("UPDATE sessions SET created_at = '2000-01-01' WHERE id = ?").run(sessionId);
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev", tmuxPane: "%1" });
    const tmux = mockTmux();
    const change = () => {
      if (kind === "binding") sessionRegistry.updateBinding(nodeId, { tmuxSession: "new-owner", tmuxPane: "%new" });
      else { const newer = sessionRegistry.registerSession(nodeId, "r01-new-owner"); sessionRegistry.updateStatus(newer.id, "running"); }
    };
    let calls = 0;
    tmux.probeSession = vi.fn(async () => {
      calls++;
      if ((phase === "probe" && calls === 1) || (phase === "reprobe" && calls === 2)) change();
      return calls === 1 ? { state: "transport_unavailable", cause: "no server running on /tmp/tmux-1000/default" } : { state: "absent" };
    });
    tmux.startServer = vi.fn(async () => { if (phase === "start") change(); return { ok: true }; });
    await buildTeardown(tmux).teardown(rigId);
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId)).toEqual({ status: "detached", intentionally_stopped: 0 });
    if (kind === "binding") expect(sessionRegistry.getBindingForNode(nodeId)).toMatchObject({ tmuxSession: "new-owner", tmuxPane: "%new" });
    else expect(sessionRegistry.getSessionsForRig(rigId).find(session => session.sessionName === "r01-new-owner")?.status).toBe("running");
    expect(tmux.startServer).toHaveBeenCalledTimes(phase === "probe" ? 0 : 1);
    expect(tmux.probeSession).toHaveBeenCalledTimes(phase === "reprobe" ? 2 : 1);
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it.each(["present", "transport_unavailable", "throw", "no-probe"])("keeps an unconfirmed detached seat unchanged: %s", async state => {
    const { rigId, sessionId } = seedRig();
    sessionRegistry.updateStatus(sessionId, "detached");
    const tmux = mockTmux();
    if (state !== "no-probe") tmux.probeSession = vi.fn(async () => {
      if (state === "throw") throw new Error("fixture unavailable");
      return state === "present" ? { state: "present" } : { state: "transport_unavailable", cause: "fixture unavailable" };
    });
    await buildTeardown(tmux).teardown(rigId);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "detached", intentionally_stopped: 0 });
  });

  it("preserves a detached node's binding, including a binding created while its absence probe awaited", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateStatus(sessionId, "detached");
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => {
      sessionRegistry.updateBinding(nodeId, { tmuxSession: "new-owner", tmuxPane: "%new" });
      return { state: "absent" };
    });
    await buildTeardown(tmux).teardown(rigId);
    expect(sessionRegistry.getBindingForNode(nodeId)).toMatchObject({ tmuxSession: "new-owner", tmuxPane: "%new" });
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "detached", intentionally_stopped: 0 });
    vi.mocked(tmux.probeSession).mockClear();
    await buildTeardown(tmux).teardown(rigId);
    expect(tmux.probeSession).not.toHaveBeenCalled();
  });

  it("does not mark an older detached session after a new session appears during the probe", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateStatus(sessionId, "detached");
    db.prepare("UPDATE sessions SET created_at = '2000-01-01' WHERE id = ?").run(sessionId);
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => {
      const newer = sessionRegistry.registerSession(nodeId, "r01-new");
      sessionRegistry.updateStatus(newer.id, "running");
      return { state: "absent" };
    });
    await buildTeardown(tmux).teardown(rigId);
    expect(db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ status: "detached", intentionally_stopped: 0 });
    expect(sessionRegistry.getSessionsForRig(rigId).find(s => s.sessionName === "r01-new")?.status).toBe("running");
    expect(tmux.killSession).not.toHaveBeenCalled();
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

  it("captures durable recovery state before stopping when live metadata discovery fails", async () => {
    const { rigId, nodeId, sessionId } = seedRigWithNode({ runtime: "codex", cwd: tmpDir });
    sessionRegistry.updateResumeToken(sessionId, "codex_id", "saved-thread", "operator");
    const missingTokenNode = rigRepo.addNode(rigId, "new-seat", { runtime: "codex", cwd: tmpDir });
    const missingTokenSession = sessionRegistry.registerSession(missingTokenNode.id, "new-seat@test-rig");
    sessionRegistry.updateStatus(missingTokenSession.id, "running");
    const checkpointStore = new CheckpointStore(db);
    checkpointStore.createCheckpoint(nodeId, { summary: "latest work", nextStep: "finish review" });
    const snapshotRepo = new SnapshotRepository(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const tmux = mockTmux();
    tmux.getPanePid = vi.fn(async () => 100);
    const refresher = new ResumeMetadataRefresher({ sessionRegistry, tmuxAdapter: tmux,
      listProcesses: async () => { throw new Error("process discovery timed out"); } });
    tmux.killSession = vi.fn(async () => {
      const captured = snapshotRepo.findLatestAutoPreDown(rigId);
      expect(captured?.data.sessions.find(s => s.id === sessionId)).toMatchObject({ status: "running", resumeToken: "saved-thread" });
      expect(captured?.data.checkpoints[nodeId]).toMatchObject({ summary: "latest work", nextStep: "finish review" });
      return { ok: true };
    });
    const td = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus,
      tmuxAdapter: tmux, snapshotCapture, resumeMetadataRefresher: refresher });

    const result = await td.teardown(rigId);

    expect(result.snapshotId).toBe(snapshotRepo.findLatestAutoPreDown(rigId)?.id);
    expect(result.snapshotId).not.toBeNull();
    expect(result.sessionsKilled).toBe(2);
    expect(result.errors).toContain("Resume metadata refresh failed: process discovery timed out");
    expect(result.errors.some(error => error.startsWith("Snapshot failed:"))).toBe(false);
    expect(sessionRegistry.getSessionsForRig(rigId).find(s => s.id === sessionId)?.status).toBe("exited");
  });

  it("reports refresh and capture failures separately and still stops the rig", async () => {
    const { rigId } = seedRig();
    const snapshotCapture = mockSnapshotCapture(db);
    vi.mocked(snapshotCapture.captureSnapshot).mockImplementation(() => { throw new Error("snapshot storage unavailable"); });
    const tmux = mockTmux();
    const td = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, snapshotCapture,
      resumeMetadataRefresher: { refresh: async () => { throw new Error("discovery unavailable"); } } as unknown as ResumeMetadataRefresher });

    const result = await td.teardown(rigId);

    expect(snapshotCapture.captureSnapshot).toHaveBeenCalledWith(rigId, "auto-pre-down");
    expect(result).toMatchObject({ snapshotId: null, sessionsKilled: 1 });
    expect(result.errors).toEqual(["Resume metadata refresh failed: discovery unavailable", "Snapshot failed: snapshot storage unavailable"]);
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

  it.each([
    ["claude-code", "CLAUDE.md"], ["claude-code", "CLAUDE.local.md"], ["codex", "AGENTS.md"], ["pi", "AGENTS.md"], ["omp", "AGENTS.md"],
  ])("preserves %s guidance when a sibling sharing %s cannot stop", async (runtime, fileName) => {
    const { rigId, nodeId, sessionId } = seedRigWithNode({ runtime, cwd: tmpDir });
    if (fileName === "CLAUDE.local.md") rigRepo.setRigClaudeManagedBlockFile(rigId, fileName);
    const sibling = rigRepo.addNode(rigId, "survivor", { runtime, cwd: tmpDir });
    const survivingSession = sessionRegistry.registerSession(sibling.id, "survivor@test-rig");
    sessionRegistry.updateStatus(survivingSession.id, "running");
    const guidance = path.join(tmpDir, fileName);
    const content = "Operator notes\n<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nworking guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n";
    fs.writeFileSync(guidance, content);
    const tmux = mockTmux();
    tmux.killSession = vi.fn(async target => target === "survivor@test-rig"
      ? { ok: false, code: "kill_failed", message: "tmux error" } : { ok: true });

    const result = await buildTeardown(tmux).teardown(rigId, { delete: true });

    expect(result).toMatchObject({ sessionsKilled: 1, deleted: false, deleteBlocked: true });
    expect(sessionRegistry.getSessionsForRig(rigId).find(s => s.id === sessionId)?.status).toBe("exited");
    expect(sessionRegistry.getSessionsForRig(rigId).find(s => s.id === survivingSession.id)?.status).toBe("running");
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId)).toEqual({ intentionally_stopped: 1 });
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(survivingSession.id)).toEqual({ intentionally_stopped: 0 });
    expect(fs.readFileSync(guidance, "utf-8")).toBe(content);
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();

    // A later successful shutdown releases the file for ordinary cleanup.
    tmux.killSession = vi.fn(async () => ({ ok: true }));
    await buildTeardown(tmux).teardown(rigId);
    expect(fs.readFileSync(guidance, "utf-8")).toBe("Operator notes\n");
  });

  // The seat-skills line's block goes at down only while it still holds the line; a person's edit is kept and named.
  it.each([
    ["claude-code", "CLAUDE.md"], ["codex", "AGENTS.md"],
  ] as const)("keeps a person's edit to the seat-skills line in a %s seat's %s and reports it; an unedited line goes", async (runtime, fileName) => {
    const writer = { exists: (p: string) => fs.existsSync(p), readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c) };
    const asset = fs.readFileSync(path.join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md"), "utf-8");
    const personal = "# Personal instructions\nPreserve these exact bytes.\n";
    // An appended word and an indented line (four spaces make it a Markdown code block) are both a person's edits.
    const edits = { none: (line: string) => line, appended: (line: string) => `${line} PERSON LINE EDIT`, indented: (line: string) => `    ${line}` };
    for (const [kind, edit] of Object.entries(edits)) {
      const cwd = fs.mkdtempSync(path.join(tmpDir, `${runtime}-`));
      const guidance = path.join(cwd, fileName);
      fs.writeFileSync(guidance, personal);
      mergeManagedBlock(writer, guidance, "CULTURE.md", "culture text");
      mergeManagedBlock(writer, guidance, "openrig-seat-skills.md", asset);
      fs.writeFileSync(guidance, fs.readFileSync(guidance, "utf-8").replace(SEAT_SKILLS_BOOTSTRAP_LINE, edit(SEAT_SKILLS_BOOTSTRAP_LINE)));
      const before = fs.readFileSync(guidance, "utf-8");
      const rig = rigRepo.createRig(`line-${runtime}-${kind}`);
      const node = rigRepo.addNode(rig.id, "dev", { runtime, cwd });
      sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, `dev@line-${runtime}-${kind}`).id, "running");

      const result = await buildTeardown().teardown(rig.id);

      const after = fs.readFileSync(guidance, "utf-8");
      if (kind === "none") {
        expect(after, kind).toBe(personal);
        expect(result.keptGuidance, kind).toBeUndefined();
      } else {
        // Only the culture block and its separator go: every byte around the kept edit stays.
        expect(after, kind).toBe(before.replace(`\n\n${managedBlockText("CULTURE.md", "culture text")}`, ""));
        expect(after, kind).toContain(`<!-- BEGIN OpenRig MANAGED BLOCK: openrig-seat-skills.md -->\n${edit(SEAT_SKILLS_BOOTSTRAP_LINE)}\n`);
        expect(result.keptGuidance, kind).toEqual([`${guidance}: openrig-seat-skills.md`]);
      }
    }
  });

  // Down takes out exactly what the writer added: a person's file is byte for byte what it was before the line went in,
  // whatever it ended with, after one start or several, beside the rig's other blocks; a file the line created is gone.
  it.each([
    ["claude-code", "CLAUDE.md"], ["codex", "AGENTS.md"],
  ] as const)("returns a %s seat's %s to its original bytes after the seat-skills line was on", async (runtime, fileName) => {
    const writer = { exists: (p: string) => fs.existsSync(p), readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c) };
    const asset = fs.readFileSync(path.join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md"), "utf-8");
    const shapes = { "no trailing newline": "# Notes\nkeep these", "one trailing newline": "# Notes\nkeep these\n", "two trailing newlines": "# Notes\nkeep these\n\n", "an empty file": "", "a new file": null };
    for (const [shape, original] of Object.entries(shapes)) {
      for (const starts of [1, 2]) {
        const label = `${shape}, ${starts} start(s)`;
        const cwd = fs.mkdtempSync(path.join(tmpDir, `${runtime}-`));
        const guidance = path.join(cwd, fileName);
        if (original !== null) fs.writeFileSync(guidance, original);
        // Each start merges the rig's culture and then the seat-skills line, as a start with the line on writes them.
        for (let i = 0; i < starts; i++) {
          mergeManagedBlock(writer, guidance, "CULTURE.md", "culture text");
          mergeManagedBlock(writer, guidance, "openrig-seat-skills.md", asset);
        }
        expect(fs.readFileSync(guidance, "utf-8"), label).toContain(SEAT_SKILLS_BOOTSTRAP_LINE);
        const rig = rigRepo.createRig(`bytes-${runtime}-${Object.keys(shapes).indexOf(shape)}-${starts}`);
        const node = rigRepo.addNode(rig.id, "dev", { runtime, cwd });
        sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, `dev@${rig.name}`).id, "running");

        await buildTeardown().teardown(rig.id);

        if (original === null) expect(fs.existsSync(guidance), label).toBe(false);
        else expect(fs.readFileSync(guidance, "utf-8"), label).toBe(original);
      }
    }
  });

  // What down can't tell apart: blank lines a person adds right after OpenRig's last block look like the writer's, so they
  // go with it; text a person adds there is kept, with its own newlines.
  it("removes blank lines a person added right after the seat-skills block, and keeps text they added there", async () => {
    const writer = { exists: (p: string) => fs.existsSync(p), readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c) };
    const asset = fs.readFileSync(path.join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md"), "utf-8");
    const original = "# Notes\nkeep these\n";
    for (const [added, expected] of [["\n\n\n", original], ["\nperson tail\n", `${original}\nperson tail\n`]] as const) {
      const cwd = fs.mkdtempSync(path.join(tmpDir, "claude-code-"));
      const guidance = path.join(cwd, "CLAUDE.md");
      fs.writeFileSync(guidance, original);
      mergeManagedBlock(writer, guidance, "openrig-seat-skills.md", asset);
      fs.appendFileSync(guidance, added);
      const rig = rigRepo.createRig(`after-block-${expected.length}`);
      const node = rigRepo.addNode(rig.id, "dev", { runtime: "claude-code", cwd });
      sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, `dev@${rig.name}`).id, "running");

      await buildTeardown().teardown(rig.id);

      expect(fs.readFileSync(guidance, "utf-8"), JSON.stringify(added)).toBe(expected);
    }
  });

  it.each(["kill_failed", "transport_unavailable"] as const)("keeps guidance when termination is unconfirmed: %s", async failure => {
    const { rigId, sessionId } = seedRigWithNode({ runtime: "codex", cwd: tmpDir });
    const guidance = path.join(tmpDir, "AGENTS.md");
    const content = "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nworking guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n";
    fs.writeFileSync(guidance, content);
    const tmux = mockTmux({ ok: false, code: "kill_failed", message: "tmux error" });
    if (failure === "transport_unavailable") tmux.probeSession = vi.fn(async () => ({ state: "transport_unavailable", cause: "socket unavailable" }));
    await buildTeardown(tmux).teardown(rigId);
    expect(sessionRegistry.getSessionsForRig(rigId).find(s => s.id === sessionId)?.status).toBe("running");
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId)).toEqual({ intentionally_stopped: 0 });
    expect(fs.readFileSync(guidance, "utf-8")).toBe(content);
  });

  it("preserves another rig's shared guidance during ordinary teardown", async () => {
    const { rigId } = seedRigWithNode({ runtime: "codex", cwd: tmpDir });
    const other = rigRepo.createRig("other-rig");
    const otherNode = rigRepo.addNode(other.id, "dev", { runtime: "codex", cwd: tmpDir });
    const session = sessionRegistry.registerSession(otherNode.id, "dev@other-rig");
    sessionRegistry.updateStatus(session.id, "running");
    const guidance = path.join(tmpDir, "AGENTS.md");
    const content = "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nshared guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n";
    fs.writeFileSync(guidance, content);
    await buildTeardown().teardown(rigId);
    expect(fs.readFileSync(guidance, "utf-8")).toBe(content);
  });

  // #875: Pi and omp seats write their blocks to AGENTS.md too, so a Codex rig stopping must not strip a file they still use.
  it.each(["pi", "omp"])("keeps a shared AGENTS.md that another rig's live %s seat still uses when a Codex rig stops", async (runtime) => {
    const { rigId } = seedRigWithNode({ runtime: "codex", cwd: tmpDir });
    const other = rigRepo.createRig("other-rig");
    const otherNode = rigRepo.addNode(other.id, "dev", { runtime, cwd: tmpDir });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(otherNode.id, "dev@other-rig").id, "running");
    const guidance = path.join(tmpDir, "AGENTS.md");
    const content = "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nshared guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n";
    fs.writeFileSync(guidance, content);
    await buildTeardown().teardown(rigId);
    expect(fs.readFileSync(guidance, "utf-8")).toBe(content);
  });

  // #875: once no seat in a cwd still uses them, down takes back the collector, its status line and the activity relay hooks
  // OpenRig added there, and leaves everything else as the person had it.
  describe("OpenRig's Claude collector, status line and activity hooks in a seat's cwd", () => {
    const COLLECTOR = "// shipped collector\n";

    /** A Claude seat's cwd after a real collector install, with the person's own settings text if given. */
    function claudeCwd(ownSettings?: string) {
      const cwd = fs.mkdtempSync(path.join(tmpDir, "claude-cwd-"));
      const state = path.join(tmpDir, "openrig-home");
      const asset = path.join(tmpDir, "collector-asset.cjs");
      fs.writeFileSync(asset, COLLECTOR);
      const settings = path.join(cwd, ".claude", "settings.local.json");
      if (ownSettings !== undefined) {
        fs.mkdirSync(path.dirname(settings), { recursive: true });
        fs.writeFileSync(settings, ownSettings);
      }
      const fsOps = {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        copyFile: replaceFile, homedir: os.homedir(),
      };
      new ClaudeCodeAdapter({ tmux: {} as TmuxAdapter, fsOps, stateDir: state, collectorAssetPath: asset })
        .ensureContextCollector({ cwd, tmuxSession: "dev@claude-rig" });
      const relay = `${shellQuote(process.execPath)} ${shellQuote(claudeActivityRelayPath(state))}`;
      return { cwd, asset, settings, collector: path.join(cwd, ".openrig", "context-collector.cjs"), relay };
    }

    /** Add hook groups the way the adapter writes them. */
    function addHooks(settings: string, hooks: Record<string, unknown[]>): void {
      const current = JSON.parse(fs.readFileSync(settings, "utf-8")) as Record<string, unknown>;
      current["hooks"] = { ...(current["hooks"] as Record<string, unknown> | undefined), ...hooks };
      fs.writeFileSync(settings, JSON.stringify(current, null, 2));
    }

    function claudeRig(name: string, cwd: string): string {
      const rig = rigRepo.createRig(name);
      const node = rigRepo.addNode(rig.id, "dev", { runtime: "claude-code", cwd });
      sessionRegistry.updateStatus(sessionRegistry.registerSession(node.id, `dev@${name}`).id, "running");
      return rig.id;
    }

    function teardownWith(asset: string, tmux?: TmuxAdapter) {
      return new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux ?? mockTmux(),
        snapshotCapture: mockSnapshotCapture(db), eventBus, claudeCollectorAssetPath: asset });
    }

    it("gives a non-git cwd back the person's own settings bytes, and removes the collector and its emptied folder", async () => {
      const own = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, env: { TEAM: "1" } }, null, 2);
      const s = claudeCwd(own);
      addHooks(s.settings, { Stop: [{ hooks: [{ type: "command", command: s.relay }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: s.relay, timeout: 5 }] }] });
      expect(fs.readFileSync(s.settings, "utf-8")).not.toBe(own);
      expect(fs.existsSync(path.join(s.cwd, ".git"))).toBe(false);

      const result = await teardownWith(s.asset).teardown(claudeRig("claude-rig", s.cwd));

      expect(fs.readFileSync(s.settings, "utf-8")).toBe(own);
      expect(fs.existsSync(s.collector)).toBe(false);
      expect(fs.existsSync(path.join(s.cwd, ".openrig"))).toBe(false);
      expect(result.keptFiles).toBeUndefined();
      expect(result.errors).toEqual([]);
    });

    it("keeps settings.local.json as {} when OpenRig's entries were all it held, since nothing says who created it", async () => {
      const s = claudeCwd();
      addHooks(s.settings, { Stop: [{ hooks: [{ type: "command", command: s.relay }] }] });

      await teardownWith(s.asset).teardown(claudeRig("claude-rig", s.cwd));

      expect(fs.readFileSync(s.settings, "utf-8")).toBe("{}");
      expect(fs.existsSync(path.join(s.cwd, ".claude"))).toBe(true);
      expect(fs.existsSync(path.join(s.cwd, ".openrig"))).toBe(false);
    });

    it("takes only OpenRig's hooks out of a mixed group, keeping the person's hooks, the group's other fields and their status line fields", async () => {
      const person = { type: "command", command: "echo person" };
      const s = claudeCwd(JSON.stringify({ permissions: { deny: ["Read(.env)"] }, statusLine: { padding: 2 } }, null, 2));
      addHooks(s.settings, {
        PreToolUse: [{ matcher: "Bash", hooks: [person, { type: "command", command: s.relay }] }],
        Stop: [{ hooks: [{ type: "command", command: s.relay }] }],
        Notification: [{ matcher: "", hooks: [person] }],
      });

      await teardownWith(s.asset).teardown(claudeRig("claude-rig", s.cwd));

      expect(JSON.parse(fs.readFileSync(s.settings, "utf-8"))).toEqual({
        permissions: { deny: ["Read(.env)"] },
        statusLine: { padding: 2 },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [person] }], Notification: [{ matcher: "", hooks: [person] }] },
      });
    });

    it("keeps and names a collector whose bytes aren't the shipped collector's, and still takes its status line out", async () => {
      const s = claudeCwd();
      fs.appendFileSync(s.collector, "// a person's edit\n");

      const result = await teardownWith(s.asset).teardown(claudeRig("claude-rig", s.cwd));

      expect(fs.readFileSync(s.collector, "utf-8")).toBe(`${COLLECTOR}// a person's edit\n`);
      expect(result.keptFiles).toEqual([`${s.collector}: not the shipped collector's bytes, so it was kept`]);
      expect(JSON.parse(fs.readFileSync(s.settings, "utf-8"))).toEqual({});
      expect(result.errors).toEqual([]);
    });

    it.each(["{ \"permissions\": ", "[]"])("leaves settings it can't read as a settings object (%s) byte for byte, and names them", async (text) => {
      const s = claudeCwd(text);

      const result = await teardownWith(s.asset).teardown(claudeRig("claude-rig", s.cwd));

      expect(fs.readFileSync(s.settings, "utf-8")).toBe(text);
      expect(result.keptFiles).toEqual([`${s.settings}: not a JSON settings object, so it was left as it is`]);
      expect(fs.existsSync(s.collector)).toBe(false);
      expect(result.errors).toEqual([]);
    });

    it.each(["another rig's seat", "a sibling whose stop failed"] as const)("keeps everything while %s still uses the cwd", async (consumer) => {
      const own = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2);
      const s = claudeCwd(own);
      addHooks(s.settings, { Stop: [{ hooks: [{ type: "command", command: s.relay }] }] });
      const before = fs.readFileSync(s.settings, "utf-8");
      const rigId = claudeRig("claude-rig", s.cwd);
      const tmux = mockTmux();
      if (consumer === "another rig's seat") claudeRig("other-rig", s.cwd);
      else {
        const sibling = rigRepo.addNode(rigId, "survivor", { runtime: "claude-code", cwd: s.cwd });
        sessionRegistry.updateStatus(sessionRegistry.registerSession(sibling.id, "survivor@claude-rig").id, "running");
        tmux.killSession = vi.fn(async target => target === "survivor@claude-rig"
          ? { ok: false, code: "kill_failed", message: "tmux error" } : { ok: true });
      }

      await teardownWith(s.asset, tmux).teardown(rigId);

      expect(fs.readFileSync(s.settings, "utf-8")).toBe(before);
      expect(fs.readFileSync(s.collector, "utf-8")).toBe(COLLECTOR);

      if (consumer === "a sibling whose stop failed") {
        // Once that seat stops too, the next down takes OpenRig's additions back.
        tmux.killSession = vi.fn(async () => ({ ok: true }));
        await teardownWith(s.asset, tmux).teardown(rigId);
        expect(fs.readFileSync(s.settings, "utf-8")).toBe(own);
        expect(fs.existsSync(s.collector)).toBe(false);
      }
    });

    // A link below the cwd shares a file between two directories: the stopping seat's cwd A and a live seat's cwd B. Whichever
    // way the link points, the shared target stays and is named; A's own, unshared targets still go.
    it.each(["B's .claude and .openrig link to A's", "A's .claude and .openrig link to B's", "settings.local.json is hardlinked"] as const)(
      "keeps a Claude target a seat in another directory still uses when %s", async (shape) => {
        const own = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2);
        const real = claudeCwd(own);
        addHooks(real.settings, { Stop: [{ hooks: [{ type: "command", command: real.relay }] }] });
        const other = fs.mkdtempSync(path.join(tmpDir, "claude-other-"));
        let a = real.cwd, b = other;
        if (shape === "A's .claude and .openrig link to B's") { a = other; b = real.cwd; }
        if (shape === "settings.local.json is hardlinked") {
          fs.mkdirSync(path.join(other, ".claude"));
          fs.linkSync(real.settings, path.join(other, ".claude", "settings.local.json"));
        } else {
          fs.symlinkSync(path.join(real.cwd, ".claude"), path.join(other, ".claude"));
          fs.symlinkSync(path.join(real.cwd, ".openrig"), path.join(other, ".openrig"));
        }
        const before = fs.readFileSync(real.settings, "utf-8");
        const rigId = claudeRig("claude-rig", a);
        claudeRig("other-rig", b);

        const result = await teardownWith(real.asset).teardown(rigId);

        expect(fs.readFileSync(real.settings, "utf-8")).toBe(before);
        const aSettings = path.join(a, ".claude", "settings.local.json");
        const aCollector = path.join(a, ".openrig", "context-collector.cjs");
        if (shape === "settings.local.json is hardlinked") {
          // A's collector isn't shared, so it still goes.
          expect(fs.existsSync(real.collector)).toBe(false);
          expect(result.keptFiles).toEqual([`${aSettings}: another seat's directory still uses it through a link, so it was kept`]);
        } else {
          expect(fs.readFileSync(real.collector, "utf-8")).toBe(COLLECTOR);
          expect(result.keptFiles).toEqual([
            `${aSettings}: another seat's directory still uses it through a link, so it was kept`,
            `${aCollector}: another seat's directory still uses it through a link, so it was kept`,
          ]);
        }
        expect(result.errors).toEqual([]);
      });
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

  it.each([false, true])("leaves a seat joined with rig attach as an external CLI claimed and running, and still stops the tmux seat (delete=%s)", async (del) => {
    const { rigId, nodeId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const desktop = rigRepo.addNode(rigId, "desktop", { runtime: "claude-code" });
    sessionRegistry.updateBinding(desktop.id, { attachmentType: "external_cli", externalSessionName: "desktop@test-rig" });
    const claimed = sessionRegistry.registerClaimedSession(desktop.id, "desktop@test-rig");
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async (name: string) => ({ state: name === "r01-dev" ? "present" : "absent" }));

    const result = await buildTeardown(tmux).teardown(rigId, { delete: del });

    if (!del) {
      // The claim is untouched: not recorded as stopped, and its binding kept, while the tmux seat beside it is stopped.
      expect(db.prepare("SELECT status, intentionally_stopped AS stopped FROM sessions WHERE id = ?").get(claimed.id)).toEqual({ status: "running", stopped: 0 });
      expect(sessionRegistry.getBindingForNode(desktop.id)).toMatchObject({ attachmentType: "external_cli" });
      expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    }
    expect(tmux.probeSession).not.toHaveBeenCalledWith("desktop@test-rig");
    expect(tmux.killSession).not.toHaveBeenCalledWith("desktop@test-rig");
    expect(result).toMatchObject({ sessionsKilled: 1, errors: [], deleted: del, leftRunning: ["desktop@test-rig"] });
  });

  it("stops a seat whose stored kind is neither tmux nor external CLI, as it does today: only an external CLI seat is left running", async () => {
    const { rigId, nodeId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    db.prepare("UPDATE bindings SET attachment_type = 'herdr' WHERE node_id = ?").run(nodeId);
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async (name: string) => ({ state: name === "r01-dev" ? "present" : "absent" }));

    const result = await buildTeardown(tmux).teardown(rigId, { delete: false });

    expect(tmux.killSession).toHaveBeenCalledWith("r01-dev");
    expect(result).toMatchObject({ sessionsKilled: 1, errors: [] });
    expect(result.leftRunning).toBeUndefined();
  });

  it("names the community-harness seats whose pane it stopped, since the harness's own processes may outlive it", async () => {
    const { rigId } = seedRigWithNode({ runtime: "claude-code", cwd: "/tmp" });
    const hermes = rigRepo.addNode(rigId, "hermes", { runtime: "synth-harness" });
    const launched = sessionRegistry.registerSession(hermes.id, "hermes@test-rig");
    sessionRegistry.updateStatus(launched.id, "running");
    sessionRegistry.recordCommunityHarnessSelection(launched.id, "synth-harness");
    // A free-text runtime with a preset's name, never launched for that preset, isn't one.
    const namesake = rigRepo.addNode(rigId, "namesake", { runtime: "synth-harness" });
    sessionRegistry.updateStatus(sessionRegistry.registerSession(namesake.id, "namesake@test-rig").id, "running");

    const result = await buildTeardown().teardown(rigId);

    expect(result).toMatchObject({ sessionsKilled: 3, errors: [], paneOnly: ["hermes@test-rig"] });
  });

  // T13: Stale session (tmux gone) -> benign
  it("stale session (tmux already gone) treated as success", async () => {
    const { rigId } = seedRig();
    const tmux = mockTmux({ ok: false, code: "session_not_found" });
    const td = buildTeardown(tmux);

    const result = await td.teardown(rigId, { delete: true });

    expect(result.sessionsKilled).toBe(0);
    expect(result.deleted).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("deletes a failed launch whose recorded session is absent without asking the guard to kill it", async () => {
    const { rigId, nodeId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const tmux = mockTmux({ ok: false, code: "guard_target_unknown", message: "ambiguous target" });
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));

    const result = await buildTeardown(tmux).teardown(rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(result.deleteBlocked).toBe(false);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(rigRepo.getRig(rigId)).toBeNull();
  });

  it("deletes an archived duplicate without killing the live rig's same-name session", async () => {
    const stale = seedRig();
    sessionRegistry.updateBinding(stale.nodeId, { tmuxSession: "r01-dev" });
    rigRepo.archiveRig(stale.rigId);
    const liveRig = rigRepo.createRig("test-rig");
    const liveNode = rigRepo.addNode(liveRig.id, "dev");
    const liveSession = sessionRegistry.registerSession(liveNode.id, "r01-dev");
    sessionRegistry.updateStatus(liveSession.id, "running");
    sessionRegistry.updateBinding(liveNode.id, { tmuxSession: "r01-dev" });
    db.prepare("UPDATE nodes SET runtime = 'claude-code', cwd = ? WHERE id IN (?, ?)")
      .run(tmpDir, stale.nodeId, liveNode.id);
    const guidance = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(guidance, "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nlive guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n");
    const tmux = mockTmux({ ok: false, code: "guard_target_unknown", message: "owned by live rig" });
    tmux.probeSession = vi.fn(async () => ({ state: "present" }));

    const result = await buildTeardown(tmux).teardown(stale.rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(rigRepo.getRig(liveRig.id)).not.toBeNull();
    expect(sessionRegistry.getSessionsForRig(liveRig.id)[0]?.status).toBe("running");
    expect(sessionRegistry.getBindingForNode(liveNode.id)?.tmuxSession).toBe("r01-dev");
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it("keeps the rig when tmux cannot confirm whether a session is absent", async () => {
    const { rigId } = seedRig();
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "transport_unavailable", cause: "permission denied" }));

    const result = await buildTeardown(tmux).teardown(rigId, { delete: true });

    expect(result.deleteBlocked).toBe(true);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(rigRepo.getRig(rigId)).not.toBeNull();
  });

  it.each(["/tmp/tmux-501/default", "/team/tmux/tmux-501/default"])("stops a rig after its own server reports absence on %s", async (socket) => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const terminal = noServerTerminal(`Command failed: tmux has-session -t =r01-dev\nno server running on ${socket}`);
    const tmux = mockTmux();
    tmux.probeSession = terminal.probeSession;

    const result = await buildTeardown(tmux).teardown(rigId);

    expect(result.errors).toEqual([]);
    expect(result.sessionsKilled).toBe(0);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    expect(sessionRegistry.getSessionsForRig(rigId).find((session) => session.id === sessionId))
      .toMatchObject({ status: "exited" });
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(sessionId))
      .toEqual({ intentionally_stopped: 1 });
    expect(checkRunningNameGuard({ findRigsByName: (name) => rigRepo.findRigsByName(name),
      countRunningSessions: makeRunningSessionCounter(db) }, "test-rig")).toEqual({ ok: true });
    expect(terminal.commands).toEqual(["tmux has-session -t '=r01-dev'"]);
    expect((await confirmStoppedGenerations(db, [rigId], tmux.probeSession.bind(tmux))).ok).toBe(true);
    rigRepo.archiveRig(rigId);
    expect(db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId))
      .toEqual({ archived_at: expect.any(String) });
  });

  it.each([
    "error connecting to /other-caller/tmux-501/default (No such file or directory)",
    // Synthetic Connection refused shape: real tmux 3.6a prints "no server running on ..." for a stale socket.
    "error connecting to /tmp/tmux-501/default (Connection refused)",
    "error connecting to /tmp/no server running/tmux-501/default (Connection refused)",
    "error connecting to /tmp/no server running/tmux-501/default (No such file or directory)",
    "error connecting to /tmp/\nno server running on x/tmux-501/default (Permission denied)",
    "error connecting to /tmp/no session/tmux-501/default (No such file or directory)",
    "permission denied: no server running on /tmp/tmux-501/default",
  ])("retains the binding when the server probe is uncertain: %s", async (cause) => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const tmux = mockTmux();
    const adapter = new TmuxAdapter(async () => { throw new Error("unexpected legacy exec"); }, undefined, async () => {
      throw Object.assign(new Error(`Command failed: /fixture/tmux has-session -t =r01-dev\n${cause}`), { execStderr: cause });
    });
    tmux.probeSession = vi.fn((name) => adapter.probeSession(name));

    const result = await buildTeardown(tmux).teardown(rigId, { delete: true });

    expect(result).toMatchObject({ deleted: false, deleteBlocked: true, sessionsKilled: 0 });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(rigRepo.getRig(rigId)).not.toBeNull();
    expect(sessionRegistry.getBindingForNode(nodeId)?.tmuxSession).toBe("r01-dev");
    expect(sessionRegistry.getSessionsForRig(rigId).find((session) => session.id === sessionId)?.status).toBe("running");
    sessionRegistry.updateStatus(sessionId, "detached");
    expect((await confirmStoppedGenerations(db, [rigId], tmux.probeSession.bind(tmux))).ok).toBe(false);
  });

  it("retains the binding if the tmux server vanishes between probe and kill", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const tmux = mockTmux({ ok: false, code: "session_not_found", message: "no server running on /tmp/tmux-501/default" });
    tmux.probeSession = vi.fn(async () => ({ state: "present" }));

    const result = await buildTeardown(tmux).teardown(rigId, { delete: true });

    expect(result).toMatchObject({ deleted: false, deleteBlocked: true, sessionsKilled: 0 });
    expect(rigRepo.getRig(rigId)).not.toBeNull();
    expect(sessionRegistry.getBindingForNode(nodeId)?.tmuxSession).toBe("r01-dev");
    expect(sessionRegistry.getSessionsForRig(rigId).find((session) => session.id === sessionId)?.status).toBe("running");
  });

  it("preserves guidance shared with a live rig under a different name", async () => {
    const stale = seedRig();
    sessionRegistry.updateStatus(stale.sessionId, "exited");
    rigRepo.archiveRig(stale.rigId);
    const live = rigRepo.createRig("other-name");
    const liveNode = rigRepo.addNode(live.id, "dev");
    db.prepare("UPDATE nodes SET runtime = 'claude-code', cwd = ? WHERE id IN (?, ?)")
      .run(tmpDir, stale.nodeId, liveNode.id);
    const guidance = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(guidance, "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nlive guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n");

    const result = await buildTeardown().teardown(stale.rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it.each([
    ["claude-code", "CLAUDE.md"],
    ["claude-code", "CLAUDE.local.md"],
    ["codex", "AGENTS.md"],
  ])("preserves %s guidance shared through a symlinked working directory (%s)", async (runtime, fileName) => {
    const realCwd = path.join(tmpDir, "real-workspace");
    const aliasCwd = path.join(tmpDir, "alias-workspace");
    fs.mkdirSync(realCwd);
    fs.symlinkSync(realCwd, aliasCwd, process.platform === "win32" ? "junction" : "dir");
    const stale = seedRigWithNode({ runtime, cwd: aliasCwd, sessionStatus: "exited" });
    rigRepo.archiveRig(stale.rigId);
    const live = rigRepo.createRig("live-name");
    rigRepo.addNode(live.id, "dev", { runtime, cwd: realCwd });
    if (fileName === "CLAUDE.local.md") {
      rigRepo.setRigClaudeManagedBlockFile(stale.rigId, fileName);
      rigRepo.setRigClaudeManagedBlockFile(live.id, fileName);
    }
    const guidance = path.join(realCwd, fileName);
    fs.writeFileSync(guidance, "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nlive guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n");

    const result = await buildTeardown().teardown(stale.rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it.each([
    ["claude-code", "CLAUDE.md"],
    ["claude-code", "CLAUDE.local.md"],
    ["codex", "AGENTS.md"],
  ])("preserves %s guidance created while teardown probes tmux (%s)", async (runtime, fileName) => {
    const stale = seedRigWithNode({ runtime, cwd: tmpDir });
    rigRepo.archiveRig(stale.rigId);
    const live = rigRepo.createRig("live-name");
    rigRepo.addNode(live.id, "dev", { runtime, cwd: tmpDir });
    if (fileName === "CLAUDE.local.md") {
      rigRepo.setRigClaudeManagedBlockFile(stale.rigId, fileName);
      rigRepo.setRigClaudeManagedBlockFile(live.id, fileName);
    }
    const guidance = path.join(tmpDir, fileName);
    expect(fs.existsSync(guidance)).toBe(false);
    let probeEntered!: () => void;
    let resumeProbe!: () => void;
    const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
    const resume = new Promise<void>((resolve) => { resumeProbe = resolve; });
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => {
      probeEntered();
      await resume;
      return { state: "absent" } as const;
    });

    const teardown = buildTeardown(tmux).teardown(stale.rigId, { delete: true });
    await entered;
    fs.writeFileSync(guidance, "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nlive guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n");
    resumeProbe();
    const result = await teardown;

    expect(result.deleted).toBe(true);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it("preserves guidance shared through a case alias on a case-insensitive volume", async () => {
    const realCwd = path.join(tmpDir, "Workspace");
    const caseAlias = path.join(tmpDir, "workspace");
    fs.mkdirSync(realCwd);
    // This alias exists only on a case-insensitive test volume.
    if (!fs.existsSync(caseAlias)) return;
    const stale = seedRigWithNode({ runtime: "codex", cwd: caseAlias, sessionStatus: "exited" });
    rigRepo.archiveRig(stale.rigId);
    const live = rigRepo.createRig("live-name");
    rigRepo.addNode(live.id, "dev", { runtime: "codex", cwd: realCwd });
    const guidance = path.join(realCwd, "AGENTS.md");
    fs.writeFileSync(guidance, "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nlive guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n");

    const result = await buildTeardown().teardown(stale.rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(fs.readFileSync(guidance, "utf-8")).toContain("live guidance");
  });

  it("removes stale guidance when a same-name rig uses a different path", async () => {
    const stale = seedRig();
    sessionRegistry.updateStatus(stale.sessionId, "exited");
    rigRepo.archiveRig(stale.rigId);
    const live = rigRepo.createRig("test-rig");
    const liveNode = rigRepo.addNode(live.id, "dev");
    db.prepare("UPDATE nodes SET runtime = 'claude-code', cwd = ? WHERE id = ?")
      .run(tmpDir, stale.nodeId);
    db.prepare("UPDATE nodes SET runtime = 'claude-code', cwd = ? WHERE id = ?")
      .run(path.join(tmpDir, "other"), liveNode.id);
    const guidance = path.join(tmpDir, "CLAUDE.md");
    fs.writeFileSync(guidance, "<!-- BEGIN OpenRig MANAGED BLOCK: role -->\nstale guidance\n<!-- END OpenRig MANAGED BLOCK: role -->\n");

    const result = await buildTeardown().teardown(stale.rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(fs.existsSync(guidance)).toBe(false);
  });

  it("removes only OpenRig-managed blocks and preserves user + third-party content", async () => {
    const cwd = path.join(tmpDir, "claude-project");
    fs.mkdirSync(cwd, { recursive: true });
    const claudeMd = path.join(cwd, "CLAUDE.md");
    fs.writeFileSync(claudeMd, [
      "# User intro",
      "<!-- BEGIN OpenRig MANAGED BLOCK: role -->",
      "managed role",
      "<!-- END OpenRig MANAGED BLOCK: role -->",
      "<!-- BEGIN THIRD PARTY BLOCK -->",
      "third party",
      "<!-- END THIRD PARTY BLOCK -->",
      "tail",
    ].join("\n\n"));
    const { rigId } = seedRigWithNode({ runtime: "claude-code", cwd });
    const td = buildTeardown();

    await td.teardown(rigId);

    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).toContain("# User intro");
    expect(content).toContain("third party");
    expect(content).toContain("tail");
    expect(content).not.toContain("BEGIN OpenRig MANAGED BLOCK");
  });

  it("deletes guidance file if only OpenRig-managed content remains after teardown", async () => {
    const cwd = path.join(tmpDir, "codex-project");
    fs.mkdirSync(cwd, { recursive: true });
    const agentsMd = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(agentsMd, [
      "<!-- BEGIN OpenRig MANAGED BLOCK: role -->",
      "managed role",
      "<!-- END OpenRig MANAGED BLOCK: role -->",
    ].join("\n"));
    const { rigId } = seedRigWithNode({ runtime: "codex", cwd, sessionStatus: "exited" });
    const td = buildTeardown();

    const result = await td.teardown(rigId);

    expect(result.alreadyStopped).toBe(true);
    expect(fs.existsSync(agentsMd)).toBe(false);
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

// rig down stops only the seat's own terminal. On the production path (the guard installed, the server chosen by execution
// args, every write as argv), a session is stopped only when it carries the seat's OpenRig marker, and each effect runs
// only on the server and session id it was read from. Each case runs on its own private tmux server.
describe.skipIf(process.platform === "win32")("rig down leaves a terminal it can't show to be the seat's", () => {
  const NAME = "dev-impl@owned";
  const exec = promisify(execFile);

  async function harness(hook?: (argv: string[], tmux: (...a: string[]) => Promise<string>) => Promise<void>) {
    // Short socket path for macOS sockaddr_un, no inherited server, no config.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rd-"));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMUX_TMPDIR: home, SHELL: "/bin/sh" };
    const tmux = async (...args: string[]) => (await exec("tmux", ["-L", "own", "-f", "/dev/null", ...args], { env, timeout: 5000 })).stdout.trim();
    const adapter = new TmuxAdapter(async () => { throw new Error("unexpected shell execution"); }, undefined, async (argv) => {
      const out = (await exec(argv[0]!, argv.slice(1), { env, timeout: 5000 })).stdout;
      await hook?.(argv, tmux);
      return out;
    }, ["-L", "own", "-f", "/dev/null"]);
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
    const guard = new SeatDeliveryGuard(db, (target) => resolveGuardTarget(db, target));
    guard.recoverActivation();
    adapter.deliveryGuard = guard;
    const rig = rigRepo.createRig("owned");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: home });
    const bind = async () => {
      const pane = (await tmux("list-panes", "-t", `=${NAME}:`, "-F", "#{pane_id}")).split("\n")[0]!;
      const session = sessionRegistry.registerSession(node.id, NAME);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: NAME, tmuxPane: pane });
      return session;
    };
    const teardown = () => new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: adapter,
      snapshotCapture: mockSnapshotCapture(db) }).teardown(rig.id, { snapshot: false });
    const alive = (name: string) => tmux("has-session", "-t", `=${name}`).then(() => true, () => false);
    const close = async () => { await tmux("kill-server").catch(() => {}); db.close(); fs.rmSync(home, { recursive: true, force: true }); };
    return { tmux, node, bind, teardown, alive, close, sessionRegistry, db };
  }

  // What's left after a refusal: the session row still running and its binding intact, so nothing reads as stopped.
  function expectLeftRunning(h: Awaited<ReturnType<typeof harness>>, sessionId: string, result: { sessionsKilled: number; errors: string[] }, reason: RegExp) {
    expect(result.sessionsKilled).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(new RegExp(`^Kill failed for session '${NAME}': '${NAME}' was left running: its tmux session \\$\\d+ ${reason.source}`));
    expect(h.sessionRegistry.getBindingForNode(h.node.id)?.tmuxSession).toBe(NAME);
    expect(h.db.prepare("SELECT status FROM sessions WHERE id=?").get(sessionId)).toEqual({ status: "running" });
  }

  it("the seat's own session, marked with its node, is stopped as before", async () => {
    const h = await harness();
    try {
      await h.tmux("new-session", "-d", "-s", "keepalive", "sleep 300");
      await h.tmux("new-session", "-d", "-s", NAME, "-e", `OPENRIG_NODE_ID=${h.node.id}`, "sleep 300");
      await h.bind();
      expect(await h.teardown()).toMatchObject({ sessionsKilled: 1, errors: [] });
      expect(await h.alive(NAME)).toBe(false);
      expect(await h.alive("keepalive")).toBe(true);
      expect(h.sessionRegistry.getBindingForNode(h.node.id)).toBeNull();
    } finally { await h.close(); }
  });

  it("after the tmux server is replaced, another terminal with the seat's name and its old ids survives", async () => {
    const h = await harness();
    try {
      await h.tmux("new-session", "-d", "-s", NAME, "-e", `OPENRIG_NODE_ID=${h.node.id}`, "sleep 300");
      const session = await h.bind();
      expect(h.sessionRegistry.getBindingForNode(h.node.id)?.tmuxPane).toBe("%0");
      await h.tmux("kill-server");
      await h.tmux("new-session", "-d", "-s", NAME, "sleep 301");
      expect(await h.tmux("list-panes", "-t", `=${NAME}:`, "-F", "#{session_id} #{pane_id}")).toBe("$0 %0");
      expectLeftRunning(h, session.id, await h.teardown(), /doesn't carry this seat's OpenRig marker \(OPENRIG_NODE_ID\)/);
      expect(await h.alive(NAME)).toBe(true);
    } finally { await h.close(); }
  });

  it("a session with the seat's name but no marker (adopted, bound or older) is left running, not stopped", async () => {
    const h = await harness();
    // The daemon is on its own server here, so the manual path must name it: a plain `tmux` reaches another server.
    setDaemonTmuxServer(["-L", "own"]);
    try {
      await h.tmux("new-session", "-d", "-s", NAME, "sleep 300");
      const session = await h.bind();
      const result = await h.teardown();
      expectLeftRunning(h, session.id, result, /doesn't carry this seat's OpenRig marker \(OPENRIG_NODE_ID\)/);
      expect(result.errors[0]).toContain(`If it is this seat's, look first with \`tmux -L own attach -t '=${NAME}'\`, `
        + `then stop it with \`tmux -L own kill-session -t '=${NAME}'\` and run the command again.`);
      expect(await h.alive(NAME)).toBe(true);
    } finally { setDaemonTmuxServer([]); await h.close(); }
  });

  it("a session marked with another seat's node is left running", async () => {
    const h = await harness();
    try {
      await h.tmux("new-session", "-d", "-s", NAME, "-e", "OPENRIG_NODE_ID=another-node", "sleep 300");
      const session = await h.bind();
      expectLeftRunning(h, session.id, await h.teardown(), /carries another seat's OpenRig marker \(OPENRIG_NODE_ID=another-node\)/);
      expect(await h.alive(NAME)).toBe(true);
    } finally { await h.close(); }
  });

  it("on the same server, a replacement with the seat's name (a different pane) survives", async () => {
    const h = await harness();
    try {
      // The keepalive comes first, so the server stays the same one throughout.
      await h.tmux("new-session", "-d", "-s", "keepalive", "sleep 300");
      await h.tmux("new-session", "-d", "-s", NAME, "-e", `OPENRIG_NODE_ID=${h.node.id}`, "sleep 300");
      const session = await h.bind();
      await h.tmux("kill-session", "-t", `=${NAME}`);
      await h.tmux("new-session", "-d", "-s", NAME, "sleep 301");
      const result = await h.teardown();
      expect(result).toMatchObject({ sessionsKilled: 0 });
      expect(result.errors[0]).toMatch(/Managed pane identity unavailable or changed; no input written/);
      expect(await h.alive(NAME)).toBe(true);
      expect(h.db.prepare("SELECT status FROM sessions WHERE id=?").get(session.id)).toEqual({ status: "running" });
    } finally { await h.close(); }
  });

  it("a server replaced between reading the seat's marker and stopping it leaves the new terminal alone", async () => {
    let replaced = false;
    const h = await harness(async (argv, tmux) => {
      // Just after the marker is read on the seat's server, that server is replaced, and another terminal takes the name and
      // the old ids.
      if (replaced || !argv.includes("show-environment")) return;
      replaced = true;
      await tmux("kill-server");
      await tmux("new-session", "-d", "-s", NAME, "sleep 301");
    });
    try {
      await h.tmux("new-session", "-d", "-s", NAME, "-e", `OPENRIG_NODE_ID=${h.node.id}`, "sleep 300");
      const session = await h.bind();
      const result = await h.teardown();
      expect(replaced).toBe(true);
      expect(result.sessionsKilled).toBe(0);
      expect(result.errors).toEqual([`Kill failed for session '${NAME}': $0 is no longer that session on the tmux server it was read from `
        + "(the server may have been replaced); nothing was detached or killed."]);
      expect(await h.tmux("list-panes", "-t", `=${NAME}:`, "-F", "#{session_id} #{pane_id}")).toBe("$0 %0");
      expect(h.db.prepare("SELECT status FROM sessions WHERE id=?").get(session.id)).toEqual({ status: "running" });
    } finally { await h.close(); }
  });
});
