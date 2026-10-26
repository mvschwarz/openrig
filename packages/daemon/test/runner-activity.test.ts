import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore, hookEventState } from "../src/domain/agent-activity-store.js";
import { SeatActivityService, HOOK_AUTHORITY_WINDOW_MS } from "../src/domain/seat-activity-service.js";
import { activityRoutes, restoredRunnerHookEvidence } from "../src/routes/activity.js";
import {
  CLAUDE_ACTIVITY_RUNG_INVENTORY,
  CODEX_ACTIVITY_RUNG_INVENTORY,
  OMP_ACTIVITY_RUNG_INVENTORY,
  PI_ACTIVITY_RUNG_INVENTORY,
  TMUX_GENERIC_RUNG_INVENTORY,
  runtimeRungInventory,
} from "../src/domain/activity-taxonomy.js";
import { mapPiEvent, RunnerCore } from "../src/adapters/pi-runner.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";
import { createDaemon } from "../src/startup.js";

// pi and omp seats read activity from their runners' own turn events, through the one activity service.
// Every test posts what the runner posts for a runner event (mapPiEvent's hook), through the real route and recorder.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(runtime: "pi" | "omp") {
  const clock = { now: Date.parse("2026-10-21T12:00:00.000Z") };
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("runner-activity");
  const node = rigs.addNode(rig.id, "dev.a", { runtime });
  const sessions = new SessionRegistry(db);
  // The seat's previous occupant, under its own session name and generation, then the current one by handover.
  const oldSession = sessions.registerSession(node.id, "dev-a-old@runner-activity");
  const oldGeneration = sessions.currentOccupantTenure(node.id)!.generationUuid;
  sessions.updateStatus(oldSession.id, "exited");
  const session = sessions.registerSession(node.id, "dev-a@runner-activity", "handover");
  sessions.updateStatus(session.id, "running");
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus, now: () => new Date(clock.now),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  // The daemon's wiring: a new oracle (as after a restart) restores each runner seat's last hook from the store.
  const newOracle = () => new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
    now: () => new Date(clock.now), restoreHookEvidence: (seat, seatRuntime) => restoredRunnerHookEvidence(store, seat, seatRuntime) });
  let oracle = newOracle();
  oracle.declareRungInventory({ seatNodeId: node.id, sessionName: session.sessionName }, runtimeRungInventory(runtime));
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    c.set("seatActivityService" as never, oracle as never);
    await next();
  });
  /** A daemon restart: the in-memory ladder is gone; the first sweep declares the seat again. */
  async function restart() {
    oracle = newOracle();
    await oracle.pollAllRunningTmuxSeats(db);
  }
  app.route("/api/activity", activityRoutes);
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  /** What the runner posts (its activityPayload) for a hook event. */
  async function post(hookEvent: string, subtype: string | null, over: Record<string, unknown> = {}) {
    const response = await app.request("/api/activity/hooks", { method: "POST",
      headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionName: session.sessionName, nodeId: node.id, generation, runtime, hookEvent, subtype,
        occurredAt: new Date(clock.now).toISOString(), ...over }) });
    expect(response.status).toBe(200);
  }
  /** A post the real runner produced, delivered as its io would send it, for this seat. */
  async function deliver(payload: Record<string, unknown>) {
    const { hookEvent, subtype, ...rest } = payload;
    await post(String(hookEvent), (subtype as string | null) ?? null, { ...rest, sessionName: session.sessionName, nodeId: node.id, generation });
  }
  const nowIso = () => new Date(clock.now).toISOString();
  /** A runner event, posted exactly as the runner maps it; events that post nothing post nothing. */
  async function runnerEvent(event: Record<string, unknown>) {
    const mapped = mapPiEvent(event, runtime);
    if (mapped.activity) await post(mapped.activity.hookEvent, mapped.activity.subtype);
  }
  const state = () => oracle.getSeatState(node.id)!;
  const later = (ms: number) => { clock.now += ms; };
  const parked = () => diagnoseSeatParked({
    getSeatState: (id) => oracle.getSeatState(id),
    listOpenObligations: () => ({ rows: [{ qitemId: "q-1", state: "pending" }] as never, limit: 500 }),
  } as never, { seatNodeId: node.id, sessionName: session.sessionName }).parked;
  expect(generation).not.toBe(oldGeneration);
  return { post, runnerEvent, deliver, nowIso, state, later, parked, restart, node, session, oldGeneration, sessions };
}

