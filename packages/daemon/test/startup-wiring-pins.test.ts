// P16 — STARTUP-WIRING PIN GRADUATION (the UNINJECTED-SERVICE class, twice
// recurred: validateRig-uninjected + the dead occupant-invalidator). A service
// with an optional safety dep passes every unit test while production startup
// silently never injects it — the feature is OFF in prod and nothing notices.
//
// These pins drive the REAL createDaemon composition ONCE and assert, per
// SAFETY-classified optional dep, that the production injection actually
// happened. A pin here failing means a startup edit un-wired a safety feature.
//
// The census (P16 sweep, 2026-08-07) also found FIVE deps that are UNINJECTED
// TODAY — those are it.todo ledger entries at the bottom (routed to the desk as
// findings; a passing pin would freeze the defect). When a finding's fix lands,
// its todo graduates to a real pin.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../src/startup.js";
import { seatRuntimeDir } from "../src/domain/seat-runtime-dir.js";
import type { AppDeps } from "../src/server.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ExecFn } from "../src/domain/tmux-adapter.js";
import type Database from "better-sqlite3";
import type { ContextMonitor } from "../src/domain/context-monitor.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { getActiveRotationCount, startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";
import type { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import type { SeatPoolPolicyDeps } from "../src/domain/policies/seat-pool.js";
import { readSeatPoolHold, type SeatPoolExecutor, type SeatPoolExecutorDeps } from "../src/domain/seat-pool-executor.js";
import { QueueRepositoryError } from "../src/domain/queue-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SeatPoolSlotsRepository } from "../src/domain/seat-pool-slots.js";
import { runSeatPoolDispatchGuard } from "../src/domain/seat-pool-dispatch-guard.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

// What production startup hands the watchdog's delivery and two of its policies, recorded on the way through to the
// real factories (nothing else changes): their queue-only seams are closures with no other handle.
const composed = vi.hoisted(() => ({
  deliver: [] as unknown[], idleGate: [] as unknown[], parkedOwner: [] as unknown[], seatPool: [] as unknown[], seatPoolRegistration: [] as string[],
  seatPoolExecutor: [] as Array<{ deps: unknown; executor: unknown }>,
}));
vi.mock("../src/domain/watchdog-delivery.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/domain/watchdog-delivery.js")>();
  return { ...real, makeWatchdogDeliver: (deps: Parameters<typeof real.makeWatchdogDeliver>[0]) => { composed.deliver.push(deps); return real.makeWatchdogDeliver(deps); } };
});
vi.mock("../src/domain/policies/idle-gate-qitem.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/domain/policies/idle-gate-qitem.js")>();
  return { ...real, makeIdleGateQitemPolicy: (deps: Parameters<typeof real.makeIdleGateQitemPolicy>[0]) => { composed.idleGate.push(deps); return real.makeIdleGateQitemPolicy(deps); } };
});
vi.mock("../src/domain/policies/parked-owner-consumer.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/domain/policies/parked-owner-consumer.js")>();
  return { ...real, makeParkedOwnerConsumerPolicy: (deps: Parameters<typeof real.makeParkedOwnerConsumerPolicy>[0]) => { composed.parkedOwner.push(deps); return real.makeParkedOwnerConsumerPolicy(deps); } };
});
// Any call into the seat pool registration module, which nothing in the daemon calls while the job is unarmed.
vi.mock("../src/domain/seat-pool-registration.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/domain/seat-pool-registration.js")>();
  const spy = <F extends (...args: never[]) => unknown>(name: string, fn: F) =>
    ((...args: Parameters<F>) => { composed.seatPoolRegistration.push(name); return fn(...args); }) as F;
  return {
    ...real,
    ensureSeatPoolJob: spy("ensureSeatPoolJob", real.ensureSeatPoolJob),
    reconcileSeatPoolNode: spy("reconcileSeatPoolNode", real.reconcileSeatPoolNode),
    reconcileSeatPoolsAtStartup: spy("reconcileSeatPoolsAtStartup", real.reconcileSeatPoolsAtStartup),
  };
});
vi.mock("../src/domain/seat-pool-executor.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/domain/seat-pool-executor.js")>();
  return {
    ...real,
    makeSeatPoolExecutor: (deps: Parameters<typeof real.makeSeatPoolExecutor>[0]) => {
      const executor = real.makeSeatPoolExecutor(deps);
      composed.seatPoolExecutor.push({ deps, executor });
      return executor;
    },
  };
});
vi.mock("../src/domain/policies/seat-pool.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/domain/policies/seat-pool.js")>();
  return { ...real, makeSeatPoolPolicy: (deps: Parameters<typeof real.makeSeatPoolPolicy>[0]) => { composed.seatPool.push(deps); return real.makeSeatPoolPolicy(deps); } };
});

