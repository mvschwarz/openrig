import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes } from "../src/routes/activity.js";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY, CODEX_ACTIVITY_RUNG_INVENTORY, type AdapterRungInventory } from "../src/domain/activity-taxonomy.js";

// Claude and Codex hook posts reach the daemon in arrival order, which can differ from the order the agent emitted them.
// The oracle orders a hook source's working and idle posts by the emitter's own time, so a late Stop can't make a seat
// that's mid-turn read idle. Each cell posts what the relay posts, through the real route and recorder.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/** A Codex seat whose trial hook rung has been promoted (as after its agreement window). */
const PROMOTED_CODEX: AdapterRungInventory = { ...CODEX_ACTIVITY_RUNG_INVENTORY,
  rungs: CODEX_ACTIVITY_RUNG_INVENTORY.rungs.map((r) => r.rung === "lifecycle-hooks" ? { ...r, initialTrust: "authoritative" } : r) };

function fixture(runtime: "claude-code" | "codex") {
  const clock = { now: Date.parse("2026-11-25T21:00:00.000Z") };
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("hook-order");
  const node = rigs.addNode(rig.id, "dev.a", { runtime });
  const sessions = new SessionRegistry(db);
  const session = sessions.registerSession(node.id, "dev-a@hook-order");
  sessions.updateStatus(session.id, "running");
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => new Date(clock.now),
    resolveOccupantGeneration: (id) => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  // No self-report reader and no pane sampling: the hook rung decides, as on a Claude seat with no usable self-report.
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
    now: () => new Date(clock.now) });
  oracle.declareRungInventory({ seatNodeId: node.id, sessionName: session.sessionName },
    runtime === "codex" ? PROMOTED_CODEX : CLAUDE_ACTIVITY_RUNG_INVENTORY);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    c.set("seatActivityService" as never, oracle as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  const at = (offsetMs: number) => new Date(clock.now + offsetMs).toISOString();
  /** One relay post. `occurredAt` is the emitter's clock; null leaves it out, so the daemon dates it on arrival. */
  async function post(hookEvent: string, occurredAt: string | null, over: Record<string, unknown> = {}) {
    const response = await app.request("/api/activity/hooks", { method: "POST",
      headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionName: session.sessionName, nodeId: node.id, generation, runtime, hookEvent, subtype: null,
        relayRoute: "managed", ...(occurredAt ? { occurredAt } : {}), ...over }) });
    expect(response.status).toBe(200);
  }
  return { post, at, oracle, node, session, later: (ms: number) => { clock.now += ms; },
    state: () => oracle.getSeatState(node.id)! };
}

describe("a hook source's turn boundaries follow the emitter's order", () => {
  for (const runtime of ["claude-code", "codex"] as const) {
    it(`${runtime}: a Stop emitted before the next turn's prompt, arriving after it, doesn't make the seat idle`, async () => {
      const f = fixture(runtime);
      f.later(2_000);
      await f.post("UserPromptSubmit", f.at(0)); // the newer post arrives first
      await f.post("Stop", f.at(-1_000)); // the previous turn's Stop, emitted a second earlier, arrives late
      expect(f.state().activity).toBe("working");
    });

    it(`${runtime}: a prompt emitted before the Stop, arriving after it, doesn't make an idle seat working`, async () => {
      const f = fixture(runtime);
      f.later(2_000);
      await f.post("Stop", f.at(0));
      await f.post("UserPromptSubmit", f.at(-1_000));
      expect(f.state().activity).toBe("idle-at-prompt");
    });
  }

  it("in order, each boundary still decides", async () => {
    const f = fixture("claude-code");
    await f.post("UserPromptSubmit", f.at(0));
    expect(f.state().activity).toBe("working");
    f.later(1_000);
    await f.post("Stop", f.at(0));
    expect(f.state().activity).toBe("idle-at-prompt");
    f.later(1_000);
    await f.post("UserPromptSubmit", f.at(0));
    expect(f.state().activity).toBe("working");
  });

  it("a post with no time of its own is dated on arrival, so the newest post still decides", async () => {
    const f = fixture("claude-code");
    await f.post("UserPromptSubmit", f.at(0));
    f.later(1_000);
    await f.post("Stop", null);
    expect(f.state().activity).toBe("idle-at-prompt");
  });

  it("posts at the same time, with no sequence, keep arrival order (a duplicate from the other relay route changes nothing)", async () => {
    const f = fixture("claude-code");
    const t = f.at(0);
    await f.post("Stop", t);
    await f.post("Stop", t, { relayRoute: "plugin" });
    expect(f.state().activity).toBe("idle-at-prompt");
    await f.post("UserPromptSubmit", t);
    expect(f.state().activity).toBe("working");
  });
});

describe("attention isn't dropped for arriving late", () => {
  it("an older needs-input post arriving after a newer prompt still reads needs-input", () => {
    const f = fixture("codex");
    const seat = { seatNodeId: f.node.id, sessionName: f.session.sessionName };
    f.later(2_000);
    f.oracle.reportEvidence({ ...seat, rung: "lifecycle-hooks", sourceId: "codex:hooks", seq: 1,
      observedAt: f.at(0), activity: "working", needsInput: { count: 0, reason: null } });
    f.oracle.reportEvidence({ ...seat, rung: "lifecycle-hooks", sourceId: "codex:hooks", seq: 2,
      observedAt: f.at(-1_000), needsInput: { count: 1, reason: "elicitation_dialog" } });
    expect(f.state().needsInput.count).toBe(1);
  });

  it("a working post older than a needs-input post already seen doesn't clear it", () => {
    const f = fixture("codex");
    const seat = { seatNodeId: f.node.id, sessionName: f.session.sessionName };
    f.later(2_000);
    f.oracle.reportEvidence({ ...seat, rung: "lifecycle-hooks", sourceId: "codex:hooks", seq: 1,
      observedAt: f.at(0), needsInput: { count: 1, reason: "elicitation_dialog" } });
    f.oracle.reportEvidence({ ...seat, rung: "lifecycle-hooks", sourceId: "codex:hooks", seq: 2,
      observedAt: f.at(-1_000), activity: "working", needsInput: { count: 0, reason: null } });
    expect(f.state().needsInput.count).toBe(1);
  });
});
