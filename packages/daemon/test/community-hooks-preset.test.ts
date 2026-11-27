import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";
import { CommunityHarnessRuntimeAdapter, launchedCommunityHarness } from "../src/adapters/community-harness-runtime-adapter.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore, hookEventState } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes, restoredRunnerHookEvidence } from "../src/routes/activity.js";
import { nodesRoutes } from "../src/routes/sessions.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { COMMUNITY_HARNESS_RUNG_INVENTORY, COMMUNITY_RUNNER_RUNG_INVENTORY, runtimeRungInventory } from "../src/domain/activity-taxonomy.js";
import type { StructuralObservation } from "../src/domain/seat-structural-activity-service.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";
import { migrate } from "../src/db/migrate.js";
import { idleGateFiredConditionSchema } from "../src/db/migrations/078_idle_gate_fired_condition.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { formatSeatActivity } from "../../cli/src/lib/seat-activity.js";
import { compactNodeProjection } from "../../cli/src/commands/ps.js";
import { statusGlyph } from "../../tui/src/topology/glyphs.js";

// A plain community preset whose own hook script posts the events it declares (`activity_hooks`): its seat's activity and
// attention follow those hooks, ordered by when they happened, with the screen's dialog under them, everywhere a person
// looks (the oracle, rig ps and MCP, the TUI graph).

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
const BASE = "format: 1\nname: synth\ncommand: synth-seat\nmaintainer: Example Maintainer\nlimits: []\n";
function presetDir(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-presets-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "synth.yaml"), body);
  return dir;
}
const PARTIAL = ["PreToolUse", "PostToolUse", "Stop"]; // agy-shaped: no declared turn start
const DURABLE = ["UserPromptSubmit", "PreToolUse", "Stop"];

describe("declaring the hooks a plain preset posts", () => {
  it("reads activity_hooks sorted without repeats, and refuses only a value that isn't a list of event names", () => {
    expect(loadCommunityHarnessPreset("synth", presetDir(BASE + "activity_hooks: [Stop, PreToolUse, Stop]\n")))
      .toMatchObject({ ok: true, preset: { activityHooks: ["PreToolUse", "Stop"], runner: false } });
    expect(loadCommunityHarnessPreset("synth", presetDir(BASE))).not.toHaveProperty("preset.activityHooks");
    for (const bad of ["activity_hooks: Stop\n", "activity_hooks: [Stop, 3]\n", "activity_hooks: ['']\n"]) {
      expect(loadCommunityHarnessPreset("synth", presetDir(BASE + bad)))
        .toMatchObject({ ok: false, message: expect.stringContaining("activity_hooks must be a list of hook event names") });
    }
  });

  it("gives the recorded hooks authority, durable only with a declared turn start; a runner keeps its own inventory", () => {
    expect(runtimeRungInventory("synth", "synth", false, PARTIAL)).toMatchObject({ activityHooks: ["PostToolUse", "PreToolUse", "Stop"], rungs: [
      { rung: "lifecycle-hooks", lifecycleCoverage: "partial", initialTrust: "authoritative" },
      { rung: "needs-input-chrome", initialTrust: "authoritative" },
      { rung: "window-sampling", initialTrust: "positive-only" }] });
    expect(runtimeRungInventory("synth", "synth", false, PARTIAL).rungs[0]).not.toHaveProperty("durableBoundaries");
    for (const start of ["UserPromptSubmit", "active"]) {
      expect(runtimeRungInventory("synth", "synth", false, [start, "Stop"]).rungs[0]).toMatchObject({ lifecycleCoverage: "full", durableBoundaries: true });
    }
    expect(runtimeRungInventory("synth", "synth", true, PARTIAL)).toBe(COMMUNITY_RUNNER_RUNG_INVENTORY);
    expect(runtimeRungInventory("synth", "synth", false, null)).toBe(COMMUNITY_HARNESS_RUNG_INVENTORY);
    expect(runtimeRungInventory("codex", null, false, PARTIAL)).not.toHaveProperty("activityHooks");
  });

  it("records the declaration with the launch, so a later preset edit doesn't change a running seat", () => {
    const dir = presetDir(BASE + "activity_hooks: [PreToolUse, Stop]\n");
    const launched = launchedCommunityHarness(new CommunityHarnessRuntimeAdapter("synth", { tmux: {} as never, presetsDir: () => dir }))!;
    const db = createFullTestDb(); cleanups.push(() => db.close());
    const rig = new RigRepository(db).createRig("hooks");
    const node = new RigRepository(db).addNode(rig.id, "dev.a", { runtime: "synth" });
    const registry = new SessionRegistry(db);
    const session = registry.registerSession(node.id, "dev-a@hooks");
    registry.recordCommunityHarnessSelection(session.id, launched.app, launched.runner, launched.activityHooks);
    writeFileSync(join(dir, "synth.yaml"), BASE);
    registry.recordCommunityHarnessSelection(session.id, "synth"); // a restore carrying only the selection
    expect(db.prepare("SELECT agent_runner, agent_activity_hooks FROM sessions WHERE id = ?").get(session.id))
      .toEqual({ agent_runner: 0, agent_activity_hooks: '["PreToolUse","Stop"]' });
  });
});

