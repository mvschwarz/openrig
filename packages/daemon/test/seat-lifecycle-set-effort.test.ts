// OPR.0.7.0.7 — rig seat set-effort: save one seat's effort for its next managed continuation.
// Requested, saved, emitted at launch and observed natively stay four separate values; this
// verb only knows the first two, and never reports a change that didn't happen.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { PiRecordSelection } from "../src/domain/model-divergence/current-generation-record.js";
import { readPiModelObservation } from "../src/domain/model-divergence/effective-model-readers.js";

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
      from: null, to: "high", reason: "long refactor", operator: "orch-lead@eff-rig", actorClass: "peer",
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

describe("SeatLifecycleService.setEffort and effortReport on a Pi seat", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let tmux: ReturnType<typeof fakeTmux>;
  let service: SeatLifecycleService;
  let dir: string;
  let selection: PiRecordSelection;
  const RUNNER_START_MS = Date.parse("2026-10-19T10:00:00.000Z");
  const at = (offsetSeconds: number) => new Date(RUNNER_START_MS + offsetSeconds * 1000).toISOString();

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    tmux = fakeTmux();
    dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
    selection = { ok: false, reason: "no managed Pi runner under registered pane %1" };
    service = new SeatLifecycleService({
      db, rigRepo, sessionRegistry, eventBus: new EventBus(db), tmuxAdapter: tmux.adapter,
      // The reader reads the runner's newest own turn within its occupant recheck.
      piRecords: { currentPiRecord: async () => selection.ok
        ? { ...selection, observation: readPiModelObservation(selection.path, { notBeforeMs: selection.notBeforeMs }) } : selection },
    });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function piSeat(runtime = "pi", effort?: string) {
    const rig = rigRepo.findRigsByName("pi-rig")[0] ?? rigRepo.createRig("pi-rig");
    const sessionName = `dev-${runtime}@pi-rig`;
    const node = rigRepo.addNode(rig.id, `dev.${runtime}`, { runtime, cwd: "/project", model: "anthropic/claude-fable-5", ...(effort ? { effort } : {}) });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    tmux.setAlive(sessionName, true);
    return { rig, node, sessionName };
  }

  /** The verified runner, launched with `thinking` (null: no flag), and its session file's records. */
  function runner(thinking: string | null, records: Array<Record<string, unknown>>) {
    const path = join(dir, "session.jsonl");
    const lines = [{ type: "session", version: 3, id: "s1", timestamp: at(-600), cwd: "/project" }, ...records];
    writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    selection = {
      ok: true, path, launchId: "L1", notBeforeMs: RUNNER_START_MS + 999, pid: 4101, startedAt: "Mon Oct 19 10:00:00 2026",
      command: `node /opt/openrig/pi-runner.js --session-name dev-pi@pi-rig --state-root /s --cwd /project --launch-id L1 --trust approve --model anthropic/claude-fable-5${thinking ? ` --thinking ${thinking}` : ""}`,
    };
  }
  const turn = (offsetSeconds: number, thinkingLevel?: string) => ({
    type: "message", id: `e${offsetSeconds}`, parentId: null, timestamp: at(offsetSeconds),
    message: { role: "assistant", provider: "anthropic", model: "claude-fable-5", stopReason: "stop", ...(thinkingLevel ? { thinkingLevel } : {}) },
  });

  it("set and --clear succeed with the audited event", async () => {
    const { rig, node, sessionName } = piSeat("pi", "medium");
    const set = await service.setEffort({ seatRef: sessionName, effort: "high", reason: "deep work", operator: "op" });
    if (!set.ok) throw new Error(set.message);
    expect(set).toMatchObject({ runtime: "pi", requested: "high", changed: true, saved: { choice: "high", effective: "high", source: "seat_choice" } });
    expect(set.warning).toBeUndefined();
    const cleared = await service.setEffort({ seatRef: sessionName, effort: null, reason: "back to spec" });
    if (!cleared.ok) throw new Error(cleared.message);
    expect(cleared).toMatchObject({ requested: null, changed: true, saved: { choice: null, effective: "medium", source: "authored" } });
    expect(eventsOfType(db, "node.effort_changed")).toEqual([
      { type: "node.effort_changed", rigId: rig.id, nodeId: node.id, logicalId: "dev.pi", from: null, to: "high", reason: "deep work", operator: "op", actorClass: "peer" },
      { type: "node.effort_changed", rigId: rig.id, nodeId: node.id, logicalId: "dev.pi", from: "high", to: null, reason: "back to spec", operator: null, actorClass: "unknown" },
    ]);
  });

  it("saves a level Pi doesn't know, such as Codex's none, with Pi's warning", async () => {
    const { sessionName } = piSeat();
    const none = await service.setEffort({ seatRef: sessionName, effort: "none", reason: "x" });
    if (!none.ok) throw new Error(none.message);
    expect(none).toMatchObject({ changed: true, saved: { choice: "none", effective: "none" } });
    expect(none.warning).toContain(`"none" isn't a level Pi is known to accept`);
    expect(none.warning).toContain("ignores a level it doesn't know");
  });

  it("an OMP seat is still refused", async () => {
    const { node, sessionName } = piSeat("omp");
    const result = await service.setEffort({ seatRef: sessionName, effort: "high", reason: "x" });
    expect(result).toMatchObject({ ok: false, code: "effort_unsupported_runtime" });
    if (!result.ok) expect(result.message).toContain("claude-code, codex and pi seats only");
    expect(await service.effortReport(sessionName)).toMatchObject({ ok: false, code: "effort_unsupported_runtime" });
    expect(nodeRow(db, node.id).effort_choice).toBeNull();
  });

  it("the level sent and the level Pi recorded agree", async () => {
    const { sessionName } = piSeat("pi", "high");
    runner("high", [turn(-30, "low"), turn(5, "high")]);
    const report = await service.effortReport(sessionName);
    expect(report).toMatchObject({
      ok: true, runtime: "pi",
      emitted: { state: "observed", value: "high", pid: 4101, startedAt: "Mon Oct 19 10:00:00 2026", matchesSaved: true },
      observed: { state: "observed", value: "high", at: at(5), source: "Pi session (latest successful assistant turn; error and aborted turns are skipped)", outcome: "recorded", matchesEmitted: true },
    });
    const { summary, observed } = report as { summary: string; observed: { detail: string } };
    expect(observed.detail).toBe("Pi recorded this level with the turn's request: the session's level after Pi's own cap, not proof the provider applied it.");
    expect(summary).toContain("applied level NOT VERIFIED (Pi records the level it requested, not what the provider ran)");
    expect(summary).not.toContain("model fallback");
  });

  it("a capped level is reported apart from the level sent", async () => {
    const { sessionName } = piSeat("pi", "xhigh");
    runner("xhigh", [turn(5, "high")]);
    const report = await service.effortReport(sessionName);
    expect(report).toMatchObject({ emitted: { value: "xhigh", matchesSaved: true }, observed: { state: "observed", value: "high", matchesEmitted: false } });
    const summary = (report as { summary: string }).summary;
    expect(summary).toContain("high, not the xhigh sent at launch (Pi caps a level the model doesn't offer, ignores one it doesn't know, and the level can change inside the session)");
    expect(summary).not.toContain("changed or overridden inside the session");
  });

  it("with no flag sent, Pi's own level is not a mismatch", async () => {
    const { sessionName } = piSeat();
    runner(null, [turn(5, "medium")]);
    const report = await service.effortReport(sessionName);
    expect(report).toMatchObject({ emitted: { state: "observed", value: null, matchesSaved: true }, observed: { state: "observed", value: "medium" } });
    expect((report as { observed: object }).observed).not.toHaveProperty("matchesEmitted");
    expect((report as { summary: string }).summary).not.toContain("not the");
  });

  it("a --thinking value that ps shows with whitespace is unknown, not its first word", async () => {
    const { sessionName } = piSeat("pi", "high");
    runner("very high --session x", [turn(5, "high")]);
    const report = await service.effortReport(sessionName);
    expect(report).toMatchObject({
      emitted: { state: "unknown", detail: "The launch command's --thinking value can't be read unambiguously (it contains whitespace)." },
      observed: { state: "observed", value: "high" },
    });
    expect((report as { observed: object }).observed).not.toHaveProperty("matchesEmitted");
    expect((report as { summary: string }).summary).toContain("Launch: unknown");
    expect((report as { summary: string }).summary).toContain("Native effort: high (Pi session");
    expect((report as { summary: string }).summary).not.toContain("NOT VERIFIED");
  });

  it("a saved value the launch guard leaves out is reported as not sent, with the reason", async () => {
    const { sessionName } = piSeat("pi", "--cwd");
    runner(null, [turn(5, "medium")]);
    const report = await service.effortReport(sessionName);
    expect(report).toMatchObject({ saved: { effective: "--cwd" }, emitted: { state: "observed", value: null, matchesSaved: true } });
    const summary = (report as { summary: string }).summary;
    expect(summary).toContain("Launch sent: no flag. The saved value isn't sent: it doesn't pass the check set-effort uses");
    expect(summary).not.toContain("it applies at the seat's next managed continuation");
    // A launch from before the value was saved still carries its own flag; the saved value still isn't sent.
    runner("high", [turn(5, "high")]);
    const older = (await service.effortReport(sessionName)) as { summary: string };
    expect(older.summary).toContain("Launch sent: high. The saved value isn't sent");
    expect(older.summary).not.toContain("it applies at the seat's next managed continuation");
  });

  it("a Pi that doesn't record the level (0.87.1) is NOT VERIFIED and says why", async () => {
    const { sessionName } = piSeat("pi", "high");
    runner("high", [turn(5)]);
    const report = await service.effortReport(sessionName);
    expect(report).toMatchObject({ emitted: { state: "observed", value: "high" }, observed: { state: "not_verified" } });
    expect((report as { observed: { detail: string } }).observed.detail).toContain("Pi 0.99.0 and later do");
  });

  it("no turn since this launch is NOT VERIFIED with the reader's reason", async () => {
    const { sessionName } = piSeat("pi", "high");
    runner("high", [turn(-30, "high")]);
    const report = await service.effortReport(sessionName);
    expect(report).toMatchObject({ emitted: { state: "observed", value: "high" }, observed: { state: "not_verified" } });
    expect((report as { observed: { detail: string } }).observed.detail).toContain("predates the current runner");
  });

  it("a runner that can't be verified leaves the launch unknown and native effort NOT VERIFIED, with the reason", async () => {
    const { sessionName } = piSeat("pi", "high");
    const report = await service.effortReport(sessionName);
    expect(report).toMatchObject({ ok: true, emitted: { state: "unknown" }, observed: { state: "not_verified" } });
    const { emitted, observed, summary } = report as { emitted: { detail: string }; observed: { detail: string }; summary: string };
    expect(emitted.detail).toContain("no managed Pi runner under registered pane %1");
    expect(observed.detail).toContain("no managed Pi runner under registered pane %1");
    expect(summary).toContain("Native effort: NOT VERIFIED");
  });
});