const PAST_HOOK_WINDOW = HOOK_AUTHORITY_WINDOW_MS + 60_000;

describe("runner inventories", () => {
  it("gives pi and omp the runner inventory and leaves every other runtime as it was", () => {
    expect(runtimeRungInventory("pi")).toBe(PI_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("omp")).toBe(OMP_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("claude-code")).toBe(CLAUDE_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("codex")).toBe(CODEX_ACTIVITY_RUNG_INVENTORY);
    for (const runtime of ["terminal", "stub", null]) expect(runtimeRungInventory(runtime)).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    for (const inventory of [PI_ACTIVITY_RUNG_INVENTORY, OMP_ACTIVITY_RUNG_INVENTORY]) {
      expect(inventory.rungs).toEqual([
        { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative", durableBoundaries: true },
        { rung: "window-sampling", lifecycleCoverage: "partial", initialTrust: "positive-only" },
      ]);
    }
    // Claude and Codex hooks stay time-bounded.
    for (const inventory of [CLAUDE_ACTIVITY_RUNG_INVENTORY, CODEX_ACTIVITY_RUNG_INVENTORY]) {
      expect(inventory.rungs.some((r) => "durableBoundaries" in r)).toBe(false);
    }
  });
});

describe.each(["pi", "omp"] as const)("%s seat activity from its runner's turn events", (runtime) => {
  it("a quiet active turn reads working, then unknown past the hook window, never idle; a completed turn stays idle", async () => {
    const f = fixture(runtime);
    expect(f.state().activity).toBe("unknown");
    await f.runnerEvent({ type: "agent_start" });
    expect(f.state()).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
    expect(f.parked()).toBe(false);
    f.later(PAST_HOOK_WINDOW); // waiting on the model, or its end was lost: the pane is quiet
    expect(f.state()).toMatchObject({ activity: "unknown", decidedBy: null }); // the claimed-row backstop still sees no "working"
    expect(f.parked()).toBe("indeterminate");
    await f.runnerEvent({ type: "agent_end" });
    f.later(PAST_HOOK_WINDOW);
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    expect(f.parked()).toBe(true); // the parked-owner wake has a parked seat to wake
  });

  it("a turn whose runner never sends agent_start still reads working from turn_start", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_end" });
    expect(f.state().activity).toBe("idle-at-prompt");
    await f.runnerEvent({ type: "turn_start" });
    expect(f.state().activity).toBe("working");
  });

  it("process exit reads unknown, never idle, and stays so", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_start" });
    await f.post("Stop", `${runtime}_exited`);
    expect(f.state().activity).toBe("unknown");
    f.later(PAST_HOOK_WINDOW);
    expect(f.state().activity).toBe("unknown");
    expect(f.parked()).toBe("indeterminate");
    expect(hookEventState("Stop", `${runtime}_exited`, runtime)).toBe("unknown");
  });

  it("a late post from the previous occupant's generation or session changes nothing", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_start" });
    await f.post("Stop", "agent_end", { generation: f.oldGeneration });
    expect(f.state().activity).toBe("working");
    await f.post("Stop", "agent_end", { sessionName: "dev-a-old@runner-activity", nodeId: undefined, generation: f.oldGeneration });
    expect(f.state().activity).toBe("working");
  });
});

describe.each(["pi", "omp"] as const)("%s seat after a daemon restart", (runtime) => {
  it("an idle seat holding work comes back idle and parked, even long past the store's freshness window", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_start" });
    await f.runnerEvent({ type: "agent_end" });
    f.later(60 * 60 * 1000); // an hour idle, then the daemon restarts
    await f.restart();
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    expect(f.parked()).toBe(true);
  });

  it("a seat mid-turn comes back working, its first live event still decides, and an old start doesn't hold", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_start" });
    await f.restart();
    expect(f.state().activity).toBe("working");
    await f.runnerEvent({ type: "agent_end" });
    expect(f.state().activity).toBe("idle-at-prompt");
    const g = fixture(runtime);
    await g.runnerEvent({ type: "agent_start" });
    g.later(PAST_HOOK_WINDOW); // the restored start is older than the hook window: not working forever
    await g.restart();
    expect(g.state().activity).toBe("unknown");
  });

  it("a seat whose runner exited comes back unknown, not idle", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_end" });
    await f.post("Stop", `${runtime}_exited`);
    await f.restart();
    expect(f.state().activity).toBe("unknown");
  });

  it("restores nothing from a previous occupant's generation", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_end" });
    // A successor occupant under the same session name, which hasn't posted yet.
    f.sessions.updateStatus(f.session.id, "exited");
    const successor = f.sessions.registerSession(f.node.id, f.session.sessionName, "handover");
    f.sessions.updateStatus(successor.id, "running");
    await f.restart();
    expect(f.state()?.activity ?? "unknown").toBe("unknown");
  });
});

