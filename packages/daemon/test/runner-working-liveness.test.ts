import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService, HOOK_AUTHORITY_WINDOW_MS } from "../src/domain/seat-activity-service.js";
import { activityRoutes, restoredRunnerHookEvidence } from "../src/routes/activity.js";
import { runtimeRungInventory } from "../src/domain/activity-taxonomy.js";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";

// The runner contract's working beat (section 4): `active` / `liveness` keeps a long, quiet turn reading working while
// the runner says its prompt is outstanding and its agent alive. A beat counts only for the live generation's latest
// accepted turn that hasn't ended, with a sequence above every earlier post's, and never while attention is
// outstanding; it lasts its livenessSeconds, clamped to 5-60 s (30 s without one), then the seat reads unknown again.
// Every test posts what a runner posts, through the real route, recorder and activity service.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const runtime = "pi";
  const clock = { now: Date.parse("2026-11-01T12:00:00.000Z") };
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("working-liveness");
  const node = rigs.addNode(rig.id, "dev.a", { runtime });
  const sessions = new SessionRegistry(db);
  const oldSession = sessions.registerSession(node.id, "dev-a-old@working-liveness");
  const oldGeneration = sessions.currentOccupantTenure(node.id)!.generationUuid;
  sessions.updateStatus(oldSession.id, "exited");
  const session = sessions.registerSession(node.id, "dev-a@working-liveness", "handover");
  sessions.updateStatus(session.id, "running");
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus, now: () => new Date(clock.now),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const newOracle = () => {
    const service = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
      now: () => new Date(clock.now), restoreHookEvidence: (seat, seatRuntime) => restoredRunnerHookEvidence(store, seat, seatRuntime) });
    service.declareRungInventory({ seatNodeId: node.id, sessionName: session.sessionName }, runtimeRungInventory(runtime));
    return service;
  };
  let oracle = newOracle();
  let app = new Hono();
  const mount = (routes: typeof activityRoutes) => {
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, store as never);
      c.set("activityHookToken" as never, "fixture-token" as never);
      c.set("seatActivityService" as never, oracle as never);
      await next();
    });
    app.route("/api/activity", routes);
  };
  mount(activityRoutes);
  let generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  async function post(hookEvent: string, subtype: string | null, over: Record<string, unknown> = {}) {
    const response = await app.request("/api/activity/hooks", { method: "POST",
      headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionName: session.sessionName, nodeId: node.id, generation, runtime, hookEvent, subtype,
        occurredAt: new Date(clock.now).toISOString(), ...over }) });
    expect(response.status).toBe(200);
    return await response.json() as { ok: boolean; ignored?: string };
  }
  let sequence = 0;
  const next = () => ++sequence;
  const accepted = (turnId: string) => post("UserPromptSubmit", "accepted", { turnId, sequence: next() });
  const beat = (turnId: string, over: Record<string, unknown> = {}) =>
    post("active", "liveness", { turnId, sequence: next(), livenessSeconds: 30, ...over });
  const state = () => oracle.getSeatState(node.id)!;
  const later = (ms: number) => { clock.now += ms; };
  const at = (skewMs = 0) => new Date(clock.now + skewMs).toISOString();
  // A daemon restart: a new activity service takes the seat's last recorded hook, as its reconcile pass does.
  const restart = () => {
    oracle = newOracle();
    const evidence = restoredRunnerHookEvidence(store, { seatNodeId: node.id, sessionName: session.sessionName }, runtime);
    if (evidence) oracle.reportEvidence({ ...evidence, seq: 0 });
  };
  // The same, with what the route module held in memory lost too, its working-liveness gate among it.
  const restartDaemon = async () => {
    vi.resetModules();
    mount((await import("../src/routes/activity.js")).activityRoutes);
    restart();
  };
  // `rig seat clear-attention`: the operator's word that the prompt is gone, outside the hook route.
  const clearAttention = () => {
    store.recordHookEvent({ sessionName: session.sessionName, runtime, generation, hookEvent: "PermissionPromptCleared" });
    oracle.settlePermissionPrompt(session.sessionName);
  };
  // A same-name replacement: a new occupant takes the seat and keeps its session name.
  const replaceOccupant = () => {
    const previous = generation;
    sessions.updateStatus(session.id, "exited");
    const replacement = sessions.registerSession(node.id, session.sessionName, "handover");
    sessions.updateStatus(replacement.id, "running");
    generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
    return { previous, current: generation };
  };
  return { post, accepted, beat, next, state, later, at, restart, restartDaemon, clearAttention, replaceOccupant, oldGeneration, runtime,
    sessionName: session.sessionName, nodeId: node.id, generation: () => generation };
}

