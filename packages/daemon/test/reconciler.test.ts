import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmuxAdapter(
  sessionExists: Record<string, boolean>,
  errors?: Record<string, Error>
): TmuxAdapter {
  const hasSession = async (name: string) => {
    if (errors?.[name]) {
      throw errors[name];
    }
    return sessionExists[name] ?? false;
  };
  return {
    hasSession,
    probeSession: async (name: string) =>
      (await hasSession(name)) ? { state: "present" as const } : { state: "absent" as const },
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("Reconciler", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function createReconciler(tmux: TmuxAdapter) {
    return new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  }

  function seedRigWithSessions(statuses: { logicalId: string; sessionName: string; status: string }[]) {
    const rig = rigRepo.createRig("r01");
    const nodes: { id: string; logicalId: string }[] = [];
    for (const s of statuses) {
      const node = rigRepo.addNode(rig.id, s.logicalId, { role: "worker" });
      const session = sessionRegistry.registerSession(node.id, s.sessionName);
      sessionRegistry.updateStatus(session.id, s.status);
      nodes.push({ id: node.id, logicalId: s.logicalId });
    }
    return { rig, nodes };
  }

  it("session still alive: tmux confirms, status stays unchanged", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": true }));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(1);
    expect(result.detached).toBe(0);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });

  it("session gone: status updated to detached + event emitted", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(1);
    expect(result.detached).toBe(1);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("detached");

    // Event persisted
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'session.detached'")
      .all();
    expect(events).toHaveLength(1);

    // Subscriber notified
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("session.detached");
  });

  it("a session counts as detached once its transaction commits, even if notifying afterwards throws", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);
    // The bus catches a subscriber's own error; this stands for a database error in its post-commit drain.
    vi.spyOn(eventBus, "notifySubscribers").mockImplementation(() => { throw new Error("post-commit notify failed"); });

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    const session = sessionRegistry.getSessionsForRig(rig.id)[0]!;
    expect(session.status).toBe("detached");
    expect(result.detached).toBe(1);
    expect(result.detachedSessionIds).toEqual([session.id]);
    expect(result.errors).toEqual([{ sessionId: session.id, error: "post-commit notify failed" }]);
  });

  it("no sessions in DB: no changes, no events", async () => {
    const rig = rigRepo.createRig("r01");
    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(0);

    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("already-detached sessions skipped (not re-checked)", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "detached" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    // Not checked — already detached
    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
  });

  it("already-exited sessions skipped (not re-checked)", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "exited" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
  });

  it("superseded occupant history stays terminal when its old pane is absent", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "superseded" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
    expect(sessionRegistry.getSessionsForRig(rig.id)[0]!.status).toBe("superseded");
    expect(db.prepare("SELECT * FROM events WHERE type = 'session.detached'").all()).toHaveLength(0);
  });

  it("multiple nodes: 3 sessions, 2 alive, 1 gone -> only gone one detached", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "running" },
      { logicalId: "orch1-lead", sessionName: "r01-orch1-lead", status: "running" },
    ]);

    const reconciler = createReconciler(
      mockTmuxAdapter({
        "r01-dev1-impl": true,
        "r01-dev1-qa": false, // gone
        "r01-orch1-lead": true,
      })
    );
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(3);
    expect(result.detached).toBe(1);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const qa = sessions.find((s) => s.sessionName === "r01-dev1-qa");
    expect(qa!.status).toBe("detached");
    const impl = sessions.find((s) => s.sessionName === "r01-dev1-impl");
    expect(impl!.status).toBe("running");
  });

  // #2940: the keep_alive supervisor reconciles only its own seats at runtime; the rest of the rig is left as it is.
  it("nodeIds: only the named nodes' sessions are probed and detached; the other seats stay as they were", async () => {
    const { rig, nodes } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "running" },
    ]);
    const probed: string[] = [];
    const tmux = mockTmuxAdapter({});
    const probe = tmux.probeSession.bind(tmux);
    tmux.probeSession = async (name: string) => { probed.push(name); return probe(name); };

    const result = await createReconciler(tmux).reconcile(rig.id, { nodeIds: [nodes[1]!.id] });

    expect(probed).toEqual(["r01-dev1-qa"]);
    expect(result).toMatchObject({ checked: 1, detached: 1, unseen: [], errors: [] });
    const qa = sessionRegistry.getSessionsForRig(rig.id).find((s) => s.sessionName === "r01-dev1-qa")!;
    expect(result.detachedSessionIds).toEqual([qa.id]);
    expect(qa.status).toBe("detached");
    // Both are gone from tmux, but only the named node was reconciled.
    expect(sessionRegistry.getSessionsForRig(rig.id).find((s) => s.sessionName === "r01-dev1-impl")!.status).toBe("running");
    expect(db.prepare("SELECT node_id FROM events WHERE type = 'session.detached'").all()).toEqual([{ node_id: nodes[1]!.id }]);
  });

  it("nodeIds: an empty list reconciles nothing; without the option every seat is reconciled as before", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "running" },
    ]);
    const reconciler = createReconciler(mockTmuxAdapter({}));
    expect(await reconciler.reconcile(rig.id, { nodeIds: [] })).toMatchObject({ checked: 0, detached: 0 });
    expect(await reconciler.reconcile(rig.id)).toMatchObject({ checked: 2, detached: 2 });
  });

  // #2940: the keep_alive supervisor acts only on a seat that is actually gone. A socket it can't reach doesn't say so.
  it("absenceProof positive: an unreachable tmux leaves the row as it is and reports it undetermined", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "running" },
      { logicalId: "dev1-ops", sessionName: "r01-dev1-ops", status: "running" },
    ]);
    const tmux = mockTmuxAdapter({});
    const cause = "error connecting to /tmp/tmux-1000/default (No such file or directory)";
    tmux.probeSession = async (name: string) => name === "r01-dev1-impl"
      ? { state: "transport_unavailable" as const, cause }
      : name === "r01-dev1-qa"
        ? { state: "transport_unavailable" as const, cause: "no server running on /tmp/tmux-1000/default" }
        : { state: "absent" as const };
    const reconciler = createReconciler(tmux);

    const result = await reconciler.reconcile(rig.id, { absenceProof: "positive" });

    const byName = (name: string) => sessionRegistry.getSessionsForRig(rig.id).find((s) => s.sessionName === name)!;
    expect(byName("r01-dev1-impl").status).toBe("running");
    expect(result.undetermined).toEqual([{ sessionId: byName("r01-dev1-impl").id, sessionName: "r01-dev1-impl", cause }]);
    // No server, or a positive absence, is proof.
    expect(byName("r01-dev1-qa").status).toBe("detached");
    expect(byName("r01-dev1-ops").status).toBe("detached");
    expect(result).toMatchObject({ detached: 2, errors: [] });
  });

  it("#2940: with positive proof asked for, a terminal row is probed without being rewritten, and only proof counts", async () => {
    const { rig, nodes } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "exited" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "superseded" },
      { logicalId: "dev1-ops", sessionName: "r01-dev1-ops", status: "running" },
    ]);
    const byName = (name: string) => sessionRegistry.getSessionsForRig(rig.id).find((s) => s.sessionName === name)!;
    // The ops seat's last observed process can't be checked: the process table is unreadable.
    new SeatIdentityStore(db).upsert({
      nodeId: nodes[2]!.id, verdict: "verified", evidenceSource: null, reason: null,
      evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
      sessionName: "r01-dev1-ops", observedAt: new Date().toISOString(),
    });
    const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: mockTmuxAdapter({ "r01-dev1-qa": true }),
      readProcesses: async () => { throw new Error("ps failed"); } });

    const result = await reconciler.reconcile(rig.id, { absenceProof: "positive" });

    expect(result.provenAbsent).toEqual([byName("r01-dev1-impl").id]);
    expect(result.undetermined).toEqual([
      { sessionId: byName("r01-dev1-qa").id, sessionName: "r01-dev1-qa", cause: "the session is present in tmux" },
      { sessionId: byName("r01-dev1-ops").id, sessionName: "r01-dev1-ops", cause: "the process table couldn't be read" },
    ]);
    expect(["r01-dev1-impl", "r01-dev1-qa", "r01-dev1-ops"].map((name) => byName(name).status)).toEqual(["exited", "superseded", "running"]);
    expect(result).toMatchObject({ detached: 0, errors: [] });
    // Without the option terminal rows are still skipped, as at boot.
    const boot = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: mockTmuxAdapter({ "r01-dev1-qa": true }),
      readProcesses: async () => { throw new Error("ps failed"); } }).reconcile(rig.id);
    expect(boot.provenAbsent).toBeUndefined();
    expect(boot.checked).toBe(1);
  });

  it("#2940: a missing socket starts an empty server only for a seat's latest session whose recorded process is proven gone", async () => {
    const { rig, nodes } = seedRigWithSessions([{ logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" }]);
    const session = sessionRegistry.getSessionsForRig(rig.id)[0]!;
    let serverUp = false;
    const startServer = vi.fn(async () => { serverUp = true; return { ok: true as const }; });
    const tmux = mockTmuxAdapter({});
    tmux.probeSession = async () => serverUp ? { state: "absent" as const }
      : { state: "transport_unavailable" as const, cause: "error connecting to /tmp/tmux-1000/default (No such file or directory)" };
    (tmux as unknown as { startServer: typeof startServer }).startServer = startServer;
    const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, readProcesses: async () => [] });
    const evidenceFor = (sessionName: string) => new SeatIdentityStore(db).upsert({
      nodeId: nodes[0]!.id, verdict: "verified", evidenceSource: null, reason: null,
      evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
      sessionName, observedAt: new Date(Date.now() + 1_000).toISOString(),
    });

    // No evidence, then evidence for another session: nothing proves the seat's server is gone, so none is started.
    for (const evidence of [null, "r01-dev1-impl-earlier"]) {
      if (evidence) evidenceFor(evidence);
      const unknown = await reconciler.reconcile(rig.id, { absenceProof: "positive" });
      expect(startServer).not.toHaveBeenCalled();
      expect(unknown.undetermined?.map((entry) => entry.sessionId)).toEqual([session.id]);
      expect(unknown.provenAbsent).toEqual([]);
    }
    expect(sessionRegistry.getSessionsForRig(rig.id)[0]!.status).toBe("running");

    // The process recorded for this very session no longer runs: an empty server is started once, and absence proven.
    evidenceFor("r01-dev1-impl");
    const proven = await reconciler.reconcile(rig.id, { absenceProof: "positive" });
    expect(startServer).toHaveBeenCalledOnce();
    expect(proven.provenAbsent).toEqual([session.id]);
    expect(sessionRegistry.getSessionsForRig(rig.id)[0]!.status).toBe("detached");
  });

  it("#2940: a missing socket starts no empty server while a tmux server still runs: it may only have lost its socket", async () => {
    const { rig, nodes } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "running" },
    ]);
    const startServer = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmuxAdapter({});
    tmux.probeSession = async () =>
      ({ state: "transport_unavailable" as const, cause: "error connecting to /tmp/tmux-1000/default (No such file or directory)" });
    (tmux as unknown as { startServer: typeof startServer }).startServer = startServer;
    // The impl seat's process recorded for its session is gone; the qa seat has no evidence.
    new SeatIdentityStore(db).upsert({
      nodeId: nodes[0]!.id, verdict: "verified", evidenceSource: null, reason: null,
      evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
      sessionName: "r01-dev1-impl", observedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    // A tmux server whose socket was removed still runs, and may still run the qa seat.
    const orphan = { pid: 777, ppid: 1, pgid: 777, tpgid: -1, executableName: "tmux: server",
      startedAt: "Mon Nov 16 10:00:00 2026", command: "tmux -D" };
    const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, readProcesses: async () => [orphan] });

    const result = await reconciler.reconcile(rig.id, { absenceProof: "positive" });

    expect(startServer).not.toHaveBeenCalled();
    expect(result.provenAbsent).toEqual([]);
    expect(result.undetermined?.map((entry) => entry.sessionName)).toEqual(["r01-dev1-impl", "r01-dev1-qa"]);
    expect(sessionRegistry.getSessionsForRig(rig.id).map((s) => s.status)).toEqual(["running", "running"]);
  });

  it("without absenceProof an unreachable tmux still detaches, as at boot", async () => {
    const { rig } = seedRigWithSessions([{ logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" }]);
    const tmux = mockTmuxAdapter({});
    tmux.probeSession = async () => ({ state: "transport_unavailable" as const, cause: "error connecting to /tmp/tmux-1000/default (Connection refused)" });
    const result = await createReconciler(tmux).reconcile(rig.id);
    expect(result).toMatchObject({ detached: 1 });
    expect(result.undetermined).toBeUndefined();
  });

  it("#2940: a pending stop is confirmed only on proof the session is gone, at boot too", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "running" },
    ]);
    const byName = (name: string) => sessionRegistry.getSessionsForRig(rig.id).find((s) => s.sessionName === name)!;
    for (const name of ["r01-dev1-impl", "r01-dev1-qa"]) sessionRegistry.requestStop(byName(name).id, `attempt-${name}`);
    const tmux = mockTmuxAdapter({});
    const cause = "error connecting to /tmp/tmux-1000/default (Connection refused)";
    tmux.probeSession = async (name: string) => name === "r01-dev1-impl"
      ? { state: "transport_unavailable" as const, cause }
      : { state: "transport_unavailable" as const, cause: "no server running on /tmp/tmux-1000/default" };

    const result = await createReconciler(tmux).reconcile(rig.id);

    const flagged = (name: string) => db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(byName(name).id);
    // An unreachable socket proves nothing: the request stays pending on a row left as it was.
    expect(flagged("r01-dev1-impl")).toEqual({ status: "running", intentionally_stopped: 1 });
    expect(result.undetermined).toEqual([{ sessionId: byName("r01-dev1-impl").id, sessionName: "r01-dev1-impl", cause }]);
    // No server running is proof: that stop is confirmed.
    expect(flagged("r01-dev1-qa")).toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(result.stopsConfirmed).toEqual([byName("r01-dev1-qa").id]);
    expect(result.detachedSessionIds).toEqual([]);
  });

  it("#2940: a stop request withdrawn while the reconcile awaits its probe or census is no confirmed stop", async () => {
    const withdrawnDuring = async (where: "probe" | "census", opts?: { absenceProof?: "positive" }) => {
      const rigName = `r-${where}-${opts?.absenceProof ?? "boot"}`;
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });
      const session = sessionRegistry.registerSession(node.id, `dev1-impl@${rigName}`);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.requestStop(session.id, "attempt-a");
      // A stop proven to have had no effect puts its request back while the reconcile waits.
      const withdraw = () => sessionRegistry.revertStopRequest(session.id, "attempt-a", { flag: 0, attempt: null });
      if (where === "census") {
        new SeatIdentityStore(db).upsert({
          nodeId: node.id, verdict: "verified", evidenceSource: null, reason: null,
          evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
          sessionName: session.sessionName, observedAt: new Date(Date.now() + 1_000).toISOString(),
        });
      }
      const tmux = mockTmuxAdapter({});
      tmux.probeSession = async () => { if (where === "probe") withdraw(); return { state: "absent" as const }; };
      const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux,
        readProcesses: async () => { if (where === "census") withdraw(); return []; } });
      const result = await reconciler.reconcile(rig.id, { nodeIds: [node.id], ...opts });
      return { session, result };
    };
    const flags = (id: string) => db.prepare("SELECT status, intentionally_stopped, stop_attempt FROM sessions WHERE id = ?").get(id);

    for (const [where, opts] of [["probe", undefined], ["census", undefined], ["census", { absenceProof: "positive" }]] as const) {
      const { session, result } = await withdrawnDuring(where, opts);
      expect(result.stopsConfirmed).toBeUndefined();
      expect(result.detachedSessionIds).toEqual([session.id]);
      expect(flags(session.id)).toEqual({ status: "detached", intentionally_stopped: 0, stop_attempt: null });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'session.stopped'").get()).toEqual({ n: 0 });
  });

  it("#2940: a pending stop stays pending at boot when the process table can't be read for its seat's recorded process", async () => {
    const { rig, nodes } = seedRigWithSessions([{ logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" }]);
    const session = sessionRegistry.getSessionsForRig(rig.id)[0]!;
    sessionRegistry.requestStop(session.id, "attempt-a");
    sessionRegistry.updateBinding(nodes[0]!.id, { attachmentType: "tmux", tmuxSession: "r01-dev1-impl", tmuxPane: "%1" });
    new SeatIdentityStore(db).upsert({
      nodeId: nodes[0]!.id, verdict: "verified", evidenceSource: null, reason: null,
      evidence: { registeredPane: "%1", observedPid: 4242, observedPanePid: 4241, observedCommand: "claude", matchedLayer: 1 },
      sessionName: "r01-dev1-impl", observedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const tmux = mockTmuxAdapter({});
    const flags = () => db.prepare("SELECT status, intentionally_stopped, stop_attempt FROM sessions WHERE id = ?").get(session.id);

    const unreadable = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux,
      readProcesses: async () => { throw new Error("ps failed"); } }).reconcile(rig.id);

    expect(unreadable.undetermined).toEqual([{ sessionId: session.id, sessionName: "r01-dev1-impl", cause: "the process table couldn't be read" }]);
    expect(unreadable.stopsConfirmed).toBeUndefined();
    expect(flags()).toEqual({ status: "running", intentionally_stopped: 1, stop_attempt: "attempt-a" });
    expect(sessionRegistry.getBindingForNode(nodes[0]!.id)).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'session.stopped'").get()).toEqual({ n: 0 });

    // A readable table that doesn't list the recorded pids confirms the stop, as before.
    const readable = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, readProcesses: async () => [] }).reconcile(rig.id);
    expect(readable.stopsConfirmed).toEqual([session.id]);
    expect(flags()).toEqual({ status: "exited", intentionally_stopped: 1, stop_attempt: null });
    expect(sessionRegistry.getBindingForNode(nodes[0]!.id)).toBeNull();
  });

  it("#2940: with positive proof asked for, a detached row is probed again and a session tmux shows is no fall", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "detached" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "detached" },
    ]);
    const byName = (name: string) => sessionRegistry.getSessionsForRig(rig.id).find((s) => s.sessionName === name)!;
    const tmux = mockTmuxAdapter({ "r01-dev1-impl": true });

    const result = await createReconciler(tmux).reconcile(rig.id, { absenceProof: "positive" });

    expect(result.undetermined).toEqual([
      { sessionId: byName("r01-dev1-impl").id, sessionName: "r01-dev1-impl", cause: "the session is present in tmux" },
    ]);
    expect(byName("r01-dev1-impl").status).toBe("detached");
    expect(byName("r01-dev1-qa").status).toBe("detached");
    expect(result).toMatchObject({ detached: 0, errors: [] });
    // Without the option a detached row is still skipped, as at boot.
    expect((await createReconciler(tmux).reconcile(rig.id)).undetermined).toBeUndefined();
  });

  it("idempotent: reconcile twice with same state -> no duplicate events", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));

    await reconciler.reconcile(rig.id);
    const result2 = await reconciler.reconcile(rig.id);

    // Second run: session is already detached, so skipped
    expect(result2.checked).toBe(0);
    expect(result2.detached).toBe(0);

    // Only 1 event total
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'session.detached'")
      .all();
    expect(events).toHaveLength(1);
  });

  it("constructor throws on mismatched db handles", () => {
    const otherDb = createDb();
    migrate(otherDb, [coreSchema, bindingsSessionsSchema, eventsSchema]);
    const otherRegistry = new SessionRegistry(otherDb);

    expect(
      () =>
        new Reconciler({
          db,
          sessionRegistry: otherRegistry,
          eventBus,
          tmuxAdapter: mockTmuxAdapter({}),
        })
    ).toThrow(/same db handle/);

    otherDb.close();
  });

  it("markDetached + event persistence is atomic (sabotage events -> no partial state)", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    // Sabotage events table so persistWithinTransaction fails after markDetached
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    // Should have errored on this session
    expect(result.errors).toHaveLength(1);

    // Session status NOT changed to detached (transaction rolled back)
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });

  it("unexpected tmux error: session not marked detached, error in result", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(
      mockTmuxAdapter({}, { "r01-dev1-impl": new Error("unexpected tmux failure") })
    );
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0); // couldn't check it
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("unexpected tmux failure");

    // Session NOT marked detached
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });

  // L1 cold-start tmux truth repair: post-reboot socket-absence is classified
  // transport_unavailable by probeSession; the Reconciler ELECTS to treat that
  // state as detachable at its own call site (OPR.0.5.4.2 mini-req 2), so DB
  // state still matches tmux reality after a reboot.
  it("socket-absent at adapter layer (probe not-present): session detached + event emitted", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(1);
    expect(result.detached).toBe(1);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("detached");

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'session.detached'")
      .all();
    expect(events).toHaveLength(1);
  });

  it("permission error at adapter layer (hasSession rethrows): session NOT detached, error recorded", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const permErr = new Error("error connecting to /private/tmp/tmux-501/default (Operation not permitted)");
    const reconciler = createReconciler(
      mockTmuxAdapter({}, { "r01-dev1-impl": permErr })
    );
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("Operation not permitted");

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });
});