/** A synth seat through the real hook route, store, oracle, nodes and graph routes. Its screen and its structural frame are
 *  the test's to set; `hooks` and `runner` are what its launch recorded. One clock for all of them: the routes read Date. */
function fixture(opts: { hooks?: string[]; runner?: boolean; runtime?: string } = {}) {
  const runtime = opts.runtime ?? "synth";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-25T12:00:00.000Z"));
  const db = createFullTestDb(); cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("hooks");
  const node = rigs.addNode(rig.id, "dev.a", { runtime });
  const sessions = new SessionRegistry(db);
  let session = sessions.registerSession(node.id, "dev-a@hooks");
  const launch = () => {
    sessions.updateStatus(session.id, "running");
    sessions.updateStartupStatus(session.id, "ready", new Date().toISOString());
    if (runtime === "synth") sessions.recordCommunityHarnessSelection(session.id, "synth", opts.runner ?? false, opts.hooks);
  };
  launch();
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  let paneAt = 0; // the pane's last write, in epoch seconds
  let frame: StructuralObservation | null = null;
  const structural = { getStructuralActivity: () => frame };
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => paneAt }, defaultWindowSeconds: 3,
    structuralActivity: structural,
    restoreHookEvidence: (seat, seatRuntime) => restoredRunnerHookEvidence(store, seat, seatRuntime) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ agentActivityStore: store, activityHookToken: "fixture-token", seatActivityService: oracle,
      rigRepo: rigs, sessionRegistry: sessions, seatStructuralActivityService: structural,
      tmuxAdapter: { getPaneCommand: async () => "synth-seat", capturePaneContent: async () => null } })) c.set(key as never, value as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  app.route("/api/rigs/:rigId/nodes", nodesRoutes);
  app.route("/api/rigs", rigsRoutes);
  const generation = () => sessions.currentOccupantTenure(node.id)!.generationUuid;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    /** A hook post arriving now. `occurredAt` defaults to now; null leaves it out, so the store stamps the arrival. */
    async post(hookEvent: string, post: { occurredAt?: number | null; subtype?: string; generation?: string } = {}) {
      const occurredAt = post.occurredAt === undefined ? Date.now() : post.occurredAt;
      const response = await app.request("/api/activity/hooks", { method: "POST",
        headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
        body: JSON.stringify({ sessionName: session.sessionName, nodeId: node.id, generation: post.generation ?? generation(), runtime,
          hookEvent, subtype: post.subtype ?? null, ...(occurredAt === null ? {} : { occurredAt: iso(occurredAt) }) }) });
      expect(response.status).toBe(200);
    },
    /** One sweep of the oracle's poller: it declares from the record and samples the pane and its frame. */
    sweep: () => oracle.pollAllRunningTmuxSeats(db),
    screen(motion: "moving" | "quiet") { paneAt = Math.floor(Date.now() / 1000) - (motion === "moving" ? 0 : 60); },
    /** The structural frame the recognizer read: a dialog, an unrecognized screen, or a failed read (null). */
    frame(shows: "dialog" | "draft" | "unrecognized" | null, at: { started?: number; checked?: number } = {}) {
      const started = at.started ?? Date.now();
      frame = shows === null ? null : { state: shows === "unrecognized" ? "unknown" : "attention",
        reason: shows === "dialog" ? "selection_prompt" : shows === "draft" ? "prompt_draft" : "community_harness_no_idle_signal",
        evidence: shows === "draft" ? "› fix the flaky test next" : "› 1. Yes, proceed",
        observedAt: iso(started), captureStartedAt: iso(started), ...(at.checked ? { checkedAt: iso(at.checked) } : {}) };
    },
    /** A new occupant under the same session name, launched with the same declaration. */
    replace() { session = sessions.registerSession(node.id, "dev-a@hooks", "handover"); launch(); },
    generation,
    state: () => oracle.getSeatState(node.id),
    latest: () => store.getLatestForNode({ nodeId: node.id, sessionName: session.sessionName }),
    async served() { return (await (await app.request(`/api/rigs/${rig.id}/nodes`)).json())[0]; },
    async glyph() {
      const graph = await (await app.request(`/api/rigs/${rig.id}/graph`)).json() as { nodes: Array<{ type: string; data: never }> };
      return statusGlyph(graph.nodes.find(n => n.type === "rigNode")!.data);
    },
    now: () => Date.now(),
    later(ms: number) { vi.setSystemTime(Date.now() + ms); },
    db, oracle, ref: () => ({ seatNodeId: node.id, sessionName: session.sessionName }),
  };
}

