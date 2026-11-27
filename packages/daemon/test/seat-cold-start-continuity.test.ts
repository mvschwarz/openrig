// #2829 slice 1 — continuity proof on the Pi path (maintainer term 3).
//
// Cold start goes through the ordinary single-seat launch door, so it inherits the
// door's continuity decision instead of inventing one:
//   - a `resume_if_possible` seat with a Pi session-file token RESUMES that exact file
//     (Pi's honest session-file continuation) and the queued rows are still there to be
//     delivered once the seat is observed running;
//   - a seat whose conversation cannot be resumed PARKS as `awaiting-decision` with zero
//     sessions started — it is never silently replaced by a fresh conversation.
//
// These tests drive the real RestoreOrchestrator.launchSingleNode over a real migrated
// database and a real captured snapshot; only tmux and the Pi resume adapter are fakes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import { SeatColdStarter } from "../src/domain/seat-cold-start.js";
import { QueueRepository as QueueRepo } from "../src/domain/queue-repository.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import type { RigSpec } from "../src/domain/types.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { QueueTransferStaging } from "../src/domain/queue-transfer-staging.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { readStandbyStop } from "../src/domain/seat-standby.js";

const RIG = "pi-continuity";
const SEAT_SESSION = "dev-impl@pi-continuity";
const PEER_SESSION = "dev-rev@pi-continuity";
const SESSION_FILE = "/home/pi/.pi/sessions/conv-42.jsonl";

function tmuxWithLivePeer(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "pi"),
    getPanePid: vi.fn(async () => 1234),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }],
    // Only the peer is live; the cold-start target's session is gone.
    probeSession: async (name: string) => ({ state: name === PEER_SESSION ? "present" : "absent" }),
  } as unknown as TmuxAdapter;
}

function recipeWithColdStart(): { rigSpec: RigSpec } {
  return {
    rigSpec: {
      version: "0.2",
      name: RIG,
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "pi", cwd: ".", coldStart: true }],
        edges: [],
      }],
      edges: [],
    } as RigSpec,
  };
}