let db: Database.Database;
let deps: AppDeps;
let contextMonitor: ContextMonitor;
let scratch: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // D15 isolation: the composition writes real state — anchor it in scratch.
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "p16-wiring-"));
  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL", "TMUX_TMPDIR"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.OPENRIG_HOME = path.join(scratch, "home");
  process.env.OPENRIG_DB = path.join(scratch, "stale.sqlite");
  process.env.TMUX_TMPDIR = path.join(scratch, "tmux");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  const cmuxFactory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  const tmuxExec: ExecFn = async () => "";
  // A file DB composes the slow-op recorder that :memory: deliberately skips.
  // A relative selection must still reach seats whose cwd differs from the daemon.
  const result = await createDaemon({ cmuxFactory, tmuxExec, dbPath: path.relative(process.cwd(), path.join(scratch, "selected.sqlite")) });
  db = result.db;
  deps = result.deps;
  contextMonitor = result.contextMonitor;
}, 60000);

afterAll(() => {
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Reach a private field for a WIRING assertion (presence, never behavior). */
function priv<T>(obj: unknown, key: string): T {
  return (obj as Record<string, T>)[key] as T;
}

describe("P16 — AppDeps members with safety semantics are composed (definedness pins)", () => {
  const MEMBERS: Array<keyof AppDeps> = [
    "queueRepo", "inboxHandler", "outboxHandler", "sessionTransport",
    "transcriptStore", "providerService", "seatIdentityReconciler",
    "seatActivityService", "watchdogJobsRepo", "watchdogHistoryLog",
    "watchdogPolicyEngine", "watchdogScheduler", "periodicSnapshotScheduler",
    "workflowRuntime", "selfAttachService", "rigLifecycleService",
    "resumeMetadataRefresher", "runtimeAdapters",
    "seatStructuralActivityService",
    "streamStore", "askService", "wakeResolveService", "projectClassifier",
    "classifierLeaseManager", "classificationAttemptLedger", "viewProjector", "tmuxOptionDefaults",
  ];
  for (const member of MEMBERS) {
    it(`deps.${String(member)} is constructed by production startup`, () => {
      expect(deps[member], `AppDeps.${String(member)} must be composed by createDaemon`).toBeDefined();
    });
  }
});

describe("P16 — domain-internal safety injections (the recurred class, pinned at the wire)", () => {
  it("new seats receive the daemon's runtime directory default (#2030)", () => {
    expect(deps.tmuxAdapter.launchEnvironment!()).toHaveProperty("runtimeDir", seatRuntimeDir(process.env));
  });
  it("new seats receive the selected database and configured tmux directory, not a stale DB override", () => {
    const env = deps.tmuxAdapter.launchEnvironment!().env;
    expect(env.OPENRIG_DB).toBe(path.resolve(db.name));
    expect(env.OPENRIG_DB).not.toBe(process.env.OPENRIG_DB);
    expect(env.TMUX_TMPDIR).toBe(process.env.TMUX_TMPDIR);
    const selected = priv<Record<string, string>>(deps.nodeLauncher, "sessionEnv");
    expect(selected.OPENRIG_DB).toBe(path.resolve(db.name));
    expect(selected.TMUX_TMPDIR).toBe(process.env.TMUX_TMPDIR);
    const seatCwd = path.join(scratch, "seat"); fs.mkdirSync(seatCwd);
    const fromSeat = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').realpathSync(process.env.OPENRIG_DB))"], {
      cwd: seatCwd, env: { ...process.env, ...selected }, encoding: "utf8",
    });
    expect(fromSeat).toBe(fs.realpathSync(db.name));
  });

  it("QueueRepository keeps recording separate from topology-backed receiver selection", async () => {
    const destination = "b@definitely-unregistered-rig";
    expect(deps.queueRepo!.acceptsDestination(destination)).toBe(false);
    const item = await deps.queueRepo!.create({
      sourceSession: "a@known-nowhere", destinationSession: destination,
      body: "wiring probe", nudge: false,
    });
    expect(deps.queueRepo!.getById(item.qitemId)?.destinationSession).toBe(destination);
    expect(deps.queueRepo!.acceptsDestination(destination)).toBe(false);
    expect(deps.queueRepo!.destinationAdvisory(destination)?.status).toBe("missing");
  });

  it("QueueRepository.workflowFrontierPredicate is injected (the close-path guard)", () => {
    expect(priv(deps.queueRepo, "workflowFrontierPredicate")).toBeTruthy();
  });

  it("SessionTransport carries the eventBus (dangerous-override audit fails closed without it)", () => {
    expect(priv(deps.sessionTransport, "eventBus")).toBeTruthy();
  });

  it("SessionTransport carries the slow-op recorder (composed conditionally at startup:238 — a real-db daemon must have it)", () => {
    expect(priv(deps.sessionTransport, "slowOpRecorder")).toBeTruthy();
  });

  it("ContextMonitor carries the compaction enforcer (threshold->action detector)", () => {
    expect(priv(contextMonitor, "compactionEnforcer")).toBeTruthy();
  });

  it.todo("51-08 (graduates at the slice fold): ContextMonitor carries usageSamples + providerWindowSampler — pin flips live when hv/51-08-telemetry lands; asserting now would pin a wiring main does not yet carry");

  it("ClassifierLeaseManager.isAlive is attached post-construction (the lease-liveness seam)", () => {
    expect(priv(deps.classifierLeaseManager, "isAlive")).toBeTruthy();
  });

  it("QueueRepository transport is attached post-construction (the wake path)", () => {
    expect(priv(deps.queueRepo, "transport")).toBeTruthy();
  });

  it("a session's end stops its transcript capture (the rotation is subscribed to session events)", () => {
    const capture = { capturePaneContent: async () => "" } as unknown as TmuxAdapter;
    const names = ["stopped@wiring-pin", "removed@wiring-pin", "cleaned@wiring-pin"];
    try {
      for (const name of names) startTranscriptRotation(capture, name, path.join(scratch, `${name}.log`), { lines: 1, pollIntervalMs: 60_000 });
      const before = getActiveRotationCount();
      deps.eventBus.emit({ type: "session.stopped", rigId: "r", nodeId: "n1", sessionName: names[0]!, reason: "pin", operator: null });
      deps.eventBus.emit({ type: "session.detached", rigId: "r", nodeId: "n2", sessionName: names[1]! });
      deps.eventBus.emit({ type: "session.cleaned", rigId: "r", nodeId: "n3", sessionName: names[2]!, reason: "pin", operator: null,
        actions: { sessionsExited: [names[2]!], bindingCleared: true } });
      expect(getActiveRotationCount()).toBe(before - names.length);
    } finally {
      for (const name of names) stopTranscriptRotation(name);
    }
  });
});

