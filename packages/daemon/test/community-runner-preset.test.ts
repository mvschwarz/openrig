import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry, sessionCommunityRunnerSelect } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore, hookEventState, isRunnerExit, latestHookMovedOn } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes, restoredRunnerHookEvidence } from "../src/routes/activity.js";
import {
  COMMUNITY_HARNESS_RUNG_INVENTORY,
  COMMUNITY_RUNNER_RUNG_INVENTORY,
  OMP_ACTIVITY_RUNG_INVENTORY,
  PI_ACTIVITY_RUNG_INVENTORY,
  runtimeRungInventory,
} from "../src/domain/activity-taxonomy.js";
import { createFullTestDb, migrationsForFullTestDb } from "./helpers/test-app.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { AgentActivity } from "../src/domain/types.js";

// A community preset whose command is an OpenRig-aware runner (`runner: true`): its seat's activity follows the hooks
// its runner posts, decided by what that occupant's launch declared, never by a later preset edit. Every other seat,
// built-in or plain community, keeps today's behaviour.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const BASE = "format: 1\nname: synth\ncommand: synth-seat --acp\nmaintainer: Example Maintainer\nlimits: []\n";
function presetDir(body: string): string {
  const dir = scratch("runner-presets-");
  writeFileSync(join(dir, "synth.yaml"), body);
  return dir;
}

describe("declaring a runner preset", () => {
  it("loads runner: true with launch_result, and a preset without it reads as plain", () => {
    expect(loadCommunityHarnessPreset("synth", presetDir(BASE + "launch_result: true\nrunner: true\n")))
      .toMatchObject({ ok: true, preset: { runner: true, launchResult: true } });
    expect(loadCommunityHarnessPreset("synth", presetDir(BASE))).toMatchObject({ ok: true, preset: { runner: false } });
  });

  it.each([
    ["runner without launch_result", "runner: true\n", "runner needs launch_result: true"],
    ["runner with names_conversation", "runner: true\nnames_conversation: true\n", "runner needs launch_result: true"],
    ["runner, launch_result and names_conversation", "runner: true\nlaunch_result: true\nnames_conversation: true\n", "can't both be true"],
    ["a runner that isn't a boolean", "runner: yes-please\nlaunch_result: true\n", "runner must be true or false"],
  ])("refuses %s", (_case, extra, message) => {
    expect(loadCommunityHarnessPreset("synth", presetDir(BASE + extra))).toMatchObject({ ok: false, message: expect.stringContaining(message) });
  });
});

describe("the runner declaration recorded with the launch", () => {
  function seat(db: Database.Database) {
    const registry = new SessionRegistry(db);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1', 'rig-1', 'work.worker', 'synth', '/tmp')").run();
    return { registry, session: registry.registerSession("n1", "work-worker@r") };
  }
  const recorded = (db: Database.Database, id: string) =>
    (db.prepare("SELECT agent_app, agent_runner FROM sessions WHERE id = ?").get(id) as { agent_app: string | null; agent_runner: number | null });

  it("records 1 for a runner launch and 0 for a plain one; a selection carried without it leaves the field as it was", () => {
    const db = createFullTestDb(); cleanups.push(() => db.close());
    const { registry, session } = seat(db);
    expect(recorded(db, session.id)).toEqual({ agent_app: null, agent_runner: null });
    registry.recordCommunityHarnessSelection(session.id, "synth", true);
    expect(recorded(db, session.id)).toEqual({ agent_app: "synth", agent_runner: 1 });
    registry.recordCommunityHarnessSelection(session.id, "synth");
    expect(recorded(db, session.id)).toEqual({ agent_app: "synth", agent_runner: 1 });
    registry.recordCommunityHarnessSelection(session.id, "synth", false);
    expect(recorded(db, session.id)).toEqual({ agent_app: "synth", agent_runner: 0 });
  });

  it("reads NULL on a legacy schema without the column, and still records the selection there", () => {
    const db = new Database(":memory:"); cleanups.push(() => db.close());
    migrate(db, migrationsForFullTestDb.filter(item => !item.name.startsWith("141_")));
    expect(sessionCommunityRunnerSelect(db)).toBe("NULL");
    const { registry, session } = seat(db);
    registry.recordCommunityHarnessSelection(session.id, "synth", true);
    expect(db.prepare("SELECT agent_app FROM sessions WHERE id = ?").get(session.id)).toEqual({ agent_app: "synth" });
  });

  it("takes the declaration from the preset at launch time", () => {
    const dir = presetDir(BASE + "launch_result: true\nrunner: true\n");
    const adapter = new CommunityHarnessRuntimeAdapter("synth", { tmux: {} as never, presetsDir: () => dir });
    expect(adapter.runner()).toBe(true);
    writeFileSync(join(dir, "synth.yaml"), BASE + "launch_result: true\n");
    expect(adapter.runner()).toBe(false);
  });
});

