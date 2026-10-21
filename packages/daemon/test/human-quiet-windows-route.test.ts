// The quiet-hours routes: read, set, end and clear a registered person's quiet window, through the real gateway routes
// with a temp home, a real SQLite schema and an injected clock. No delivery decision reads the window yet.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { addHumanFragment } from "../src/domain/gateway/human-registry.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function fixture(startIso = "2026-10-20T12:00:00Z") {
  const home = mkdtempSync(join(tmpdir(), "quiet-route-")); homes.push(home);
  expect(addHumanFragment({ entityId: "alex", class: "human", displayName: "Alex", address: "alex@external",
    prefs: { deliveryClass: "B" },
    connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: "U-FIXTURE" }],
  }, home).ok).toBe(true);
  const db = createFullTestDb();
  const clock = { now: new Date(startIso) };
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("db" as never, db as never); await next(); });
  app.route("/api/gateway", gatewayRoutes({ home, now: () => clock.now }));
  const call = async (method: string, path: string, body?: unknown, session = "orch@demo") => {
    const res = await app.request(`/api/gateway/human/${path}`, { method,
      headers: { "Content-Type": "application/json", ...(session ? { "X-OpenRig-Session": session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { db, clock, call };
}

describe("quiet hours over the gateway routes", () => {
  it("set, show, end and clear a daily window; the state carries the occurrence, revision and next boundary", async () => {
    const f = fixture();
    const empty = await f.call("GET", "alex/quiet");
    expect(empty).toMatchObject({ status: 200, body: { ok: true, window: null, state: { active: false, nextBoundary: null } } });

    const set = await f.call("PUT", "alex/quiet", { daily: "22:00-07:00", timezone: "Europe/Berlin" });
    expect(set.status).toBe(200);
    expect(set.body.window).toMatchObject({ kind: "daily", start: "22:00", end: "07:00", timezone: "Europe/Berlin", revision: 1,
      source: "manual", setBy: "orch@demo" });
    expect(set.body.state).toMatchObject({ active: false, nextBoundary: { kind: "start", at: "2026-10-20T20:00:00.000Z" } });

    f.clock.now = new Date("2026-10-20T23:00:00Z");
    const on = await f.call("GET", "alex/quiet");
    expect(on.body.state).toMatchObject({ active: true, occurrence: "2026-10-20", revision: 1, nextBoundary: { kind: "end", at: "2026-10-21T05:00:00.000Z" } });

    const ended = await f.call("POST", "alex/quiet/end", {});
    expect(ended).toMatchObject({ status: 200, body: { ended: { occurrence: "2026-10-20", revision: 1 },
      window: { ended: { occurrence: "2026-10-20", by: "orch@demo" } }, state: { active: false, nextBoundary: { kind: "start" } } } });

    const again = await f.call("POST", "alex/quiet/end", {});
    expect(again).toMatchObject({ status: 409, body: { error: "not_quiet" } });

    const cleared = await f.call("POST", "alex/quiet/clear", {});
    expect(cleared).toMatchObject({ status: 200, body: { cleared: { revision: 2 }, window: null, state: { active: false, nextBoundary: null } } });
    expect(await f.call("POST", "alex/quiet/clear", {})).toMatchObject({ status: 409, body: { error: "no_window" } });
  });

  it("an until-time can be a local HH:MM, meaning its next occurrence in the timezone", async () => {
    const f = fixture("2026-10-20T12:00:00Z"); // 14:00 in Berlin
    const set = await f.call("PUT", "alex/quiet", { until: "18:30", timezone: "Europe/Berlin" });
    expect(set.body.window).toMatchObject({ kind: "until", until: "2026-10-20T16:30:00.000Z" });
    expect(set.body.state).toMatchObject({ active: true, occurrence: "until" });
    const tomorrow = await f.call("PUT", "alex/quiet", { until: "09:00", timezone: "Europe/Berlin" });
    expect(tomorrow.body.window).toMatchObject({ until: "2026-10-21T07:00:00.000Z", revision: 2 });
  });

  it("an actor named in the body is recorded when there's no seat identity", async () => {
    const f = fixture();
    const set = await f.call("PUT", "alex/quiet", { daily: "22:00-07:00", timezone: "UTC", actor: "alex" }, "");
    expect(set.body.window).toMatchObject({ setBy: "alex" });
  });

  it("an invalid zone, time or combination is refused with a clear message, and nothing is stored", async () => {
    const f = fixture();
    const cases: Array<[unknown, RegExp]> = [
      [{ daily: "22:00-07:00", timezone: "Mars/Olympus" }, /unknown timezone "Mars\/Olympus"/],
      [{ daily: "22-07", timezone: "UTC" }, /HH:MM-HH:MM/],
      [{ daily: "25:00-07:00", timezone: "UTC" }, /HH:MM/],
      [{ until: "tomorrow", timezone: "UTC" }, /isn't a time/],
      [{ until: "2026-10-20T11:00:00Z", timezone: "UTC" }, /already passed/],
      [{ daily: "22:00-07:00", until: "09:00", timezone: "UTC" }, /not both/],
      [{ timezone: "UTC" }, /not both and not neither/],
    ];
    for (const [body, message] of cases) {
      const res = await f.call("PUT", "alex/quiet", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.message).toMatch(message);
    }
    expect((await f.call("GET", "alex/quiet")).body.window).toBeNull();
  });

  it("someone who isn't a registered human is a 404, and nothing is stored for them", async () => {
    const f = fixture();
    expect(await f.call("PUT", "nobody/quiet", { daily: "22:00-07:00", timezone: "UTC" })).toMatchObject({ status: 404, body: { error: "human_not_found" } });
    expect(await f.call("GET", "nobody/quiet")).toMatchObject({ status: 404 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM human_quiet_windows").get()).toEqual({ n: 0 });
  });
});
