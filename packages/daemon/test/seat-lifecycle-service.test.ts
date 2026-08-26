// S5 (OPR.0.5.4.5) — seat-lifecycle verb surface: set-model / stop / clean.
// RED-first pins for the three KI-5.3-9 gaps. The gap-3 defect (a dead managed
// seat is permanently `already_bound`) is demonstrated inside the P5 pin against
// the real NodeLauncher, so the committed RED models the runtime relation, not a
// fixture of the author's imagination.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter, type TmuxResult } from "../src/adapters/tmux.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

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
  function seatFixture(rigName: string, logicalId: string, opts?: { model?: string; origin?: "claimed" }) {
    const existing = rigRepo.findRigsByName(rigName)[0] ?? rigRepo.createRig(rigName);
    const sessionName = `${logicalId.replace(".", "-")}@${rigName}`;
    const node = rigRepo.addNode(existing.id, logicalId, {
      runtime: "claude-code",
      cwd: "/project",
      model: opts?.model ?? "fable",
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
    expect(events[0]).toMatchObject({ nodeId: a.node.id, sessionName: a.sessionName, reason: "single-seat stop test", operator: "op@rig" });
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

  it("P4: stop refuses a claimed (adopted) session, an indeterminate probe, and a no-session node", async () => {
    const claimed = seatFixture("s5-rig", "dev.adopted", { origin: "claimed" });
    const claimedResult = await service.stopSeat({ seatRef: claimed.sessionName, reason: "x" });
    expect(claimedResult.ok).toBe(false);
    if (claimedResult.ok) throw new Error("expected refusal");
    expect(claimedResult.code).toBe("claimed_session");

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
    expect(liveResult.guidance).toContain("stop");
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