describe("source order", () => {
  it("an older Stop arriving after the next turn's start doesn't win, past the hook window or across a restart", async () => {
    const f = fixture("pi");
    const posts: Record<string, unknown>[] = [];
    const core = new RunnerCore({ sendRpc: () => {}, mirrorLine: () => {}, mirrorAppend: () => {},
      postActivity: (payload) => { posts.push(payload); }, writeSidecar: () => {}, now: f.nowIso },
    { sessionName: f.session.sessionName, nodeId: f.node.id, launchId: "launch-1" });
    core.start();
    // The real runner's posts for a turn of 33 tool calls and the start of the next, stamped at one clock reading: only its
    // order tells them apart.
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    for (let i = 0; i < 33; i++) core.handlePiLine(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
    for (const type of ["agent_end", "agent_start"]) core.handlePiLine(JSON.stringify({ type }));
    const sent = posts.filter((p) => typeof p.hookEvent === "string" && p.eventFamily === undefined);
    const newest = sent.at(-1)!;
    expect([sent.at(-2)!.hookEvent, newest.hookEvent, newest.sequence]).toEqual(["Stop", "active", 36]);
    await f.deliver(newest); // the next turn's start arrives first, then all 35 older posts, the Stop last
    for (const older of sent.slice(0, -1)) await f.deliver(older);
    expect(f.state().activity).toBe("working");
    await f.restart(); // restoring uses the same order: the newest start, not the late Stop
    expect(f.state().activity).toBe("working");
    f.later(PAST_HOOK_WINDOW);
    expect(f.state().activity).toBe("unknown");
  });

  it("orders by event time first, so a later runner launch's first post isn't taken as older", async () => {
    const f = fixture("pi");
    await f.post("active", "agent_start", { sequence: 40 });
    f.later(1_000);
    await f.post("Stop", "agent_end", { sequence: 1 }); // a relaunched runner starts its count again
    expect(f.state().activity).toBe("idle-at-prompt");
  });
});

describe("the daemon's own wiring", () => {
  it("its sweep restores a pi seat's last recorded runner hook, so an idle seat reads idle with no new event", async () => {
    const originalNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 404 }));
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "", cmuxExec: async () => "" } as Parameters<typeof createDaemon>[0]);
      const { rigRepo, sessionRegistry, agentActivityStore, seatActivityService } = daemon.deps;
      const rig = rigRepo.createRig("runner-restore");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "pi" });
      const sessionName = "worker@runner-restore";
      const session = sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStatus(session.id, "running");
      const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
      // Recorded before this daemon's oracle saw the seat, as after a restart.
      agentActivityStore.recordHookEvent({ sessionName, nodeId: node.id, runtime: "pi", generation, hookEvent: "Stop", subtype: "agent_end" });
      expect(seatActivityService.getSeatState(node.id)).toBeNull();
      await seatActivityService.pollAllRunningTmuxSeats(daemon.db);
      expect(seatActivityService.getSeatState(node.id)).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    } finally {
      daemon?.eventLoopMonitor.stop();
      daemon?.db.close();
      fetch.mockRestore();
      if (originalNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = originalNoKernel;
    }
  });
});

