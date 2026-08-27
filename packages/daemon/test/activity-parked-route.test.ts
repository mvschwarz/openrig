import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";

// OPR.0.5.5.19 A7 — the /api/activity/parked surface: read-only join of the oracle and
// the queue's obligation face, with the honest 503/404 refusals.

const SEAT = "node-p1";
const SESSION = "dev50-qa@v-openrig-build";

function makeApp(opts: { withDeps: boolean; rows?: Array<{ qitemId: string; state: string; summary?: string | null }> }) {
  const clock = { now: 3_000_000 };
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
  });
  svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
    adapterId: "claude-code-adapter",
    runtime: "claude-code",
    rungs: [{ rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" }],
  });
  svc.reportEvidence({
    seatNodeId: SEAT, sessionName: SESSION, rung: "window-sampling",
    sourceId: "tmux:window-activity", seq: 1, observedAt: new Date(clock.now).toISOString(),
    activity: "idle-at-prompt",
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts.withDeps) {
      c.set("seatActivityService" as never, svc as never);
      c.set("queueRepo" as never, { list: () => opts.rows ?? [] } as never);
      c.set("rigRepo" as never, { db: { prepare: () => ({ all: () => [{ node_id: SEAT, session_name: SESSION }] }) } } as never);
    }
    await next();
  });
  app.route("/api/activity", activityRoutes);
  return app;
}

describe("S19 A7 — GET /api/activity/parked", () => {
  it("rig-level: joins the oracle with the obligation face and returns the derived diagnosis", async () => {
    const app = makeApp({ withDeps: true, rows: [{ qitemId: "qitem-9", state: "pending", summary: "owed" }] });
    const res = await app.request("/api/activity/parked");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rig: { parked: boolean; seats: Array<{ parked: boolean }> } };
    expect(body.ok).toBe(true);
    expect(body.rig.parked).toBe(true);
    expect(body.rig.seats[0]!.parked).toBe(true);
  });

  it("seat-level resolves node id OR session name; an unknown seat teaches with the known set", async () => {
    const app = makeApp({ withDeps: true, rows: [] });
    const byName = await app.request(`/api/activity/parked?seat=${encodeURIComponent(SESSION)}`);
    expect(byName.status).toBe(200);
    const ghost = await app.request("/api/activity/parked?seat=ghost");
    expect(ghost.status).toBe(404);
    const body = await ghost.json() as { error: string };
    expect(body.error).toContain(SESSION); // teaching names the known seats
  });

  it("missing deps refuse 503 with the unconfigured surface named — never a fabricated empty diagnosis", async () => {
    const app = makeApp({ withDeps: false });
    const res = await app.request("/api/activity/parked");
    expect(res.status).toBe(503);
  });
});
