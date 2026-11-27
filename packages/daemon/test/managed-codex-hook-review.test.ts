import { describe, expect, it } from "vitest";
import { classifyPaneActivity } from "../src/domain/session-transport.js";
import { capturelessSeatActivity } from "../src/domain/node-inventory.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import type { AgentActivity } from "../src/domain/types.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const menu = "OpenAI Codex (v0.171.0)\nHooks need review\n2 hooks are new or changed.\n"
  + "› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)";
const now = new Date("2030-01-01T00:00:10Z");
const before = "2030-01-01T00:00:01Z";

describe("a managed Codex seat's hook-review reason", () => {
  it("names the active menu without reading or choosing an approval", () => {
    expect(classifyPaneActivity(menu, { runtime: "codex" }))
      .toMatchObject({ state: "attention", reason: "hook_trust_gate" });
  });

  it.each([
    `${menu}\n› Ask anything`,
    `${menu}\nOpenAI Codex (v0.171.0)\nmodel: gpt-6\n› Ask anything`,
    "OpenAI Codex (v0.171.0)\nChoose a model\n› 1. gpt-6\n  2. gpt-5",
  ])("does not call dismissed hook text or another chooser hook review: %s", screen => {
    expect(classifyPaneActivity(screen, { runtime: "codex" }).reason).not.toBe("hook_trust_gate");
  });

  it("carries the reason through the structural cache and past an earlier idle hook", async () => {
    const structural = new SeatStructuralActivityService({ capturePaneContent: async () => menu } as never,
      () => now);
    await structural.pollSeat("worker@non-kernel", undefined, "codex");
    const frame = structural.getStructuralActivity("worker@non-kernel");
    expect(frame).toMatchObject({ state: "attention", reason: "hook_trust_gate" });
    const hook = { state: "idle", reason: "Stop", eventAt: before, runtime: "codex" } as AgentActivity;
    expect(capturelessSeatActivity({ sessionName: "worker@non-kernel", runtime: "codex", hookActivity: hook,
      structural: frame, motion: null, now }).activity)
      .toMatchObject({ state: "needs_input", reason: "hook_trust_gate" });
  });

  it.each(["running", "needs_input"] as const)("keeps a positive %s hook ahead of the cached menu", state => {
    const hook = { state, reason: "existing", eventAt: before, runtime: "codex" } as AgentActivity;
    const frame = { ...classifyPaneActivity(menu, { runtime: "codex" }), observedAt: now.toISOString(),
      captureStartedAt: now.toISOString() };
    expect(capturelessSeatActivity({ sessionName: "worker@non-kernel", runtime: "codex", hookActivity: hook,
      structural: frame, motion: null, now }).activity).toBe(hook);
  });

  it("does not put an older capture ahead of a later idle hook", () => {
    const hook = { state: "idle", reason: "Stop", eventAt: now.toISOString(), runtime: "codex" } as AgentActivity;
    const frame = { ...classifyPaneActivity(menu, { runtime: "codex" }), observedAt: now.toISOString(), captureStartedAt: before };
    expect(capturelessSeatActivity({ sessionName: "worker@non-kernel", runtime: "codex", hookActivity: hook,
      structural: frame, motion: null, now }).activity).toBe(hook);
  });

  it("keeps a current usage limit ahead of an older menu capture", () => {
    const hook = { state: "unknown", reason: "usage_limit", rawEvent: "at_limit", eventAt: now.toISOString(),
      runtime: "codex", stale: false } as AgentActivity;
    const frame = { ...classifyPaneActivity(menu, { runtime: "codex" }), observedAt: before, captureStartedAt: before };
    expect(capturelessSeatActivity({ sessionName: "worker@non-kernel", runtime: "codex", hookActivity: hook,
      structural: frame, motion: null, now }).activity).toBe(hook);
  });

  it.each(["nodes", "status", "node status"])("serves the oracle's hook-review reason through %s", async surface => {
    const db = createFullTestDb();
    try {
      let clock = now.getTime();
      const structural = new SeatStructuralActivityService({ capturePaneContent: async () => menu } as never, () => new Date(clock));
      const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => clock / 1000 - 60 },
        structuralActivity: structural, now: () => new Date(clock) });
      const { app, rigRepo, sessionRegistry } = createTestApp(db, {
        seatStructuralActivityService: structural, appDeps: { seatActivityService: oracle },
      });
      const rig = rigRepo.createRig("product-team");
      const node = rigRepo.addNode(rig.id, "worker", { runtime: "codex" });
      const session = "worker@product-team";
      const registered = sessionRegistry.registerSession(node.id, session);
      sessionRegistry.updateStatus(registered.id, "running");
      sessionRegistry.updateStartupStatus(registered.id, "ready");
      sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: session, tmuxPane: "%1" });
      oracle.declareRungInventory({ seatNodeId: node.id, sessionName: session }, CODEX_ACTIVITY_RUNG_INVENTORY);
      oracle.recordCodexOccupant(node.id, { paneId: "%1", pid: 123 });
      clock += 1000;
      await structural.pollSeat(session, new Map([[session, { text: menu, capturedAt: new Date(clock), pane: { id: "%1", pid: 123 } }]]),
        "codex", null, new Date(clock));
      await oracle.pollSeat(session);
      expect(oracle.getSeatState(node.id)?.needsInput).toEqual({ count: 1, reason: "hook_trust_gate" });
      const path = surface === "nodes" ? `/api/rigs/${rig.id}/nodes` : surface === "status"
        ? `/api/seat/status/${encodeURIComponent(session)}` : `/api/seat/status/node/${node.id}`;
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const body = await response.json();
      const row = surface === "nodes" ? body.find((entry: { nodeId: string }) => entry.nodeId === node.id) : body;
      expect(row.activityState).toMatchObject({ display: "needs-input", needsInput: { count: 1, reason: "hook_trust_gate" } });
    } finally { db.close(); }
  });
});
