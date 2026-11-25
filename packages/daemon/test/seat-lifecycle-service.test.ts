// S5 (OPR.0.5.4.5) — seat-lifecycle verb surface: set-model / stop / clean.
// RED-first pins for the three KI-5.3-9 gaps. The gap-3 defect (a dead managed
// seat is permanently `already_bound`) is demonstrated inside the P5 pin against
// the real NodeLauncher, so the committed RED models the runtime relation, not a
// fixture of the author's imagination.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter, type TmuxResult } from "../src/adapters/tmux.js";
import { SeatLifecycleService, claimedSessionRoutes } from "../src/domain/seat-lifecycle-service.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { KeepAliveSupervisor } from "../src/domain/keep-alive-supervisor.js";

interface FakeTmux {
  adapter: TmuxAdapter;
  killed: string[];
  setAlive(name: string, alive: boolean): void;
  failProbeFor(name: string): void;
}

function fakeTmux(): FakeTmux {
  const alive = new Map<string, boolean>();
  const failing = new Set<string>();
  const killed: string[] = [];
  const adapter = {
    createSession: async () => ({ ok: true as const }),
    killSession: async (name: string): Promise<TmuxResult> => {
      killed.push(name);
      alive.set(name, false);
      return { ok: true as const };
    },
    hasSession: async (name: string): Promise<boolean> => {
      if (failing.has(name)) throw new Error("tmux probe failed (injected)");
      return alive.get(name) ?? false;
    },
    // Classified probe (OPR.0.5.4.2): this fake models POSITIVE evidence only —
    // present/absent from the liveness map, and an UNEXPECTED throw for the
    // injected-failure set (the service must fail closed on it). The
    // transport_unavailable class is deliberately NOT expressible here; blip
    // behavior is pinned against the REAL adapter below (fix r1, row 9baac99f).
    probeSession: async (name: string): Promise<{ state: "present" } | { state: "absent" }> => {
      if (failing.has(name)) throw new Error("tmux probe failed (injected)");
      return (alive.get(name) ?? false) ? { state: "present" } : { state: "absent" };
    },
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
    setSessionOption: async () => undefined,
  } as unknown as TmuxAdapter;
  return {
    adapter,
    killed,
    setAlive: (name, isAlive) => alive.set(name, isAlive),
    failProbeFor: (name) => failing.add(name),
  };
}

/** Byte-level lineage snapshot: everything the clean/set-model verbs must never touch. */
function lineageSnapshot(db: Database.Database, nodeId: string) {
  return {
    sessionRows: db.prepare(
      "SELECT id, session_name, resume_token, resume_type FROM sessions WHERE node_id = ? ORDER BY id",
    ).all(nodeId),
    tenureCount: (db.prepare(
      "SELECT COUNT(*) AS c FROM occupant_tenures WHERE node_id = ?",
    ).get(nodeId) as { c: number }).c,
    nodeRow: db.prepare("SELECT id, logical_id, model FROM nodes WHERE id = ?").get(nodeId),
  };
}