describe("pi idle liveness", () => {
  const BEAT = 180_000; // the runner's idle heartbeat, which it states as livenessSeconds on every Stop it posts
  const beat = (f: ReturnType<typeof fixture>) => f.post("Stop", "idle_heartbeat", { livenessSeconds: 180 });

  it("a seat that has just become ready reads idle from its first beat, with no turn yet", async () => {
    const f = fixture("pi");
    expect(f.state().activity).toBe("unknown");
    await beat(f);
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    expect(f.parked()).toBe(true);
  });

  it("an idle report holds for two beats, then lapses to unknown: a runner that died quietly stops reading idle", async () => {
    const f = fixture("pi");
    await f.runnerEvent({ type: "agent_start" });
    await f.post("Stop", "agent_end", { livenessSeconds: 180 });
    f.later(2 * BEAT - 1_000);
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    f.later(2_000);
    expect(f.state()).toMatchObject({ activity: "unknown", decidedBy: null });
    expect(f.parked()).toBe("indeterminate"); // no longer counts as a parked, available owner
  });

  it("keeps reading idle for as long as the beats keep coming", async () => {
    const f = fixture("pi");
    for (let i = 0; i < 6; i++) {
      await beat(f);
      f.later(BEAT);
      expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    }
  });

  it("a beat doesn't make a working seat idle and a turn start ends the idle", async () => {
    const f = fixture("pi");
    await beat(f);
    await f.runnerEvent({ type: "agent_start" });
    expect(f.state()).toMatchObject({ activity: "working" });
    f.later(HOOK_AUTHORITY_WINDOW_MS + 1_000); // a quiet turn: still the 15 s working window, as before
    expect(f.state()).toMatchObject({ activity: "unknown", decidedBy: null });
  });

  it("silence never clears a pending attention prompt", async () => {
    const f = fixture("pi");
    await beat(f);
    f.later(1_000);
    await f.post("Notification", "permission_prompt");
    f.later(60 * 60 * 1000);
    expect(f.state().needsInput).toMatchObject({ count: 1 });
    expect(f.parked()).toBe(true);
  });

  it("an idle report with no liveness promise (an older runner) still holds until the next boundary", async () => {
    const f = fixture("pi");
    await f.runnerEvent({ type: "agent_start" });
    await f.runnerEvent({ type: "agent_end" });
    f.later(60 * 60 * 1000);
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
  });

  it("ignores a liveness value that isn't a positive whole number of at most an hour", async () => {
    for (const bad of [0, -5, 1.5, 7200, "180", null]) {
      const f = fixture("pi");
      await f.post("Stop", "agent_end", { livenessSeconds: bad });
      f.later(60 * 60 * 1000);
      expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    }
  });

  it("after a daemon restart a fresh idle report is restored and a stale one is not", async () => {
    const f = fixture("pi");
    await beat(f);
    f.later(BEAT);
    await f.restart();
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    f.later(60 * 60 * 1000); // the runner died during the downtime and no beat has come since
    await f.restart();
    expect(f.state()).toMatchObject({ activity: "unknown", decidedBy: null });
  });
});

describe("omp only", () => {
  it("a nonterminal agent_end keeps the turn working", async () => {
    const f = fixture("omp");
    await f.runnerEvent({ type: "agent_start" });
    await f.runnerEvent({ type: "agent_end", isTerminal: false });
    expect(f.state().activity).toBe("working");
  });

  it("attention reads needs-input, holds past the hook window, and the next turn clears it", async () => {
    const f = fixture("omp");
    await f.runnerEvent({ type: "agent_start" });
    await f.post("Notification", "permission_prompt");
    f.later(PAST_HOOK_WINDOW);
    expect(f.state().needsInput).toMatchObject({ count: 1 });
    expect(f.parked()).toBe(true); // needs-input with open work is parked
    await f.runnerEvent({ type: "agent_start" });
    expect(f.state()).toMatchObject({ activity: "working", needsInput: { count: 0 } });
  });
});

describe("Claude hooks stay time-bounded", () => {
  it("a Claude Stop older than the hook window no longer decides", () => {
    const clock = { now: Date.parse("2026-10-21T12:00:00.000Z") };
    const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
      now: () => new Date(clock.now) });
    const seat = { seatNodeId: "n-claude", sessionName: "c@r" };
    oracle.declareRungInventory(seat, CLAUDE_ACTIVITY_RUNG_INVENTORY);
    oracle.reportEvidence({ ...seat, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 1,
      observedAt: new Date(clock.now).toISOString(), activity: "idle-at-prompt" });
    expect(oracle.getSeatState("n-claude")!.activity).toBe("idle-at-prompt");
    clock.now += PAST_HOOK_WINDOW;
    oracle.reportEvidence({ ...seat, rung: "needs-input-chrome", sourceId: "claude-code:chrome", seq: 1,
      observedAt: new Date(clock.now).toISOString(), needsInput: { count: 0, reason: null } });
    expect(oracle.getSeatState("n-claude")!.activity).toBe("unknown");
  });
});