describe("a queue-only seat's watchdog reminders go through its queue, as startup composes them (#3076)", () => {
  type DeliverDeps = Parameters<typeof makeWatchdogDeliver>[0];
  type SeatCheck = { isQueueOnlySeat?: (sessionName: string) => boolean };
  const deliverDeps = () => composed.deliver.at(-1) as DeliverDeps;
  const typist = "typist@pin-rig";
  beforeAll(async () => {
    db.exec(`INSERT INTO rigs(id,name) VALUES ('pin-rig','pin-rig');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('pin-node','pin-rig','typist','claude-code');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('pin-binding','pin-node','${typist}','%9');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('pin-session','pin-node','${typist}','running');`);
    await deps.tmuxAdapter.deliveryGuard!.set("pin-node", { mode: "queue-only" }, "person@pin-rig", "a person types here");
  });

  it("the delivery, the idle-gate policy and the parked-owner policy each read the seat's typing guard", () => {
    expect(composed.deliver).toHaveLength(1);
    for (const check of [deliverDeps(), composed.idleGate.at(-1) as SeatCheck, composed.parkedOwner.at(-1) as SeatCheck]) {
      expect(check.isQueueOnlySeat?.(typist)).toBe(true);
      expect(check.isQueueOnlySeat?.("nobody@pin-nowhere")).toBe(false);
    }
  });

  it("a reminder's cold row is OpenRig's, with no nudge: nothing wakes the seat", async () => {
    const create = vi.spyOn(deps.queueRepo!, "create");
    try {
      const row = await deliverDeps().createQueueRow!({ qitemId: "qitem-watchdog-pin", destinationSession: typist, body: "Check the deploy.",
        summary: "Watchdog (periodic-reminder): Check the deploy.", tags: ["watchdog", "queue-only"] });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceSession: "watchdog@system", nudge: false, wakeTrigger: "openrig" }));
      expect(row).toEqual({ qitemId: "qitem-watchdog-pin", state: "pending" });
      expect(deps.queueRepo!.getById(row.qitemId)).toMatchObject({ sourceSession: "watchdog@system", destinationSession: typist });
      expect(deps.queueRepo!.getById(row.qitemId)!.lastNudgeAttempt ?? null).toBeNull();
    } finally { create.mockRestore(); }
  });

  it("the parked rows a reminder is noted on, and the notes, are the queue repository's", () => {
    const parked = vi.spyOn(deps.queueRepo!, "parkedRowsOwnedBy").mockReturnValue(["qitem-parked-pin"]);
    const noted = vi.spyOn(deps.queueRepo!, "noteParkedRows").mockReturnValue(["qitem-parked-pin"]);
    const again = vi.spyOn(deps.queueRepo!, "noteOpenWatchdogRow").mockReturnValue("qitem-watchdog-pin");
    try {
      expect(deliverDeps().resolveParkedRows!({ jobId: "pin-job", targetSession: typist })).toEqual(["qitem-parked-pin"]);
      expect(parked).toHaveBeenCalledWith("pin-job", typist);
      const notes = [{ qitemId: "qitem-parked-pin", jobId: "pin-job", note: "n" }];
      expect(deliverDeps().noteParkedRows!({ owner: typist, notes })).toEqual(["qitem-parked-pin"]);
      expect(noted).toHaveBeenCalledWith(typist, notes);
      expect(deliverDeps().noteQueuedRow!({ jobId: "pin-job", destinationSession: typist, note: "again" })).toBe("qitem-watchdog-pin");
      expect(again).toHaveBeenCalledWith("pin-job", typist, "again");
    } finally { parked.mockRestore(); noted.mockRestore(); again.mockRestore(); }
  });
});

