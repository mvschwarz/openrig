import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { terminalRoutes } from "../src/routes/terminal.js";

function fixture() {
  const followView = vi.fn(async (request: unknown) => ({ provider: "herdr", ok: true, opened: [], absent: [], degraded: [], pages: 1,
    request, following: { id: "stable", enabled: true, state: "empty" } }));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("terminalService" as never, { followView } as never); await next(); });
  app.route("/terminal", terminalRoutes({ bearerToken: "fixture-owner-token" }));
  const post = (body: unknown, authorized = true) => app.request("/terminal/follow", { method: "POST",
    headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer fixture-owner-token" } : {}) }, body: JSON.stringify(body) });
  return { post, followView };
}
describe("owner-authorized following API", () => {
  it("uses the existing bearer boundary before provisioning any writable viewer", async () => {
    const f = fixture(); expect((await f.post({ view: "qitem:task", enabled: true }, false)).status).toBe(401);
    expect(f.followView).not.toHaveBeenCalled();
  });
  it("passes the selected endpoint and presentation controls through one canonical operation", async () => {
    const f = fixture(); const body = { view: "qitem:task", enabled: true, provider: "herdr", session: "example",
      maxTiles: 12, pin: ["a@team"], suppressionMs: 1000, suppress: ["b@team"] };
    expect((await f.post(body)).status).toBe(200); expect(f.followView).toHaveBeenCalledWith(body);
  });
  it.each([{ enabled: "yes" }, { enabled: true, maxTiles: 0 }, { enabled: true, maxTiles: 257 },
    { enabled: true, graceMs: -1 }, { enabled: true, pin: "a" }, { enabled: true, suppress: ["bad\nseat"] }])("rejects malformed controls before any effect: %j", async controls => {
    const f = fixture(); expect((await f.post({ view: "qitem:task", ...controls })).status).toBe(400);
    expect(f.followView).not.toHaveBeenCalled();
  });
});