describe("PostToolUse is a working beat only for a community preset's own hooks", () => {
  it("reads running for a community harness and stays noise for built-in runtimes", () => {
    expect(hookEventState("PostToolUse", null, "synth")).toBe("running");
    for (const builtIn of ["claude-code", "codex", "pi", "omp"]) expect(hookEventState("PostToolUse", null, builtIn)).toBe("unknown");
    expect(hookEventState("PostToolUse", null, null)).toBe("unknown");
  });
});

describe("a declared-hooks seat's activity follows its own hooks", () => {
  it("reads PreToolUse and PostToolUse working and Stop idle; without a declared turn start, a quiet pane then reads unknown, never idle", async () => {
    const seat = fixture({ hooks: PARTIAL });
    await seat.post("PreToolUse");
    expect(seat.state()).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
    seat.later(1000); await seat.post("PostToolUse");
    expect(seat.state()).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
    seat.later(1000); await seat.post("Stop", { subtype: "end_turn" });
    expect(seat.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    seat.later(16_000); seat.screen("quiet"); await seat.sweep();
    expect(seat.state()?.activity).toBe("unknown");
    seat.screen("moving"); await seat.sweep();
    expect(seat.state()).toMatchObject({ activity: "working", decidedBy: "window-sampling" });
  });

  it("holds a Stop's idle past the hook window when a turn start is declared, while a lost working boundary still lapses", async () => {
    const seat = fixture({ hooks: DURABLE });
    await seat.post("UserPromptSubmit");
    seat.later(16_000); seat.screen("quiet"); await seat.sweep();
    expect(seat.state()?.activity).toBe("unknown");
    await seat.post("Stop", { subtype: "end_turn" });
    seat.later(60_000); seat.screen("quiet"); await seat.sweep();
    expect(seat.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    await seat.post("UserPromptSubmit");
    expect(seat.state()?.activity).toBe("working");
  });

  // C-F1: a PreToolUse from t=2 arrives first, then a Stop from t=1. The store records both; the oracle keeps working.
  it.each([["a partial declaration", PARTIAL], ["a durable declaration", DURABLE]] as const)(
    "takes posts in the order they happened, not arrived, for %s", async (_case, hooks) => {
      const seat = fixture({ hooks: [...hooks] });
      const t = seat.now();
      seat.later(2500); await seat.post("PreToolUse", { occurredAt: t + 2000 });
      seat.later(500); await seat.post("Stop", { occurredAt: t + 1000, subtype: "end_turn" });
      expect(seat.state()).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
      expect(seat.latest()?.rawEvent).toBe("Stop");
      // The same pair in order.
      seat.later(1000); await seat.post("Stop", { subtype: "end_turn" });
      expect(seat.state()?.activity).toBe("idle-at-prompt");
      seat.later(1000); await seat.post("PreToolUse");
      expect(seat.state()?.activity).toBe("working");
    });

  it("orders posts without occurredAt by arrival: the named limit (G1)", async () => {
    const seat = fixture({ hooks: PARTIAL });
    await seat.post("PreToolUse", { occurredAt: null });
    seat.later(500); await seat.post("Stop", { occurredAt: null, subtype: "end_turn" });
    expect(seat.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
  });

  it("ignores a post carrying an earlier occupant's generation", async () => {
    const seat = fixture({ hooks: PARTIAL });
    const earlier = seat.generation();
    seat.replace(); await seat.sweep();
    await seat.post("PreToolUse");
    seat.later(1000); await seat.post("Stop", { generation: earlier, subtype: "end_turn" });
    expect(seat.state()?.activity).toBe("working");
  });

  it("is declared the same way by the hook route's first post and by the reconcile pass, which doesn't re-declare it on a poll", async () => {
    const byRoute = fixture({ hooks: PARTIAL });
    await byRoute.post("Stop", { subtype: "end_turn" });
    const bySweep = fixture({ hooks: PARTIAL });
    await bySweep.sweep(); await bySweep.post("Stop", { subtype: "end_turn" });
    const trusts = (seat: typeof byRoute) => seat.state()!.rungs.map(r => [r.rung, r.trust]);
    expect(trusts(byRoute)).toEqual(trusts(bySweep));
    expect(trusts(byRoute)).toContainEqual(["lifecycle-hooks", "authoritative"]);
    // A dialog captured after the route's declaration still decides after a sweep: the sweep kept that inventory.
    byRoute.later(500); byRoute.frame("dialog"); byRoute.later(500); byRoute.screen("quiet"); await byRoute.sweep();
    expect(byRoute.state()?.needsInput.count).toBe(1);
  });

  it("keeps a runner's inventory when the preset also declares activity_hooks, and serves no declaration for it (C-F3)", async () => {
    const seat = fixture({ hooks: ["PreToolUse", "Stop"], runner: true });
    await seat.post("UserPromptSubmit", { subtype: "accepted" });
    seat.later(1000); await seat.post("Stop", { subtype: "end_turn" });
    seat.later(60_000); seat.screen("quiet"); await seat.sweep();
    expect(seat.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    const served = await seat.served();
    expect(served.communityHarness).not.toHaveProperty("activityHooks");
    expect(formatSeatActivity({ ...served, agentActivity: { state: "needs_input" } })).toBe("needs-input (screen)");
  });
});

describe("a declared-hooks seat's attention from the screen", () => {
  it("reads a dialog after a Stop as needs-input; the next hook ends it, and so does a frame with no dialog", async () => {
    const seat = fixture({ hooks: PARTIAL });
    await seat.post("Stop", { subtype: "end_turn" });
    seat.later(500); seat.frame("dialog"); seat.screen("quiet"); await seat.sweep();
    expect(seat.state()?.needsInput).toEqual({ count: 1, reason: "selection_prompt" });
    seat.later(500); await seat.post("PreToolUse");
    expect(seat.state()?.needsInput.count).toBe(0);
    // The same capture, revalidated after the hook, is still older than it.
    seat.later(500); seat.frame("dialog", { started: seat.now() - 1000, checked: seat.now() }); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(0);
    seat.frame("dialog"); seat.later(10); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(1);
    seat.later(500); seat.frame("unrecognized"); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(0);
  });

  it("doesn't raise needs-input for a draft frame newer than the latest hook: typing isn't a question", async () => {
    const seat = fixture({ hooks: PARTIAL });
    await seat.post("PreToolUse");
    seat.later(500); seat.frame("draft"); seat.screen("quiet"); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(0);
    expect(seat.state()?.activity).toBe("working");
    // A dialog after it still counts, and a draft that replaces the dialog withdraws it.
    seat.later(500); seat.frame("dialog"); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(1);
    seat.later(500); seat.frame("draft"); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(0);
  });

  it("doesn't decide from a capture that started before the latest hook, or before the seat's inventory", async () => {
    const seat = fixture({ hooks: PARTIAL });
    seat.frame("dialog", { started: seat.now() - 1000 }); seat.screen("quiet"); seat.later(10); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(0);
    seat.later(500); await seat.post("Stop", { subtype: "end_turn" });
    seat.frame("dialog", { started: seat.now() - 300, checked: seat.now() + 200 }); seat.later(500); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(0);
    seat.frame("dialog"); seat.later(10); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(1);
  });

  it("ends the source when its frame goes stale or the read fails", async () => {
    const seat = fixture({ hooks: PARTIAL });
    await seat.post("Stop", { subtype: "end_turn" });
    seat.later(500); seat.frame("dialog"); seat.screen("quiet"); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(1);
    seat.later(5000);
    expect(seat.state()?.needsInput.count).toBe(0);
    seat.frame("dialog"); seat.later(10); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(1);
    seat.frame(null); seat.later(10); await seat.sweep();
    expect(seat.state()?.needsInput.count).toBe(0);
  });
});

describe("what a person sees for a declared-hooks seat (C-F2)", () => {
  it("renders the oracle's decision in rig ps and MCP, not the older screen reading", async () => {
    const seat = fixture({ hooks: PARTIAL });
    seat.screen("quiet"); await seat.sweep();
    seat.later(100); seat.frame("dialog");
    const captured = seat.now();
    seat.later(400); await seat.post("Stop", { subtype: "end_turn" });
    // Minutes later the hook has aged out of the older reading, and the same capture, revalidated, comes back there.
    seat.later(6 * 60_000); seat.frame("dialog", { started: captured, checked: seat.now() }); seat.screen("quiet"); await seat.sweep();
    const served = await seat.served();
    expect(served.agentActivity).toMatchObject({ state: "needs_input" });
    expect(served.activityState).toMatchObject({ display: "unknown", needsInput: { count: 0 } });
    // Its label says where its attention comes from: its hooks as well as the screen.
    expect(served.communityHarness).toMatchObject({ activityHooks: PARTIAL, needsInput: "from structured activity and screen observations" });
    expect(formatSeatActivity(served)).toBe("unknown");
    expect(compactNodeProjection([served])[0]).toMatchObject({ activity: "unknown" });
  });

  it("drives the oracle's consumers: idle-gate wakes only an idle seat, and the parked diagnosis follows the same state", async () => {
    const seat = fixture({ hooks: PARTIAL });
    migrate(seat.db, [idleGateFiredConditionSchema]);
    const at = new Date().toISOString();
    seat.db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, tags)
      VALUES ('q-gate', ?, ?, 'lead@hooks', 'dev-a@hooks', 'pending', 'routine', 'review it', '["gate:qa"]')`).run(at, at);
    const gate = makeIdleGateQitemPolicy({ db: seat.db, seatActivity: seat.oracle });
    const job = { jobId: "job-1", policy: "idle-gate-qitem", target: { session: "dev-a@hooks" }, intervalSeconds: 30, context: {},
      lastEvaluationAt: null, lastFireAt: null, registeredBySession: "lead@hooks", registeredAt: at } as unknown as PolicyJob;
    const open = { rows: [{ qitemId: "q-gate", state: "pending" }], limit: 500 } as never;
    const read = async () => [(await gate.evaluate(job)) as { action: string; reason?: string },
      diagnoseSeatParked({ getSeatState: id => seat.oracle.getSeatState(id), listOpenObligations: () => open }, seat.ref()).parked];
    await seat.post("PreToolUse");
    expect(await read()).toEqual([expect.objectContaining({ action: "skip", reason: "seat_active" }), false]);
    seat.later(1000); await seat.post("Stop", { subtype: "end_turn" });
    expect(await read()).toEqual([expect.objectContaining({ action: "send" }), true]);
    seat.later(500); seat.frame("dialog"); seat.screen("quiet"); await seat.sweep();
    expect(await read()).toEqual([expect.objectContaining({ action: "skip", reason: "seat_needs_input" }), true]);
    seat.frame(null); seat.later(16_000); await seat.sweep();
    expect(await read()).toEqual([expect.objectContaining({ action: "skip", reason: "activity_stale_unknown" }), "indeterminate"]);
  });

  it("keeps the screen fallback only for a community seat without declared hooks", () => {
    const row = { activityState: { display: "idle", needsInput: { count: 0 } }, agentActivity: { state: "needs_input" } };
    expect(formatSeatActivity({ ...row, communityHarness: { activityHooks: ["Stop"] } })).toBe("idle");
    expect(formatSeatActivity({ ...row, communityHarness: {} })).toBe("needs-input (screen)");
  });

  it("draws the graph glyph from the served decision: a hook seat's unknown stays ○, and a built-in seat follows the oracle too", async () => {
    const seat = fixture({ hooks: PARTIAL });
    await seat.post("PreToolUse");
    expect(await seat.glyph()).toMatchObject({ glyph: "●", token: "actActive" });
    seat.later(1000); await seat.post("Stop", { subtype: "end_turn" });
    expect(await seat.glyph()).toMatchObject({ glyph: "●", token: "actIdle" });
    seat.later(16_000); seat.screen("quiet"); await seat.sweep();
    expect(await seat.glyph()).toMatchObject({ glyph: "○", token: "actDetached" });
    seat.later(500); seat.frame("dialog"); seat.later(10); await seat.sweep();
    expect(await seat.glyph()).toMatchObject({ glyph: "◐" });
    // A Codex seat: its hooks are on trial, so its quiet pane decides idle while the older reading says running.
    const codex = fixture({ runtime: "codex" });
    codex.screen("quiet"); await codex.sweep();
    await codex.post("UserPromptSubmit");
    expect((await codex.served()).agentActivity).toMatchObject({ state: "running" });
    expect(await codex.glyph()).toMatchObject({ glyph: "●", token: "actIdle" });
  });
});