describe("the seat-pool job stays unarmed until the activation change (#3395)", () => {
  it("Startup composes the seat-pool policy and leaves it unarmed: the watchdog engine does not resolve `seat-pool`, daemon start registers no seat-pool job, and a seat-pool job registered by hand ends `terminal` with `unknown_policy:seat-pool` at its first evaluation.", async () => {
    // the executor the policy hands each evaluation to reads the model node's stored block and its slot rows
    expect(composed.seatPool).toHaveLength(1);
    expect(composed.seatPoolExecutor).toHaveLength(1);
    const executorDeps = composed.seatPoolExecutor[0]!.deps as SeatPoolExecutorDeps;
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("pin-pool");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
    const block = { max: 3, min: 1, dispatchAfterSeconds: 45, idleGraceSeconds: 120, cooldownSeconds: 90, dispatchTag: null, cwdTemplate: null, drain: false };
    const model = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: pod.id, pool: { spec: block } });
    const agent = rigRepo.addNode(rig.id, "dev.impl-s1", { runtime: "claude-code", podId: pod.id });
    const slots = new SeatPoolSlotsRepository(db);
    slots.insert({ modelNodeId: model.id, slotNumber: 1, nodeId: agent.id, phase: "live", at: "2026-11-18T10:00:00.000Z" });
    expect(executorDeps.rigRepo.getNodePool(model.id)).toEqual({ spec: block });
    expect(executorDeps.slots.forModel(model.id)).toEqual(slots.forModel(model.id));
    expect(executorDeps.slots.forModel(model.id).map((s) => s.nodeId)).toEqual([agent.id]);

    // unarmed: the engine does not have the policy, and daemon start called no registration
    const engine = deps.watchdogPolicyEngine!;
    const jobs = deps.watchdogJobsRepo!;
    expect(engine.resolvePolicy("seat-pool")).toBeUndefined();
    expect(composed.seatPoolRegistration).toEqual([]);
    expect(jobs.listAll().filter((job) => job.policy === "seat-pool")).toEqual([]);

    const job = jobs.register({
      policy: "seat-pool",
      specYaml: "policy: seat-pool\ntarget:\n  session: dev-impl@pin-pool\n",
      targetSession: "dev-impl@pin-pool",
      intervalSeconds: 60,
      registeredBySession: "person@pin-pool",
    });
    expect(job.state).toBe("active");
    const result = await engine.evaluate(job);
    expect(result.outcome).toEqual({ action: "terminal", reason: "unknown_policy:seat-pool" });
    expect(jobs.getById(job.jobId)).toMatchObject({ state: "terminal", terminalReason: "unknown_policy:seat-pool" });
  });
});

