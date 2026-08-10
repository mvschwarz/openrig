// 5b82324b — public-path regression (HIGH-3): the DEFAULT /api/rigs/:id/nodes route (what `rig ps`
// hits) must consume the structural cache, so a live hook-less seat renders a real ACTIVITY instead of
// unknown — and it must do so WITHOUT a per-request tmux capture (the healthz-wedge invariant).

import { describe, it, expect } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

describe("5b — default node-route ACTIVITY consumes the structural cache (public-path)", () => {
  it("hook-less seat + cached structural agent_active → ACTIVITY running on the DEFAULT route, NO per-request capture", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const sess = reg.registerSession(node.id, "dev-impl@r");
    reg.updateStatus(sess.id, "running");
    reg.updateBinding(node.id, { tmuxSession: "dev-impl@r", attachmentType: "tmux" });

    // A capture-counting tmux behind the structural service; pre-populate one background observation.
    let captures = 0;
    const structural = new SeatStructuralActivityService({
      capturePaneContent: async () => { captures++; return "⠋ Working… esc to interrupt"; },
    } as never);
    await structural.pollSeat("dev-impl@r"); // ONE capture on the background path
    const backgroundCaptures = captures; // 1
    expect(structural.getStructuralActivity("dev-impl@r")?.state).toBe("agent_active");

    // No runtime hook recorded ⇒ the seat is hook-less; the store returns null and the fold consults
    // the injected structural cache.
    const { app } = createTestApp(db, { seatStructuralActivityService: structural });

    const res = await app.request(`/api/rigs/${rig.id}/nodes`); // DEFAULT (no ?full) — the rig ps path
    expect(res.status).toBe(200);
    const nodes = (await res.json()) as Array<{ canonicalSessionName?: string; agentActivity?: { state: string; evidenceSource: string } }>;
    const seat = nodes.find((n) => n.canonicalSessionName === "dev-impl@r");
    expect(seat?.agentActivity?.state).toBe("running"); // pre-5b this was unknown/no_runtime_hook
    expect(seat?.agentActivity?.evidenceSource).toBe("pane_heuristic");
    // Zero-request-capture invariant: the default route READ the cache; it did NOT capture during the request.
    expect(captures).toBe(backgroundCaptures);
    db.close();
  });
});
