import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes } from "../src/routes/activity.js";
import { runtimeRungInventory } from "../src/domain/activity-taxonomy.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("retirement-hooks");
  const node = rigs.addNode(rig.id, "dev.a", { runtime: "claude-code" });
  const sessions = new SessionRegistry(db);
  const session = sessions.registerSession(node.id, "dev-a@retirement-hooks");
  sessions.updateStatus(session.id, "running");
  const store = new AgentActivityStore({ db, eventBus: new EventBus(db),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3 });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    c.set("seatActivityService" as never, oracle as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  async function hook(input: { sessionName?: string; nodeId?: string; hookEvent?: string; generation?: string } = {}) {
    const count = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.activity'").get() as { n: number };
    const response = await app.request("/api/activity/hooks", { method: "POST",
      headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "claude-code", hookEvent: "Notification", subtype: "idle_prompt", generation,
        sessionName: session.sessionName, ...input }) });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    const after = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.activity'").get() as { n: number };
    expect(after.n).toBe(count.n + 1); // late reports remain archival records
  }
  return { db, node, sessions, session, oracle, hook, store, generation };
}

describe("retired hook evidence through the real HTTP route", () => {
  it("a delayed hook remains recorded but cannot restore an exited seat's oracle", async () => {
    const f = fixture();
    await f.hook();
    expect(f.oracle.getSeatState(f.node.id)!.activity).toBe("idle-at-prompt");
    f.sessions.updateStatus(f.session.id, "exited");
    await f.oracle.pollAllRunningTmuxSeats(f.db);
    await f.hook();
    expect(f.oracle.getSeatState(f.node.id)!.activity).toBe("unknown");
    expect(f.oracle.getSeatStateBySession(f.session.sessionName)).toBeNull();
  });

  it.each([false, true])("a prior session hook cannot replace a live successor (nodeId supplied: %s)", async withNodeId => {
    const f = fixture(); await f.hook();
    f.sessions.updateStatus(f.session.id, "exited");
    const successor = f.sessions.registerSession(f.node.id, "dev-b@retirement-hooks");
    f.sessions.updateStatus(successor.id, "running");
    await f.oracle.pollAllRunningTmuxSeats(f.db);
    await f.hook({ sessionName: successor.sessionName, nodeId: f.node.id, hookEvent: "UserPromptSubmit",
      generation: f.sessions.currentOccupantTenure(f.node.id)!.generationUuid });
    expect(f.oracle.getSeatStateBySession(successor.sessionName)!.activity).toBe("working");
    await f.hook(withNodeId ? { nodeId: f.node.id } : {});
    expect(f.oracle.getSeatState(f.node.id)!.activity).toBe("working");
    expect(f.oracle.getSeatStateBySession(f.session.sessionName)).toBeNull();
  });

  it("a live first hook can declare its inventory and nodeId-only reports still feed the current session", async () => {
    const f = fixture();
    expect(f.oracle.getSeatState(f.node.id)).toBeNull();
    await f.hook({ sessionName: undefined, nodeId: f.node.id });
    expect(f.oracle.getSeatStateBySession(f.session.sessionName)!.activity).toBe("idle-at-prompt");
    expect(f.oracle.hasRungInventory(f.node.id)).toBe(true);
  });

  it("a running non-tmux seat keeps its hook oracle across the tmux sampler sweep", async () => {
    const f = fixture();
    f.sessions.updateBinding(f.node.id, { attachmentType: "cmux", cmuxWorkspace: "fixture", cmuxSurface: "fixture" });
    await f.hook();
    await f.oracle.pollAllRunningTmuxSeats(f.db);
    expect(f.oracle.getSeatStateBySession(f.session.sessionName)!.activity).toBe("idle-at-prompt");
  });

  it("a delayed registered generation cannot overwrite a same-name successor's current oracle", async () => {
    const f = fixture(); await f.hook();
    f.sessions.updateStatus(f.session.id, "exited");
    await f.oracle.pollAllRunningTmuxSeats(f.db);
    const successor = f.sessions.registerSession(f.node.id, f.session.sessionName, "handover");
    const currentGeneration = f.sessions.currentOccupantTenure(f.node.id)!.generationUuid;
    expect(currentGeneration).not.toBe(f.generation);
    f.sessions.updateStatus(successor.id, "running");
    await f.oracle.pollAllRunningTmuxSeats(f.db);
    await f.hook({ hookEvent: "UserPromptSubmit", generation: currentGeneration });
    expect(f.oracle.getSeatState(f.node.id)!.activity).toBe("working");
    await f.hook({ generation: f.generation });
    expect(f.store.getLatestForNode({ nodeId: f.node.id })!.reason).toBe("generation_mismatch");
    expect(f.oracle.getSeatState(f.node.id)!.activity).toBe("working");
  });

  it("a live legacy hook without a carried generation retains its existing oracle behavior", async () => {
    const f = fixture(); await f.hook({ generation: undefined });
    expect(f.store.getLatestForNode({ nodeId: f.node.id })!.generationProvenance).toBe("unresolved");
    expect(f.oracle.getSeatState(f.node.id)!.activity).toBe("idle-at-prompt");
  });

  it("direct evidence cannot resurrect retirement or rebind a successor; undeclared first evidence remains supported", () => {
    const f = fixture();
    const report = (sessionName: string, seq: number, activity: "working" | "idle-at-prompt") => f.oracle.reportEvidence({
      seatNodeId: f.node.id, sessionName, sourceId: "tmux:window-activity", rung: "window-sampling", seq,
      observedAt: new Date().toISOString(), activity });
    report(f.session.sessionName, 1, "idle-at-prompt");
    expect(f.oracle.getSeatState(f.node.id)!.activity).toBe("idle-at-prompt");
    f.oracle.forgetSeat(f.session.sessionName);
    report(f.session.sessionName, 2, "working");
    expect(f.oracle.getSeatState(f.node.id)!.activity).toBe("unknown");
    const successor = "dev-b@retirement-hooks";
    f.oracle.declareRungInventory({ seatNodeId: f.node.id, sessionName: successor }, runtimeRungInventory(null));
    report(successor, 1, "working"); report(f.session.sessionName, 3, "idle-at-prompt");
    expect(f.oracle.getSeatStateBySession(successor)!.activity).toBe("working");
    expect(f.oracle.getSeatStateBySession(f.session.sessionName)).toBeNull();
  });
});