describe("the seat-pool executor's composition (#3395)", () => {
  it("Startup composes the seat-pool executor with the daemon's queue, outbox, delivery guard, seat activity and events, and the policy hands each evaluation to it.", async () => {
    expect(composed.seatPoolExecutor).toHaveLength(1);
    const { deps: raw, executor } = composed.seatPoolExecutor[0]!;
    const executorDeps = raw as SeatPoolExecutorDeps;
    expect(executorDeps.db).toBe(db);
    expect(executorDeps.jobsRepo).toBe(deps.watchdogJobsRepo);

    // a node of its own, with a running session, so the delivery guard resolves it
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("pin-exec");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
    const execNode = rigRepo.addNode(rig.id, "dev.exec", { runtime: "claude-code", podId: pod.id });
    const sessions = new SessionRegistry(db);
    sessions.updateStatus(sessions.registerSession(execNode.id, "dev-exec@pin-exec").id, "running");

    const route = vi.spyOn(deps.queueRepo!, "routeToFallback").mockReturnValue({} as never);
    const obligations = vi.spyOn(deps.queueRepo!, "listOpenObligations");
    const list = vi.spyOn(deps.queueRepo!, "list");
    const held = vi.spyOn(deps.outboxHandler!, "heldCount").mockReturnValue(3);
    const custody = vi.spyOn(deps.tmuxAdapter.deliveryGuard!, "custody");
    const seatState = vi.spyOn(deps.seatActivityService!, "getSeatState").mockReturnValue(null);
    const cycle = vi.spyOn(executor as SeatPoolExecutor, "cycle").mockResolvedValue({ action: "skip", reason: "seat_pool_report" });
    try {
      // the queue: the move, with its compare-and-set and wake, and a refusal kept with the queue's code
      expect(await executorDeps.queue.moveRow({ qitemId: "q-pin", from: "a@pin-pool", to: "b@pin-pool", reason: "r" })).toEqual({ ok: true });
      expect(route).toHaveBeenCalledWith("q-pin", "b@pin-pool", "r", { expectState: "pending", expectDestination: "a@pin-pool", wake: true });
      route.mockImplementation(() => { throw new QueueRepositoryError("fallback_state_mismatch", "m"); });
      expect(await executorDeps.queue.moveRow({ qitemId: "q-pin", from: "a@pin-pool", to: "b@pin-pool", reason: "r" }))
        .toEqual({ ok: false, code: "fallback_state_mismatch", message: "m" });
      // the queue: the two reads
      executorDeps.queue.openRows("x@pin-pool");
      expect(obligations).toHaveBeenCalledWith("x@pin-pool", expect.any(Number));
      executorDeps.queue.pendingRows("x@pin-pool");
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ destinationSession: "x@pin-pool", state: "pending" }));
      // the outbox's held messages
      expect(executorDeps.heldCount("n")).toBe(3);
      expect(held).toHaveBeenCalledWith("n");
      // the delivery guard's custody
      expect(await executorDeps.custody([execNode.id], async () => "ran")).toBe("ran");
      expect(custody).toHaveBeenCalledWith([execNode.id], expect.any(Function));
      // the seat activity, and the node executor's confirmed stop
      expect(executorDeps.seatState(execNode.id)).toBeNull();
      expect(seatState).toHaveBeenCalledWith(execNode.id);
      expect(executorDeps.confirmedStopped(execNode.id)).toBe(false);
      new SeatIdentityStore(db).upsert({
        nodeId: execNode.id, sessionName: "dev-exec@pin-exec", verdict: "pane_missing", reason: "pane_exited", evidenceSource: "tmux_session",
        evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
        observedAt: new Date(Date.now() + 1000).toISOString(),
      });
      expect(executorDeps.confirmedStopped(execNode.id)).toBe(true);
      // the events: the rig's rig.stopped is the hold
      const stopped = deps.eventBus.emit({ type: "rig.stopped", rigId: rig.id });
      expect(readSeatPoolHold(executorDeps.db, rig.id).stoppedSeq).toBe(stopped.seq);
      // the policy hands each evaluation to the executor
      await (composed.seatPool[0] as SeatPoolPolicyDeps).cycle({ jobId: "j", context: {} });
      expect(cycle).toHaveBeenCalledWith({ jobId: "j", context: {} });
    } finally {
      route.mockRestore(); obligations.mockRestore(); list.mockRestore(); held.mockRestore();
      custody.mockRestore(); seatState.mockRestore(); cycle.mockRestore();
    }
  });
});