function eventsOfType(db: Database.Database, type: string): Array<Record<string, unknown>> {
  const rows = db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

describe("SeatLifecycleService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let tmux: FakeTmux;
  let service: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    tmux = fakeTmux();
    service = new SeatLifecycleService({
      db,
      rigRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux.adapter,
    });
  });

  afterEach(() => {
    db.close();
  });

  /** One live managed seat: node + running session + binding + live tmux. */
  function seatFixture(rigName: string, logicalId: string, opts?: { model?: string; origin?: "claimed"; keepAlive?: boolean }) {
    const existing = rigRepo.findRigsByName(rigName)[0] ?? rigRepo.createRig(rigName);
    const sessionName = `${logicalId.replace(".", "-")}@${rigName}`;
    const node = rigRepo.addNode(existing.id, logicalId, {
      runtime: "claude-code",
      cwd: "/project",
      model: opts?.model ?? "fable",
      ...(opts?.keepAlive ? { keepAlive: true } : {}),
    });
    const session = opts?.origin === "claimed"
      ? sessionRegistry.registerClaimedSession(node.id, sessionName)
      : sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_session_id", "resume-uuid-1234", "hook");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    tmux.setAlive(sessionName, true);
    return { rig: existing, node, session, sessionName };
  }

  describe("setLaunchWrapper", () => {
    afterEach(() => vi.restoreAllMocks());

    function storedWrapper(nodeId: string) {
      return (db.prepare("SELECT launch_wrapper FROM nodes WHERE id = ?").get(nodeId) as { launch_wrapper: string | null }).launch_wrapper;
    }

    it("sets, leaves an identical selection alone, and clears only the addressed seat with an atomic audit", async () => {
      const { rig, node, sessionName } = seatFixture("wrappers", "dev.impl");
      const sibling = seatFixture("wrappers", "dev.qa");
      rigRepo.setNodeLaunchWrapper(sibling.node.id, ["sibling-wrapper"]);
      const rows = () => ({
        nodes: db.prepare("SELECT * FROM nodes ORDER BY id").all().map(row => {
          const { launch_wrapper, ...rest } = row as Record<string, unknown>;
          return rest;
        }),
        sessions: db.prepare("SELECT * FROM sessions ORDER BY id").all(),
        bindings: db.prepare("SELECT * FROM bindings ORDER BY id").all(),
        tenures: db.prepare("SELECT * FROM occupant_tenures ORDER BY id").all(),
      });
      const before = rows();
      const terminalCalls = (["createSession", "killSession", "hasSession", "probeSession", "sendText", "sendKeys"] as const)
        .map(method => vi.spyOn(tmux.adapter, method));
      const sessionWrites = [vi.spyOn(sessionRegistry, "updateStatus"), vi.spyOn(sessionRegistry, "updateBinding"),
        vi.spyOn(sessionRegistry, "registerSession")];
      const stop = vi.spyOn(service, "stopSeat"), launch = vi.spyOn(service, "launchFresh"), restart = vi.spyOn(service, "restartInPlace");
      const notified: unknown[] = [];
      eventBus.subscribe(event => {
        if (event.type === "node.launch_wrapper_changed") {
          expect(db.inTransaction).toBe(false);
          expect(storedWrapper(node.id)).toBe(event.to === null ? null : JSON.stringify(event.to));
          notified.push(event);
        }
      });
      const argv = ["/missing/wrapper", "--flag", "space and 'quotes'"];
      const input = { seatRef: sessionName, argv, reason: "  select environment  ", operator: "operator@wrappers" };
      expect(await service.setLaunchWrapper(input)).toEqual({ ok: true,
        seat: { rigId: rig.id, rigName: "wrappers", logicalId: "dev.impl", nodeId: node.id },
        from: null, to: argv, changed: true, effect: "next_launch" });
      expect(storedWrapper(node.id)).toBe(JSON.stringify(argv));
      expect(await service.setLaunchWrapper(input)).toMatchObject({ ok: true, from: argv, to: argv, changed: false });
      expect(await service.setLaunchWrapper({ ...input, argv: [] })).toMatchObject({
        ok: true, from: argv, to: null, changed: true, effect: "next_launch" });
      expect(storedWrapper(node.id)).toBeNull();
      expect(await service.setLaunchWrapper({ ...input, argv: [] })).toMatchObject({ ok: true, changed: false, from: null, to: null });
      expect(eventsOfType(db, "node.launch_wrapper_changed")).toEqual([
        { type: "node.launch_wrapper_changed", rigId: rig.id, nodeId: node.id, logicalId: "dev.impl",
          from: null, to: argv, reason: "select environment", operator: "operator@wrappers" },
        { type: "node.launch_wrapper_changed", rigId: rig.id, nodeId: node.id, logicalId: "dev.impl",
          from: argv, to: null, reason: "select environment", operator: "operator@wrappers" },
      ]);
      expect(notified).toHaveLength(2);
      expect(storedWrapper(sibling.node.id)).toBe(JSON.stringify(["sibling-wrapper"]));
      expect(rows()).toEqual(before);
      for (const call of [...terminalCalls, ...sessionWrites, stop, launch, restart]) expect(call).not.toHaveBeenCalled();
    });

    it.each([undefined, null, "wrapper", {}, [3], [""], ["./wrapper"], ["bin/wrapper"], ["wrapper", "a\0b"], ["wrapper\r"], ["wrapper", "a\nb"]].map(argv => ({ argv })))(
      "refuses invalid argv $argv without changing the saved selection", async ({ argv }) => {
        const { node, sessionName } = seatFixture("wrappers", "dev.impl");
        rigRepo.setNodeLaunchWrapper(node.id, ["original-wrapper"]);
        expect(await service.setLaunchWrapper({ seatRef: sessionName, argv, reason: "invalid selection" }))
          .toMatchObject({ ok: false, code: "invalid_launch_wrapper" });
        expect(storedWrapper(node.id)).toBe(JSON.stringify(["original-wrapper"]));
        expect(eventsOfType(db, "node.launch_wrapper_changed")).toEqual([]);
      },
    );

    it.each(["", " \n "])("requires a non-empty reason (%j)", async reason => {
      const { node, sessionName } = seatFixture("wrappers", "dev.impl");
      expect(await service.setLaunchWrapper({ seatRef: sessionName, argv: ["wrapper"], reason }))
        .toMatchObject({ ok: false, code: "missing_reason" });
      expect(storedWrapper(node.id)).toBeNull();
      expect(eventsOfType(db, "node.launch_wrapper_changed")).toEqual([]);
    });

    it.each(["stub", "terminal", "omp", "openshell-claude"])("refuses unsupported runtime %s", async runtime => {
      const rig = rigRepo.createRig("wrappers"), node = rigRepo.addNode(rig.id, "dev", { runtime });
      for (const argv of [["wrapper"], []]) {
        expect(await service.setLaunchWrapper({ seatRef: "dev@wrappers", argv, reason: "select environment" }))
          .toMatchObject({ ok: false, code: "launch_wrapper_unsupported_runtime" });
      }
      expect(storedWrapper(node.id)).toBeNull();
      expect(eventsOfType(db, "node.launch_wrapper_changed")).toEqual([]);
    });

    it.each(["pi", "codex", "claude-code", "community-cli"])("supports a stored %s seat by immutable node ID", async runtime => {
      const rig = rigRepo.createRig("wrappers"), node = rigRepo.addNode(rig.id, "dev", { runtime });
      expect(await service.setLaunchWrapper({ nodeId: node.id, argv: ["wrapper"], reason: "select environment" }))
        .toMatchObject({ ok: true, changed: true, to: ["wrapper"], effect: "next_launch" });
      expect(storedWrapper(node.id)).toBe(JSON.stringify(["wrapper"]));
    });

    it("rolls back the wrapper if its audit cannot be persisted", async () => {
      const { node, sessionName } = seatFixture("wrappers", "dev.impl");
      const notify = vi.spyOn(eventBus, "notifySubscribers");
      vi.spyOn(eventBus, "persistWithinTransaction").mockImplementation(() => { throw new Error("audit unavailable"); });
      expect(await service.setLaunchWrapper({ seatRef: sessionName, argv: ["wrapper"], reason: "select environment" }))
        .toMatchObject({ ok: false, code: "launch_wrapper_persistence_failed" });
      expect(storedWrapper(node.id)).toBeNull();
      expect(eventsOfType(db, "node.launch_wrapper_changed")).toEqual([]);
      expect(notify).not.toHaveBeenCalled();
    });

    it("refuses when the repository updates no row", async () => {
      const { node, sessionName } = seatFixture("wrappers", "dev.impl");
      vi.spyOn(rigRepo, "setNodeLaunchWrapper").mockReturnValue(false);
      expect(await service.setLaunchWrapper({ seatRef: sessionName, argv: ["wrapper"], reason: "select environment" }))
        .toMatchObject({ ok: false, code: "launch_wrapper_persistence_failed" });
      expect(storedWrapper(node.id)).toBeNull();
      expect(eventsOfType(db, "node.launch_wrapper_changed")).toEqual([]);
    });

    it.each(["launch_wrapper", "runtime"])("refuses a concurrent change to %s", async column => {
      const { node, sessionName } = seatFixture("wrappers", "dev.impl");
      const getRig = rigRepo.getRig.bind(rigRepo);
      vi.spyOn(rigRepo, "getRig").mockImplementationOnce(rigId => {
        const snapshot = getRig(rigId);
        db.prepare(`UPDATE nodes SET ${column} = ? WHERE id = ?`).run(column === "runtime" ? "codex" : JSON.stringify(["other-wrapper"]), node.id);
        return snapshot;
      });
      expect(await service.setLaunchWrapper({ seatRef: sessionName, argv: ["wrapper"], reason: "select environment" }))
        .toMatchObject({ ok: false, code: "launch_wrapper_configuration_changed" });
      expect(storedWrapper(node.id)).toBe(column === "launch_wrapper" ? JSON.stringify(["other-wrapper"]) : null);
      expect(eventsOfType(db, "node.launch_wrapper_changed")).toEqual([]);
    });
  });

  // ---- P1 / P2 — set-model ----

  it("P1: set-model persists nodes.model and emits one audited node.model_changed event", async () => {
    const { rig, node, sessionName } = seatFixture("s5-rig", "dev.impl", { model: "fable" });

    const result = await service.setModel({
      seatRef: sessionName,
      model: "claude-fable-5",
      reason: "alias migration to canonical id",
      operator: "orch-lead@s5-rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.from).toBe("fable");
    expect(result.to).toBe("claude-fable-5");
    expect(result.changed).toBe(true);

    const persisted = rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id)!;
    expect(persisted.model).toBe("claude-fable-5");

    const events = eventsOfType(db, "node.model_changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "dev.impl",
      from: "fable",
      to: "claude-fable-5",
      reason: "alias migration to canonical id",
      operator: "orch-lead@s5-rig",
    });
  });

  it("P1: set-model with the already-persisted value is changed:false and emits nothing", async () => {
    const { sessionName } = seatFixture("s5-rig", "dev.impl", { model: "claude-fable-5" });

    const result = await service.setModel({ seatRef: sessionName, model: "claude-fable-5", reason: "no-op check" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.changed).toBe(false);
    expect(eventsOfType(db, "node.model_changed")).toHaveLength(0);
  });

  it("P2: set-model leaves session lineage byte-identical (sessions + occupant_tenures + resume token)", async () => {
    const { node, sessionName } = seatFixture("s5-rig", "dev.impl", { model: "fable" });
    const before = lineageSnapshot(db, node.id);

    const result = await service.setModel({ seatRef: sessionName, model: "claude-fable-5", reason: "alias migration" });
    expect(result.ok).toBe(true);

    const after = lineageSnapshot(db, node.id);
    expect(after.sessionRows).toEqual(before.sessionRows);
    expect(after.tenureCount).toBe(before.tenureCount);
    // The ONLY node-row change is the model column.
    expect(after.nodeRow).toEqual({ ...(before.nodeRow as Record<string, unknown>), model: "claude-fable-5" });
  });

  it("set-model refusals are loud and mutation-free", async () => {
    const { rig, node, sessionName } = seatFixture("s5-rig", "dev.impl", { model: "fable" });

    const missingModel = await service.setModel({ seatRef: sessionName, model: "   ", reason: "x" });
    expect(missingModel.ok).toBe(false);
    if (missingModel.ok) throw new Error("expected refusal");
    expect(missingModel.code).toBe("missing_model");

    const missingReason = await service.setModel({ seatRef: sessionName, model: "claude-fable-5", reason: "" });
    expect(missingReason.ok).toBe(false);
    if (missingReason.ok) throw new Error("expected refusal");
    expect(missingReason.code).toBe("missing_reason");

    const notFound = await service.setModel({ seatRef: "ghost-seat@s5-rig", model: "claude-fable-5", reason: "x" });
    expect(notFound.ok).toBe(false);
    if (notFound.ok) throw new Error("expected refusal");
    expect(notFound.code).toBe("seat_not_found");

    // Same logical id in two rigs, bare ref → ambiguous, with the matches listed.
    seatFixture("s5-rig-b", "dev.impl", { model: "fable" });
    const ambiguous = await service.setModel({ seatRef: "dev.impl", model: "claude-fable-5", reason: "x" });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error("expected refusal");
    expect(ambiguous.code).toBe("seat_ambiguous");
    expect(ambiguous.matches?.length).toBe(2);

    // No mutation happened anywhere along the refusals.
    const persisted = rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id)!;
    expect(persisted.model).toBe("fable");
    expect(eventsOfType(db, "node.model_changed")).toHaveLength(0);
  });

  // ---- P3 / P4 — stop ----

  it("P3: stop kills exactly the target seat; the sibling's session, binding and tmux survive", async () => {
    const a = seatFixture("s5-rig", "dev.impla");
    const b = seatFixture("s5-rig", "dev.implb");

    const result = await service.stopSeat({ seatRef: a.sessionName, reason: "single-seat stop test", operator: "op@rig" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(tmux.killed).toEqual([a.sessionName]);

    const aSession = db.prepare("SELECT status FROM sessions WHERE id = ?").get(a.session.id) as { status: string };
    expect(aSession.status).toBe("exited");
    expect(sessionRegistry.getBindingForNode(a.node.id)).toBeNull();

    const bSession = db.prepare("SELECT status FROM sessions WHERE id = ?").get(b.session.id) as { status: string };
    expect(bSession.status).toBe("running");
    expect(sessionRegistry.getBindingForNode(b.node.id)).not.toBeNull();

    const events = eventsOfType(db, "session.stopped");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ nodeId: a.node.id, sessionId: a.session.id, sessionName: a.sessionName, reason: "single-seat stop test", operator: "op@rig" });
  });

  it("labels a managed community stop as pane-only while retaining its normal seat audit", async () => {
    const a = seatFixture("community-stop", "dev.worker");
    db.prepare("UPDATE nodes SET runtime='openshell-claude' WHERE id=?").run(a.node.id);
    sessionRegistry.recordCommunityHarnessSelection(a.session.id, "openshell-claude");
    const result = await service.stopSeat({ seatRef: a.sessionName, reason: "close selected viewer" });
    expect(result).toMatchObject({ ok: true, paneOnly: true });
    expect(tmux.killed).toEqual([a.sessionName]);
    expect(eventsOfType(db, "session.stopped")).toHaveLength(1);
  });

  describe("intentional stop in the rig lifecycle", () => {
    function summary(rigId: string) {
      return new PsProjectionService({ db }).getEntries().find((entry) => entry.rigId === rigId)!;
    }

    it("keeps a rig running after stopping an on-demand seat, with truthful process counts", async () => {
      const stopped = seatFixture("on-demand", "dev.qa");
      seatFixture("on-demand", "dev.impl");
      const lineage = lineageSnapshot(db, stopped.node.id);

      expect((await service.stopSeat({ seatRef: stopped.sessionName, reason: "wait for the next review" })).ok).toBe(true);

      expect(summary(stopped.rig.id)).toMatchObject({
        lifecycleState: "running", status: "partial", nodeCount: 2, runningCount: 1,
      });
      expect(getNodeInventory(db, stopped.rig.id).find((entry) => entry.nodeId === stopped.node.id)).toMatchObject({
        sessionStatus: "exited", intentionallyStopped: true,
      });
      expect(lineageSnapshot(db, stopped.node.id)).toEqual(lineage);
      // Reconstruct the reader after pruning audit events: intent is durable state.
      db.prepare("DELETE FROM events").run();
      expect(summary(stopped.rig.id).lifecycleState).toBe("running");
    });

    it("does not hide an exit between the live probe and the kill", async () => {
      const stopped = seatFixture("stop-race", "dev.qa");
      seatFixture("stop-race", "dev.impl");
      vi.spyOn(tmux.adapter, "killSession").mockImplementationOnce(async () => {
        tmux.setAlive(stopped.sessionName, false);
        return { ok: false, code: "session_not_found", message: "session exited before kill" };
      });

      expect((await service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" })).ok).toBe(true);
      expect(tmux.adapter.killSession).toHaveBeenCalledWith(stopped.sessionName);
      expect(summary(stopped.rig.id)).toMatchObject({
        lifecycleState: "degraded", status: "partial", nodeCount: 2, runningCount: 1,
      });
      expect(getNodeInventory(db, stopped.rig.id).find((entry) => entry.nodeId === stopped.node.id)).toMatchObject({
        sessionStatus: "exited", intentionallyStopped: false,
      });
      expect(sessionRegistry.getBindingForNode(stopped.node.id)).toBeNull();
    });

    it("does not leave a stopped seat's old startup prompt in the rig lifecycle", async () => {
      const stopped = seatFixture("stop-prompt", "dev.qa");
      seatFixture("stop-prompt", "dev.impl");
      sessionRegistry.updateStartupStatus(stopped.session.id, "attention_required");
      expect(summary(stopped.rig.id).lifecycleState).toBe("attention_required");

      expect((await service.stopSeat({ seatRef: stopped.sessionName, reason: "do not run this seat now" })).ok).toBe(true);
      expect(summary(stopped.rig.id).lifecycleState).toBe("running");
    });

    it("keeps the whole rig stopped when every seat was intentionally stopped", async () => {
      const first = seatFixture("all-stopped", "dev.qa");
      const second = seatFixture("all-stopped", "dev.impl");
      await service.stopSeat({ seatRef: first.sessionName, reason: "pause review" });
      await service.stopSeat({ seatRef: second.sessionName, reason: "pause implementation" });
      expect(summary(first.rig.id)).toMatchObject({ lifecycleState: "stopped", status: "stopped", runningCount: 0 });
    });

    it("still reports a crashed sibling and a live sibling needing attention", async () => {
      const stopped = seatFixture("mixed-stops", "dev.qa");
      const crashed = seatFixture("mixed-stops", "dev.impl");
      const live = seatFixture("mixed-stops", "dev.lead");
      await service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" });
      sessionRegistry.markDetached(crashed.session.id);
      sessionRegistry.clearBinding(crashed.node.id);

      expect(summary(stopped.rig.id).lifecycleState).toBe("degraded");
      sessionRegistry.updateStartupStatus(live.session.id, "attention_required");
      expect(summary(stopped.rig.id).lifecycleState).toBe("attention_required");
    });

    it("does not carry stop intent into a new session on the same seat", async () => {
      const stopped = seatFixture("new-occupant", "dev.qa");
      seatFixture("new-occupant", "dev.impl");
      await service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" });
      expect(summary(stopped.rig.id).lifecycleState).toBe("running");

      const replacement = sessionRegistry.registerSession(stopped.node.id, stopped.sessionName);
      sessionRegistry.updateStatus(replacement.id, "running");
      sessionRegistry.markDetached(replacement.id);
      expect(summary(stopped.rig.id).lifecycleState).toBe("degraded");
      expect(getNodeInventory(db, stopped.rig.id).find((entry) => entry.nodeId === stopped.node.id)?.intentionallyStopped).not.toBe(true);
    });

    // #2940 (point 3 of the maintainer's design): a later observation or the startup reconcile of the same row must
    // not undo the person's stop. Only a later start or resume, which writes a new session row, replaces it.
    it("keeps the stop when the stopped session's row is observed again", async () => {
      const stopped = seatFixture("same-session", "dev.qa");
      seatFixture("same-session", "dev.impl");
      await service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" });
      expect(summary(stopped.rig.id).lifecycleState).toBe("running");

      sessionRegistry.updateStatus(stopped.session.id, "exited");
      // Every status write is an observation, a running one included (a compensation writes earlier statuses back).
      sessionRegistry.updateStatus(stopped.session.id, "running");
      expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(stopped.session.id)).toEqual({ intentionally_stopped: 1 });
      sessionRegistry.markDetached(stopped.session.id);
      sessionRegistry.updateStatus(stopped.session.id, "exited");
      expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(stopped.session.id)).toEqual({ intentionally_stopped: 1 });
      expect(summary(stopped.rig.id).lifecycleState).toBe("running");
      expect(getNodeInventory(db, stopped.rig.id).find((entry) => entry.nodeId === stopped.node.id)?.intentionallyStopped).toBe(true);
    });

    it("does not exempt a stopped session after a replacement binding appears", async () => {
      const stopped = seatFixture("rebound-seat", "dev.qa");
      seatFixture("rebound-seat", "dev.impl");
      await service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" });
      sessionRegistry.updateBinding(stopped.node.id, {
        attachmentType: "tmux", tmuxSession: stopped.sessionName, tmuxPane: "%replacement",
      });

      expect(summary(stopped.rig.id).lifecycleState).toBe("degraded");
      expect(getNodeInventory(db, stopped.rig.id).find((entry) => entry.nodeId === stopped.node.id)?.intentionallyStopped).toBe(false);
    });

    it("does not turn cleaning an already-dead seat into an intentional stop", async () => {
      const dead = seatFixture("dead-clean", "dev.qa");
      seatFixture("dead-clean", "dev.impl");
      tmux.setAlive(dead.sessionName, false);
      expect((await service.cleanSeat({ seatRef: dead.sessionName, reason: "clean stale binding" })).ok).toBe(true);
      expect(summary(dead.rig.id).lifecycleState).toBe("degraded");
      expect(getNodeInventory(db, dead.rig.id).find((entry) => entry.nodeId === dead.node.id)?.intentionallyStopped).not.toBe(true);
    });

    // #2940: a stop left pending (a daemon lost mid-stop) on a seat whose session is gone: clean proves it gone, so the
    // stop is confirmed rather than left pending for good on an exited row no reconcile looks at again.
    it("confirms a pending stop when it cleans the seat it was recorded on", async () => {
      const pending = seatFixture("pending-clean", "dev.qa");
      seatFixture("pending-clean", "dev.impl");
      sessionRegistry.requestStop(pending.session.id, "lost-attempt");
      tmux.setAlive(pending.sessionName, false);
      expect((await service.cleanSeat({ seatRef: pending.sessionName, reason: "clean after a lost stop" })).ok).toBe(true);
      const entry = getNodeInventory(db, pending.rig.id).find((node) => node.nodeId === pending.node.id)!;
      expect(entry).toMatchObject({ sessionStatus: "exited", intentionallyStopped: true });
      expect(entry.stopRequested).toBeUndefined();
    });

    // #2940: the request is recorded before the kill, so a stop whose confirming transaction fails after the kill
    // (the same state a daemon lost between kill and commit leaves) is pending, never a fall: not reported as exited,
    // binding and skills kept, and confirmed by the reconcile once the session is gone.
    it("keeps a pending stop when the audited stop transaction fails after the kill", async () => {
      const stopped = seatFixture("failed-stop", "dev.qa");
      seatFixture("failed-stop", "dev.impl");
      vi.spyOn(eventBus, "persistWithinTransaction").mockImplementationOnce(() => { throw new Error("audit unavailable"); });

      await expect(service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" })).rejects.toThrow("audit unavailable");
      const entry = getNodeInventory(db, stopped.rig.id).find((node) => node.nodeId === stopped.node.id)!;
      expect(entry.sessionStatus).not.toBe("exited");
      expect(entry.intentionallyStopped).not.toBe(true);
      expect(entry.stopRequested).toBe(true);
      expect(sessionRegistry.getBindingForNode(stopped.node.id)).not.toBeNull();

      const reconcile = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux.adapter, readProcesses: async () => [] })
        .reconcile(stopped.rig.id);
      expect(reconcile.stopsConfirmed).toEqual([stopped.session.id]);
      expect(reconcile.detachedSessionIds).not.toContain(stopped.session.id);
      expect(getNodeInventory(db, stopped.rig.id).find((node) => node.nodeId === stopped.node.id)).toMatchObject({
        sessionStatus: "exited", intentionallyStopped: true,
      });
      expect(sessionRegistry.getBindingForNode(stopped.node.id)).toBeNull();
    });

    it("records the request before the kill: a daemon lost before the kill leaves the live seat pending, not stopped", async () => {
      const stopped = seatFixture("crash-before", "dev.qa");
      seatFixture("crash-before", "dev.impl");
      let seenAtKill: unknown;
      vi.spyOn(tmux.adapter, "killSession").mockImplementationOnce(async () => {
        seenAtKill = db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(stopped.session.id);
        throw new Error("daemon lost here");
      });
      await expect(service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" })).rejects.toThrow("daemon lost here");
      expect(seenAtKill).toEqual({ status: "running", intentionally_stopped: 1 });

      // The session is still there: the reconcile leaves the request pending and does not detach the seat.
      const reconcile = await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux.adapter, readProcesses: async () => [] })
        .reconcile(stopped.rig.id);
      expect(reconcile.stopsConfirmed).toBeUndefined();
      expect(reconcile.detachedSessionIds).toEqual([]);
      expect(getNodeInventory(db, stopped.rig.id).find((node) => node.nodeId === stopped.node.id)).toMatchObject({
        sessionStatus: "running", stopRequested: true,
      });
    });

    it("puts back only this attempt's request on a failure proven to have had no effect", async () => {
      const stopped = seatFixture("no-effect", "dev.qa");
      seatFixture("no-effect", "dev.impl");
      vi.spyOn(tmux.adapter, "killSession").mockImplementationOnce(async () =>
        ({ ok: false, code: "tmux_error", message: "refused before detach", stopPhase: "none" }));
      const refused = await service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" });
      expect(refused).toMatchObject({ ok: false, code: "tmux_probe_failed" });
      expect(db.prepare("SELECT intentionally_stopped, stop_attempt FROM sessions WHERE id = ?").get(stopped.session.id))
        .toEqual({ intentionally_stopped: 0, stop_attempt: null });

      // An earlier stop request on the same row is never erased by a later attempt's undo.
      sessionRegistry.requestStop(stopped.session.id, "earlier-attempt");
      vi.spyOn(tmux.adapter, "killSession").mockImplementationOnce(async () =>
        ({ ok: false, code: "tmux_error", message: "refused before detach", stopPhase: "none" }));
      await service.stopSeat({ seatRef: stopped.sessionName, reason: "again" });
      expect(db.prepare("SELECT intentionally_stopped, stop_attempt FROM sessions WHERE id = ?").get(stopped.session.id))
        .toEqual({ intentionally_stopped: 1, stop_attempt: "earlier-attempt" });
    });

    it("keeps the request on an uncertain failure (the stop got past the first effect)", async () => {
      const stopped = seatFixture("uncertain", "dev.qa");
      seatFixture("uncertain", "dev.impl");
      vi.spyOn(tmux.adapter, "killSession").mockImplementationOnce(async () =>
        ({ ok: false, code: "timeout", message: "kill timed out", stopPhase: "kill_attempted" }));
      const refused = await service.stopSeat({ seatRef: stopped.sessionName, reason: "pause review" });
      expect(refused).toMatchObject({ ok: false, partialEffect: true, stopPhase: "kill_attempted" });
      expect(getNodeInventory(db, stopped.rig.id).find((node) => node.nodeId === stopped.node.id)).toMatchObject({
        sessionStatus: "running", intentionallyStopped: false, stopRequested: true,
      });
      expect(sessionRegistry.getBindingForNode(stopped.node.id)).not.toBeNull();
    });

    it("a revert never reaches another attempt's request or a replacement session", () => {
      const stopped = seatFixture("cas", "dev.qa");
      const prev = sessionRegistry.requestStop(stopped.session.id, "attempt-a")!;
      sessionRegistry.requestStop(stopped.session.id, "attempt-b");
      expect(sessionRegistry.revertStopRequest(stopped.session.id, "attempt-a", prev)).toBe(false);
      expect(db.prepare("SELECT intentionally_stopped, stop_attempt FROM sessions WHERE id = ?").get(stopped.session.id))
        .toEqual({ intentionally_stopped: 1, stop_attempt: "attempt-b" });
      const replacement = sessionRegistry.registerSession(stopped.node.id, stopped.sessionName);
      sessionRegistry.updateStatus(replacement.id, "running");
      expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(replacement.id)).toEqual({ intentionally_stopped: 0 });
    });
  });

  // #2940: `rig seat stop` means stay down. A keep_alive seat that already fell is held down rather than refused, so the
  // supervisor doesn't bring back a seat the person just stopped. Other seats keep today's refusal.
  describe("#2940: stopping a keep_alive seat that is already down", () => {
    const flags = (id: string) => db.prepare("SELECT status, intentionally_stopped FROM sessions WHERE id = ?").get(id);

    it.each([
      ["detached", (id: string) => sessionRegistry.markDetached(id)],
      ["running (not reconciled yet)", (_id: string) => {}],
      ["exited without a stop", (id: string) => sessionRegistry.updateStatus(id, "exited")],
    ] as const)("records a confirmed stop on a keep_alive seat whose %s session is gone", async (_label, setStatus) => {
      const fell = seatFixture("hold-down", "dev.qa", { keepAlive: true });
      seatFixture("hold-down", "dev.impl");
      setStatus(fell.session.id);
      tmux.setAlive(fell.sessionName, false);

      const result = await service.stopSeat({ seatRef: fell.sessionName, reason: "keep it down" });

      expect(result).toMatchObject({ ok: true, alreadyDown: true, sessionId: fell.session.id });
      if (!result.ok) throw new Error("expected ok");
      expect(result.message).toContain("held down");
      expect(tmux.killed).toEqual([]);
      expect(flags(fell.session.id)).toEqual({ status: "exited", intentionally_stopped: 1 });
      expect(sessionRegistry.getBindingForNode(fell.node.id)).toBeNull();
      expect(getNodeInventory(db, fell.rig.id).find((entry) => entry.nodeId === fell.node.id)).toMatchObject({ intentionallyStopped: true });
      expect(eventsOfType(db, "session.stopped")).toEqual([expect.objectContaining({ nodeId: fell.node.id, reason: "keep it down" })]);
    });

    it("records the stop on a failed relaunch's superseded session, keeping its status", async () => {
      const fell = seatFixture("hold-superseded", "dev.qa", { keepAlive: true });
      sessionRegistry.markDetached(fell.session.id);
      const attempt = sessionRegistry.registerSession(fell.node.id, fell.sessionName);
      sessionRegistry.markSuperseded(attempt.id);
      tmux.setAlive(fell.sessionName, false);

      expect(await service.stopSeat({ seatRef: fell.sessionName, reason: "keep it down" })).toMatchObject({ ok: true, alreadyDown: true, sessionId: attempt.id });
      expect(flags(attempt.id)).toEqual({ status: "superseded", intentionally_stopped: 1 });
      expect(sessionRegistry.getBindingForNode(fell.node.id)).toBeNull();
      expect(getNodeInventory(db, fell.rig.id).find((entry) => entry.nodeId === fell.node.id)).toMatchObject({ intentionallyStopped: true });
    });

    it("refuses, with no mutation, a keep_alive seat whose fallen latest session has an older one still live", async () => {
      const fell = seatFixture("hold-older-live", "dev.qa", { keepAlive: true });
      const latest = sessionRegistry.registerSession(fell.node.id, "dev-qa-renamed@hold-older-live");
      sessionRegistry.markDetached(latest.id);
      tmux.setAlive(fell.sessionName, true);
      tmux.setAlive("dev-qa-renamed@hold-older-live", false);

      expect(await service.stopSeat({ seatRef: fell.sessionName, reason: "keep it down" })).toMatchObject({ ok: false, code: "session_not_live" });
      expect(flags(latest.id)).toEqual({ status: "detached", intentionally_stopped: 0 });
      expect(flags(fell.session.id)).toEqual({ status: "running", intentionally_stopped: 0 });
      expect(sessionRegistry.getBindingForNode(fell.node.id)).not.toBeNull();
      expect(tmux.killed).toEqual([]);
    });

    it("still refuses a seat without keep_alive whose session is gone, with no mutation", async () => {
      const fell = seatFixture("no-hold", "dev.qa");
      sessionRegistry.markDetached(fell.session.id);
      tmux.setAlive(fell.sessionName, false);
      expect(await service.stopSeat({ seatRef: fell.sessionName, reason: "keep it down" })).toMatchObject({ ok: false, code: "session_not_live" });
      expect(flags(fell.session.id)).toEqual({ status: "detached", intentionally_stopped: 0 });
      expect(sessionRegistry.getBindingForNode(fell.node.id)).not.toBeNull();
    });

    it("keeps an external seat out: its missing tmux session is refused as before", async () => {
      const ext = seatFixture("hold-external", "dev.qa", { keepAlive: true });
      sessionRegistry.updateBinding(ext.node.id, { attachmentType: "external_cli", externalSessionName: "ext" });
      tmux.setAlive(ext.sessionName, false);
      expect(await service.stopSeat({ seatRef: ext.sessionName, reason: "keep it down" })).toMatchObject({ ok: false });
      expect(flags(ext.session.id)).toEqual({ status: "running", intentionally_stopped: 0 });
    });

    it("puts back a refused stop's request on a detached latest session, so keep_alive can relaunch it", async () => {
      // The latest session is recorded detached (a boot reconcile that couldn't reach tmux) yet tmux shows it again.
      const seat = seatFixture("revert-detached", "dev.qa", { keepAlive: true });
      seatFixture("revert-detached", "dev.impl");
      sessionRegistry.markDetached(seat.session.id);
      vi.spyOn(tmux.adapter, "killSession").mockImplementationOnce(async () =>
        ({ ok: false, code: "tmux_error", message: "refused before detach", stopPhase: "none" }));

      const refused = await service.stopSeat({ seatRef: seat.sessionName, reason: "pause review" });

      expect(refused).toMatchObject({ ok: false, code: "tmux_probe_failed" });
      expect(db.prepare("SELECT status, intentionally_stopped, stop_attempt FROM sessions WHERE id = ?").get(seat.session.id))
        .toEqual({ status: "detached", intentionally_stopped: 0, stop_attempt: null });
      expect(getNodeInventory(db, seat.rig.id).find((entry) => entry.nodeId === seat.node.id)?.stopRequested).toBeUndefined();

      // The session is lost later: keep_alive reads the fall as one and relaunches the seat.
      tmux.setAlive(seat.sessionName, false);
      const launchSingleNode = vi.fn(async () => ({ ok: true as const, launched: [], alreadyRunning: [] }));
      await new KeepAliveSupervisor({
        db, eventBus, restoreOrchestrator: { launchSingleNode: launchSingleNode as never }, onTickError: () => {},
        reconciler: new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux.adapter, readProcesses: async () => [] }),
      }).runTickNow();
      expect(launchSingleNode).toHaveBeenCalledWith(seat.rig.id, "dev.qa", expect.anything());
    });

    it("says the request stays recorded when a refused stop's request was replaced meanwhile", async () => {
      const seat = seatFixture("revert-replaced", "dev.qa");
      seatFixture("revert-replaced", "dev.impl");
      vi.spyOn(tmux.adapter, "killSession").mockImplementationOnce(async () => {
        // Another stop records its own attempt while this one's kill is refused.
        sessionRegistry.requestStop(seat.session.id, "concurrent-attempt");
        return { ok: false, code: "tmux_error", message: "refused before detach", stopPhase: "none" };
      });

      const refused = await service.stopSeat({ seatRef: seat.sessionName, reason: "pause review" });

      expect(refused).toMatchObject({ ok: false, code: "tmux_probe_failed" });
      if (refused.ok) throw new Error("expected refusal");
      expect(refused.message).toContain("The stop request stays recorded");
      expect(db.prepare("SELECT intentionally_stopped, stop_attempt FROM sessions WHERE id = ?").get(seat.session.id))
        .toEqual({ intentionally_stopped: 1, stop_attempt: "concurrent-attempt" });
    });

    it("confirms the stop when a keep_alive seat's session exits between the probe and the kill", async () => {
      const stopped = seatFixture("hold-race", "dev.qa", { keepAlive: true });
      seatFixture("hold-race", "dev.impl");
      vi.spyOn(tmux.adapter, "killSession").mockImplementationOnce(async () => {
        tmux.setAlive(stopped.sessionName, false);
        return { ok: false, code: "session_not_found", message: "session exited before kill" };
      });
      expect(await service.stopSeat({ seatRef: stopped.sessionName, reason: "keep it down" })).toMatchObject({ ok: true });
      expect(flags(stopped.session.id)).toEqual({ status: "exited", intentionally_stopped: 1 });
      expect(getNodeInventory(db, stopped.rig.id).find((entry) => entry.nodeId === stopped.node.id)).toMatchObject({
        sessionStatus: "exited", intentionallyStopped: true,
      });
      expect(sessionRegistry.getBindingForNode(stopped.node.id)).toBeNull();
    });
  });

  it("P4: stop refuses a dead seat (session_not_live → guidance names clean), no mutation", async () => {
    const a = seatFixture("s5-rig", "dev.impl");
    tmux.setAlive(a.sessionName, false);

    const result = await service.stopSeat({ seatRef: a.sessionName, reason: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("session_not_live");
    expect(result.guidance).toContain("clean");
    expect(tmux.killed).toEqual([]);
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(a.session.id) as { status: string }).status).toBe("running");
    expect(sessionRegistry.getBindingForNode(a.node.id)).not.toBeNull();
  });

  // #2440 records a launched handover's successor as launched from 0.7.9; one handed over earlier keeps origin=claimed.
  function recordHandover(nodeId: string, outcome: string | null) {
    db.prepare("UPDATE nodes SET continuity_outcome = ?, handover_result = 'complete', handover_at = ? WHERE id = ?")
      .run(outcome, "2026-11-01T10:00:00.000Z", nodeId);
  }

  it.each(["fresh", "forked", "rebuilt"])("a seat handed over (%s) before 0.7.9 is refused as that case, never pointed at rig unclaim", async (outcome) => {
    const seat = seatFixture("s5-rig", "dev.handed", { origin: "claimed" });
    recordHandover(seat.node.id, outcome);
    for (const result of [
      await service.stopSeat({ seatRef: seat.sessionName, reason: "x" }),
      await service.cleanSeat({ seatRef: seat.sessionName, reason: "x" }),
    ]) {
      expect(result).toMatchObject({ ok: false, code: "claimed_session" });
      if (result.ok) throw new Error("expected refusal");
      expect(result.message).toContain(`last handover (${outcome} at 2026-11-01T10:00:00.000Z)`);
      expect(result.message).toContain("before OpenRig 0.7.9");
      expect(result.guidance).toBe("It keeps that origin until its next launched handover or managed launch.");
      expect(result.guidance).not.toContain("rig unclaim");
    }
    expect(tmux.killed).toEqual([]);
  });

  it("an adopted seat with no handover, or a discovered one, still points at rig unclaim", async () => {
    const adopted = seatFixture("s5-rig", "dev.adopted", { origin: "claimed" });
    const discovered = seatFixture("s5-rig", "dev.discovered", { origin: "claimed" });
    recordHandover(discovered.node.id, null);
    for (const seat of [adopted, discovered]) {
      for (const result of [
        await service.stopSeat({ seatRef: seat.sessionName, reason: "x" }),
        await service.cleanSeat({ seatRef: seat.sessionName, reason: "x" }),
      ]) {
        expect(result).toMatchObject({ ok: false, code: "claimed_session", guidance: expect.stringContaining("rig unclaim") });
        if (result.ok) throw new Error("expected refusal");
        expect(result.message).toContain("was adopted (origin=claimed)");
      }
    }
    expect(tmux.killed).toEqual([]);
  });

  it("P4: stop refuses a claimed (adopted) session, an indeterminate probe, and a no-session node", async () => {
    const claimed = seatFixture("s5-rig", "dev.adopted", { origin: "claimed" });
    const claimedResult = await service.stopSeat({ seatRef: claimed.sessionName, reason: "x" });
    expect(claimedResult.ok).toBe(false);
    if (claimedResult.ok) throw new Error("expected refusal");
    expect(claimedResult.code).toBe("claimed_session");
    // the refusal names the supported route, rig unclaim, and says rig down doesn't stop a session OpenRig didn't start,
    // even in a one-seat rig.
    expect(claimedResult.guidance).toBe("To end this session, run rig unclaim 'dev-adopted@s5-rig' (it releases the session from OpenRig "
      + "and leaves its process running), then end that process and the underlying tmux session, including any remaining shell, so no session keeps the seat's name. Closing only its viewing window leaves the tmux session running. rig down 's5-rig' leaves a session OpenRig didn't start running.");

    const probed = seatFixture("s5-rig", "dev.flaky");
    tmux.failProbeFor(probed.sessionName);
    const probeResult = await service.stopSeat({ seatRef: probed.sessionName, reason: "x" });
    expect(probeResult.ok).toBe(false);
    if (probeResult.ok) throw new Error("expected refusal");
    expect(probeResult.code).toBe("tmux_probe_failed");
    expect(tmux.killed).toEqual([]);

    const rig = rigRepo.findRigsByName("s5-rig")[0]!;
    rigRepo.addNode(rig.id, "dev.bare", { runtime: "claude-code" });
    const bare = await service.stopSeat({ seatRef: "dev.bare", reason: "x" });
    expect(bare.ok).toBe(false);
    if (bare.ok) throw new Error("expected refusal");
    expect(bare.code).toBe("no_session");
  });

  it("the claimed-session guidance is the same in a rig of several seats, and says rig down leaves an external CLI running", async () => {
    const claimed = seatFixture("adopted-rig", "dev.adopted", { origin: "claimed" });
    seatFixture("adopted-rig", "dev.peer");
    const shared = await service.stopSeat({ seatRef: claimed.sessionName, reason: "x" });
    if (shared.ok) throw new Error("expected refusal");
    expect(shared.guidance).toBe("To end this session, run rig unclaim 'dev-adopted@adopted-rig' (it releases the session from OpenRig "
      + "and leaves its process running), then end that process and the underlying tmux session, including any remaining shell, so no session keeps the seat's name. Closing only its viewing window leaves the tmux session running. rig down 'adopted-rig' leaves a session OpenRig didn't start running.");

    sessionRegistry.updateBinding(claimed.node.id, { attachmentType: "external_cli", externalSessionName: claimed.sessionName });
    const external = await service.stopSeat({ seatRef: claimed.sessionName, reason: "x" });
    if (external.ok) throw new Error("expected refusal");
    expect(external.code).toBe("claimed_session");
    expect(external.guidance).toContain("rig down leaves it running");
    expect(external.guidance).not.toContain("run rig down");
    expect(external.guidance).toContain("run rig unclaim 'dev-adopted@adopted-rig'");
    expect(tmux.killed).toEqual([]);
  });

  it("claimedSessionRoutes routes a tmux session through rig unclaim, never rig down", () => {
    expect(claimedSessionRoutes("r", "a@r")).toBe("To end this session, run rig unclaim 'a@r' (it releases the session from OpenRig "
      + "and leaves its process running), then end that process and the underlying tmux session, including any remaining shell, so no session keeps the seat's name. Closing only its viewing window leaves the tmux session running. rig down 'r' leaves a session OpenRig didn't start running.");
  });

  // ---- P5 / P6 — clean ----

  it("P5: clean returns a dead seat to launchable WITHOUT deleting owner state (the already_bound defect, pinned)", async () => {
    const a = seatFixture("s5-rig", "dev.impl");
    // The seat dies outside any supported verb (clean exit): tmux gone, DB stale.
    tmux.setAlive(a.sessionName, false);

    const launcher = new NodeLauncher({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux.adapter,
    });

    // The gap-3 defect at base: the binding survives death, so launch refuses forever.
    const blocked = await launcher.launchNode(a.rig.id, "dev.impl");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected already_bound");
    expect(blocked.code).toBe("already_bound");

    const before = lineageSnapshot(db, a.node.id);
    const cleaned = await service.cleanSeat({ seatRef: a.sessionName, reason: "clean exit observed", operator: "op@rig" });
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) throw new Error(cleaned.message);
    expect(cleaned.actions.bindingCleared).toBe(true);
    expect(cleaned.actions.sessionsExited).toEqual([a.sessionName]);

    // Owner state preserved: node row, session history (incl. resume token), tenure ledger.
    const after = lineageSnapshot(db, a.node.id);
    expect(after.nodeRow).toEqual(before.nodeRow);
    expect(after.tenureCount).toBe(before.tenureCount);
    expect(after.sessionRows.length).toBe(before.sessionRows.length);
    expect((after.sessionRows[0] as { resume_token: string | null }).resume_token).toBe("resume-uuid-1234");

    // Binding cleared; session terminal; audit event persisted.
    expect(sessionRegistry.getBindingForNode(a.node.id)).toBeNull();
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(a.session.id) as { status: string }).status).toBe("exited");
    expect(eventsOfType(db, "session.cleaned")).toHaveLength(1);

    // The post-condition that defines the verb: launch no longer refuses already_bound.
    const relaunch = await launcher.launchNode(a.rig.id, "dev.impl");
    expect(relaunch.code === "already_bound").toBe(false);
  });

  it("P5: clean of a reconciler-detached seat clears only the stale binding", async () => {
    const a = seatFixture("s5-rig", "dev.impl");
    tmux.setAlive(a.sessionName, false);
    sessionRegistry.markDetached(a.session.id); // what the reconciler records on death

    const cleaned = await service.cleanSeat({ seatRef: a.sessionName, reason: "post-reconcile clean" });
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) throw new Error(cleaned.message);
    expect(cleaned.actions.bindingCleared).toBe(true);
    expect(cleaned.actions.sessionsExited).toEqual([]); // detached is already terminal
    expect(sessionRegistry.getBindingForNode(a.node.id)).toBeNull();
  });

  it("P6: clean refuses a LIVE seat (session_live → guidance names stop), an indeterminate probe, and a clean seat (nothing_to_clean names both checks)", async () => {
    const live = seatFixture("s5-rig", "dev.live");
    const liveResult = await service.cleanSeat({ seatRef: live.sessionName, reason: "x" });
    expect(liveResult.ok).toBe(false);
    if (liveResult.ok) throw new Error("expected refusal");
    expect(liveResult.code).toBe("session_live");
    expect(liveResult.guidance).toBe("Stop a live seat first with: rig seat stop");
    expect(sessionRegistry.getBindingForNode(live.node.id)).not.toBeNull();

    const probed = seatFixture("s5-rig", "dev.flaky");
    tmux.failProbeFor(probed.sessionName);
    const probeResult = await service.cleanSeat({ seatRef: probed.sessionName, reason: "x" });
    expect(probeResult.ok).toBe(false);
    if (probeResult.ok) throw new Error("expected refusal");
    expect(probeResult.code).toBe("tmux_probe_failed");

    const done = seatFixture("s5-rig", "dev.done");
    tmux.setAlive(done.sessionName, false);
    sessionRegistry.markDetached(done.session.id);
    sessionRegistry.clearBinding(done.node.id);
    const nothing = await service.cleanSeat({ seatRef: done.sessionName, reason: "x" });
    expect(nothing.ok).toBe(false);
    if (nothing.ok) throw new Error("expected refusal");
    expect(nothing.code).toBe("nothing_to_clean");
    expect(nothing.message).toMatch(/binding/i);
    expect(nothing.message).toMatch(/session/i);
  });

  it.each([true, false])("clean names the older live blocker when the latest session is live=%s", async (latestAlive) => {
    // Distinct registration times make the same ordering used by stop deterministic.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 1000);
    let older: ReturnType<typeof seatFixture>;
    try { older = seatFixture("s5-rig", "dev.impl"); } finally { clock.mockRestore(); }
    const newerName = "dev-impl-v2@s5-rig";
    const newer = sessionRegistry.registerSession(older.node.id, newerName);
    sessionRegistry.updateStatus(newer.id, "running");
    sessionRegistry.updateBinding(older.node.id, { attachmentType: "tmux", tmuxSession: newerName, tmuxPane: "%2" });
    tmux.setAlive(newerName, latestAlive);
    const snapshot = () => ({
      sessions: db.prepare("SELECT * FROM sessions WHERE node_id = ? ORDER BY id").all(older.node.id),
      binding: sessionRegistry.getBindingForNode(older.node.id),
      lineage: lineageSnapshot(db, older.node.id),
    });
    const before = snapshot();

    const result = await service.cleanSeat({ seatRef: newerName, reason: "inspect stale history" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected live-session refusal");
    expect(result.code).toBe("session_live");
    expect(result.message).toContain(older.sessionName);
    expect(snapshot()).toEqual(before);
    expect(eventsOfType(db, "session.cleaned")).toHaveLength(0);
    expect(tmux.killed).toEqual([]);

    // The old advice cannot clear this blocker: stop selects the newer row.
    const stopped = await service.stopSeat({ seatRef: newerName, reason: "demonstrate stop target" });
    expect(stopped.ok).toBe(latestAlive);
    if (!stopped.ok) expect(stopped.code).toBe("session_not_live");
    expect(tmux.killed).toEqual(latestAlive ? [newerName] : []);
    const retry = await service.cleanSeat({ seatRef: newerName, reason: "retry after stop" });
    expect(retry).toMatchObject({ ok: false, code: "session_live" });
    expect(await tmux.adapter.hasSession(older.sessionName)).toBe(true);

    expect(result.guidance).toContain(`rig capture -- '${older.sessionName}'`);
    expect(result.guidance).toContain("end it yourself if it is no longer needed");
    expect(result.guidance).toContain("retry");
    expect(result.guidance).toContain("rig seat stop targets the seat's latest session");
    expect(result.guidance).not.toContain("Stop a live seat first");
  });

  it("clean also names a live binding target that stop cannot select", async () => {
    const seat = seatFixture("s5-rig", "dev.impl");
    sessionRegistry.updateStatus(seat.session.id, "exited");
    tmux.setAlive(seat.sessionName, false);
    const bindingName = "dev-impl-bound@s5-rig";
    sessionRegistry.updateBinding(seat.node.id, { attachmentType: "tmux", tmuxSession: bindingName, tmuxPane: "%2" });
    tmux.setAlive(bindingName, true);

    const result = await service.cleanSeat({ seatRef: "dev.impl", reason: "inspect stale binding" });
    expect(result).toMatchObject({ ok: false, code: "session_live" });
    if (result.ok) throw new Error("expected live-binding refusal");
    expect(result.guidance).toContain(`rig capture -- '${bindingName}'`);
    expect(result.guidance).not.toContain("Stop a live seat first");
    expect(sessionRegistry.getBindingForNode(seat.node.id)?.tmuxSession).toBe(bindingName);
    expect(tmux.killed).toEqual([]);
    expect(eventsOfType(db, "session.cleaned")).toHaveLength(0);
  });

  it.each([
    ["personal terminal", "'personal terminal'"],
    ["personal'terminal", "'personal'\"'\"'terminal'"],
    ["-old", "'-old'"],
  ])("clean quotes adopted live binding %s whose latest row is terminal", async (name, quoted) => {
    const seat = seatFixture("s5-rig", "dev.impl", { origin: "claimed" });
    db.prepare("UPDATE sessions SET session_name = ?, status = 'exited' WHERE id = ?").run(name, seat.session.id);
    sessionRegistry.updateBinding(seat.node.id, { attachmentType: "tmux", tmuxSession: name, tmuxPane: "%1" });
    tmux.setAlive(seat.sessionName, false);
    tmux.setAlive(name, true);
    const result = await service.cleanSeat({ seatRef: "dev.impl", reason: "inspect adopted binding" });
    expect(result).toMatchObject({ ok: false, code: "session_live" });
    if (result.ok) throw new Error("expected live-binding refusal");
    expect(result.guidance).toContain(`rig capture -- ${quoted}`);
    expect(result.guidance).not.toContain("Stop a live seat first");
    expect(sessionRegistry.getBindingForNode(seat.node.id)?.tmuxSession).toBe(name);
    const stopped = await service.stopSeat({ seatRef: "dev.impl", reason: "demonstrate adopted refusal" });
    expect(stopped).toMatchObject({ ok: false, code: "claimed_session" });
    expect(tmux.killed).toEqual([]);
    expect(eventsOfType(db, "session.cleaned")).toHaveLength(0);
  });

  // ---- Wave-2 fix round 1 (r1 BLOCKING, row 9baac99f) — transport blip vs the REAL adapter ----
  //
  // The r1 evidence (inverted here as the RED): the real TmuxAdapter under a
  // no-server blip classifies probeSession() = transport_unavailable, while its
  // COLLAPSED hasSession() view returns false. Verbs that consume the collapsed
  // view read the blip as absence — the KI-5.3-8 fabricated-absence class, in
  // the destructive direction: clean would clear a LIVE seat's state.
  describe("transport blip (real TmuxAdapter, injected no-server exec)", () => {
    function blipWorld() {
      const realTmux = new TmuxAdapter(async () => {
        throw new Error("no server running on /private/tmp/tmux-501/default");
      });
      const svc = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: realTmux });
      const seat = seatFixture("s5-rig", "dev.impl");
      return { realTmux, svc, seat };
    }

    it("the adapter itself distinguishes the blip (control: probe says transport_unavailable)", async () => {
      const { realTmux, seat } = blipWorld();
      const probe = await realTmux.probeSession(seat.sessionName);
      expect(probe.state).toBe("transport_unavailable");
    });

    it("clean under a blip REFUSES indeterminate and leaves the live seat's state byte-identical", async () => {
      const { svc, seat } = blipWorld();
      const before = lineageSnapshot(db, seat.node.id);

      const res = await svc.cleanSeat({ seatRef: seat.sessionName, reason: "blip pin" });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("DEFECT: cleanSeat proceeded under a transport blip against a live seat");
      expect(res.code).toBe("tmux_probe_failed");
      expect(res.message).toMatch(/not determined|indeterminate/i);

      // Nothing was destroyed: binding intact, session still running, no event.
      expect(sessionRegistry.getBindingForNode(seat.node.id)).not.toBeNull();
      expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
      expect(eventsOfType(db, "session.cleaned")).toHaveLength(0);
      expect(lineageSnapshot(db, seat.node.id)).toEqual(before);
    });

    it("F3 pin (r2 row 30045f39): older-LIVE / newer-dead sessions — clean must refuse, not terminalize the live older session", async () => {
      // Canonical-name churn can leave one node with several non-terminal session
      // rows under DIFFERENT names (staged/legacy renames). clean mutates ALL
      // non-terminal rows, so its safety probe must cover every row it will
      // touch — probing only the newest fabricates safety for the others.
      const tmuxLocal = fakeTmux();
      const svcLocal = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmuxLocal.adapter });
      // The fixture session is the OLDER row and stays LIVE in tmux.
      // (seatFixture marks liveness on the OUTER fake; mirror it on this test's own.)
      const seat = seatFixture("s5-rig", "dev.impl");
      tmuxLocal.setAlive(seat.sessionName, true);
      // A NEWER session row under a successor name, dead in tmux.
      const newerName = "dev-impl-v2@s5-rig";
      const newer = sessionRegistry.registerSession(seat.node.id, newerName);
      sessionRegistry.updateStatus(newer.id, "running");
      tmuxLocal.setAlive(newerName, false);
      // Ordering guard from the DB itself: the dead row IS the newest.
      const newest = db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(seat.node.id) as { id: string };
      expect(newest.id).toBe(newer.id);

      // Addressed by the CURRENT canonical name (the newest session's) — the
      // realistic operator ref; the older live session hides behind it.
      const res = await svcLocal.cleanSeat({ seatRef: newerName, reason: "F3 pin" });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error(`DEFECT (F3): clean proceeded and terminalized sessions ${JSON.stringify(res.actions)} while "${seat.sessionName}" is LIVE`);
      expect(res.code).toBe("session_live");
      expect(res.message).toContain(seat.sessionName);
      // The live older session row is untouched.
      expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
      expect(sessionRegistry.getBindingForNode(seat.node.id)).not.toBeNull();
    });

    it("stop under a blip REFUSES indeterminate — and does NOT route the operator to clean", async () => {
      const { svc, seat } = blipWorld();

      const res = await svc.stopSeat({ seatRef: seat.sessionName, reason: "blip pin" });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("DEFECT: stopSeat acted under a transport blip");
      // The blip must be the INDETERMINATE refusal, never the positive-absence one.
      expect(res.code).toBe("tmux_probe_failed");
      // The unsafe routing r1 flagged: under a blip the refusal must not point
      // at the destructive verb.
      expect(res.guidance ?? "").not.toContain("clean");
      expect(res.message ?? "").not.toContain("rig seat clean");
      // Session untouched.
      expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
    });
  });
});
