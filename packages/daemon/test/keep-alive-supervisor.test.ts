import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator, type NarrowLaunchResult, type RestoreOrchestratorDeps } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { KeepAliveSupervisor, keepAliveIncidentAdopts, type KeepAliveSupervisorDeps } from "../src/domain/keep-alive-supervisor.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { restoreExistingRigUnattended, automaticRestoreInProgress } from "../src/domain/existing-rig-restore.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProcessTableRow } from "../src/domain/process-table.js";
import { createFullTestDb, createTestApp, mockNativeRuntime } from "./helpers/test-app.js";
import type { RigSpec } from "../src/domain/types.js";

// #2940: a seat that declares keep_alive is relaunched when it falls while the daemon runs, through the one-seat launch,
// within a durable attempt budget, and left alone when it was stopped on purpose.

const T0 = Date.parse("2026-11-17T08:00:00.000Z");
const BACKOFF = 30_000;
const STABLE = 10 * 60_000;
/** A process start time as the process table gives it (`ps -o lstart`, local time). */
const lstart = (d: Date) => `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} `
  + `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} `
  + `${String(d.getDate()).padStart(2, " ")} `
  + `${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")} ${d.getFullYear()}`;

describe("KeepAliveSupervisor (#2940)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let nowMs: number;
  let probes: Map<string, "present" | "absent" | Error | { state: "transport_unavailable"; cause: string }>;
  let processes: ProcessTableRow[];
  let rigId: string;
  let nodeId: string;
  let fallenId: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    nowMs = T0;
    probes = new Map();
    processes = [];
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev.driver", { role: "driver", runtime: "claude-code" });
    db.prepare("UPDATE nodes SET keep_alive = 1 WHERE id = ?").run(node.id);
    const session = sessionRegistry.registerSession(node.id, "dev-driver@r01");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    rigId = rig.id;
    nodeId = node.id;
    fallenId = session.id;
  });
  afterEach(() => db.close());

  const tmux = {
    probeSession: async (name: string) => {
      const probe = probes.get(name) ?? "absent";
      if (probe instanceof Error) throw probe;
      return typeof probe === "string" ? { state: probe } : probe;
    },
  } as unknown as TmuxAdapter;
  const reconciler = () => new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, readProcesses: async () => processes });

  /** A launch that brings the seat back: a new running session, its harness started, reported with a running status. */
  const relaunches = (status = "resumed") => vi.fn(async (): Promise<NarrowLaunchResult> => {
    const session = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    probes.set("dev-driver@r01", "present");
    return { ok: true, launched: [{ nodeId, logicalId: "dev.driver", status } as never], alreadyRunning: [] };
  });
  const launchReturns = (result: NarrowLaunchResult) => vi.fn(async () => result);

  function supervisor(launchSingleNode: ReturnType<typeof vi.fn>, extra: Partial<KeepAliveSupervisorDeps> = {}) {
    return new KeepAliveSupervisor({
      db, eventBus, reconciler: reconciler(),
      restoreOrchestrator: { launchSingleNode: launchSingleNode as never },
      backoffMs: BACKOFF, stableMs: STABLE, now: () => new Date(nowMs), onTickError: () => {}, ...extra,
    });
  }
  const budget = () => db.prepare("SELECT * FROM node_keep_alive_budget WHERE node_id = ?").get(nodeId) as
    { incident_id: string; attempts: number; last_error: string | null; exhausted_at: string | null; recovered_at: string | null;
      fallen_session_id: string | null; launched_session_id: string | null } | undefined;
  const events = (type: string) => (db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as { payload: string }[])
    .map((row) => JSON.parse(row.payload));
  /** Set a session's creation time, in the database's own format, so the order of sessions follows the test clock. */
  const createdAt = (sessionId: string, ms: number) => db.prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
    .run(new Date(ms).toISOString().replace("T", " ").slice(0, 19), sessionId);
  const anyShouldContinue = { shouldContinue: expect.any(Function) };
  const latestStatus = () => sessionRegistry.getSessionsForRig(rigId).filter((s) => s.nodeId === nodeId).at(-1)!.status;

  it("counts the attempt and persists its event before the launch starts, so a launch that throws stays counted", async () => {
    let seenDuringLaunch: unknown;
    const launch = vi.fn(async () => {
      seenDuringLaunch = { attempts: budget()?.attempts, attempted: events("seat.keep_alive.attempted").length };
      throw new Error("daemon lost mid-launch");
    });
    await supervisor(launch).runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(seenDuringLaunch).toEqual({ attempts: 1, attempted: 1 });
    expect(budget()).toMatchObject({ attempts: 1, fallen_session_id: fallenId, last_error: "daemon lost mid-launch", exhausted_at: null });
    expect(events("seat.keep_alive.attempted")).toEqual([expect.objectContaining({ rigId, nodeId, logicalId: "dev.driver", attempts: 1,
      incidentId: budget()!.incident_id })]);
  });

  it("asks for nothing fresh: the launch gets only keepAlive, and the adapters it was given", async () => {
    const launch = relaunches();
    const adapters = { "claude-code": {} } as never;
    await supervisor(launch, { adapters }).runTickNow();
    expect(launch).toHaveBeenCalledWith(rigId, "dev.driver", { adapters, keepAlive: anyShouldContinue });
  });

  it("a daemon restart over the same database neither resets the attempts nor skips the wait", async () => {
    const first = vi.fn(async () => { throw new Error("boom"); });
    await supervisor(first).runTickNow();
    expect(budget()!.attempts).toBe(1);

    const restarted = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed", error: "harness died" } as never] });
    nowMs = T0 + BACKOFF - 1;
    await supervisor(restarted).runTickNow();
    expect(restarted).not.toHaveBeenCalled();
    expect(budget()!.attempts).toBe(1);

    nowMs = T0 + BACKOFF;
    await supervisor(restarted).runTickNow();
    expect(restarted).toHaveBeenCalledOnce();
    expect(budget()).toMatchObject({ attempts: 2, last_error: "harness died" });
    expect(budget()!.exhausted_at).not.toBeNull();
  });

  it("exhausts once when the attempts run out, with the last status and error, and launches nothing more", async () => {
    const launch = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed", error: "no harness" } as never] });
    const keep = supervisor(launch);
    await keep.runTickNow();
    nowMs += BACKOFF;
    await keep.runTickNow();
    for (let i = 0; i < 3; i++) {
      nowMs += 10 * BACKOFF;
      await keep.runTickNow();
    }
    expect(launch).toHaveBeenCalledTimes(2);
    expect(events("seat.keep_alive.exhausted")).toEqual([expect.objectContaining({ attempts: 2, status: "failed", lastError: "no harness",
      incidentId: budget()!.incident_id })]);
    const entry = getNodeInventory(db, rigId).find((e) => e.nodeId === nodeId)!;
    expect(entry).toMatchObject({ keepAlive: true, lifecycleState: "attention_required",
      keepAliveIncident: { attempts: 2, exhausted: true, lastError: "no harness" } });
  });

  it("spaces attempts by a growing wait", async () => {
    const launch = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    const keep = supervisor(launch, { attempts: 3 });
    await keep.runTickNow();
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledTimes(2);
    nowMs += 2 * BACKOFF - 1;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledTimes(2);
    nowMs += 1;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["awaiting-decision", { ok: true, launched: [{ nodeId: "<node>", logicalId: "dev.driver", status: "awaiting-decision", error: "No session was started" }] }],
    ["attention_required", { ok: true, launched: [{ nodeId: "<node>", logicalId: "dev.driver", status: "attention_required", error: "resume prompt" }] }],
    ["no_usable_snapshot", { ok: false, code: "no_usable_snapshot", message: "no snapshot" }],
    ["stop_requested", { ok: false, code: "stop_requested", message: "asked to stop" }],
  ])("%s is terminal: the incident is exhausted at once and never retried", async (status, shape) => {
    const result = JSON.parse(JSON.stringify(shape).replace("<node>", nodeId)) as NarrowLaunchResult;
    const launch = launchReturns(result);
    const keep = supervisor(launch);
    await keep.runTickNow();
    nowMs += 100 * BACKOFF;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(events("seat.keep_alive.exhausted")).toEqual([expect.objectContaining({ attempts: 1, status })]);
  });

  it("a surviving session closes the incident without spending an attempt", async () => {
    // The seat's latest session turns out to be running after all when the launch looks.
    const launch = vi.fn(async (): Promise<NarrowLaunchResult> => {
      sessionRegistry.updateStatus(fallenId, "running");
      return { ok: true, launched: [], alreadyRunning: [{ nodeId, logicalId: "dev.driver" }] };
    });
    await supervisor(launch).runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(budget()).toBeUndefined();
    expect(events("seat.keep_alive.recovered")).toEqual([]);
    expect(events("seat.keep_alive.exhausted")).toEqual([]);
  });

  it("a running status with no new session running is not a recovery", async () => {
    const launch = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "fresh" } as never] });
    await supervisor(launch).runTickNow();
    expect(events("seat.keep_alive.recovered")).toEqual([]);
    expect(budget()).toMatchObject({ attempts: 1, recovered_at: null, last_error: "the launch reported 'fresh' but started no session" });
  });

  it("a running status whose new session is a bare shell (its harness not started) is a failed launch, not a recovery", async () => {
    let leftId = "";
    const launch = vi.fn(async (): Promise<NarrowLaunchResult> => {
      const session = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "attention_required");
      probes.set("dev-driver@r01", "present");
      leftId = session.id;
      return { ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "fresh-primed" } as never] };
    });
    const keep = supervisor(launch);
    await keep.runTickNow();
    nowMs += STABLE + BACKOFF;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(events("seat.keep_alive.recovered")).toEqual([]);
    expect(events("seat.keep_alive.exhausted")).toEqual([expect.objectContaining({ status: "fresh-primed",
      lastError: expect.stringContaining("startup status 'attention_required'") })]);
    expect(budget()).toMatchObject({ launched_session_id: leftId, recovered_at: null });
  });

  it("a running status whose new session's harness is still starting recovers once a tick sees its startup complete", async () => {
    let leftId = "";
    const launch = vi.fn(async (): Promise<NarrowLaunchResult> => {
      const session = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
      sessionRegistry.updateStatus(session.id, "running");
      probes.set("dev-driver@r01", "present");
      leftId = session.id;
      return { ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "resumed" } as never] };
    });
    const keep = supervisor(launch);
    await keep.runTickNow();
    expect(budget()).toMatchObject({ launched_session_id: leftId, recovered_at: null, attempts: 1 });
    nowMs += STABLE;
    await keep.runTickNow();
    expect(events("seat.keep_alive.recovered")).toEqual([]);
    expect(budget()).toMatchObject({ launched_session_id: leftId, recovered_at: null });

    sessionRegistry.updateStartupStatus(leftId, "ready");
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(events("seat.keep_alive.recovered")).toEqual([expect.objectContaining({ attempts: 1 })]);
    nowMs += STABLE;
    await keep.runTickNow();
    expect(budget()).toBeUndefined();
    expect(launch).toHaveBeenCalledOnce();
  });

  it("a surviving latest session that is a bare shell doesn't reset the budget: the seat waits for a person", async () => {
    const launch = vi.fn(async (): Promise<NarrowLaunchResult> => {
      sessionRegistry.updateStatus(fallenId, "running");
      sessionRegistry.updateStartupStatus(fallenId, "attention_required");
      return { ok: true, launched: [], alreadyRunning: [{ nodeId, logicalId: "dev.driver" }] };
    });
    await supervisor(launch).runTickNow();
    expect(budget()).toMatchObject({ attempts: 1 });
    expect(budget()!.exhausted_at).not.toBeNull();
    expect(events("seat.keep_alive.exhausted")).toEqual([expect.objectContaining({ status: "already_running",
      lastError: expect.stringContaining("harness's startup hasn't completed") })]);
  });

  it("a recovered seat that runs for the stable period ends its incident; a fall before that continues it", async () => {
    const launch = relaunches();
    const keep = supervisor(launch);
    await keep.runTickNow();
    expect(events("seat.keep_alive.recovered")).toEqual([expect.objectContaining({ attempts: 1, status: "resumed" })]);
    expect(budget()).toMatchObject({ attempts: 1 });
    expect(budget()!.recovered_at).not.toBeNull();

    nowMs += STABLE - 1;
    await keep.runTickNow();
    expect(budget()).toMatchObject({ attempts: 1 });
    nowMs += 1;
    await keep.runTickNow();
    expect(budget()).toBeUndefined();

    // Falls again later: a new incident with a whole budget.
    probes.set("dev-driver@r01", "absent");
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(budget()).toMatchObject({ attempts: 1 });

    // Falls again before the stable period: the same incident goes on to its 2nd attempt.
    const incident = budget()!.incident_id;
    probes.set("dev-driver@r01", "absent");
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledTimes(3);
    expect(budget()).toMatchObject({ attempts: 2, incident_id: incident });
  });

  it("a person's start after the incident ran out opens a new incident when that session falls", async () => {
    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    const keep = supervisor(failing, { attempts: 1 });
    await keep.runTickNow();
    const exhausted = budget()!;
    expect(exhausted.exhausted_at).not.toBeNull();

    const started = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
    sessionRegistry.updateStatus(started.id, "running");
    probes.set("dev-driver@r01", "present");
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(budget()).toBeUndefined();

    probes.set("dev-driver@r01", "absent");
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(budget()).toMatchObject({ attempts: 1, fallen_session_id: started.id });
    expect(budget()!.incident_id).not.toBe(exhausted.incident_id);
  });

  it("an unknown probe never recovers: the session stays running", async () => {
    probes.set("dev-driver@r01", new Error("tmux timed out"));
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(latestStatus()).toBe("running");
    expect(budget()).toBeUndefined();
  });

  it("a recorded process still running (the seat on a server this daemon can't see) never recovers", async () => {
    const observed = new Date(T0 - 60_000);
    new SeatIdentityStore(db).upsert({
      nodeId, verdict: "verified", evidenceSource: null, reason: null,
      evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
      sessionName: "dev-driver@r01", observedAt: observed.toISOString(),
    });
    const started = new Date(observed.getTime() - 10 * 60_000);
    processes = [{ pid: 4241, ppid: 1, pgid: 4241, tpgid: -1, executableName: "claude", startedAt: lstart(started), command: "claude" }];
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(latestStatus()).toBe("running");
  });

  it("a detached session tmux still shows (a stale boot status) is no fall: nothing is launched", async () => {
    sessionRegistry.markDetached(fallenId);
    probes.set("dev-driver@r01", "present");
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(budget()).toBeUndefined();
    // Once tmux shows it absent, the same detached session is a proven fall.
    probes.set("dev-driver@r01", "absent");
    await supervisor(launch).runTickNow();
    expect(launch).toHaveBeenCalledOnce();
  });

  it("an exited session without a stop request ended cleanly and is left down", async () => {
    sessionRegistry.updateStatus(fallenId, "exited");
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    expect(launch).not.toHaveBeenCalled();
  });

  it("skips a seat stopped on purpose, and ends its incident", async () => {
    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    const keep = supervisor(failing);
    await keep.runTickNow();
    expect(budget()).toMatchObject({ attempts: 1 });
    sessionRegistry.markIntentionallyStopped(fallenId);
    nowMs += 10 * BACKOFF;
    await keep.runTickNow();
    expect(failing).toHaveBeenCalledOnce();
    expect(budget()).toBeUndefined();
  });

  it("skips a claimed seat and a seat attached from outside, without reconciling them", async () => {
    const claimedNode = rigRepo.addNode(rigId, "dev.claimed", { role: "worker" });
    db.prepare("UPDATE nodes SET keep_alive = 1 WHERE id = ?").run(claimedNode.id);
    const claimed = sessionRegistry.registerClaimedSession(claimedNode.id, "claimed-pane");
    sessionRegistry.updateBinding(nodeId, { attachmentType: "external_cli", externalSessionName: "outside" });
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(latestStatus()).toBe("running");
    expect(sessionRegistry.getSessionsForRig(rigId).find((s) => s.id === claimed.id)!.status).toBe("running");
  });

  it("leaves a rig to the restore running for it", async () => {
    const launch = relaunches();
    await supervisor(launch, { restoreOrchestrator: { launchSingleNode: launch as never, restoreInProgress: () => true } }).runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(latestStatus()).toBe("running");
  });

  it("is inert for seats that don't declare keep_alive", async () => {
    db.prepare("UPDATE nodes SET keep_alive = 0 WHERE id = ?").run(nodeId);
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(latestStatus()).toBe("running");
  });

  it.each([
    ["attention_required", "running"],
    ["awaiting-decision", "superseded"],
  ])("a terminal %s that leaves its session (%s) records it, so the exhaustion stays and nothing restarts", async (status, left) => {
    let leftId = "";
    const launch = vi.fn(async (): Promise<NarrowLaunchResult> => {
      const session = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
      sessionRegistry.updateStatus(session.id, left as never);
      leftId = session.id;
      if (left === "running") probes.set("dev-driver@r01", "present");
      return { ok: true, launched: [{ nodeId, logicalId: "dev.driver", status, error: "parked" } as never] };
    });
    const keep = supervisor(launch);
    await keep.runTickNow();
    expect(budget()).toMatchObject({ launched_session_id: leftId, attempts: 1 });
    nowMs += 100 * BACKOFF;
    await keep.runTickNow();
    probes.set("dev-driver@r01", "absent");
    nowMs += 100 * BACKOFF;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(budget()).toMatchObject({ launched_session_id: leftId, attempts: 1 });
    expect(budget()!.exhausted_at).not.toBeNull();
    expect(events("seat.keep_alive.exhausted")).toHaveLength(1);
    expect(events("seat.keep_alive.attempted")).toHaveLength(1);
  });

  it("a failed launch that left its session running is exhausted, not reported recovered", async () => {
    let leftId = "";
    const launch = vi.fn(async (): Promise<NarrowLaunchResult> => {
      const session = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
      sessionRegistry.updateStatus(session.id, "running");
      probes.set("dev-driver@r01", "present");
      leftId = session.id;
      return { ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed", error: "startup failed" } as never] };
    });
    const keep = supervisor(launch);
    await keep.runTickNow();
    nowMs += STABLE + BACKOFF;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(events("seat.keep_alive.recovered")).toEqual([]);
    expect(events("seat.keep_alive.exhausted")).toEqual([expect.objectContaining({ attempts: 1, status: "failed",
      lastError: "startup failed; the failed launch left its session running" })]);
    expect(budget()).toMatchObject({ launched_session_id: leftId });
  });

  it("an older session still running behind the fallen latest one exhausts the incident once instead of looping", async () => {
    // fallenId is the older session, still live under its name; the seat's latest session, under another name, fell.
    const newer = sessionRegistry.registerSession(nodeId, "dev-driver-new@r01");
    sessionRegistry.updateStatus(newer.id, "running");
    createdAt(fallenId, T0 - 120_000);
    createdAt(newer.id, T0 - 60_000);
    probes.set("dev-driver@r01", "present");
    const launch = launchReturns({ ok: true, launched: [], alreadyRunning: [{ nodeId, logicalId: "dev.driver" }] });
    const keep = supervisor(launch);
    for (let i = 0; i < 4; i++) {
      await keep.runTickNow();
      nowMs += 10 * BACKOFF;
    }
    expect(launch).toHaveBeenCalledOnce();
    expect(events("seat.keep_alive.attempted")).toHaveLength(1);
    expect(events("seat.keep_alive.exhausted")).toEqual([expect.objectContaining({ status: "already_running",
      lastError: expect.stringContaining("'dev-driver@r01'") })]);
    expect(budget()).toMatchObject({ fallen_session_id: newer.id });
  });

  it("a daemon restart in the middle of a launch keeps the session it left in the incident, with the attempts carried", async () => {
    let entered!: () => void;
    const inLaunch = new Promise<void>((resolve) => { entered = resolve; });
    let leftId = "";
    // The launch registers its session and never returns: the daemon stopped before its outcome was written.
    const cut = vi.fn(async (): Promise<NarrowLaunchResult> => {
      const session = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready");
      createdAt(session.id, nowMs);
      probes.set("dev-driver@r01", "present");
      leftId = session.id;
      entered();
      return new Promise<NarrowLaunchResult>(() => {});
    });
    createdAt(fallenId, T0 - 60_000);
    void supervisor(cut).runTickNow();
    await inLaunch;
    const incident = budget()!.incident_id;
    expect(budget()).toMatchObject({ attempts: 1, launched_session_id: null, last_outcome: null });

    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    nowMs += 5_000;
    const restarted = supervisor(failing);
    await restarted.runTickNow();
    expect(budget()).toMatchObject({ incident_id: incident, attempts: 1, launched_session_id: leftId });
    expect(events("seat.keep_alive.recovered")).toEqual([expect.objectContaining({ attempts: 1, incidentId: incident })]);

    // It falls before the stable period: the same incident goes on to its 2nd attempt.
    probes.set("dev-driver@r01", "absent");
    nowMs += BACKOFF;
    await restarted.runTickNow();
    expect(failing).toHaveBeenCalledOnce();
    expect(budget()).toMatchObject({ incident_id: incident, attempts: 2 });
  });

  it("a person's start during the wait ends the incident, and its fall opens a new one with a whole budget", async () => {
    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    const keep = supervisor(failing);
    await keep.runTickNow();
    const first = budget()!;
    expect(first.attempts).toBe(1);

    const started = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
    sessionRegistry.updateStatus(started.id, "running");
    probes.set("dev-driver@r01", "present");
    nowMs += 5_000;
    await keep.runTickNow();
    expect(budget()).toBeUndefined();
    expect(events("seat.keep_alive.recovered")).toEqual([]);

    probes.set("dev-driver@r01", "absent");
    nowMs += 5_000;
    await keep.runTickNow();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(budget()).toMatchObject({ attempts: 1, fallen_session_id: started.id });
    expect(budget()!.incident_id).not.toBe(first.incident_id);
  });

  it("a recovered seat that falls while the daemon was down, never seen stable, stays in its incident", async () => {
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    const incident = budget()!.incident_id;
    nowMs += 60_000;
    await supervisor(launch).runTickNow();
    expect(budget()).toMatchObject({ incident_id: incident, attempts: 1 });

    // The daemon is down for hours; the seat ran and fell meanwhile. The restart alone resets nothing.
    probes.set("dev-driver@r01", "absent");
    nowMs += 3 * 60 * 60_000;
    await supervisor(launch).runTickNow();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(budget()).toMatchObject({ incident_id: incident, attempts: 2 });
  });

  it("a launch the shutdown refuses while it waits for the lease gives its attempt back and emits nothing more", async () => {
    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed", error: "x" } as never] });
    const keep = supervisor(failing);
    await keep.runTickNow();
    const before = budget()!;

    let entered!: () => void;
    const inLaunch = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const lease = new Promise<void>((resolve) => { release = resolve; });
    const waiting = vi.fn(async (_rig: string, _logical: string, opts?: { keepAlive?: boolean | { shouldContinue?: () => boolean } }) => {
      entered();
      await lease;
      const check = typeof opts?.keepAlive === "object" ? opts.keepAlive.shouldContinue : undefined;
      if (check && !check()) return { ok: false, code: "shutting_down", message: "shutting down" } as NarrowLaunchResult;
      throw new Error("the launch went ahead during shutdown");
    });
    nowMs += BACKOFF;
    const second = supervisor(waiting);
    second.start();
    const tick = second.runTickNow();
    await inLaunch;
    expect(budget()!.attempts).toBe(2);
    const stopping = second.stop();
    release();
    await stopping;
    await tick;
    expect(waiting).toHaveBeenCalledOnce();
    expect(budget()).toEqual(expect.objectContaining({ incident_id: before.incident_id, attempts: 1,
      last_attempt_at: before.last_attempt_at, last_error: "x", exhausted_at: null, launched_session_id: before.launched_session_id }));
    expect(events("seat.keep_alive.exhausted")).toEqual([]);
    expect(events("seat.keep_alive.attempted")).toHaveLength(2);
  });

  it("a shutdown that refuses the first attempt of an incident leaves no incident", async () => {
    const refused = vi.fn(async () => ({ ok: false, code: "shutting_down", message: "shutting down" } as NarrowLaunchResult));
    await supervisor(refused).runTickNow();
    expect(refused).toHaveBeenCalledOnce();
    expect(budget()).toBeUndefined();
    expect(events("seat.keep_alive.exhausted")).toEqual([]);
  });

  it("an exhausted seat a person stops loses its incident, so it stops asking for attention", async () => {
    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    const keep = supervisor(failing, { attempts: 1 });
    await keep.runTickNow();
    expect(budget()!.exhausted_at).not.toBeNull();
    sessionRegistry.markIntentionallyStopped(fallenId);
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(budget()).toBeUndefined();
    expect(failing).toHaveBeenCalledOnce();
  });

  it("a stop request still pending keeps the incident and its budget; only a confirmed stop ends it", async () => {
    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    const keep = supervisor(failing, { attempts: 3 });
    await keep.runTickNow();
    const incident = budget()!.incident_id;
    sessionRegistry.requestStop(fallenId, "stop-1");
    nowMs += 10 * BACKOFF;
    await keep.runTickNow();
    expect(failing).toHaveBeenCalledOnce();
    expect(budget()).toMatchObject({ incident_id: incident, attempts: 1 });

    // The checked stop proves its kill had no effect and puts the request back: the same incident goes on.
    db.prepare("UPDATE sessions SET intentionally_stopped = 0, stop_attempt = NULL WHERE id = ?").run(fallenId);
    await keep.runTickNow();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(budget()).toMatchObject({ incident_id: incident, attempts: 2 });
  });

  it("a daemon that died during the last allowed launch exhausts the incident after the restart, launching nothing more", async () => {
    sessionRegistry.updateStatus(fallenId, "detached");
    const lastAttempt = new Date(T0 - 10 * 60_000).toISOString();
    db.prepare(`INSERT INTO node_keep_alive_budget (node_id, incident_id, fallen_session_id, attempts, last_attempt_at, last_error)
      VALUES (?, 'incident-1', ?, 2, ?, 'harness died')`).run(nodeId, fallenId, lastAttempt);
    const launch = relaunches();
    const keep = supervisor(launch);
    await keep.runTickNow();
    nowMs += 10 * BACKOFF;
    await keep.runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(events("seat.keep_alive.exhausted")).toEqual([expect.objectContaining({ incidentId: "incident-1", attempts: 2,
      lastError: "harness died" })]);
  });

  it("an unreachable tmux socket proves nothing: the seat isn't relaunched; a probe showing no server is a fall", async () => {
    probes.set("dev-driver@r01", { state: "transport_unavailable",
      cause: "error connecting to /tmp/tmux-1000/default (No such file or directory)" });
    const launch = relaunches();
    const keep = supervisor(launch);
    await keep.runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(latestStatus()).toBe("running");
    expect(budget()).toBeUndefined();

    probes.set("dev-driver@r01", { state: "transport_unavailable", cause: "no server running on /tmp/tmux-1000/default" });
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
  });

  it("retries the incident's own failed launch only on proof it is gone, whatever status that launch left", async () => {
    // The failed launch leaves its session exited, a status the reconcile used to skip without probing it.
    const launch = vi.fn(async (): Promise<NarrowLaunchResult> => {
      const session = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
      sessionRegistry.updateStatus(session.id, "exited");
      return { ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed", error: "harness died" } as never] };
    });
    const keep = supervisor(launch, { attempts: 3 });
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();

    probes.set("dev-driver@r01", { state: "transport_unavailable", cause: "error connecting to /tmp/tmux-1000/default (Permission denied)" });
    nowMs += 10 * BACKOFF;
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(budget()).toMatchObject({ attempts: 1 });

    probes.set("dev-driver@r01", "absent");
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("an automatic restore at daemon start keeps the incident and its budget; only a person's start ends it", async () => {
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    snapshotCapture.captureSnapshot(rigId, "auto-pre-down");
    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    const keep = supervisor(failing, { attempts: 3 });
    await keep.runTickNow();
    const incident = budget()!.incident_id;
    expect(budget()).toMatchObject({ attempts: 1 });

    // The daemon restarts and its restore brings the seat back on a session of its own.
    let restoredId = "";
    const restore = vi.fn(async (_snapshotId: string, opts: { onSessionLaunched?: (nodeId: string, sessionId: string) => void }) => {
      const session = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready");
      restoredId = session.id;
      opts.onSessionLaunched?.(nodeId, session.id);
      return { ok: true, result: { rigResult: "fully_restored", nodes: [] } };
    });
    await restoreExistingRigUnattended({ rigRepo, snapshotRepo, snapshotCapture,
      restoreOrchestrator: { restore } as unknown as RestoreOrchestrator }, rigId, () => false);
    expect(restore).toHaveBeenCalledOnce();
    probes.set("dev-driver@r01", "present");
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(budget()).toMatchObject({ incident_id: incident, attempts: 1, launched_session_id: restoredId });

    // It falls again before the stable period: the same incident goes on with the attempts it has left.
    probes.set("dev-driver@r01", "absent");
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(budget()).toMatchObject({ incident_id: incident, attempts: 2 });
  });

  it("a missing tmux socket (a reboot's /tmp cleanup) is proven absent once an empty server is started", async () => {
    let serverUp = false;
    const startServer = vi.fn(async () => { serverUp = true; return { ok: true as const }; });
    const rebooted = {
      probeSession: async () => serverUp ? { state: "absent" as const }
        : { state: "transport_unavailable" as const, cause: "error connecting to /tmp/tmux-1000/default (No such file or directory)" },
      startServer,
    } as unknown as TmuxAdapter;
    // The seat's process recorded for this very session, since it began, is no longer running.
    createdAt(fallenId, T0 - 60_000);
    new SeatIdentityStore(db).upsert({
      nodeId, verdict: "verified", evidenceSource: null, reason: null,
      evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
      sessionName: "dev-driver@r01", observedAt: new Date(T0 - 30_000).toISOString(),
    });
    const launch = relaunches();
    await supervisor(launch, {
      reconciler: new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: rebooted, readProcesses: async () => processes }),
    }).runTickNow();
    expect(startServer).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
  });

  describe("a missing tmux socket whose seat's recorded pid is held by a process again (a reboot reuses pids)", () => {
    let startServer: ReturnType<typeof vi.fn>;
    const run = async (holder: ProcessTableRow) => {
      let serverUp = false;
      startServer = vi.fn(async () => { serverUp = true; return { ok: true as const }; });
      const rebooted = {
        probeSession: async () => serverUp ? { state: "absent" as const }
          : { state: "transport_unavailable" as const, cause: "error connecting to /tmp/tmux-1000/default (No such file or directory)" },
        startServer,
      } as unknown as TmuxAdapter;
      createdAt(fallenId, T0 - 60_000);
      new SeatIdentityStore(db).upsert({
        nodeId, verdict: "verified", evidenceSource: null, reason: null,
        evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
        sessionName: "dev-driver@r01", observedAt: new Date(T0 - 30_000).toISOString(),
      });
      processes = [holder];
      const launch = relaunches();
      await supervisor(launch, {
        reconciler: new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: rebooted, readProcesses: async () => processes }),
      }).runTickNow();
      return launch;
    };
    const holder = (startedAt: string): ProcessTableRow =>
      ({ pid: 4241, ppid: 1, pgid: 4241, tpgid: -1, executableName: "bash", startedAt, command: "bash" });

    it("is proven gone when that process started after the observation, and the seat is relaunched", async () => {
      const launch = await run(holder(lstart(new Date(T0 - 10_000))));
      expect(startServer).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledOnce();
    });

    it.each([
      ["started at or before the observation (the seat's own process)", lstart(new Date(T0 - 10 * 60_000))],
      ["whose start can't be dated", "not a start time"],
    ])("holds the seat while that process %s", async (_label, startedAt) => {
      const launch = await run(holder(startedAt));
      expect(startServer).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(latestStatus()).toBe("running");
      expect(budget()).toBeUndefined();
    });
  });

  it("a released claimed session still running in its owner's tmux doesn't hold back the seat's own proven fall", async () => {
    // `rig unclaim` leaves the released row detached, without a stop request, while its owner's session runs on.
    const released = sessionRegistry.registerClaimedSession(nodeId, "owner-pane");
    sessionRegistry.updateStatus(released.id, "detached");
    createdAt(released.id, T0 - 120_000);
    createdAt(fallenId, T0 - 60_000);
    probes.set("owner-pane", "present");
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    expect(launch).toHaveBeenCalledOnce();
  });

  it("an older session of the seat under another tmux name that the probe couldn't settle holds back the retry", async () => {
    const older = sessionRegistry.registerSession(nodeId, "dev-driver-old@r01");
    sessionRegistry.updateStatus(older.id, "superseded");
    createdAt(older.id, T0 - 120_000);
    createdAt(fallenId, T0 - 60_000);
    probes.set("dev-driver-old@r01", { state: "transport_unavailable", cause: "error connecting to /tmp/tmux-1000/old (Permission denied)" });
    const launch = relaunches();
    await supervisor(launch).runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(budget()).toBeUndefined();
  });

  it("an automatic restore's session adopted into an exhausted incident ends it once a tick has seen it run stable", async () => {
    const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
    const keep = supervisor(failing, { attempts: 1 });
    await keep.runTickNow();
    expect(budget()!.exhausted_at).not.toBeNull();

    const restored = sessionRegistry.registerSession(nodeId, "dev-driver@r01");
    sessionRegistry.updateStatus(restored.id, "running");
    sessionRegistry.updateStartupStatus(restored.id, "ready");
    keepAliveIncidentAdopts(db, nodeId, restored.id, new Date(nowMs));
    probes.set("dev-driver@r01", "present");
    nowMs += BACKOFF;
    await keep.runTickNow();
    expect(budget()!.exhausted_at).not.toBeNull();
    nowMs += STABLE;
    await keep.runTickNow();
    expect(budget()).toBeUndefined();
    expect(failing).toHaveBeenCalledOnce();
  });

  it("leaves a rig to daemon start's restore while it runs, and acts once it has settled", async () => {
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    snapshotCapture.captureSnapshot(rigId, "auto-pre-down");
    let entered!: () => void;
    const inRestore = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const restore = vi.fn(async () => {
      entered();
      await gate;
      return { ok: false, code: "rig_locked", message: "fixture" };
    });
    const unattended = restoreExistingRigUnattended({ rigRepo, snapshotRepo, snapshotCapture,
      restoreOrchestrator: { restore } as unknown as RestoreOrchestrator }, rigId, () => false);
    await inRestore;
    expect(automaticRestoreInProgress(db, rigId)).toBe(true);

    const launch = relaunches();
    const keep = supervisor(launch);
    await keep.runTickNow();
    expect(launch).not.toHaveBeenCalled();
    expect(latestStatus()).toBe("running");

    release();
    await unattended;
    expect(automaticRestoreInProgress(db, rigId)).toBe(false);
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
  });

  describe("stop()", () => {
    function timers() {
      const scheduled: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
      return {
        scheduled,
        setTimer: (cb: () => void, ms: number) => {
          const entry = { cb, ms, cleared: false };
          scheduled.push(entry);
          return entry as unknown as NodeJS.Timeout;
        },
        clearTimer: (handle: NodeJS.Timeout) => { (handle as unknown as { cleared: boolean }).cleared = true; },
      };
    }

    it("prevents any new attempt, including one the wait had scheduled, and is idempotent", async () => {
      const t = timers();
      const failing = launchReturns({ ok: true, launched: [{ nodeId, logicalId: "dev.driver", status: "failed" } as never] });
      const keep = supervisor(failing, { setTimer: t.setTimer, clearTimer: t.clearTimer });
      keep.start();
      keep.start();
      expect(t.scheduled).toHaveLength(1);
      await keep.runTickNow();
      expect(failing).toHaveBeenCalledOnce();

      await keep.stop();
      await keep.stop();
      expect(t.scheduled[0]!.cleared).toBe(true);
      expect(keep.isRunning()).toBe(false);
      nowMs += 10 * BACKOFF;
      await keep.runTickNow();
      expect(failing).toHaveBeenCalledOnce();
      expect(budget()).toMatchObject({ attempts: 1, exhausted_at: null });
    });

    it("during a tick, stops the attempt it was about to make", async () => {
      const t = timers();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const inReconcile = new Promise<void>((resolve) => { entered = resolve; });
      const real = reconciler();
      const slow = { reconcile: async (id: string, opts?: { nodeIds?: readonly string[] }) => { entered(); await gate; return real.reconcile(id, opts); } };
      const launch = relaunches();
      const keep = supervisor(launch, { reconciler: slow, setTimer: t.setTimer, clearTimer: t.clearTimer });
      keep.start();
      const tick = keep.runTickNow();
      await inReconcile;
      const stopping = keep.stop();
      release();
      await stopping;
      await tick;
      expect(launch).not.toHaveBeenCalled();
      expect(budget()).toBeUndefined();
    });
  });

  /** The real one-seat launch for the seat: in a pod, with a snapshot that starts it fresh (from its saved startup
   *  context, or with none, through the recipe's fresh launch), over a tmux whose session stop the test decides. */
  function realOrchestrator(killSession: (name: string) => Promise<unknown>,
    opts: { startupContext?: boolean; onCreateSession?: () => void } = {}) {
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", rigId, "dev", "Dev");
    db.prepare("UPDATE nodes SET pod_id = 'pod-1' WHERE id = ?").run(nodeId);
    const snapshotRepo = new SnapshotRepository(db);
    snapshotRepo.createSnapshot(rigId, "manual", {
      rig: { id: rigId, name: "r01" },
      nodes: [{ id: nodeId, logicalId: "dev.driver", rigId, runtime: "claude-code", podId: "pod-1" }],
      sessions: [{ nodeId, id: fallenId, sessionName: "dev-driver@r01", status: "running", resumeType: "none", resumeToken: null, restorePolicy: "relaunch_fresh" }],
      edges: [], checkpoints: {},
      nodeStartupContext: opts.startupContext === false ? {}
        : { [nodeId]: { projectionEntries: [], resolvedStartupFiles: [], startupActions: [], runtime: "claude-code" } },
    } as never);
    const fakeTmux = {
      createSession: vi.fn(async () => { opts.onCreateSession?.(); return { ok: true as const }; }), hasSession: vi.fn(async () => false),
      sendKeys: vi.fn(async () => {}), capturePaneContent: vi.fn(async () => ""), getPaneCommand: vi.fn(async () => null),
      getPanePid: vi.fn(async () => null), listPanes: vi.fn(async () => []), getSessionStatus: vi.fn(async () => null),
      waitForReady: vi.fn(async () => true), listSessions: vi.fn(async () => []), startPipePane: vi.fn(async () => true),
      killSession: vi.fn(killSession),
    };
    const checkpointStore = new CheckpointStore(db);
    const orchestrator = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo,
      snapshotCapture: new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore }),
      checkpointStore, nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: fakeTmux as never }),
      tmuxAdapter: fakeTmux as never, claudeResume: new ClaudeResumeAdapter(fakeTmux as never), codexResume: new CodexResumeAdapter(fakeTmux as never),
      listProcesses: async () => [],
    });
    const launch = vi.fn((id: string, logicalId: string, launchOpts?: Parameters<RestoreOrchestrator["launchSingleNode"]>[2]) =>
      orchestrator.launchSingleNode(id, logicalId, launchOpts));
    return { orchestrator, fakeTmux, launch };
  }
  const readyHarness = () => ({
    runtime: "claude-code", listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), launchHarness: vi.fn(async () => ({ ok: true as const })),
    checkReady: vi.fn(async () => ({ ready: true })),
  });
  const ownShells = () => sessionRegistry.getSessionsForRig(rigId).filter((s) => s.nodeId === nodeId && s.id !== fallenId);

  // A shutdown that begins after the relaunch's shell exists: the real launch rolls the shell back, and only a stop
  // tmux confirmed is a rollback. An unconfirmed stop leaves the shell's session and binding as they are, reported, and
  // the attempt stays counted.
  it.each([
    ["returns false", async () => ({ ok: false as const, message: "server busy" })],
    ["throws", async () => { throw new Error("tmux timed out"); }],
  ])("a shutdown after the relaunch's shell exists whose stop %s keeps the attempt and reports the shell left in place", async (_how, kill) => {
    let keep!: KeepAliveSupervisor;
    const { fakeTmux, launch } = realOrchestrator(kill, { onCreateSession: () => { void keep.stop(); } });
    const harness = readyHarness();
    keep = supervisor(launch, { adapters: { "claude-code": harness } as never });
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(harness.launchHarness).not.toHaveBeenCalled();
    const shells = ownShells();
    expect(shells).toHaveLength(1);
    expect(fakeTmux.killSession).toHaveBeenCalledWith(shells[0]!.sessionName);
    // The shell may still run: its session and binding stay, and the incident keeps it as its own.
    expect(shells[0]!.status).toBe("running");
    expect(sessionRegistry.getBindingForNode(nodeId)?.tmuxSession).toBe(shells[0]!.sessionName);
    expect(budget()).toMatchObject({ attempts: 1, launched_session_id: shells[0]!.id });
    expect(budget()!.exhausted_at).not.toBeNull();
    expect(budget()!.last_error).toContain(`couldn't be confirmed stopped`);
    expect(budget()!.last_error).toContain(shells[0]!.sessionName);
    expect(events("seat.keep_alive.attempted")).toHaveLength(1);
    expect(events("seat.keep_alive.exhausted")).toEqual([expect.objectContaining({ attempts: 1, status: "shutting_down" })]);
  });

  it.each(["before", "shell", "retired"] as const)("a shutdown the relaunch undid (%s) gives its attempt back", async (when) => {
    let keep!: KeepAliveSupervisor;
    let kills = 0;
    // The provisional shell's retire is the only stop that finds a session; a stop of a session already gone isn't confirmed.
    const kill = async () => (++kills === 1 ? { ok: true as const } : { ok: false as const, message: "can't find session" });
    const { orchestrator, fakeTmux, launch } = when === "retired"
      ? realOrchestrator(async () => { const result = await kill(); void keep.stop(); return result; }, { startupContext: false })
      : realOrchestrator(kill, { onCreateSession: () => { if (when === "shell") void keep.stop(); } });
    const freshLaunch = vi.fn(async () => ({ status: "launched" as const }));
    if (when === "retired") Object.assign(orchestrator as never, { freshLaunch, freshLaunchAvailable: () => true });
    const harness = readyHarness();
    const launching = when === "before"
      ? vi.fn((...args: Parameters<typeof launch>) => { void keep.stop(); return launch(...args); })
      : launch;
    keep = supervisor(launching, { adapters: { "claude-code": harness } as never });
    await keep.runTickNow();
    expect(launch).toHaveBeenCalledOnce();
    expect(harness.launchHarness).not.toHaveBeenCalled();
    expect(freshLaunch).not.toHaveBeenCalled();
    if (when === "before") {
      expect(fakeTmux.createSession).not.toHaveBeenCalled();
    } else {
      expect(fakeTmux.killSession).toHaveBeenCalledOnce();
      expect(ownShells().map((s) => s.status)).toEqual(["superseded"]);
    }
    expect(budget()).toBeUndefined();
    expect(events("seat.keep_alive.exhausted")).toEqual([]);
  });

  // A rig down that lands after the supervisor saw the fall, before its launch takes the seat's lease: the real
  // launchSingleNode re-reads the seat under the lease, refuses with stop_requested and starts nothing.
  it("a rig down racing a tick wins: the launch refuses under the lease and nothing is launched", async () => {
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", rigId, "dev", "Dev");
    db.prepare("UPDATE nodes SET pod_id = 'pod-1' WHERE id = ?").run(nodeId);
    const snapshotRepo = new SnapshotRepository(db);
    snapshotRepo.createSnapshot(rigId, "manual", {
      rig: { id: rigId, name: "r01" },
      nodes: [{ id: nodeId, logicalId: "dev.driver", rigId, runtime: "claude-code", podId: "pod-1" }],
      sessions: [{ nodeId, id: fallenId, sessionName: "dev-driver@r01", status: "running", resumeType: "none", resumeToken: null, restorePolicy: "relaunch_fresh" }],
      edges: [], checkpoints: {},
      nodeStartupContext: { [nodeId]: { projectionEntries: [], resolvedStartupFiles: [], startupActions: [], runtime: "claude-code" } },
    } as never);
    const fakeTmux = {
      createSession: vi.fn(async () => ({ ok: true as const })), hasSession: vi.fn(async () => false), sendKeys: vi.fn(async () => {}),
      capturePaneContent: vi.fn(async () => ""), getPaneCommand: vi.fn(async () => null), getPanePid: vi.fn(async () => null),
      listPanes: vi.fn(async () => []), getSessionStatus: vi.fn(async () => null), waitForReady: vi.fn(async () => true),
      listSessions: vi.fn(async () => []), startPipePane: vi.fn(async () => true), killSession: vi.fn(async () => {}),
    };
    const checkpointStore = new CheckpointStore(db);
    const orchestrator = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo,
      snapshotCapture: new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore }),
      checkpointStore, nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: fakeTmux as never }),
      tmuxAdapter: fakeTmux as never, claudeResume: new ClaudeResumeAdapter(fakeTmux as never), codexResume: new CodexResumeAdapter(fakeTmux as never),
      listProcesses: async () => [],
    });
    const results: NarrowLaunchResult[] = [];
    const racing = vi.fn(async (id: string, logicalId: string, opts?: { keepAlive?: boolean | { shouldContinue?: () => boolean } }) => {
      sessionRegistry.requestStop(fallenId, "down-1");
      const result = await orchestrator.launchSingleNode(id, logicalId, opts);
      results.push(result);
      return result;
    });
    const keep = supervisor(racing);
    await keep.runTickNow();
    expect(racing).toHaveBeenCalledWith(rigId, "dev.driver", { keepAlive: anyShouldContinue });
    expect(results).toEqual([expect.objectContaining({ ok: false, code: "stop_requested" })]);
    expect(fakeTmux.createSession).not.toHaveBeenCalled();
    expect(sessionRegistry.getSessionsForRig(rigId).filter((s) => s.nodeId === nodeId)).toHaveLength(1);

    // The down confirms its stop once the session is gone, and the incident ends with it.
    sessionRegistry.markIntentionallyStopped(fallenId);
    nowMs += 10 * BACKOFF;
    await keep.runTickNow();
    expect(racing).toHaveBeenCalledOnce();
    expect(budget()).toBeUndefined();
  });
});