describe("the seat-pool drain's composition (#3395)", () => {
  it("Startup composes the seat-pool drain with the delivery guard's lifecycle lease, the resume metadata refresh of the drained session, the snapshot capture's `auto-rehydrate` kind and the seat lifecycle service's checked stop.", async () => {
    expect(composed.seatPoolExecutor).toHaveLength(1);
    const drain = (composed.seatPoolExecutor[0]!.deps as SeatPoolExecutorDeps).drain;
    expect(drain).toBeDefined();

    // a node of its own, with a running session, so the delivery guard resolves it
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("pin-drain");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "dev.drain", { runtime: "claude-code", podId: pod.id });
    const sessions = new SessionRegistry(db);
    const sessionId = sessions.registerSession(node.id, "dev-drain@pin-drain").id;
    sessions.updateStatus(sessionId, "running");
    // another live session of the rig, which the drain does not stop
    const other = rigRepo.addNode(rig.id, "dev.other", { runtime: "claude-code", podId: pod.id });
    sessions.updateStatus(sessions.registerSession(other.id, "dev-other@pin-drain").id, "running");

    const lifecycle = vi.spyOn(deps.tmuxAdapter.deliveryGuard!, "lifecycle");
    const refresh = vi.spyOn(deps.resumeMetadataRefresher!, "refresh").mockResolvedValue(undefined as never);
    const capture = vi.spyOn(deps.snapshotCapture, "captureSnapshot").mockReturnValue({ id: "snap-pin" } as never);
    const stop = vi.spyOn(SeatLifecycleService.prototype, "stopSeat")
      .mockResolvedValue({ ok: false, code: "stop_uncertain", message: "m", partialEffect: true });
    try {
      // the delivery guard's lifecycle lease
      expect(await drain!.lifecycle([node.id], async () => "ran")).toBe("ran");
      expect(lifecycle).toHaveBeenCalledWith([node.id], expect.any(Function));
      // the resume metadata refresh rig down runs before its snapshot, of the drained session only
      await drain!.refresh({ rigId: rig.id, nodeId: node.id, sessionId });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]![0].map((s) => s.sessionId)).toEqual([sessionId]);
      // the snapshot capture, as an auto-rehydrate snapshot of the rig
      expect(drain!.capture(rig.id)).toEqual({ snapshotId: "snap-pin" });
      expect(capture).toHaveBeenCalledWith(rig.id, "auto-rehydrate");
      // the checked stop: the expected session is passed through, and a refusal keeps its code, message and partial effect
      const expected = { nodeId: node.id, sessionId: "session-1" };
      expect(await drain!.stopSeat({ seatRef: "dev-drain@pin-drain", reason: "r", expected }))
        .toEqual({ ok: false, code: "stop_uncertain", message: "m", partialEffect: true });
      expect(stop).toHaveBeenCalledWith({ seatRef: "dev-drain@pin-drain", reason: "r", operator: null, expected });
      stop.mockResolvedValueOnce({ ok: true } as never);
      expect(await drain!.stopSeat({ seatRef: "dev-drain@pin-drain", reason: "r", expected })).toEqual({ ok: true });
      // the drain's own recheck reaches the checked stop
      const recheck = () => null;
      stop.mockResolvedValueOnce({ ok: true } as never);
      await drain!.stopSeat({ seatRef: "dev-drain@pin-drain", reason: "r", expected, recheck });
      expect(stop).toHaveBeenLastCalledWith({ seatRef: "dev-drain@pin-drain", reason: "r", operator: null, expected, recheck });
    } finally {
      lifecycle.mockRestore(); refresh.mockRestore(); capture.mockRestore(); stop.mockRestore();
    }
  });
});

