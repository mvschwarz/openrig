import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


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
    ["claude-code", "CLAUDE.md"], ["claude-code", "CLAUDE.local.md"], ["codex", "AGENTS.md"],
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
    expect(fs.readFileSync(guidance, "utf-8")).toBe(content);
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();

    // A later successful shutdown releases the file for ordinary cleanup.
    tmux.killSession = vi.fn(async () => ({ ok: true }));
    await buildTeardown(tmux).teardown(rigId);
    expect(fs.readFileSync(guidance, "utf-8")).toBe("Operator notes\n");
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

  it("retains the binding when the tmux server is unreachable", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const tmux = mockTmux();
    tmux.probeSession = vi.fn(async () => ({ state: "transport_unavailable", cause: "no server running on /tmp/tmux-501/default" }));

    const result = await buildTeardown(tmux).teardown(rigId, { delete: true });

    expect(result).toMatchObject({ deleted: false, deleteBlocked: true, sessionsKilled: 0 });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(rigRepo.getRig(rigId)).not.toBeNull();
    expect(sessionRegistry.getBindingForNode(nodeId)?.tmuxSession).toBe("r01-dev");
    expect(sessionRegistry.getSessionsForRig(rigId).find((session) => session.id === sessionId)?.status).toBe("running");
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
