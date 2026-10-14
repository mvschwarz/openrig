// OPR.0.7.0.7 — rig seat set-effort: save one seat's effort for its next managed continuation.
// Requested, saved, emitted at launch and observed natively stay four separate values; this
// verb only knows the first two, and never reports a change that didn't happen.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

function fakeTmux() {
  const alive = new Map<string, boolean>();
  const failing = new Set<string>();
  const adapter = {
    probeSession: async (name: string) => {
      if (failing.has(name)) throw new Error("tmux probe failed (injected)");
      return (alive.get(name) ?? false) ? { state: "present" } : { state: "absent" };
    },
  } as unknown as TmuxAdapter;
  return { adapter, setAlive: (name: string, v: boolean) => alive.set(name, v), failProbeFor: (name: string) => failing.add(name) };
}

function eventsOfType(db: Database.Database, type: string): Array<Record<string, unknown>> {
  return (db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function nodeRow(db: Database.Database, nodeId: string) {
  return db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as Record<string, unknown>;
}

describe("SeatLifecycleService.setEffort", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let tmux: ReturnType<typeof fakeTmux>;
  let service: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    tmux = fakeTmux();
    service = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux.adapter });
  });

  afterEach(() => db.close());

  function seat(logicalId: string, opts?: { runtime?: string; effort?: string; alive?: boolean }) {
    const rig = rigRepo.findRigsByName("eff-rig")[0] ?? rigRepo.createRig("eff-rig");
    const sessionName = `${logicalId.replace(".", "-")}@eff-rig`;
    const node = rigRepo.addNode(rig.id, logicalId, {
      runtime: opts?.runtime ?? "claude-code", cwd: "/project", model: "claude-fable-5",
      ...(opts?.effort ? { effort: opts.effort } : {}),
    });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_session_id", "resume-uuid-1", "hook");
    tmux.setAlive(sessionName, opts?.alive ?? true);
    return { rig, node, sessionName };
  }

  it("saves the seat's choice apart from its authored effort, audits it, and touches nothing else", async () => {
    const { rig, node, sessionName } = seat("dev.impl", { effort: "medium" });
    const peer = seat("dev.peer", { effort: "medium" });
    const peerBefore = nodeRow(db, peer.node.id);
    const sessionsBefore = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    const before = nodeRow(db, node.id);

    const result = await service.setEffort({ seatRef: sessionName, effort: "high", reason: "long refactor", operator: "orch-lead@eff-rig" });

    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({
      runtime: "claude-code", requested: "high", changed: true, running: "yes", emitted: "not_yet", observed: "not_observed",
      from: { choice: null, authored: "medium", effective: "medium", source: "authored" },
      saved: { choice: "high", authored: "medium", effective: "high", source: "seat_choice" },
    });
    expect(result.effect).toMatch(/next managed continuation.*running process is unchanged/);
    // Only effort_choice changed: authored effort, model, the peer and every session row are untouched.
    expect(nodeRow(db, node.id)).toEqual({ ...before, effort_choice: "high" });
    expect(nodeRow(db, peer.node.id)).toEqual(peerBefore);
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBefore);
    expect(eventsOfType(db, "node.effort_changed")).toEqual([{
      type: "node.effort_changed", rigId: rig.id, nodeId: node.id, logicalId: "dev.impl",
      from: null, to: "high", reason: "long refactor", operator: "orch-lead@eff-rig",
    }]);
    expect(rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id)!.effortChoice).toBe("high");
  });

  it("the same choice again is changed: false and mints no event", async () => {
    const { sessionName } = seat("dev.impl");
    await service.setEffort({ seatRef: sessionName, effort: "high", reason: "first" });
    const again = await service.setEffort({ seatRef: sessionName, effort: "high", reason: "again" });
    if (!again.ok) throw new Error(again.message);
    expect(again.changed).toBe(false);
    expect(eventsOfType(db, "node.effort_changed")).toHaveLength(1);
  });

  it("clear goes back to the authored effort and names it", async () => {
    const { node, sessionName } = seat("dev.impl", { effort: "medium" });
    await service.setEffort({ seatRef: sessionName, effort: "high", reason: "set" });
    const cleared = await service.setEffort({ seatRef: sessionName, effort: null, reason: "back to spec" });
    if (!cleared.ok) throw new Error(cleared.message);
    expect(cleared).toMatchObject({ requested: null, changed: true, saved: { choice: null, effective: "medium", source: "authored" } });
    expect(cleared.effect).toMatch(/no saved effort choice now, so it goes back to the spec's authored effort medium at its next managed launch, resume, restore or spec refresh.*in-place restart keeps the running effort/);
    expect(nodeRow(db, node.id).effort_choice).toBeNull();
    expect(eventsOfType(db, "node.effort_changed").at(-1)).toMatchObject({ from: "high", to: null });
  });

  it("clear with no authored effort names the runtime default, and clearing nothing is not a change", async () => {
    const { sessionName } = seat("dev.impl", { runtime: "codex" });
    const nothing = await service.setEffort({ seatRef: sessionName, effort: null, reason: "noop" });
    if (!nothing.ok) throw new Error(nothing.message);
    expect(nothing.changed).toBe(false);
    await service.setEffort({ seatRef: sessionName, effort: "xhigh", reason: "set" });
    const cleared = await service.setEffort({ seatRef: sessionName, effort: null, reason: "clear" });
    if (!cleared.ok) throw new Error(cleared.message);
    expect(cleared.saved).toEqual({ choice: null, authored: null, effective: null, source: "runtime_default" });
    expect(cleared.effect).toMatch(/no effort flag \(the runtime's own default\)/);
  });

  it("reports whether the seat is running, and unknown when the probe can't tell", async () => {
    const stopped = seat("dev.stopped", { alive: false });
    const r1 = await service.setEffort({ seatRef: stopped.sessionName, effort: "low", reason: "x" });
    expect(r1).toMatchObject({ ok: true, running: "no", changed: true });

    const blind = seat("dev.blind");
    tmux.failProbeFor(blind.sessionName);
    const r2 = await service.setEffort({ seatRef: blind.sessionName, effort: "low", reason: "x" });
    expect(r2).toMatchObject({ ok: true, running: "unknown", changed: true });
    if (r2.ok) expect(r2.runningDetail).toMatch(/INDETERMINATE/);
  });

  it("refusals are loud and save nothing", async () => {
    const { node, sessionName } = seat("dev.impl", { effort: "medium" });
    const term = seat("ops.shell", { runtime: "terminal" });
    const cases: Array<[Parameters<SeatLifecycleService["setEffort"]>[0], string]> = [
      [{ seatRef: sessionName, effort: "high", reason: " " }, "missing_reason"],
      [{ seatRef: sessionName, effort: "  ", reason: "x" }, "missing_effort"],
      [{ seatRef: sessionName, effort: "high; rm -rf /", reason: "x" }, "invalid_effort"],
      [{ seatRef: "ghost@eff-rig", effort: "high", reason: "x" }, "seat_not_found"],
      [{ seatRef: term.sessionName, effort: "high", reason: "x" }, "effort_unsupported_runtime"],
    ];
    for (const [input, code] of cases) {
      const result = await service.setEffort(input);
      expect(result).toMatchObject({ ok: false, code });
    }
    expect(nodeRow(db, node.id).effort_choice).toBeNull();
    expect(eventsOfType(db, "node.effort_changed")).toHaveLength(0);
  });

  it("a database without the choice column refuses instead of reporting a change", async () => {
    const { sessionName } = seat("dev.impl", { effort: "medium" });
    db.exec("ALTER TABLE nodes DROP COLUMN effort_choice");
    const result = await service.setEffort({ seatRef: sessionName, effort: "high", reason: "x" });
    expect(result).toMatchObject({ ok: false, code: "effort_unavailable" });
    expect(eventsOfType(db, "node.effort_changed")).toHaveLength(0);
  });

  it("saves a level the runtime isn't known to accept, with a warning, never a refusal", async () => {
    const { sessionName } = seat("dev.typo", { runtime: "codex", effort: "medium" });
    const typo = await service.setEffort({ seatRef: sessionName, effort: "hihg", reason: "typo" });
    if (!typo.ok) throw new Error(typo.message);
    expect(typo).toMatchObject({ changed: true, saved: { choice: "hihg", effective: "hihg" } });
    expect(typo.warning).toContain(`"hihg" isn't a level Codex is known to accept`);
    const known = await service.setEffort({ seatRef: sessionName, effort: "xhigh", reason: "known" });
    if (!known.ok) throw new Error(known.message);
    expect(known.warning).toBeUndefined();
    const cleared = await service.setEffort({ seatRef: sessionName, effort: null, reason: "clear" });
    if (!cleared.ok) throw new Error(cleared.message);
    expect(cleared.warning).toBeUndefined();
  });
});