describe("the seat-pool add's composition (#3395)", () => {
  it("Startup composes the seat-pool add with the daemon's export of a member and the member add of `rig add` (convergeOp over the daemon's instantiator), and the executor reserves its operation ids in the daemon's database.", async () => {
    expect(composed.seatPoolExecutor).toHaveLength(1);
    const executorDeps = composed.seatPoolExecutor[0]!.deps as SeatPoolExecutorDeps;
    // without these the executor skips the whole add stage
    expect(executorDeps.add).toBeDefined();
    const add = executorDeps.add!;
    expect(typeof add.exportMember).toBe("function");
    expect(typeof add.converge).toBe("function");
    expect(typeof add.makeFolder).toBe("function");
    expect(executorDeps.rigRepo.getNodeLaunchRecipe).toBeTypeOf("function");

    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("pin-add");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
    const model = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: pod.id, cwd: scratch });
    rigRepo.setNodeStatuslineThrottle(model.id, 30);

    const exported = vi.spyOn(deps.rigSpecExporter, "exportedRawMemberFromNode");
    const addMember = vi.spyOn(deps.podInstantiator, "addMemberToPod")
      .mockResolvedValue({ ok: false, code: "rig_not_found", message: "pinned" });
    try {
      // the export: the model member in the spec's own keys, from the daemon's exporter
      const member = add.exportMember(rig.id, model.id);
      expect(exported).toHaveBeenCalledWith(rig.id, model.id);
      expect(member).toMatchObject({ id: "impl", runtime: "claude-code", cwd: scratch, statusline_throttle: 30 });
      // the member add: convergeOp over the daemon's instantiator, with the operation's recordCreated
      const recordCreated = vi.fn();
      const converged = await add.converge(rig.id, { kind: "add_member", pod: "dev", member: { ...member, id: "impl-s1" } }, "/rig/root", { recordCreated });
      expect(converged).toEqual({ kind: "add_member", supported: true, outcome: { ok: false, code: "rig_not_found", message: "pinned" } });
      expect(addMember).toHaveBeenCalledWith(rig.id, "dev", { ...member, id: "impl-s1" }, "/rig/root", expect.objectContaining({ recordCreated }));
      // the folder of a cwd_template, created and nothing else
      const folder = path.join(scratch, "pool-slots", "pin-add", "impl-s1");
      add.makeFolder(folder);
      expect(fs.readdirSync(folder)).toEqual([]);
      // the operation ids go to the daemon's own database: the executor reserves them in its db, the daemon's
      expect(executorDeps.db).toBe(db);
    } finally {
      exported.mockRestore(); addMember.mockRestore();
    }
  });
});

describe("the seat-pool dispatch guard's composition (#4061)", () => {
  it("Startup composes the seat-pool executor with the daemon's dispatch guard runner, which runs the block's `dispatch_guard` as an argv.", () => {
    expect(composed.seatPoolExecutor).toHaveLength(1);
    const executorDeps = composed.seatPoolExecutor[0]!.deps as SeatPoolExecutorDeps;
    expect(executorDeps.dispatchGuard).toBe(runSeatPoolDispatchGuard);
  });
});