describe("choosing a seat's activity inventory", () => {
  it("gives the runner inventory only to a community seat recorded as launched for a runner", () => {
    expect(runtimeRungInventory("synth", "synth", true)).toBe(COMMUNITY_RUNNER_RUNG_INVENTORY);
    expect(runtimeRungInventory("synth", "synth", false)).toBe(COMMUNITY_HARNESS_RUNG_INVENTORY);
    expect(runtimeRungInventory("synth", "synth")).toBe(COMMUNITY_HARNESS_RUNG_INVENTORY);
    expect(COMMUNITY_RUNNER_RUNG_INVENTORY.rungs).toEqual(PI_ACTIVITY_RUNG_INVENTORY.rungs);
    // Built-ins keep theirs, whatever the flag says.
    expect(runtimeRungInventory("pi", null, true)).toBe(PI_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("omp", null, true)).toBe(OMP_ACTIVITY_RUNG_INVENTORY);
  });
});

/** A synth seat through the real hook route, store and oracle; `runner` is what its launch recorded. */
function fixture(runner: boolean | undefined) {
  const clock = { now: Date.parse("2026-10-28T12:00:00.000Z") };
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("runner-preset");
  const node = rigs.addNode(rig.id, "dev.a", { runtime: "synth" });
  const sessions = new SessionRegistry(db);
  let session = sessions.registerSession(node.id, "dev-a@runner-preset");
  sessions.updateStatus(session.id, "running");
  sessions.recordCommunityHarnessSelection(session.id, "synth", runner);
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(clock.now),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const newOracle = () => new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
    now: () => new Date(clock.now), restoreHookEvidence: (seat, seatRuntime) => restoredRunnerHookEvidence(store, seat, seatRuntime) });
  let oracle = newOracle();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    c.set("seatActivityService" as never, oracle as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  /** What a runner posts for a hook event, with the current occupant's generation. */
  async function post(hookEvent: string, subtype: string | null) {
    clock.now += 1000;
    const response = await app.request("/api/activity/hooks", { method: "POST",
      headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionName: session.sessionName, nodeId: node.id, generation: sessions.currentOccupantTenure(node.id)!.generationUuid,
        runtime: "synth", hookEvent, subtype, occurredAt: new Date(clock.now).toISOString() }) });
    expect(response.status).toBe(200);
  }
  /** A daemon restart: a new oracle whose first sweep declares the seat from the recorded launch facts. */
  async function restart() {
    oracle = newOracle();
    await oracle.pollAllRunningTmuxSeats(db);
  }
  /** A new occupant under the same session name, with its own launch facts. */
  function replace(next: boolean | undefined) {
    session = sessions.registerSession(node.id, "dev-a@runner-preset", "handover");
    sessions.updateStatus(session.id, "running");
    sessions.recordCommunityHarnessSelection(session.id, "synth", next);
  }
  const state = () => oracle.getSeatState(node.id);
  const latest = () => store.getLatestForNode({ nodeId: node.id, sessionName: session.sessionName });
  const later = (ms: number) => { clock.now += ms; };
  return { post, restart, replace, state, latest, later, db, oracle: () => oracle };
}