describe("cold start continuity on the Pi path (#2829 slice 1)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let snapshotCapture: SnapshotCapture;
  let rigId: string;
  let implNodeId: string;
  let implSessionIdValue: string;
  let deliveryGuard: SeatDeliveryGuard;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    deliveryGuard = new SeatDeliveryGuard(db, target => resolveGuardTarget(db, target));
    snapshotRepo = new SnapshotRepository(db);
    snapshotCapture = new SnapshotCapture({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore: new CheckpointStore(db),
    });

    const rig = rigRepo.createRig(RIG);
    rigId = rig.id;
    const impl = rigRepo.addNode(rig.id, "dev.impl", { runtime: "pi", cwd: "./" });
    implNodeId = impl.id;
    const peer = rigRepo.addNode(rig.id, "dev.rev", { runtime: "pi", cwd: "./" });
    const implSession = sessionRegistry.registerSession(impl.id, SEAT_SESSION);
    sessionRegistry.updateStatus(implSession.id, "running");
    const peerSession = sessionRegistry.registerSession(peer.id, PEER_SESSION);
    sessionRegistry.updateStatus(peerSession.id, "running");
    implSessionIdValue = implSession.id;
  });

  afterEach(() => {
    db.close();
  });

  function implSessionId(): string {
    return implSessionIdValue;
  }

  /** A real snapshot of the running rig, then the seat goes away (crash / reaper stop). */
  function captureThenStopSeat(): void {
    snapshotCapture.captureSnapshot(rigId, "manual");
    sessionRegistry.updateStatus(implSessionId(), "exited");
  }

  function orchestratorWith(pi: PiResumeAdapter, tmux: TmuxAdapter = tmuxWithLivePeer()): RestoreOrchestrator {
    tmux.deliveryGuard = deliveryGuard;
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore: new CheckpointStore(db),
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume: { canResume: () => false, resume: vi.fn() } as never,
      codexResume: { canResume: () => false, resume: vi.fn() } as never,
      piResume: pi,
    });
  }

  function starterFor(orchestrator: RestoreOrchestrator): SeatColdStarter {
    const tmux = tmuxWithLivePeer();
    return new SeatColdStarter({
      db,
      deliveryGuard,
      launchSingleNode: (id, logicalId) => orchestrator.launchSingleNode(id, logicalId, { requireCurrentOccupant: true }),
      probeSession: name => tmux.probeSession(name),
      getNodeLaunchRecipe: () => recipeWithColdStart(),
      log: () => {},
    });
  }

  function ledger(): string | undefined {
    return (db.prepare("SELECT last_outcome FROM seat_cold_starts WHERE node_id = ?").get(implNodeId) as { last_outcome: string } | undefined)?.last_outcome;
  }

  function recordStandby() {
    const sessionId = implSessionId();
    const identity = "$1|42|100|%1";
    sessionRegistry.updateResumeToken(sessionId, "pi_session_file", SESSION_FILE);
    sessionRegistry.markIntentionallyStopped(sessionId);
    sessionRegistry.updateBinding(implNodeId, { attachmentType: "tmux", tmuxSession: SEAT_SESSION, tmuxPane: "%1" });
    eventBus.emit({ type: "session.stopped", rigId, nodeId: implNodeId, sessionId, sessionName: SEAT_SESSION,
      operator: "daemon:seat-reaper", reason: "idle_reap", standbyPane: identity });
    const standby = readStandbyStop(db, implNodeId);
    if (!standby) throw new Error("fixture did not record standby");
    return standby;
  }

  it.each(["rig down", "rig seat stop"])("does not wake a standby seat after %s", async stop => {
    recordStandby();
    expect(readStandbyStop(db, implNodeId)).not.toBeNull();
    const tmux = tmuxWithLivePeer();
    tmux.deliveryGuard = deliveryGuard;
    const present = new Set([SEAT_SESSION, PEER_SESSION]);
    tmux.probeSession = async name => ({ state: present.has(name) ? "present" : "absent" });
    tmux.killSession = async name => { present.delete(name); return { ok: true }; };
    const deps = { db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux };
    if (stop === "rig down") {
      const teardown = new RigTeardownOrchestrator({ ...deps, snapshotCapture });
      expect(await teardown.teardown(rigId, { force: true })).toMatchObject({ errors: [], sessionsKilled: 2 });
    } else {
      expect(await new SeatLifecycleService(deps).stopSeat({ seatRef: SEAT_SESSION, reason: "stay off" })).toMatchObject({ ok: true });
      expect(present.has(PEER_SESSION)).toBe(true);
    }
    expect(readStandbyStop(db, implNodeId)).toBeNull();

    const launch = vi.fn(async () => ({ ok: false }));
    const cold = new SeatColdStarter({ db, deliveryGuard, probeSession: tmux.probeSession,
      getNodeLaunchRecipe: recipeWithColdStart, launchSingleNode: launch });
    const transport = { deliveryTarget: (name: string) => resolveGuardTarget(db, name),
      send: async () => ({ ok: false as const, sent: false, error: "no receiver" }) };
    const queue = new QueueRepo(db, eventBus, { transport });
    queue.attachOutbox(new OutboxHandler(db));
    queue.attachStandbyWake(cold.wakeStandby.bind(cold));
    const row = await queue.create({ sourceSession: "operator@external", destinationSession: SEAT_SESSION, body: "work" });
    await queue.drainPendingWakeIntents();

    expect(queue.getById(row.qitemId)?.state).toBe("pending");
    expect(launch).not.toHaveBeenCalled();
    expect(ledger()).toBeUndefined();
  });

  it("records the restore attempt when standby resume needs attention", async () => {
    const standby = recordStandby();
    const tmux = tmuxWithLivePeer();
    tmux.getDefaultShell = async () => "/bin/sh";
    tmux.standbyPaneIdentity = async () => standby.identity;
    tmux.respawnPane = async () => ({ ok: true });
    tmux.hasSession = async () => false;
    const resume = vi.fn<PiResumeAdapter["resume"]>(async () => ({ ok: false, code: "attention_required", message: "Needs operator" }));
    const restore = orchestratorWith({ canResume: () => true, resume } as PiResumeAdapter, tmux);

    const result = await deliveryGuard.lifecycle([implNodeId], () => restore.launchSingleNode(rigId, "dev.impl", { standby }));

    expect(result.launched).toEqual([expect.objectContaining({ nodeId: implNodeId, status: "attention_required" })]);
    expect(eventBus.replayAll(0)).toContainEqual(expect.objectContaining({ type: "restore.subset_completed", rigId,
      result: expect.objectContaining({ nodes: result.launched }) }));
    // The attempt is found, not missing: reconcile reads this standby resume rather than no attempt at all.
    expect((await restore.reconcileNodeRuntimeTruth(rigId, implNodeId)).code).not.toBe("no_attempt");
  });

  it.each(["create", "handoff", "park timer", "standalone reminder", "plain send", "stage-only import"] as const)("dispatches %s against a recorded standby seat", async trigger => {
    const standby = recordStandby();
    const tmux = tmuxWithLivePeer();
    tmux.probeSession = async name => ({ state: name === SEAT_SESSION ? "present" : "absent" });
    tmux.getDefaultShell = async () => "/bin/sh";
    tmux.standbyPaneIdentity = async () => standby.identity;
    tmux.respawnPane = vi.fn(async () => ({ ok: true as const }));
    const resume = vi.fn<PiResumeAdapter["resume"]>(async () => ({ ok: true }));
    const restore = orchestratorWith({ canResume: () => true, resume } as PiResumeAdapter, tmux);
    const cold = new SeatColdStarter({ db, deliveryGuard, probeSession: tmux.probeSession,
      getNodeLaunchRecipe: recipeWithColdStart, launchSingleNode: (id, logicalId, standby) => restore.launchSingleNode(id, logicalId, { standby }) });
    const outbox = new OutboxHandler(db);
    const deliveryTarget = (destination: string) => resolveGuardTarget(db, destination);
    const send = vi.fn(async (destination: string, _message: string, opts?: { committedOutboxIds?: string[] }) => {
      const current = deliveryTarget(destination);
      const matches = (opts?.committedOutboxIds ?? []).every(id =>
        JSON.stringify(outbox.getById(id)?.guardBinding) === JSON.stringify(current));
      return ledger() === "resumed" && matches ? { ok: true as const, verified: true }
        : { ok: false as const, sent: false, error: matches ? "no receiver" : "guard target changed" };
    });
    const queue = new QueueRepo(db, eventBus, { transport: { send, deliveryTarget } });
    queue.attachOutbox(outbox);
    const wake = cold.wakeStandby.bind(cold);
    queue.attachStandbyWake(wake);
    if (trigger === "plain send" || trigger === "stage-only import") {
      if (trigger === "plain send") {
        const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
        tmux.getPaneCommand = async () => null;
        await transport.send(SEAT_SESSION, "plain message");
      } else {
        const source = new Database(":memory:");
        try {
          migrate(source, ALL_MIGRATIONS);
          source.exec("INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled')");
          source.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
            VALUES ('qitem-staged', '1', '1', ?, ?, 'pending', 'staged work')`).run(PEER_SESSION, SEAT_SESSION);
          const archive = buildQueueTransfer(source, { kind: "host" }).archive;
          expect(new QueueTransferStaging(db).import(archive).stage?.status).toBe("staged");
        } finally { source.close(); }
        expect(queue.getById("qitem-staged")).toBeNull();
        expect((await queue.drainPendingWakeIntents()).delivered).toBe(0);
      }
      expect(ledger()).toBeUndefined();
      expect(resume).not.toHaveBeenCalled();
      expect(tmux.respawnPane).not.toHaveBeenCalled();
      return;
    } else if (trigger === "create") {
      const row = await queue.create({ sourceSession: PEER_SESSION, destinationSession: SEAT_SESSION, body: "new work" });
      await vi.waitFor(() => expect(queue.getById(row.qitemId)?.lastNudgeResult).toBe("verified"));
    } else if (trigger === "handoff") {
      const source = await queue.create({ sourceSession: "operator@external", destinationSession: PEER_SESSION, body: "handoff work", nudge: false });
      const { created } = await queue.handoff({ qitemId: source.qitemId, fromSession: PEER_SESSION, toSession: SEAT_SESSION });
      await vi.waitFor(() => expect(queue.getById(created.qitemId)?.lastNudgeResult).toBe("verified"));
      expect(send.mock.calls[0]).toEqual([SEAT_SESSION, expect.stringContaining(created.qitemId), expect.anything()]);
    } else {
      const deliver = makeWatchdogDeliver({ sessionTransport: { send }, wakeStandby: wake, outbox,
        resolveParkedRows: ({ jobId, targetSession }) => queue.parkedRowsOwnedBy(jobId, targetSession) });
      if (trigger === "standalone reminder") {
        await deliver({ targetSession: SEAT_SESSION, message: "plain reminder" }, { jobId: "unattached", policy: "periodic-reminder" });
        expect(resume).not.toHaveBeenCalled();
        expect(tmux.respawnPane).not.toHaveBeenCalled();
        return;
      }
      const row = await queue.create({ sourceSession: PEER_SESSION, destinationSession: SEAT_SESSION, body: "parked work", nudge: false });
      queue.update({ qitemId: row.qitemId, actorSession: SEAT_SESSION, state: "blocked", wakeAfterSeconds: 5 });
      const jobId = queue.getParkWakeStatus(row.qitemId)?.ref;
      if (!jobId) throw new Error("fixture did not arm a park timer");
      const jobs = new WatchdogJobsRepository(db);
      const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: new WatchdogHistoryLog(db), eventBus, deliver,
        onWakeAttempt: ({ jobId, deliveryStatus }) => queue.recordWatchdogWakeAttempt(jobId, deliveryStatus) });
      expect(await engine.evaluate(jobs.getByIdOrThrow(jobId))).toMatchObject({ delivery: { status: "ok" } });
      expect(queue.getParkWakeStatus(row.qitemId)).toMatchObject({ phase: "fired" });
      expect(send.mock.calls[0]?.[1]).toContain(row.qitemId);
    }
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.slice(1, 4)).toEqual(["pi_session_file", SESSION_FILE, "./"]);
    expect(sessionRegistry.getBindingForNode(implNodeId)?.tmuxPane).toBe("%1");
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it("resumes the seat's existing Pi conversation from its exact session file", async () => {
    sessionRegistry.updateResumeToken(implSessionId(), "pi_session_file", SESSION_FILE);
    db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE id = ?").run(implSessionId());
    captureThenStopSeat();

    const resume = vi.fn(async () => ({ ok: true as const }));
    const pi = { canResume: vi.fn(() => true), resume } as unknown as PiResumeAdapter;
    const starter = starterFor(orchestratorWith(pi));

    starter.notify(SEAT_SESSION);
    await vi.waitFor(() => expect(ledger()).toBe("resumed"));

    // The exact session file is the resume argument: Pi's honest continuation, never `--resume`.
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]!.slice(1, 4)).toEqual(["pi_session_file", SESSION_FILE, "./"]);
    // The seat is running again, and the earlier conversation's row is retained as history
    // (the resume continued it; nothing overwrote or discarded it).
    const newest = db.prepare("SELECT status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(implNodeId) as { status: string };
    expect(newest.status).toBe("running");
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id = ?").get(implNodeId) as { n: number }).n).toBe(2);
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(implSessionId())).toEqual({ status: "exited" });
    // The door reported a resume, not a fresh prime.
    const completed = JSON.parse((db.prepare("SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.subset_completed' ORDER BY seq DESC LIMIT 1")
      .get(rigId) as { payload: string }).payload) as { result: { nodes: Array<{ logicalId: string; status: string }> } };
    expect(completed.result.nodes.find(node => node.logicalId === "dev.impl")?.status).toBe("resumed");
  });

  it("parks an unresumable conversation as awaiting-decision and starts nothing", async () => {
    // A session row exists but no resume token was captured: the door must ask, not replace.
    db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE id = ?").run(implSessionId());
    captureThenStopSeat();
    const sessionsBefore = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

    const resume = vi.fn(async () => ({ ok: true as const }));
    const pi = { canResume: vi.fn(() => true), resume } as unknown as PiResumeAdapter;
    const starter = starterFor(orchestratorWith(pi));

    starter.notify(SEAT_SESSION);
    await vi.waitFor(() => expect(ledger()?.startsWith("awaiting_decision")).toBe(true));

    expect(resume).not.toHaveBeenCalled();
    // Zero sessions started: the old conversation's row is untouched and nothing replaced it.
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(sessionsBefore);
    expect(db.prepare("SELECT status FROM sessions WHERE id = ?").get(implSessionId())).toEqual({ status: "exited" });
  });

  it("leaves queued work owed across a cold start so the existing retry can deliver it", async () => {
    sessionRegistry.updateResumeToken(implSessionId(), "pi_session_file", SESSION_FILE);
    db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE id = ?").run(implSessionId());
    captureThenStopSeat();

    const queue = new QueueRepo(db, eventBus, {});
    const created = await queue.create({ sourceSession: "dev.rev@pi-continuity", destinationSession: SEAT_SESSION, body: "work waiting for the seat" });
    const before = db.prepare("SELECT state, destination_session FROM queue_items WHERE qitem_id = ?").get(created.qitemId);

    const pi = { canResume: vi.fn(() => true), resume: vi.fn(async () => ({ ok: true as const })) } as unknown as PiResumeAdapter;
    const starter = starterFor(orchestratorWith(pi));
    starter.notify(SEAT_SESSION);
    await vi.waitFor(() => expect(ledger()).toBe("resumed"));

    // Cold start only brings the seat up; the row stays pending, unchanged, for the queue's own pickup.
    expect(db.prepare("SELECT state, destination_session FROM queue_items WHERE qitem_id = ?").get(created.qitemId)).toEqual(before);
    expect((before as { state: string }).state).toBe("pending");
  });

  it("parks when the snapshot's occupant is older than the seat's current session (stale snapshot, R2)", async () => {
    // Conversation A is captured, then the seat runs a NEWER conversation B before going away.
    // Resuming A from the stale snapshot would silently replace B — the door must park instead.
    sessionRegistry.updateResumeToken(implSessionId(), "pi_session_file", SESSION_FILE);
    db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE id = ?").run(implSessionId());
    snapshotCapture.captureSnapshot(rigId, "manual");            // snapshot occupant = A
    sessionRegistry.updateStatus(implSessionId(), "exited");      // A ends
    const newer = sessionRegistry.registerSession(implNodeId, SEAT_SESSION);   // B, a newer id
    sessionRegistry.updateResumeToken(newer.id, "pi_session_file", "/home/pi/.pi/sessions/conv-99.jsonl");
    db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE id = ?").run(newer.id);
    sessionRegistry.updateStatus(newer.id, "exited");             // B ends too; seat dormant, latest = B
    const sessionsBefore = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

    const resume = vi.fn(async () => ({ ok: true as const }));
    const pi = { canResume: vi.fn(() => true), resume } as unknown as PiResumeAdapter;
    const starter = starterFor(orchestratorWith(pi));
    starter.notify(SEAT_SESSION);
    await vi.waitFor(() => expect(ledger()?.startsWith("awaiting_decision")).toBe(true));

    expect(resume).not.toHaveBeenCalled();
    expect((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(sessionsBefore);
  });

// #3173 review round 2 (repaired per round 3): the snapshot must NOT contain the target
// (the old fixture captured it running, which takes the resolved-occupant path instead),
// and the createSession spy must sit on the tmux instance the orchestrator actually uses.
it("parks when the seat ran after the snapshot and the snapshot records no occupant", async () => {
  // Snapshot before the seat's current session existed: only the peer is in it.
  db.prepare("DELETE FROM sessions WHERE node_id = ?").run(implNodeId);
  snapshotCapture.captureSnapshot(rigId, "manual");
  const later = sessionRegistry.registerSession(implNodeId, SEAT_SESSION);
  sessionRegistry.updateStatus(later.id, "exited"); // exited without intent → dormant, revivable
  const pi = { canResume: () => false, resume: vi.fn() } as unknown as PiResumeAdapter;
  const tmux = tmuxWithLivePeer();
  const createSession = tmux.createSession as ReturnType<typeof vi.fn>;
  const orchestrator = orchestratorWith(pi, tmux);
  const starter = starterFor(orchestrator);

  starter.notify(SEAT_SESSION);
  await vi.waitFor(() => expect(ledger()).toBeDefined());

  expect(ledger()).toContain("awaiting_decision");
  expect(pi.resume).not.toHaveBeenCalled();
  expect(createSession).not.toHaveBeenCalled();
});

// #3173 review round 3 (C): a snapshot that explicitly records the occupant absent while
// retaining the seat's resume_if_possible history with NO token used to fall through both
// guards to a fresh launch, replacing a conversation the seat had. It must park.
it("parks an explicitly-absent snapshot occupant that retains resume history without a token", async () => {
  // The seat ran under resume_if_possible but its capture carries no resume token.
  db.prepare("UPDATE sessions SET status = 'exited', restore_policy = 'resume_if_possible' WHERE node_id = ?").run(implNodeId);
  snapshotCapture.captureSnapshot(rigId, "manual");
  const pi = { canResume: () => false, resume: vi.fn() } as unknown as PiResumeAdapter;
  const tmux = tmuxWithLivePeer();
  const createSession = tmux.createSession as ReturnType<typeof vi.fn>;
  const orchestrator = orchestratorWith(pi, tmux);
  const starter = starterFor(orchestrator);

  starter.notify(SEAT_SESSION);
  await vi.waitFor(() => expect(ledger()).toBeDefined());

  expect(ledger()).toContain("awaiting_decision");
  expect(pi.resume).not.toHaveBeenCalled();
  expect(createSession).not.toHaveBeenCalled();
});

// #3173 review round 4 — the control for the C park: with periodic snapshots on, a seat
// that crashed before the periodic tick is recorded absent-occupant-with-history by the
// auto-periodic capture while KEEPING its token as the periodic resume source. That valid
// carry must not be parked by the C guard; the cold start resumes the exact conversation.
it("resumes a valid periodic carry instead of parking it", async () => {
  sessionRegistry.updateResumeToken(implSessionId(), "pi_session_file", SESSION_FILE);
  db.prepare("UPDATE sessions SET restore_policy = 'resume_if_possible' WHERE id = ?").run(implSessionId());
  snapshotCapture.captureSnapshot(rigId, "auto-pre-down");
  sessionRegistry.updateStatus(implSessionId(), "exited"); // crashed before the periodic tick
  snapshotCapture.captureSnapshot(rigId, "auto-periodic"); // occupant absent, token carried
  const resume = vi.fn(async () => ({ ok: true as const }));
  const pi = { canResume: vi.fn(() => true), resume } as unknown as PiResumeAdapter;
  const starter = starterFor(orchestratorWith(pi));

  starter.notify(SEAT_SESSION);
  await vi.waitFor(() => expect(ledger()).toBe("resumed"));

  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]!.slice(1, 4)).toEqual(["pi_session_file", SESSION_FILE, "./"]);
});
});
