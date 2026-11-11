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
import type Database from "better-sqlite3";
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
import { createFullTestDb } from "./helpers/test-app.js";
import type { RigSpec } from "../src/domain/types.js";

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
    hasSession: async (name: string) => name === PEER_SESSION,
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

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
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

  function orchestratorWith(pi: PiResumeAdapter): RestoreOrchestrator {
    const tmux = tmuxWithLivePeer();
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
      launchSingleNode: (id, logicalId) => orchestrator.launchSingleNode(id, logicalId),
      hasSession: name => tmux.hasSession(name),
      getNodeLaunchRecipe: () => recipeWithColdStart(),
      log: () => {},
    });
  }

  function ledger(): string | undefined {
    return (db.prepare("SELECT last_outcome FROM seat_cold_starts WHERE node_id = ?").get(implNodeId) as { last_outcome: string } | undefined)?.last_outcome;
  }

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
});