describe("the runner's working beat", () => {
  it("keeps a long silent turn reading working while beats keep coming, then unknown, never idle, once they stop", async () => {
    const f = fixture();
    await f.accepted("1");
    for (let i = 0; i < 8; i++) {
      f.later(12_000);
      expect(await f.beat("1")).toEqual({ ok: true, activity: expect.anything() });
      f.later(HOOK_AUTHORITY_WINDOW_MS + 5_000); // past the 15 s a bare working post has, inside the beat's 30 s
      expect(f.state()).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
      f.later(-(HOOK_AUTHORITY_WINDOW_MS + 5_000));
    }
    f.later(31_000); // the last beat's 30 s are up
    expect(f.state()).toMatchObject({ activity: "unknown", decidedBy: null });
  });

  it("lasts its livenessSeconds, clamped to 5-60 s, and 30 s when the beat has none", async () => {
    for (const [given, lasts] of [[600, 60], [1, 5], [undefined, 30], [20, 20]] as const) {
      const f = fixture();
      await f.accepted("1");
      await f.beat("1", given === undefined ? { livenessSeconds: undefined } : { livenessSeconds: given });
      f.later(lasts * 1000 - 500);
      expect(f.state().activity, `livenessSeconds ${given} still counts at ${lasts} s`).toBe("working");
      f.later(1_000);
      expect(f.state().activity, `livenessSeconds ${given} has lapsed after ${lasts} s`).toBe("unknown");
    }
  });

  it("is ignored after its turn's Stop, for an earlier turn, out of order, or with no sequence", async () => {
    const f = fixture();
    await f.accepted("1");
    await f.post("Stop", "end_turn", { sequence: f.next(), livenessSeconds: 180 });
    expect(await f.beat("1")).toMatchObject({ ok: true, ignored: "turn_ended" });
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt" });
    await f.accepted("2");
    expect(await f.beat("1")).toMatchObject({ ignored: "wrong_turn" });
    expect(await f.beat("2", { sequence: 2 })).toMatchObject({ ignored: "out_of_order" });
    expect(await f.beat("2", { sequence: undefined })).toMatchObject({ ignored: "no_sequence" });
    f.later(HOOK_AUTHORITY_WINDOW_MS + 1_000);
    expect(f.state()).toMatchObject({ activity: "unknown" }); // none of them kept turn 2 working
  });

  it("is ignored before any accepted turn, and from the previous occupant's generation", async () => {
    const f = fixture();
    expect(await f.beat("1")).toMatchObject({ ignored: "no_turn" });
    await f.accepted("1");
    expect(await f.beat("1", { generation: f.oldGeneration })).toMatchObject({ ignored: "stale_generation" });
    f.later(HOOK_AUTHORITY_WINDOW_MS + 1_000);
    expect(f.state()).toMatchObject({ activity: "unknown" });
  });

  it("never clears attention; after the runner's permission_resolved, the same turn's beats count again", async () => {
    const f = fixture();
    await f.accepted("1");
    // OpenRig records the seat's permission prompt when it opens an ask, with no runner sequence.
    await f.post("Notification", "permission_prompt", { turnId: "1" });
    const delayed = f.next(); // a beat posted before the ask, arriving after it
    expect(await f.beat("1", { sequence: delayed })).toMatchObject({ ignored: "attention_outstanding" });
    expect(f.state().needsInput).toMatchObject({ count: 1 });
    // The answer is delivered and the agent goes on with turn 1.
    await f.post("active", "permission_resolved", { turnId: "1", askId: "ask-1", sequence: f.next() });
    expect(f.state()).toMatchObject({ activity: "working", needsInput: { count: 0 } });
    expect(await f.beat("1", { sequence: delayed })).toMatchObject({ ignored: "out_of_order" });
    expect(await f.beat("1")).toEqual({ ok: true, activity: expect.anything() });
    f.later(HOOK_AUTHORITY_WINDOW_MS + 5_000);
    expect(f.state()).toMatchObject({ activity: "working", needsInput: { count: 0 } });
  });

  it("is ignored after the agent's exit", async () => {
    const f = fixture();
    await f.accepted("1");
    await f.post("Stop", `${f.runtime}_exited`, { sequence: f.next() });
    expect(await f.beat("1")).toMatchObject({ ignored: "turn_ended" });
    expect(f.state()).toMatchObject({ activity: "unknown" });
  });

  it("isn't ended by an earlier turn's Stop that arrives after the next accepted turn", async () => {
    const f = fixture();
    await f.accepted("A");
    f.later(1_000);
    const stopA = { turnId: "A", sequence: f.next(), occurredAt: f.at() }; // posted now, delivered late
    f.later(1_000);
    await f.accepted("B");
    await f.post("Stop", "end_turn", stopA);
    expect(await f.beat("B")).toEqual({ ok: true, activity: expect.anything() });
    f.later(HOOK_AUTHORITY_WINDOW_MS + 5_000);
    expect(f.state()).toMatchObject({ activity: "working" });
  });

  it("orders a beat sent without occurredAt by the time it was recorded, so a late older Stop still doesn't end the turn", async () => {
    const f = fixture();
    await f.accepted("A");
    f.later(1_000);
    const stopA = { turnId: "A", sequence: f.next(), occurredAt: f.at() }; // posted now, delivered late
    f.later(1_000);
    await f.accepted("B");
    f.later(1_000);
    expect(await f.beat("B", { occurredAt: undefined })).toEqual({ ok: true, activity: expect.anything() });
    await f.post("Stop", "end_turn", stopA);
    expect(await f.beat("B")).toEqual({ ok: true, activity: expect.anything() });
    f.later(HOOK_AUTHORITY_WINDOW_MS + 5_000);
    expect(f.state()).toMatchObject({ activity: "working" });
  });

  it("doesn't take an undated beat's arrival as newer when the daemon's clock runs behind the runner's", async () => {
    const f = fixture();
    const ahead = 3_000; // the runner's clock runs 3 s ahead of the daemon's
    await f.post("UserPromptSubmit", "accepted", { turnId: "A", sequence: f.next(), occurredAt: f.at(ahead) });
    f.later(500);
    const stopA = { turnId: "A", sequence: f.next(), occurredAt: f.at(ahead) }; // posted now, delivered late
    f.later(500);
    await f.post("UserPromptSubmit", "accepted", { turnId: "B", sequence: f.next(), occurredAt: f.at(ahead) });
    f.later(500);
    await f.beat("B", { occurredAt: undefined }); // recorded at the daemon's time, which reads before B's accepted
    await f.post("Stop", "end_turn", stopA);
    expect(await f.beat("B", { occurredAt: f.at(ahead) })).toEqual({ ok: true, activity: expect.anything() });
    f.later(HOOK_AUTHORITY_WINDOW_MS + 5_000);
    expect(f.state()).toMatchObject({ activity: "working" });
  });

  it("counts again after an operator clears the seat's attention", async () => {
    const f = fixture();
    await f.accepted("1");
    await f.post("Notification", "permission_prompt", { turnId: "1" });
    expect(await f.beat("1")).toMatchObject({ ignored: "attention_outstanding" });
    f.clearAttention();
    expect(f.state().needsInput).toMatchObject({ count: 0 });
    expect(await f.beat("1")).toEqual({ ok: true, activity: expect.anything() });
    f.later(HOOK_AUTHORITY_WINDOW_MS + 5_000);
    expect(f.state()).toMatchObject({ activity: "working" });
  });

  it("keeps its admitted lifetime across a daemon restart", async () => {
    for (const [given, lasts] of [[6000, 60], [5, 5]] as const) {
      const f = fixture();
      await f.accepted("1");
      await f.beat("1", { livenessSeconds: given });
      f.restart();
      f.later(lasts * 1000 - 500);
      expect(f.state().activity, `a restored livenessSeconds ${given} beat still counts at ${lasts} s`).toBe("working");
      f.later(1_000);
      expect(f.state().activity, `a restored livenessSeconds ${given} beat has lapsed after ${lasts} s`).toBe("unknown");
    }
  });

  it("is ignored with no generation, and from the previous occupant after a same-name replacement", async () => {
    const f = fixture();
    await f.accepted("1");
    expect(await f.beat("1", { generation: undefined })).toMatchObject({ ignored: "stale_generation" });
    const { previous, current } = f.replaceOccupant();
    // The previous occupant's beat, and the new occupant's beat for the turn its predecessor opened.
    expect(await f.beat("1", { generation: previous })).toMatchObject({ ignored: "stale_generation" });
    expect(await f.beat("1", { generation: current })).toMatchObject({ ignored: "stale_generation" });
  });

  it("is ignored for a turn whose accepted prompt carried no generation", async () => {
    const f = fixture();
    await f.post("UserPromptSubmit", "accepted", { turnId: "1", sequence: f.next(), generation: undefined });
    expect(await f.beat("1")).toMatchObject({ ignored: "stale_generation" });
  });

  // Pi's stream beat (#2336) on the contract's beat: the real Pi runner core, its posts sent through the real route.
  it("keeps a real Pi runner's long, quiet run reading working, until its agent_end", async () => {
    const f = fixture();
    const sent: Array<Promise<unknown>> = [];
    const io: RunnerIo = {
      sendRpc: () => {}, mirrorLine: () => {}, mirrorAppend: () => {}, writeSidecar: () => {}, now: () => f.at(),
      // Activity posts only: the session-identity post goes to a recorder this fixture doesn't have.
      postActivity: (payload) => { if (!payload.eventFamily) sent.push(f.post(String(payload.hookEvent), payload.subtype as string | null, payload)); },
    };
    const core = new RunnerCore(io, { sessionName: f.sessionName, nodeId: f.nodeId, launchId: "launch-1", generation: f.generation() });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: "/pi/session.jsonl", sessionId: "pi-1" } }));
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    await Promise.all(sent);
    for (let i = 0; i < 12; i++) { // a minute with nothing from the model, the runner's 5 s tick beating
      f.later(5_000);
      core.heartbeat();
      await Promise.all(sent);
      expect(f.state(), `${(i + 1) * 5} s in`).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
    }
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    await Promise.all(sent);
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt" });
  });

  // After a daemon restart mid-run its gate has no turn, so the run's beats are ignored until the runner's next accepted
  // prompt (section 4's restart rule). A prompt or a follow-up submitted into the open run is that prompt.
  it("counts a real Pi runner's beats again after a daemon restart, from its next prompt or follow-up into the open run", async () => {
    const f = fixture();
    const posts: Array<{ payload: Record<string, unknown>; result: Promise<{ ok: boolean; ignored?: string }> }> = [];
    const io: RunnerIo = {
      sendRpc: () => {}, mirrorLine: () => {}, mirrorAppend: () => {}, writeSidecar: () => {}, now: () => f.at(),
      postActivity: (payload) => {
        if (!payload.eventFamily) posts.push({ payload, result: f.post(String(payload.hookEvent), payload.subtype as string | null, payload) });
      },
    };
    const settled = () => Promise.all(posts.map(p => p.result));
    const lastBeat = async () => {
      const beat = posts.filter(p => p.payload.subtype === "liveness").at(-1)!;
      return { turnId: beat.payload.turnId, ...await beat.result };
    };
    const core = new RunnerCore(io, { sessionName: f.sessionName, nodeId: f.nodeId, launchId: "launch-1", generation: f.generation() });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: "/pi/session.jsonl", sessionId: "pi-1" } }));
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    await settled();
    await f.restartDaemon();
    f.later(5_000); core.heartbeat(); await settled();
    expect(await lastBeat()).toMatchObject({ turnId: "1", ignored: "no_turn" });
    for (const [block, turnId] of [["look at b.txt too", "2"], ["/followup then c.txt", "3"]] as const) {
      core.handleUserBlock(block);
      for (let i = 0; i < 6; i++) { // half a minute with nothing from the model
        f.later(5_000); core.heartbeat(); await settled();
        const beat = await lastBeat();
        expect(beat, `${block}: ${(i + 1) * 5} s in`).toMatchObject({ turnId, ok: true });
        expect(beat.ignored).toBeUndefined();
        expect(f.state(), `${block}: ${(i + 1) * 5} s in`).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
      }
    }
  });

  it("leaves a runner that sends no beats as before: a quiet turn falls to unknown after 15 s", async () => {
    const f = fixture();
    await f.accepted("1");
    f.later(HOOK_AUTHORITY_WINDOW_MS - 1_000);
    expect(f.state()).toMatchObject({ activity: "working" });
    f.later(2_000);
    expect(f.state()).toMatchObject({ activity: "unknown" });
  });
});