// #2940: daemon start's automatic restore isn't a person's start. These run the real restore, the real recipe-backed
// fresh launch and the real supervisor: the session the restore leaves for a seat in an incident is the incident's, and
// it ends the incident only once its harness's startup has completed and a tick has seen it run for the stable period.
describe("KeepAliveSupervisor and daemon start's automatic restore (#2940)", () => {
  let db: Database.Database;
  afterEach(() => db.close());

  const agentYaml = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default: {}\n`;

  /** A keep_alive seat in an incident (open, or exhausted) whose session fell while the daemon was down, restored by
   *  daemon start. `recipe`: the seat has a launch recipe, so the restore replaces its provisional shell with the
   *  recipe's fresh launch; without one, the restore leaves that shell as a bare shell, its harness not started. */
  async function restoredIncident(incident: "open" | "exhausted", recipe: boolean) {
    db = createFullTestDb();
    let setup!: ReturnType<typeof createTestApp>;
    const freshLaunch = vi.fn(async (id: string, node: string, launchOpts?: Parameters<NonNullable<RestoreOrchestratorDeps["freshLaunch"]>>[2]) =>
      setup.podInstantiator.launchPersistedFresh(id, node, launchOpts));
    // The harness the restore and the recipe's fresh launch both start.
    const harness = { runtime: "codex", listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })) };
    setup = createTestApp(db, {
      adapters: { codex: harness } as never,
      // The seat's Codex process as the daemon observes it, so a started harness reads ready (#3584).
      ...mockNativeRuntime(() => "codex"),
      freshLaunch,
      freshLaunchAvailable: (id, node) => setup.podInstantiator.canLaunchPersistedFresh(id, node),
      podInstantiatorFsOps: { exists: (file) => file.replaceAll("\\", "/").endsWith("/agents/impl/agent.yaml"), readFile: () => agentYaml },
    });
    const rig = setup.rigRepo.createRig("ka-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-ka", rig.id, "dev", "Development");
    const rigRoot = process.cwd();
    const rigSpec: RigSpec = { version: "0.2", name: "ka-rig", edges: [], pods: [{ id: "dev", label: "Development",
      members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }] };
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", agentRef: "local:agents/impl", profile: "default",
      cwd: rigRoot, podId: "pod-ka", ...(recipe ? { launchRecipe: { version: 1, rigRoot, rigSpec } } : {}) });
    db.prepare("UPDATE nodes SET keep_alive = 1 WHERE id = ?").run(node.id);
    const fallen = setup.sessionRegistry.registerSession(node.id, "dev-impl@ka-rig");
    setup.sessionRegistry.updateStatus(fallen.id, "running");
    db.prepare("UPDATE sessions SET restore_policy = 'relaunch_fresh' WHERE id = ?").run(fallen.id);
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@ka-rig", tmuxPane: "%7" });
    setup.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    setup.sessionRegistry.updateStatus(fallen.id, "detached");
    db.prepare(`INSERT INTO node_keep_alive_budget (node_id, incident_id, fallen_session_id, attempts, last_attempt_at, last_error,
        exhausted_at, last_outcome) VALUES (?, 'incident-1', ?, ?, ?, 'harness died', ?, ?)`)
      .run(node.id, fallen.id, incident === "exhausted" ? 2 : 1, new Date(T0 - 60_000).toISOString(),
        incident === "exhausted" ? new Date(T0 - 30_000).toISOString() : null, incident === "exhausted" ? "exhausted" : "failed");

    const restored = await restoreExistingRigUnattended({ rigRepo: setup.rigRepo, snapshotRepo: setup.snapshotRepo,
      snapshotCapture: setup.snapshotCapture, restoreOrchestrator: setup.restoreOrchestrator, runtimeAdapters: { codex: harness } as never },
    rig.id, () => true);

    let nowMs = T0;
    const live = new Set(["dev-impl@ka-rig"]);
    const tmux = { probeSession: async (name: string) => ({ state: live.has(name) ? "present" : "absent" }) } as unknown as TmuxAdapter;
    const relaunch = vi.fn(async (): Promise<NarrowLaunchResult> => ({ ok: false, code: "no_matching_nodes", message: "not expected" }));
    const keep = new KeepAliveSupervisor({
      db, eventBus: setup.eventBus,
      reconciler: new Reconciler({ db, sessionRegistry: setup.sessionRegistry, eventBus: setup.eventBus, tmuxAdapter: tmux, readProcesses: async () => [] }),
      restoreOrchestrator: { launchSingleNode: relaunch as never }, backoffMs: BACKOFF, stableMs: STABLE, now: () => new Date(nowMs),
      onTickError: (err) => { throw err; },
    });
    const sessions = () => setup.sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    return {
      setup, node, fallen, freshLaunch, harness, restored, keep, relaunch, sessions,
      budget: () => db.prepare("SELECT * FROM node_keep_alive_budget WHERE node_id = ?").get(node.id) as
        { incident_id: string; attempts: number; exhausted_at: string | null; recovered_at: string | null; launched_session_id: string | null;
          last_outcome: string | null } | undefined,
      recovered: () => (db.prepare("SELECT payload FROM events WHERE type = 'seat.keep_alive.recovered'").all() as { payload: string }[]).length,
      tick: async (advanceMs = 0) => { nowMs += advanceMs; await keep.runTickNow(); },
    };
  }

  // Item 2 of the review: the recipe-backed fresh replacement's own session is the one adopted, not the retired shell.
  it.each(["open", "exhausted"] as const)("adopts the recipe-backed fresh replacement into an %s incident, and ends it only once a tick has seen it run stable", async (incident) => {
    const r = await restoredIncident(incident, true);
    expect(r.restored).toEqual({ errors: [] });
    expect(r.freshLaunch).toHaveBeenCalledOnce();
    expect(r.harness.launchHarness).toHaveBeenCalledOnce();
    const [provisional, replacement] = r.sessions().filter((s) => s.id !== r.fallen.id);
    expect(provisional!.status).toBe("superseded");
    expect(replacement!.status).toBe("running");
    expect(replacement!.startupStatus).toBe("ready");
    expect(r.budget()).toMatchObject({ incident_id: "incident-1", launched_session_id: replacement!.id, last_outcome: "adopted",
      attempts: incident === "exhausted" ? 2 : 1 });

    // The first tick sees it running: the incident and its budget carry on until the stable period has been seen.
    await r.tick(BACKOFF);
    expect(r.budget()).toMatchObject({ incident_id: "incident-1", launched_session_id: replacement!.id,
      attempts: incident === "exhausted" ? 2 : 1 });
    expect(r.budget()!.recovered_at).not.toBeNull();
    if (incident === "exhausted") expect(r.budget()!.exhausted_at).not.toBeNull();
    await r.tick(STABLE - 1);
    expect(r.budget()).toMatchObject({ incident_id: "incident-1" });
    await r.tick(1);
    expect(r.budget()).toBeUndefined();
    expect(r.relaunch).not.toHaveBeenCalled();
  });

  // Item 3 of the review: a session left as a bare shell, its harness not started, is not a recovered agent.
  it.each(["open", "exhausted"] as const)("a session the restore left as a bare shell neither recovers nor ends an %s incident until its startup completes", async (incident) => {
    const r = await restoredIncident(incident, false);
    expect(r.freshLaunch).not.toHaveBeenCalled();
    const [shell] = r.sessions().filter((s) => s.id !== r.fallen.id);
    expect(shell!.status).toBe("running");
    expect(shell!.startupStatus).toBe("attention_required");
    expect(r.budget()).toMatchObject({ launched_session_id: shell!.id, last_outcome: "adopted" });

    for (let i = 0; i < 3; i++) await r.tick(STABLE);
    expect(r.budget()).toMatchObject({ incident_id: "incident-1", launched_session_id: shell!.id, recovered_at: null,
      attempts: incident === "exhausted" ? 2 : 1 });
    expect(r.recovered()).toBe(0);
    expect(r.relaunch).not.toHaveBeenCalled();

    // Once its harness's startup has completed (a person brought the agent up in the pane and cleared the attention),
    // the same session recovers, and ends the incident after a tick has seen it run for the stable period.
    r.setup.sessionRegistry.updateStartupStatus(shell!.id, "ready", new Date().toISOString());
    await r.tick(BACKOFF);
    expect(r.budget()!.recovered_at).not.toBeNull();
    expect(r.recovered()).toBe(incident === "open" ? 1 : 0);
    await r.tick(STABLE - 1);
    expect(r.budget()).toMatchObject({ incident_id: "incident-1" });
    await r.tick(1);
    expect(r.budget()).toBeUndefined();
    expect(r.relaunch).not.toHaveBeenCalled();
  });
});