describe("a runner seat's activity follows its hooks", () => {
  it("reads working, then idle, from the runner's posts, on the hook route's own first declaration", async () => {
    const seat = fixture(true);
    await seat.post("UserPromptSubmit", "accepted");
    expect(seat.state()).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
    await seat.post("Stop", "end_turn");
    expect(seat.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
  });

  it("is declared the same way by the reconcile pass after a daemon restart", async () => {
    const seat = fixture(true);
    await seat.restart();
    await seat.post("UserPromptSubmit", "accepted");
    expect(seat.state()).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
  });

  it("comes back idle after a daemon restart, long past the store's freshness window, as a Pi seat does", async () => {
    const seat = fixture(true);
    await seat.post("UserPromptSubmit", "accepted");
    await seat.post("Stop", "end_turn");
    seat.later(60 * 60 * 1000);
    await seat.restart();
    expect(seat.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
  });

  it.each([["a plain launch", false], ["a legacy session with nothing recorded", undefined]] as const)(
    "leaves %s as today: the same posts don't decide its activity", async (_case, runner) => {
      const seat = fixture(runner);
      await seat.restart();
      await seat.post("UserPromptSubmit", "accepted");
      await seat.post("Stop", "end_turn");
      expect(seat.state()?.decidedBy).not.toBe("lifecycle-hooks");
    });

  it("follows a replacement occupant under the same session name: the same oracle re-declares a plain one", async () => {
    const seat = fixture(true);
    await seat.restart();
    await seat.post("UserPromptSubmit", "accepted");
    expect(seat.state()).toMatchObject({ decidedBy: "lifecycle-hooks" });
    seat.replace(false);
    await seat.oracle().pollAllRunningTmuxSeats(seat.db);
    await seat.post("UserPromptSubmit", "accepted");
    expect(seat.state()?.decidedBy).not.toBe("lifecycle-hooks");
  });
});

describe("a runner's exit never reads idle", () => {
  it("reads a runner seat's <runtime>_exited as not idle, in the store and the oracle", async () => {
    const seat = fixture(true);
    await seat.post("UserPromptSubmit", "accepted");
    await seat.post("Stop", "synth_exited");
    expect(seat.latest()).toMatchObject({ state: "unknown", communityRunner: true });
    expect(seat.state()?.activity).not.toBe("idle-at-prompt");
  });

  it("still reads a runner's exit as not idle after a daemon restart, once the record has gone stale", async () => {
    const seat = fixture(true);
    await seat.post("Stop", "end_turn");
    await seat.post("Stop", "synth_exited");
    seat.later(60 * 60 * 1000);
    await seat.restart();
    expect(seat.state()?.activity).toBe("unknown");
  });

  it.each([["a plain launch", false], ["a legacy session", undefined]] as const)(
    "keeps today's mapping for %s posting an exit-shaped Stop", async (_case, runner) => {
      const seat = fixture(runner);
      await seat.post("Stop", "synth_exited");
      expect(seat.latest()?.state).toBe("idle");
      expect(seat.latest()).not.toHaveProperty("communityRunner");
    });

  it("keeps pi, omp and the other built-ins exactly as they were", () => {
    expect(isRunnerExit("pi_exited", "pi")).toBe(true);
    expect(isRunnerExit("omp_exited", "omp")).toBe(true);
    expect(isRunnerExit("synth_exited", "synth")).toBe(false);
    expect(isRunnerExit("synth_exited", "synth", true)).toBe(true);
    expect(isRunnerExit("pi_exited", "synth", true)).toBe(false);
    expect(hookEventState("Stop", "pi_exited", "pi")).toBe("unknown");
    expect(hookEventState("Stop", "end_turn", "claude-code")).toBe("idle");
    expect(hookEventState("Stop", "synth_exited", "synth")).toBe("idle");
    expect(hookEventState("Stop", "synth_exited", "synth", true)).toBe("unknown");
  });

  it("keeps the exit's meaning once the record goes stale: a dead runner hasn't moved on", () => {
    const stale = (communityRunner?: boolean): AgentActivity => ({
      state: "unknown", reason: "stale_runtime_hook", evidenceSource: "runtime_hook", sampledAt: "2026-10-28T12:10:00.000Z",
      evidence: "synth_exited", eventAt: "2026-10-28T12:05:00.000Z", rawEvent: "Stop", rawSubtype: "synth_exited",
      runtime: "synth", fallback: false, stale: true, generation: null, ...(communityRunner ? { communityRunner } : {}),
    }) as AgentActivity;
    expect(latestHookMovedOn(stale(true), "2026-10-28T12:00:00.000Z", "synth")).toBe(false);
    expect(latestHookMovedOn(stale(), "2026-10-28T12:00:00.000Z", "synth")).toBe(true);
  });
});

describe("a runner preset's launch record", () => {
  const binding = { tmuxSession: "w@r" } as NodeBinding;
  function launcher(preset: string, writeRecord: boolean) {
    const presets = presetDir(preset);
    const root = scratch("runner-results-");
    const sendShellCommand = vi.fn(async (_session: string, command: string) => {
      const file = /OPENRIG_LAUNCH_RESULT='([^']+)'/.exec(command)?.[1];
      const attempt = /OPENRIG_LAUNCH_ATTEMPT=(\S+)/.exec(command)?.[1];
      if (writeRecord && file && attempt) {
        writeFileSync(file, JSON.stringify({ format: 1, attempt, harness: "synth", nativeRef: "sess-1", producer: "synth-seat 0.1; ACP 1" }));
      }
      return { ok: true as const };
    });
    return new CommunityHarnessRuntimeAdapter("synth", { tmux: { hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "node"), sendShellCommand },
      presetsDir: () => presets, launchResultRoot: () => root, launchResultWait: { timeoutMs: 20, intervalMs: 10 } });
  }

  it("records the runner's reported conversation, with launcher provenance", async () => {
    expect(await launcher(BASE + "launch_result: true\nrunner: true\n", true).launchHarness(binding, { name: "w@r" }))
      .toEqual({ ok: true, resumeToken: "sess-1", resumeType: "community:synth", resumeProvenance: "launcher" });
  });

  it("leaves a runner seat needing attention, not ready, when its record never arrives", async () => {
    const result = await launcher(BASE + "launch_result: true\nrunner: true\n", false).launchHarness(binding, { name: "w@r" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required", error: expect.stringContaining("launch identity is unavailable") });
  });

  it("keeps a plain launch_result preset as today: it starts, with the identity unavailable", async () => {
    expect(await launcher(BASE + "launch_result: true\n", false).launchHarness(binding, { name: "w@r" }))
      .toEqual({ ok: true, warnings: [expect.stringContaining("launch identity is unavailable")] });
  });
});
