import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";

// WAVE O FIX R1 — B2 (R2 verdict 508e383d): `rig parked` claimed rig scope while folding
// EVERY running rig in the daemon. R2's effect discriminator, preserved: one idle seat in
// rig-a, one idle seat in rig-b, an obligation only in rig-b — the caller from rig-a must
// see ONLY rig-a and NOT-PARKED. Real sqlite, real route, real oracle; only the queue's
// obligation face is faked (per-destination).

const DDL = `
CREATE TABLE rigs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE nodes (id TEXT PRIMARY KEY, rig_id TEXT NOT NULL);
CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, session_name TEXT, status TEXT);
`;

describe("Wave-O B2 — parked diagnosis is RIG-SCOPED with the scope named", () => {
  let db: Database.Database;
  let svc: SeatActivityService;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(DDL);
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-a-id", "rig-a");
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-b-id", "rig-b");
    db.prepare("INSERT INTO nodes (id, rig_id) VALUES (?, ?)").run("node-a", "rig-a-id");
    db.prepare("INSERT INTO nodes (id, rig_id) VALUES (?, ?)").run("node-b", "rig-b-id");
    db.prepare("INSERT INTO sessions (node_id, session_name, status) VALUES (?, ?, ?)").run("node-a", "dev-a@rig-a", "running");
    db.prepare("INSERT INTO sessions (node_id, session_name, status) VALUES (?, ?, ?)").run("node-b", "dev-b@rig-b", "running");

    const clock = { now: 9_000_000 };
    svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
      now: () => new Date(clock.now),
    });
    for (const [node, session] of [["node-a", "dev-a@rig-a"], ["node-b", "dev-b@rig-b"]] as const) {
      svc.declareRungInventory({ seatNodeId: node, sessionName: session }, {
        adapterId: "tmux-generic", runtime: "tmux-generic",
        rungs: [{ rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" }],
      });
      svc.reportEvidence({
        seatNodeId: node, sessionName: session, rung: "window-sampling",
        sourceId: "tmux:window-activity", seq: 1, observedAt: new Date(clock.now).toISOString(),
        activity: "idle-at-prompt",
      });
    }

    // The obligation face: ONLY dev-b@rig-b owes work.
    const queueRepo = {
      list: (opts: { destinationSession?: string }) =>
        opts.destinationSession === "dev-b@rig-b"
          ? [{ qitemId: "qitem-b-1", state: "pending", summary: "owed in rig-b" }]
          : [],
    };

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("seatActivityService" as never, svc as never);
      c.set("queueRepo" as never, queueRepo as never);
      c.set("rigRepo" as never, { db } as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
  });
  afterEach(() => db.close());

  it("R2 DISCRIMINATOR: a caller from rig-a sees ONLY rig-a seats and NOT-PARKED — rig-b's obligation cannot leak in", async () => {
    const res = await app.request("/api/activity/parked", {
      headers: { "x-openrig-session": "dev-a@rig-a" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rig: { parked: boolean | string; scope?: { rig: string; resolvedFrom: string }; seats: Array<{ sessionName: string }> } };
    const names = body.rig.seats.map((s) => s.sessionName);
    expect(names).toEqual(["dev-a@rig-a"]); // candidate returned BOTH rigs
    expect(body.rig.parked).toBe(false);    // candidate said PARKED off rig-b's obligation
    expect(body.rig.scope).toEqual({ rig: "rig-a", resolvedFrom: "caller-session" }); // AM-3: the scope is NAMED
  });

  it("an explicit ?rig= coordinate scopes to that rig — rig-b IS parked on its own obligation", async () => {
    const res = await app.request("/api/activity/parked?rig=rig-b");
    const body = await res.json() as { rig: { parked: boolean; scope?: { rig: string; resolvedFrom: string }; seats: Array<{ sessionName: string; parked: boolean | string }> } };
    expect(body.rig.seats.map((s) => s.sessionName)).toEqual(["dev-b@rig-b"]);
    expect(body.rig.parked).toBe(true);
    expect(body.rig.scope).toEqual({ rig: "rig-b", resolvedFrom: "query-param" });
  });

  it("NO resolvable rig scope refuses with teaching — never a silent fleet-wide fold", async () => {
    const res = await app.request("/api/activity/parked");
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/rig/i);      // names the missing coordinate
    expect(body.error).toMatch(/\?rig=|--rig|session/i); // and how to pass it
  });

  it("explicit-seat semantics preserved: ?seat= carrying its @rig coordinate self-scopes", async () => {
    const res = await app.request("/api/activity/parked?seat=dev-b%40rig-b");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; seat: { sessionName: string; parked: boolean | string } };
    expect(body.seat.sessionName).toBe("dev-b@rig-b");
    expect(body.seat.parked).toBe(true);
  });

  it("an unknown rig coordinate teaches with the known rigs", async () => {
    const res = await app.request("/api/activity/parked?rig=ghost-rig");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("rig-a");
    expect(body.error).toContain("rig-b");
  });
});
