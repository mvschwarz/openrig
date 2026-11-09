// OPR.0.3.4.11 — launchNodeSubset tests: managed partial restore for held seats.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

function makeTmux(overrides?: Partial<Record<string, (...args: unknown[]) => unknown>>) {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => false),
    sendKeys: vi.fn(async () => {}),
    capturePaneContent: vi.fn(async () => ""),
    getPaneCommand: vi.fn(async () => null),
    getPanePid: vi.fn(async () => null),
    listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
    getSessionStatus: vi.fn(async () => null),
    waitForReady: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    startPipePane: vi.fn(async () => true),
    killSession: vi.fn(async () => {}),
    ...overrides,
  };
}

// A fresh pod-aware launch starts its harness through StartupOrchestrator, which needs the
// node's startup context and a runtime adapter (#107 refuses fresh-primed without them).
const emptyStartupContext = (runtime: string) => ({ projectionEntries: [], resolvedStartupFiles: [], startupActions: [], runtime });
function readyAdapter(runtime: string) {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    launchHarness: vi.fn(async () => ({ ok: true as const })),
    checkReady: vi.fn(async () => ({ ready: true })),
  };
}

describe("RestoreOrchestrator.launchNodeSubset", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let tmux: ReturnType<typeof makeTmux>;
  let orchestrator: RestoreOrchestrator;
  let processes: NativeProcessRow[];
  let listProcesses: ReturnType<typeof vi.fn<() => Promise<NativeProcessRow[]>>>;

  beforeEach(() => { setup(createFullTestDb()); });

  function setup(database: Database.Database) {
    db = database;
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    tmux = makeTmux();
    processes = [];
    listProcesses = vi.fn(async () => processes);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux as any });
    orchestrator = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux as any,
      claudeResume: new ClaudeResumeAdapter(tmux as any),
      codexResume: new CodexResumeAdapter(tmux as any),
      listProcesses,
    });
  }

  afterEach(() => { db.close(); });

  function seedPodAwareRig(): { rigId: string; nodeIds: string[] } {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", rig.id, "dev", "Dev");
    const n1 = rigRepo.addNode(rig.id, "dev.driver", { role: "driver", runtime: "claude-code", podId: "pod-1" });
    const n2 = rigRepo.addNode(rig.id, "dev.guard", { role: "guard", runtime: "codex", podId: "pod-1" });
    return { rigId: rig.id, nodeIds: [n1.id, n2.id] };
  }

  /** Capture the supplied private roster and startup contexts for subset-launch checks. */
  function seedSnapshot(rigId: string, nodeIds: string[], nodeStartupContext: Record<string, unknown> = {}) {
    const sessions = nodeIds.map((nid, i) => ({
      nodeId: nid,
      id: `sess-${i}`,
      sessionName: `seat-${i}@test-rig`,
      status: "running",
      resumeType: "none",
      resumeToken: null,
      restorePolicy: "relaunch_fresh",
    }));
    const data = {
      rig: { id: rigId, name: "test-rig" },
      nodes: nodeIds.map((nid, i) => ({
        id: nid,
        logicalId: i === 0 ? "dev.driver" : "dev.guard",
        rigId,
        runtime: i === 0 ? "claude-code" : "codex",
        podId: "pod-1",
      })),
      sessions,
      edges: [],
      checkpoints: {},
      nodeStartupContext,
    } as any;
    const snap = snapshotRepo.createSnapshot(rigId, "manual", data);
    return snap.id;
  }

  it.each([
    ["codex", "claude-code"],
    ["claude-code", "codex"],
  ])("saved startup %s stops live %s before subset launch", async (saved, live) => {
    const { rigId, nodeIds } = seedPodAwareRig();
    const snapshotId = seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext(saved) });
    db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(live, nodeIds[0]);
    const before = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"], { snapshotId });
    expect(result.ok).toBe(true); // The subset envelope reports individual launch outcomes.
    expect(result.launched?.[0]).toMatchObject({ status: "awaiting-decision", error: "No session was started for this seat. Restore a snapshot whose saved startup runtime matches the seat's current runtime." });
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(before);
  });

  it("returns rig_not_found for unknown rig", async () => {
    const result = await orchestrator.launchNodeSubset("nonexistent", ["dev.driver"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("rig_not_found");
  });

  it("returns no_usable_snapshot when no snapshot exists", async () => {
    const { rigId } = seedPodAwareRig();
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_usable_snapshot");
  });

  it("returns no_matching_nodes for unknown logical id", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const result = await orchestrator.launchNodeSubset(rigId, ["nonexistent.node"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_matching_nodes");
  });

  it("launches target and holds non-target with default reason", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.held).toHaveLength(1);
    expect(result.held![0].logicalId).toBe("dev.guard");
    expect(result.held![0].reason).toBe("excluded_from_subset");
    expect(result.nonTargetEffects).toMatchObject({ mode: "detach_and_hold", reason: "excluded_from_subset" });
  });

  it("single-node launch leaves non-target rows, bindings, startup state, and events unchanged", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
    const nonTarget = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(nonTarget.id, "running");
    sessionRegistry.updateBinding(nodeIds[1]!, { tmuxSession: "dev-guard@test-rig", tmuxPane: "%9" });
    db.prepare("UPDATE sessions SET startup_status = ? WHERE id = ?").run("attention_required", nonTarget.id);
    const before = {
      session: db.prepare("SELECT * FROM sessions WHERE id = ?").get(nonTarget.id),
      binding: db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeIds[1]),
      events: db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(nodeIds[1]) as { n: number },
    };

    const adapter = readyAdapter("claude-code");
    const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter } });

    expect(result.ok).toBe(true);
    expect(result.launched).toEqual([
      expect.objectContaining({ logicalId: "dev.driver", status: "fresh-primed" }),
    ]);
    expect(adapter.launchHarness).toHaveBeenCalledOnce();
    expect(result.nonTargetEffects).toEqual({ mode: "unchanged", reason: null, affected: [] });
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(nonTarget.id)).toEqual(before.session);
    expect(db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeIds[1])).toEqual(before.binding);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(nodeIds[1]) as { n: number }).n).toBe(before.events.n);
  });

  it("failed single-node launch also leaves non-target state unchanged", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const nonTarget = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(nonTarget.id, "running");
    sessionRegistry.updateBinding(nodeIds[1]!, { tmuxSession: "dev-guard@test-rig", tmuxPane: "%9" });
    db.prepare("UPDATE sessions SET startup_status = ? WHERE id = ?").run("attention_required", nonTarget.id);
    const before = {
      session: db.prepare("SELECT * FROM sessions WHERE id = ?").get(nonTarget.id),
      binding: db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeIds[1]),
      events: db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(nodeIds[1]) as { n: number },
    };
    tmux.createSession.mockResolvedValue({ ok: false, code: "tmux_error", message: "launch failed" } as never);

    const result = await orchestrator.launchSingleNode(rigId, "dev.driver");

    expect(result.ok).toBe(true);
    expect(result.launched).toEqual([
      expect.objectContaining({ logicalId: "dev.driver", status: "failed", error: "launch failed" }),
    ]);
    expect(result.nonTargetEffects).toEqual({ mode: "unchanged", reason: null, affected: [] });
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(nonTarget.id)).toEqual(before.session);
    expect(db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeIds[1])).toEqual(before.binding);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(nodeIds[1]) as { n: number }).n).toBe(before.events.n);
  });

  it("exact snapshot selection overrides automatic ranking before a narrow launch", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    const manualId = seedSnapshot(rigId, nodeIds);
    db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 10:00:00", manualId);
    const autoId = seedSnapshot(rigId, nodeIds);
    db.prepare("UPDATE snapshots SET kind = ?, created_at = ? WHERE id = ?").run("auto-pre-down", "2026-04-27 10:00:00", autoId);

    const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { snapshotId: manualId });

    expect(result.ok).toBe(true);
    expect(result.snapshotSelection).toMatchObject({ snapshotId: manualId, mode: "explicit", kind: "manual" });
  });

  it("rejects an exact snapshot from another rig before any launch mutation", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const otherRig = rigRepo.createRig("other-rig");
    const otherNode = rigRepo.addNode(otherRig.id, "other.worker", { runtime: "codex" });
    const otherSnapshot = snapshotRepo.createSnapshot(otherRig.id, "manual", {
      rig: otherRig.rig,
      nodes: [otherNode],
      sessions: [],
      edges: [],
      checkpoints: {},
    } as any);
    const before = {
      sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions").get(),
      events: db.prepare("SELECT COUNT(*) AS n FROM events").get(),
    };

    const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { snapshotId: otherSnapshot.id });

    expect(result).toMatchObject({ ok: false, code: "snapshot_wrong_rig" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(before.sessions);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(before.events);
  });

  it("does not launch a current node excluded from the selected snapshot's intended roster", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    const snapshotId = seedSnapshot(rigId, nodeIds);
    const snapshot = snapshotRepo.getSnapshot(snapshotId)!;
    const data = JSON.parse(JSON.stringify(snapshot.data));
    data.topologyRoster = { version: 1, source: "operator_explicit", intendedNodeIds: [nodeIds[0]] };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
    const beforeEvents = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };

    const result = await orchestrator.launchSingleNode(rigId, "dev.guard", { snapshotId });

    expect(result).toMatchObject({ ok: false, code: "no_matching_nodes" });
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(beforeEvents.n);
  });

  it("plans multi-seat non-target effects without mutating sessions or events", () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const before = {
      sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number },
      events: db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number },
    };

    const result = orchestrator.planNodeSubset(rigId, ["dev.driver"], { holdReason: "operator hold" });

    expect(result).toMatchObject({
      ok: true,
      planOnly: true,
      snapshotSelection: { mode: "automatic" },
      nonTargetEffects: {
        mode: "detach_and_hold",
        reason: "operator hold",
        affected: [{ logicalId: "dev.guard", reason: "operator hold" }],
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(before.sessions);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(before.events);
  });

  it("plans single-node subset by node id with nonTargetMode unchanged (#887)", () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = orchestrator.planNodeSubset(rigId, [nodeIds[0]!], { nonTargetMode: "unchanged" });

    expect(result).toMatchObject({
      ok: true,
      planOnly: true,
      targetNodes: [{ nodeId: nodeIds[0], logicalId: "dev.driver" }],
      unmatchedIds: [],
      nonTargetEffects: {
        mode: "unchanged",
        reason: null,
        affected: [],
      },
    });
  });

  it("emits restore.subset_completed for launched targets only", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'restore.subset_completed'").all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.result.nodes).toHaveLength(1);
    expect(payload.result.nodes[0].logicalId).toBe("dev.driver");
  });

  it("emits node.held for non-running held non-targets", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'node.held'").all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.logicalId).toBe("dev.guard");
    expect(payload.reason).toBe("excluded_from_subset");
  });

  it("doesn't hold a non-target seat joined with rig attach as an external CLI, since it has no tmux session to check", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    sessionRegistry.updateBinding(nodeIds[1]!, { attachmentType: "external_cli", externalSessionName: "guard-desktop@test-rig" });
    const claimed = sessionRegistry.registerClaimedSession(nodeIds[1]!, "guard-desktop@test-rig");

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.held'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(claimed.id)).toEqual({ status: "running" });
    expect(tmux.hasSession).not.toHaveBeenCalledWith("guard-desktop@test-rig");
  });

  it("leaves a targeted seat joined with rig attach as an external CLI attached, and still launches the tmux target beside it", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code"), [nodeIds[1]!]: emptyStartupContext("codex") });
    sessionRegistry.updateBinding(nodeIds[1]!, { attachmentType: "external_cli", externalSessionName: "guard-desktop@test-rig" });
    const claimed = sessionRegistry.registerClaimedSession(nodeIds[1]!, "guard-desktop@test-rig");
    const claude = readyAdapter("claude-code");
    const codex = readyAdapter("codex");

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver", "dev.guard"], { adapters: { "claude-code": claude, codex } });

    // Nothing is launched in the attached app's place, and its claim and binding are as they were.
    expect(codex.launchHarness).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(claimed.id)).toEqual({ status: "running" });
    expect(sessionRegistry.getBindingForNode(nodeIds[1]!)).toMatchObject({ attachmentType: "external_cli", externalSessionName: "guard-desktop@test-rig" });
    // A tmux session that happens to share the claim's name can't make it read as already running.
    expect(tmux.hasSession).not.toHaveBeenCalledWith("guard-desktop@test-rig");
    expect(claude.launchHarness).toHaveBeenCalledOnce();
    expect(result.launched).toEqual([
      expect.objectContaining({ logicalId: "dev.driver", status: "fresh-primed" }),
      expect.objectContaining({ logicalId: "dev.guard", status: "left_attached", error: expect.stringContaining("rig unclaim guard-desktop@test-rig") }),
    ]);
  });

  it("uses operator hold reason when provided", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"], { holdReason: "codex auth expired" });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all() as { payload: string }[];
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.reason).toBe("codex auth expired");
  });

  it("reports already_running for live targets (tmux alive)", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-driver@test-rig");

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(result.alreadyRunning![0].logicalId).toBe("dev.driver");
    expect(result.launched).toHaveLength(0);
  });

  function seedPreservedShell(runtime = "claude-code") {
    const { rigId, nodeIds } = seedPodAwareRig();
    const snapshotId = seedSnapshot(rigId, nodeIds);
    db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(runtime, nodeIds[0]);
    const data = JSON.parse((db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string }).data);
    data.nodes[0].runtime = runtime;
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(nodeIds[0]!, { tmuxSession: session.sessionName, tmuxPane: "%1" });
    tmux.hasSession.mockResolvedValue(true);
    tmux.getPaneCommand.mockResolvedValue("bash" as never);
    tmux.getPanePid.mockResolvedValue(10 as never);
    processes = [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, command: "/bin/bash", executableName: "bash", startedAt: "Fri Oct 9 07:00:00 2026" }];
    return { rigId, nodeIds, session, snapshotId };
  }

  function setSavedSession(snapshotId: string, fields: Record<string, unknown>) {
    const data = JSON.parse((db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string }).data);
    Object.assign(data.sessions[0], fields);
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
  }

  it.each([[true, "To resume its conversation"], [false, "start nothing and ask for a decision"]] as const)(
    "offers a community harness's idle seat the resume command only when its preset declares resume (resume=%s)", async (resumes, advice) => {
      const saved = process.env["OPENRIG_HOME"];
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "subset-community-"));
      try {
        process.env["OPENRIG_HOME"] = home;
        fs.mkdirSync(path.join(home, "community-harnesses"));
        fs.writeFileSync(path.join(home, "community-harnesses", "synth-harness.yaml"),
          `format: 1\nname: synth-harness\ncommand: synth-launch\nmaintainer: Example\nlimits: []\nlaunch_result: true\n${resumes ? "resume: true\n" : ""}`);
        const { rigId, session, snapshotId } = seedPreservedShell("synth-harness");
        sessionRegistry.recordCommunityHarnessSelection(session.id, "synth-harness");
        setSavedSession(snapshotId, { communityHarness: "synth-harness", resumeType: "community:synth-harness", resumeToken: "chat-123", restorePolicy: "resume_if_possible" });
        const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
        expect(result.launched![0]).toMatchObject({ status: "attention_required", error: expect.stringContaining(advice) });
      } finally {
        if (saved === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = saved;
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

  it.each(["claude-code", "codex", "pi", "omp"])("reports an exited %s agent without replacing its preserved shell", async (runtime) => {
    const { rigId, nodeIds, session } = seedPreservedShell(runtime);
    const before = sessionRegistry.getBindingForNode(nodeIds[0]!);
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.alreadyRunning).toEqual([]);
    expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "attention_required", error: expect.stringContaining("Session alive, agent not running") })]);
    expect(result.launched![0].error).toContain(session.sessionName);
    expect(result.launched![0].error).toContain("restart the agent");
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(sessionRegistry.getBindingForNode(nodeIds[0]!)).toEqual(before);
    expect(sessionRegistry.getSessionsForRig(rigId).find(s => s.id === session.id)?.status).toBe("running");
  });

  it.each([
    ["a resumable saved session", { restorePolicy: "resume_if_possible", resumeType: "claude_id", resumeToken: "token-1" }, "launch resumes from that snapshot's resume token"],
    ["a relaunch_fresh policy", { restorePolicy: "relaunch_fresh", resumeType: "claude_id", resumeToken: "token-1" }, "restore policy 'relaunch_fresh', so launch would start a fresh conversation"],
    ["a missing resume token", { restorePolicy: "resume_if_possible", resumeType: "claude_id", resumeToken: null }, "has no resume token for this seat, so launch would start nothing and ask for a decision"],
  ])("with %s, says what stopping and launching would actually do", async (saved, fields, says) => {
    const { rigId, session, snapshotId } = seedPreservedShell();
    setSavedSession(snapshotId, fields);
    const error = (await orchestrator.launchNodeSubset(rigId, ["dev.driver"])).launched![0].error!;
    expect(error).toContain(says);
    const resumable = saved === "a resumable saved session";
    // The resume route is offered only when it can resume, and it pins the snapshot that was checked.
    expect(error.includes(`rig seat stop ${session.sessionName} --reason`)).toBe(resumable);
    expect(error.includes(`rig launch ${rigId} dev.driver --snapshot-id ${snapshotId}`)).toBe(resumable);
    if (!resumable) expect(error).toContain(`launching from snapshot ${snapshotId} won't resume this conversation`);
    // The fresh route and the pane by hand are always there.
    expect(error).toContain(`rig seat launch ${session.sessionName} --fresh --stop --reason`);
    expect(error).toContain(`attach to tmux session '${session.sessionName}'`);
  });

  it.each(["subset", "single-seat"])("%s launch leaves an agent starting between the two samples running, not told to restart", async (route) => {
    const { rigId } = seedPreservedShell();
    const startedAt = "Fri Oct 9 07:00:01 2026";
    // The first sample is the idle shell; by the second, a foreground wrapper has taken the terminal.
    listProcesses.mockResolvedValueOnce([...processes]).mockResolvedValue([
      { ...processes[0]!, tpgid: 12 },
      { pid: 12, ppid: 10, pgid: 12, tpgid: 12, command: "bash ./start-agent.sh", executableName: "bash", startedAt },
    ]);
    const result = route === "subset"
      ? await orchestrator.launchNodeSubset(rigId, ["dev.driver"])
      : await orchestrator.launchSingleNode(rigId, "dev.driver");
    expect(result.alreadyRunning).toHaveLength(1);
    expect(result.launched ?? []).toEqual([]);
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("does not read a bound pane that no longer belongs to the session", async () => {
    const { rigId } = seedPreservedShell();
    tmux.listPanes.mockResolvedValue([{ id: "%7", index: 0, cwd: "/", width: 80, height: 24, active: true }] as never);
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("#1822 automatic carry idle-shell advice does not pin an explicit snapshot", async () => {
    const { rigId, session } = seedPreservedShell();
    sessionRegistry.updateResumeToken(session.id, "claude_id", "idle-conversation");
    const capture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore: new CheckpointStore(db) });
    capture.captureSnapshot(rigId, "auto-pre-down");
    sessionRegistry.updateStatus(session.id, "exited");
    const periodic = capture.captureSnapshot(rigId, "auto-periodic");
    sessionRegistry.updateStatus(session.id, "running"); // preserved shell, not a live agent
    const automatic = await orchestrator.launchSingleNode(rigId, "dev.driver");
    const advice = automatic.launched?.[0]?.error;
    expect(advice).toContain("To retry automatic resume:");
    expect(advice).toContain(`then rig launch ${rigId} dev.driver (`);
    expect(advice).toContain("reselects the latest usable snapshot");
    expect(advice).not.toContain("--snapshot-id");
    const explicit = await orchestrator.launchSingleNode(rigId, "dev.driver", { snapshotId: periodic.id });
    expect(explicit.launched?.[0]?.error).toContain("start nothing and ask for a decision");
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("single-seat launch also reports the stopped agent", async () => {
    const { rigId } = seedPreservedShell();
    const result = await orchestrator.launchSingleNode(rigId, "dev.driver");
    expect(result.alreadyRunning).toEqual([]);
    expect(result.launched![0].error).toContain("Session alive, agent not running");
    expect(result.nonTargetEffects).toEqual({ mode: "unchanged", reason: null, affected: [] });
  });

  it("preserves a live child behind a shell wrapper", async () => {
    const { rigId } = seedPreservedShell();
    processes.push({ pid: 11, ppid: 10, pgid: 10, tpgid: 10, command: "node agent.js", executableName: "node", startedAt: "Fri Oct 9 07:00:01 2026" });
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(result.launched).toEqual([]);
  });

  it("does not classify an intentional terminal shell as an exited agent", async () => {
    const { rigId } = seedPreservedShell("terminal");
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("does not replace a live session when process inspection fails", async () => {
    const { rigId } = seedPreservedShell();
    listProcesses.mockRejectedValue(new Error("ps unavailable"));
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it("uses the current terminal runtime even when the selected snapshot named an agent", async () => {
    const { rigId, nodeIds } = seedPreservedShell();
    db.prepare("UPDATE nodes SET runtime = 'terminal' WHERE id = ?").run(nodeIds[0]);
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("keeps a newly resumed foreground agent running", async () => {
    const { rigId } = seedPreservedShell();
    tmux.getPaneCommand.mockResolvedValueOnce("bash" as never).mockResolvedValue("claude" as never);
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(result.launched).toEqual([]);
  });

  it("does not emit node.held for running non-targets", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-guard@test-rig");

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all();
    expect(events).toHaveLength(0);
  });

  it("does not emit restore.subset_completed when no targets launched", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-driver@test-rig");

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type FROM events WHERE type = 'restore.subset_completed'").all();
    expect(events).toHaveLength(0);
  });

  // OPR.0.4.3.28 correction — INVERT fail-closed-on-unknown for launch liveness. A tmux
  // probe error is NOT positive evidence of a live seat (only a TRUE hasSession is). Was:
  // failedTargets + hard 503. Now: PROCEED to launch + surface a non-blocking
  // liveness_probe_unknown warning so an operator can verify no live seat was squatted.
  it("proceed-on-unknown: tmux probe error LAUNCHES the node with a liveness warning (not failedTargets)", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockRejectedValue(new Error("tmux unavailable"));

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.failedTargets ?? []).toHaveLength(0);
    expect(result.warnings?.some((w) => w.includes("liveness_probe_unknown") && w.includes("dev.driver"))).toBe(true);
  });

  // B1 regression: non-target with tmux probe error does NOT get node.held
  // Multi-target success: both targets launched, restore.subset_completed contains both
  it("launches multiple targets in one call with restore.subset_completed containing both", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver", "dev.guard"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(2);
    const launchedIds = result.launched!.map((n) => n.logicalId).sort();
    expect(launchedIds).toEqual(["dev.driver", "dev.guard"]);
    expect(result.held).toHaveLength(0);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.subset_completed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    const eventNodeIds = payload.result.nodes.map((n: { logicalId: string }) => n.logicalId).sort();
    expect(eventNodeIds).toEqual(["dev.driver", "dev.guard"]);
  });

  it("does not emit node.held for non-target with tmux probe error (fail-closed)", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => {
      if (name === "dev-guard@test-rig") throw new Error("tmux unavailable");
      return false;
    });

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all();
    expect(events).toHaveLength(0);
  });

  // B1 regression: mixed valid/invalid seats reports unmatchedIds
  it("reports unmatchedIds for seats that do not match any node", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver", "typo.seat"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.unmatchedIds).toEqual(["typo.seat"]);
  });

  // B4 regression: stale non-target DB-running sessions marked detached so inventory projects heldReason
  it("marks stale non-target DB-running sessions detached before emitting node.held", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // tmux says guard is dead
    tmux.hasSession.mockResolvedValue(false);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    // Session should now be detached, not running
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string };
    expect(row.status).toBe("detached");
    // And node.held should be emitted
    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).logicalId).toBe("dev.guard");
  });

  describe("keeping the seat's pane (a running seat relaunched in place)", () => {
    function liveDriver(rigId: string, nodeId: string, pane = "%7") {
      const live = sessionRegistry.registerSession(nodeId, "dev-driver@test-rig");
      sessionRegistry.updateStatus(live.id, "running");
      sessionRegistry.updateBinding(nodeId, { tmuxSession: "dev-driver@test-rig", tmuxPane: pane });
      Object.assign(tmux, {
        hasSession: vi.fn(async () => true),
        listPanes: vi.fn(async () => [{ id: "%7", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
        setRemainOnExit: vi.fn(async () => ({ ok: true as const })),
        signalPaneProcess: vi.fn(async () => ({ ok: true as const })),
        isPaneDead: vi.fn(async () => true),
        getDefaultShell: vi.fn(async () => "/bin/zsh"),
        respawnPane: vi.fn(async () => ({ ok: true as const })),
      });
      return live;
    }

    it("ends the seat's process in its own pane and starts a shell there, with no new session, then launches it there", async () => {
      const { rigId, nodeIds } = seedPodAwareRig();
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      const live = liveDriver(rigId, nodeIds[0]!);
      const adapter = readyAdapter("claude-code");
      // Without it, a running seat is left alone.
      expect((await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter } })).alreadyRunning)
        .toEqual([expect.objectContaining({ logicalId: "dev.driver" })]);
      expect(adapter.launchHarness).not.toHaveBeenCalled();

      const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter }, keepPane: true });
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "fresh-primed" })]);
      expect(tmux.createSession).not.toHaveBeenCalled();
      expect(tmux.killSession).not.toHaveBeenCalled();
      expect((tmux as any).signalPaneProcess).toHaveBeenCalledWith("%7", "TERM");
      expect((tmux as any).respawnPane).toHaveBeenCalledWith("%7", "/bin/zsh", expect.objectContaining({
        env: expect.objectContaining({ OPENRIG_NODE_ID: nodeIds[0], OPENRIG_SESSION_NAME: "dev-driver@test-rig" }) }));
      expect(adapter.launchHarness).toHaveBeenCalledOnce();
      expect(sessionRegistry.getBindingForNode(nodeIds[0]!)).toMatchObject({ tmuxSession: "dev-driver@test-rig", tmuxPane: "%7" });
      expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(live.id)).toEqual({ status: "superseded" });
    });

    it("launches a kept running effort in place of the saved one, without saving it as the seat's choice", async () => {
      const { rigId, nodeIds } = seedPodAwareRig();
      db.prepare("UPDATE nodes SET effort = 'low' WHERE id = ?").run(nodeIds[0]);
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      liveDriver(rigId, nodeIds[0]!);
      const adapter = readyAdapter("claude-code");
      const onLaunchEffort = vi.fn();
      const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter }, keepPane: true, keepEffort: "high", onLaunchEffort });
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "fresh-primed" })]);
      expect(adapter.launchHarness).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }), expect.anything());
      expect(onLaunchEffort).toHaveBeenCalledWith({ effort: "high", source: "kept" });
      expect(db.prepare("SELECT effort, effort_choice FROM nodes WHERE id = ?").get(nodeIds[0])).toEqual({ effort: "low", effort_choice: null });
    });

    it("an explicit effort choice saved after the switch read the seat, during the relaunch's own awaits, wins over the kept effort, and says so", async () => {
      const { rigId, nodeIds } = seedPodAwareRig();
      db.prepare("UPDATE nodes SET effort = 'low' WHERE id = ?").run(nodeIds[0]);
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      liveDriver(rigId, nodeIds[0]!);
      // The choice lands while the relaunch is respawning the pane: after the switch read "no choice", before the launch.
      (tmux as any).respawnPane = vi.fn(async () => {
        db.prepare("UPDATE nodes SET effort_choice = 'medium' WHERE id = ?").run(nodeIds[0]);
        return { ok: true as const };
      });
      const adapter = readyAdapter("claude-code");
      const onLaunchEffort = vi.fn();
      const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter }, keepPane: true, keepEffort: "high", onLaunchEffort });
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "fresh-primed" })]);
      expect(adapter.launchHarness).toHaveBeenCalledWith(expect.objectContaining({ effort: "medium" }), expect.anything());
      expect(onLaunchEffort).toHaveBeenCalledWith({ effort: "medium", source: "seat_choice" });
      expect(db.prepare("SELECT effort, effort_choice FROM nodes WHERE id = ?").get(nodeIds[0])).toEqual({ effort: "low", effort_choice: "medium" });
    });

    it("reports the effort a relaunch without a kept effort selected: a newer explicit choice saved during its awaits", async () => {
      const { rigId, nodeIds } = seedPodAwareRig();
      db.prepare("UPDATE nodes SET effort = 'low', effort_choice = 'low' WHERE id = ?").run(nodeIds[0]);
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      liveDriver(rigId, nodeIds[0]!);
      (tmux as any).respawnPane = vi.fn(async () => {
        db.prepare("UPDATE nodes SET effort_choice = 'medium' WHERE id = ?").run(nodeIds[0]);
        return { ok: true as const };
      });
      const adapter = readyAdapter("claude-code");
      const onLaunchEffort = vi.fn();
      await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter }, keepPane: true, onLaunchEffort });
      expect(adapter.launchHarness).toHaveBeenCalledWith(expect.objectContaining({ effort: "medium" }), expect.anything());
      expect(onLaunchEffort).toHaveBeenCalledWith({ effort: "medium", source: "seat_choice" });
    });

    it("a pane that isn't in the seat's session is left alone, and the seat's records are put back", async () => {
      const { rigId, nodeIds } = seedPodAwareRig();
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      const live = liveDriver(rigId, nodeIds[0]!, "%8");
      const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": readyAdapter("claude-code") }, keepPane: true });
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "failed", error: expect.stringContaining("nothing was stopped") })]);
      expect((tmux as any).signalPaneProcess).not.toHaveBeenCalled();
      expect((tmux as any).respawnPane).not.toHaveBeenCalled();
      expect(sessionRegistry.getBindingForNode(nodeIds[0]!)).toMatchObject({ tmuxSession: "dev-driver@test-rig", tmuxPane: "%8" });
      expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(live.id)).toEqual({ status: "running" });
    });

    it("carries the running Claude executable through takeover to the continuation", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-executable-"));
      try {
        const executable = path.join(root, "claude");
        fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const { rigId, nodeIds } = seedPodAwareRig();
        seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
        liveDriver(rigId, nodeIds[0]!);
        tmux.getPanePid.mockResolvedValue(10 as never);
        processes = [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, command: `${executable} --session-id original`,
          executableName: "claude", startedAt: "Fri Oct 9 07:00:00 2026" }];
        const adapter = readyAdapter("claude-code");
        (tmux as any).signalPaneProcess.mockImplementation(async () => { processes = []; return { ok: true }; });
        await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter }, keepPane: true });
        expect(adapter.launchHarness).toHaveBeenCalledWith(expect.objectContaining({ claudeExecutable: fs.realpathSync(executable) }), expect.anything());
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it.skipIf(!["darwin", "linux"].includes(process.platform))("provider takeover captures launch before stopping and passes it transiently to the adapter", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-capture-"));
      const executable = path.join(root, "claude"), script = path.join(root, "owned-child.cjs");
      fs.writeFileSync(executable, '#!/bin/sh\nprintf "  --settings <file>  Settings\\n  --model <model>  Model\\n  --resume <id>  Resume\\n"\n', { mode: 0o755 });
      fs.writeFileSync(script, 'console.log("ready");setInterval(()=>{},1000)');
      const child = spawn(process.execPath, [script, "--settings", "/custom rules.json", "--model", "opus"], {
        env: { PATH: process.env.PATH!, HOME: root, CLAUDE_CONFIG_DIR: "/custom config", CUSTOM_SETTING: "transient-only" }, stdio: ["ignore", "pipe", "ignore"],
      });
      try {
        await once(child.stdout!, "data");
        const { rigId, nodeIds } = seedPodAwareRig();
        seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
        liveDriver(rigId, nodeIds[0]!);
        (tmux as any).differingSessionEnv = vi.fn(async () => ["CUSTOM_SETTING"]);
        tmux.getPanePid.mockResolvedValue(child.pid! as never);
        // Pane/lineage is simulated; argv/environment are read from this real owned child.
        processes = [{ pid: child.pid!, ppid: process.pid, pgid: child.pid!, tpgid: child.pid!, command: `${executable} --session-id original`, executableName: "claude", startedAt: "Fri Oct 9 07:00:00 2026" }];
        const adapter = readyAdapter("claude-code");
        (tmux as any).signalPaneProcess.mockImplementation(async () => { processes = []; return { ok: true }; });
        const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter }, keepPane: true, keepClaudeLaunch: true });
        expect(adapter.launchHarness).toHaveBeenCalledWith(expect.objectContaining({ claudeLaunch: expect.objectContaining({
          args: ["--settings", "/custom rules.json", "--model", "opus"], configDir: "/custom config",
        }) }), expect.anything());
        expect(result.warnings?.join(" ")).toContain("Kept mapped running Claude options");
        expect(JSON.stringify(result)).not.toContain("transient-only");
        expect(JSON.stringify(db.prepare("SELECT * FROM snapshots").all())).not.toContain("transient-only");
      } finally { child.kill("SIGTERM"); await once(child, "close"); fs.rmSync(root, { recursive: true, force: true }); }
    }, 15_000);

    it("keeps a seat's Claude MCP opt-out beside the retained executable on the continuation", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-executable-"));
      try {
        const executable = path.join(root, "claude");
        fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const { rigId, nodeIds } = seedPodAwareRig();
        db.prepare("UPDATE nodes SET claude_mcp = 'none' WHERE id = ?").run(nodeIds[0]!);
        seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
        liveDriver(rigId, nodeIds[0]!);
        tmux.getPanePid.mockResolvedValue(10 as never);
        processes = [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, command: `${executable} --session-id original`,
          executableName: "claude", startedAt: "Fri Oct 9 07:00:00 2026" }];
        const adapter = readyAdapter("claude-code");
        (tmux as any).signalPaneProcess.mockImplementation(async () => { processes = []; return { ok: true }; });
        await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": adapter }, keepPane: true });
        expect(adapter.launchHarness).toHaveBeenCalledWith(expect.objectContaining({ claudeExecutable: fs.realpathSync(executable), claudeMcp: "none" }), expect.anything());
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it("a process that won't end isn't replaced: no shell is started over it", async () => {
      const { rigId, nodeIds } = seedPodAwareRig();
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      liveDriver(rigId, nodeIds[0]!);
      Object.assign(tmux, { isPaneDead: vi.fn(async () => false) });
      const fastLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux as any,
        paneExit: { pollMs: 1, timeoutMs: 2, sleep: async () => {} } });
      (orchestrator as any).nodeLauncher = fastLauncher;
      const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": readyAdapter("claude-code") }, keepPane: true });
      expect(result.launched).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("did not exit") })]);
      // TERM and KILL were sent, and a death probe that keeps failing looks exactly like this: the process may have ended,
      // so the result doesn't claim nothing was stopped.
      expect(result.launched![0]).not.toHaveProperty("nothingStopped");
      expect((tmux as any).signalPaneProcess).toHaveBeenCalledWith("%7", "KILL");
      expect((tmux as any).respawnPane).not.toHaveBeenCalled();
    });

    it("a pane that isn't in the session is left alone, and the result says nothing was stopped", async () => {
      const { rigId, nodeIds } = seedPodAwareRig();
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      liveDriver(rigId, nodeIds[0]!);
      Object.assign(tmux, { listPanes: vi.fn(async () => [{ id: "%8", index: 0, cwd: "/", width: 80, height: 24, active: true }]) });
      const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": readyAdapter("claude-code") }, keepPane: true });
      expect(result.launched).toEqual([expect.objectContaining({ status: "failed", nothingStopped: true, error: expect.stringContaining("nothing was stopped") })]);
      expect((tmux as any).signalPaneProcess).not.toHaveBeenCalled();
    });

    it("the takeover keeps its guarded seat target when another binding retains the same pane id", async () => {
      // The guard's own tables, as a daemon's database has them.
      db.close();
      const full = createDb();
      migrate(full, ALL_MIGRATIONS);
      setup(full);
      const { rigId, nodeIds } = seedPodAwareRig();
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      liveDriver(rigId, nodeIds[0]!);
      const peer = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
      sessionRegistry.updateStatus(peer.id, "running");
      sessionRegistry.updateBinding(nodeIds[1]!, { tmuxSession: "dev-guard@test-rig", tmuxPane: "%7" });
      expect(resolveGuardTarget(db, "%7")).toBeNull();
      // The real adapter's signal and respawn, behind the real guard, as a daemon wires them. Only the shell is a fake.
      const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
      const commands: string[] = [];
      const configs: string[] = [];
      const real = new TmuxAdapter(async (command) => { commands.push(command); return ""; }, {
        writeFile: async (_path, content) => { configs.push(content); }, unlink: async () => {},
        tmpName: () => "/inert/respawn", bufferName: () => "fixture",
      });
      real.deliveryGuard = guard;
      real.listPanes = tmux.listPanes as any;
      real.getPanePid = async () => 4242;
      Object.assign(tmux, {
        deliveryGuard: guard,
        signalPaneProcess: vi.fn((pane: string, signal: "TERM" | "KILL") => real.signalPaneProcess(pane, signal)),
        respawnPane: vi.fn((pane: string, command?: string, opts?: { cwd?: string; env?: Record<string, string> }) => real.respawnPane(pane, command, opts)),
      });

      // The switch holds the seat's lifecycle lease around the relaunch.
      const result = await guard.lifecycle([nodeIds[0]!], () =>
        orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": readyAdapter("claude-code") }, keepPane: true }));
      expect(await (tmux as any).signalPaneProcess.mock.results[0].value).toEqual({ ok: true });
      expect(await (tmux as any).respawnPane.mock.results[0].value).toMatchObject({ ok: true });
      expect(commands).toContain("kill -TERM 4242");
      expect(configs).toEqual([expect.stringMatching(/^respawn-pane -t \S*%7/)]);
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "fresh-primed" })]);
      expect(sessionRegistry.getBindingForNode(nodeIds[0]!)).toMatchObject({ tmuxSession: "dev-driver@test-rig", tmuxPane: "%7" });
      expect(sessionRegistry.getBindingForNode(nodeIds[1]!)).toMatchObject({ tmuxSession: "dev-guard@test-rig", tmuxPane: "%7" });
    });

    it("a failed registration after the pane was restarted leaves the person's session alone", async () => {
      const { rigId, nodeIds } = seedPodAwareRig();
      seedSnapshot(rigId, nodeIds, { [nodeIds[0]!]: emptyStartupContext("claude-code") });
      liveDriver(rigId, nodeIds[0]!);
      const persist = eventBus.persistWithinTransaction.bind(eventBus);
      let failed = false;
      vi.spyOn(eventBus, "persistWithinTransaction").mockImplementation((event) => {
        if (event.type === "node.launched" && !failed) { failed = true; throw new Error("synthetic DB commit failure"); }
        return persist(event);
      });
      const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { adapters: { "claude-code": readyAdapter("claude-code") }, keepPane: true });
      expect((tmux as any).respawnPane).toHaveBeenCalledOnce();
      expect(tmux.killSession).not.toHaveBeenCalled();
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "failed", error: expect.stringContaining("synthetic DB commit failure") })]);
    });
  });

  // A never-started pod-aware seat on `rig launch --seats`: no startup context and no native resume, so the restore shell
  // is retired and the seat goes to the persisted fresh launcher, all under the subset's lifecycle lease.
  describe("a never-started seat, behind the real delivery guard", () => {
    function guarded() {
      // The guard's own tables, as a daemon's database has them.
      db.close();
      const full = createDb();
      migrate(full, ALL_MIGRATIONS);
      setup(full);
      const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
      Object.assign(tmux, { deliveryGuard: guard, killSession: vi.fn(async () => ({ ok: true as const })) });
      const { rigId, nodeIds } = seedPodAwareRig();
      const snapshotId = seedSnapshot(rigId, nodeIds);
      const launcher = (orchestrator as any).nodeLauncher as NodeLauncher;
      // The persisted fresh launcher reaches NodeLauncher with the node's recorded identity and canonical session name, as
      // launchPersistedFresh does.
      const launchFresh = async (rid: string, nid: string) => {
        const node = rigRepo.getRig(rid)!.nodes.find((candidate) => candidate.id === nid)!;
        const launched = await launcher.launchNode(rid, node.logicalId, { sessionName: "dev-driver@test-rig" });
        return launched.ok ? { status: "launched" as const } : { status: "failed" as const, error: launched.message };
      };
      const freshLaunch = vi.fn(launchFresh);
      (orchestrator as any).freshLaunch = freshLaunch;
      const launch = () => orchestrator.launchNodeSubset(rigId, ["dev.driver"], { snapshotId, adapters: { "claude-code": readyAdapter("claude-code") } as any });
      return { rigId, nodeIds, freshLaunch, launchFresh, launch };
    }

    it("starts: retiring the provisional shell rebinds the lease, so the persisted fresh launch owns the seat", async () => {
      const { rigId, nodeIds, freshLaunch, launch } = guarded();
      const result = await launch();
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "fresh-primed" })]);
      expect(freshLaunch).toHaveBeenCalledWith(rigId, nodeIds[0]);
      expect(tmux.killSession).toHaveBeenCalledOnce();
      expect(tmux.createSession).toHaveBeenCalledTimes(2);
      const sessions = sessionRegistry.getSessionsForRig(rigId).filter((session) => session.nodeId === nodeIds[0]);
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((session) => session.status === "superseded")).toHaveLength(1);
      expect(sessionRegistry.getBindingForNode(nodeIds[0]!)).toMatchObject({ tmuxSession: "dev-driver@test-rig" });
    });

    it("refuses when another operation rebinds the seat while the provisional shell is being stopped, and keeps that binding", async () => {
      const { nodeIds, freshLaunch, launch } = guarded();
      Object.assign(tmux, { killSession: vi.fn(async () => {
        sessionRegistry.updateBinding(nodeIds[0]!, { tmuxSession: "dev-driver@test-rig", tmuxPane: "%9" });
        return { ok: true as const };
      }) });
      const result = await launch();
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "attention_required",
        error: expect.stringContaining("Input target/occupant changed") })]);
      expect(freshLaunch).not.toHaveBeenCalled();
      expect(sessionRegistry.getBindingForNode(nodeIds[0]!)).toMatchObject({ tmuxPane: "%9" });
    });

    it("refuses a replacement that lands after the rebind, before the fresh launch writes anything", async () => {
      const { launchFresh, launch } = guarded();
      (orchestrator as any).freshLaunch = vi.fn(async (rid: string, nid: string) => {
        sessionRegistry.updateBinding(nid, { tmuxSession: "dev-driver@test-rig", tmuxPane: "%9" });
        return launchFresh(rid, nid);
      });
      const result = await launch();
      expect(result.launched).toEqual([expect.objectContaining({ logicalId: "dev.driver", status: "failed",
        error: expect.stringContaining("Input target/occupant changed") })]);
      expect(tmux.createSession).toHaveBeenCalledOnce();
    });
  });
});