describe("the seat-pool comeback's composition (#3395)", () => {
  it("Startup composes the seat-pool comeback with the snapshot repository's comeback selection and the restore orchestrator's launchSingleNode, always with the explicit snapshotId, the daemon's runtime adapters and the filesystem, and the executor exposes its own `comeback`.", async () => {
    expect(composed.seatPoolExecutor).toHaveLength(1);
    const { deps: composedDeps, executor } = composed.seatPoolExecutor[0]! as { deps: SeatPoolExecutorDeps; executor: { comeback?: unknown } };
    // without these the executor brings no drained slot back
    const comeback = composedDeps.comeback;
    expect(comeback).toBeDefined();
    expect(typeof executor.comeback).toBe("function");

    const selection = { chosen: null, read: 2, failed: [] };
    const select = vi.spyOn(deps.snapshotRepo, "selectComebackSnapshot").mockReturnValue(selection);
    const launched = { ok: false, code: "snapshot_not_found", message: "pinned" };
    const launch = vi.spyOn(deps.restoreOrchestrator, "launchSingleNode").mockResolvedValue(launched);
    try {
      // the selection: the daemon's own snapshot repository
      expect(comeback!.select("rig-pin", "node-pin", "dev.impl-s1")).toBe(selection);
      expect(select).toHaveBeenCalledWith("rig-pin", "node-pin", "dev.impl-s1");
      // the launch: launchSingleNode with the explicit snapshot id, the runtime adapters and the filesystem
      expect(await comeback!.launch("rig-pin", "dev.impl-s1", { snapshotId: "snap-pin" })).toBe(launched);
      expect(launch).toHaveBeenCalledTimes(1);
      const [rigId, logicalId, opts] = launch.mock.calls[0]!;
      expect([rigId, logicalId]).toEqual(["rig-pin", "dev.impl-s1"]);
      expect(opts).toEqual({ snapshotId: "snap-pin", adapters: expect.any(Object), fsOps: { exists: expect.any(Function) } });
      expect(Object.keys(opts!.adapters!)).toEqual(expect.arrayContaining(["claude-code", "codex", "terminal"]));
      expect(opts!.fsOps!.exists(scratch)).toBe(true);
      expect(opts!.fsOps!.exists(path.join(scratch, "no-such-path"))).toBe(false);
    } finally {
      select.mockRestore(); launch.mockRestore();
    }
  });
});

describe("P16 — UNINJECTED-SERVICE findings ledger (routed to desk; todo graduates to a pin when the fix lands)", () => {
  it.todo("FINDING A1: SeatHandoverService.occupantInvalidator UNINJECTED (routes/seat.ts construction) — every handover commits with zero state invalidation; ghost-stage atom-B lane owns the impl");
  it.todo("FINDING A2: projection-planner resolveTargetPath UNINJECTED (rigspec-instantiator.ts:1672) — hash_conflict classification dead; operator-modified files silently overwritten");
  it.todo("FINDING A3: InboxHandler.authenticate UNINJECTED (startup.ts:950) — sender-spoofing gate is allow-all; route forwards client-supplied authenticatedSender");
  it.todo("FINDING A4: WorkflowValidator seatLivenessCheck never constructed — role_no_live_preferred_target advisory dead; instances stall at step 1 unwarned");
  it("A5 GRADUATED (P19): AskService's PsProjectionService carries seatActivity — one terminalActive truth across both paths", () => {
    const ps = priv<unknown>(deps.askService, "deps") as { psProjectionService: unknown };
    expect(priv(ps.psProjectionService, "seatActivity"), "the ask path must inject seatActivity like the attention path does").toBeTruthy();
  });

  it("SLOW-OP REQUEST MIDDLEWARE WIRED: server.ts app.use's the createSlowOpRequestMiddleware seam", () => {
    // The middleware CONTRACT moved to hermetic unit tests (slow-op-recorder.test), which cannot cover
    // 'the real server actually uses this middleware' — the uninjected-service enable-path gap. This pin
    // closes it at the source: the seam must be imported AND app.use'd (an import alone leaves the
    // request observer dead in prod).
    const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(src, "server.ts must import the extracted seam").toContain("createSlowOpRequestMiddleware");
    expect(src, "server.ts must app.use the seam, not just import it").toMatch(
      /app\.use\(\s*["']\*["']\s*,\s*createSlowOpRequestMiddleware\(/,
    );
  });
});
