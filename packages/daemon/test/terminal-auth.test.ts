import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { transportRoutes } from "../src/routes/transport.js";
import { terminalRoutes } from "../src/routes/terminal.js";
import { authBearerTokenMiddleware } from "../src/middleware/auth-bearer-token.js";

function buildApp(bearerToken: string | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionTransport" as never, {
      resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "test", tmuxSession: "test" }] }),
      send: async () => ({ ok: true }),
      capture: async () => ({ ok: true, content: "test output" }),
      broadcast: async () => ({ ok: true, results: [] }),
    });
    await next();
  });
  app.route("/api/transport", transportRoutes({ bearerToken }));
  return app;
}

describe("terminal-token auth on transport routes", () => {
  const TOKEN = "test-terminal-token-abc123";

  describe("with token required", () => {
    const app = buildApp(TOKEN);

    it("POST /send without token returns 401", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /send with wrong token returns 401", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /send with valid token passes auth", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("POST /capture without token returns 401", async () => {
      const res = await app.request("/api/transport/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /capture with valid token passes auth", async () => {
      const res = await app.request("/api/transport/capture", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ session: "test" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("POST /broadcast without token returns 401", async () => {
      const res = await app.request("/api/transport/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rig: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("with no token (null)", () => {
    const app = buildApp(null);

    it("POST /send passes through without auth", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).not.toBe(401);
    });
  });
});

describe("terminal and transport bearer diagnostics", () => {
  const terminalToken = "SYNTHETIC_TERMINAL_SECRET";
  const missionControlToken = "SYNTHETIC_MISSION_CONTROL_SECRET";
  const routes = [
    { path: "/api/terminal/follow", body: { view: "synthetic", enabled: true } },
    { path: "/api/terminal/viewer/ensure", body: { view: "synthetic", expectedPlan: "plan",
      member: { hostId: "host", nodeId: "node" } } },
    { path: "/api/transport/capture", body: { session: "test" } },
  ];

  function fixture(token: string | null = terminalToken) {
    const effect = vi.fn(async () => ({ ok: true }));
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("terminalService" as never, { followView: effect, ensureViewer: effect } as never);
      c.set("sessionTransport" as never, {
        resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "test", tmuxSession: "test" }] }),
        capture: effect,
      });
      await next();
    });
    app.route("/api/terminal", terminalRoutes({ bearerToken: token }));
    app.route("/api/transport", transportRoutes({ bearerToken: token }));
    app.post("/mission-control", authBearerTokenMiddleware({ expectedToken: missionControlToken }),
      c => c.json({ ok: true }));
    return { app, effect };
  }

  const post = (app: Hono, route: typeof routes[number], authorization?: string) => app.request(route.path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(route.body),
  });

  describe.each(routes)("$path", route => {
    it.each([
      { authorization: undefined, reason: "missing Authorization header" },
      { authorization: "Basic SYNTHETIC_HEADER_SECRET", reason: "Authorization header must be 'Bearer <token>'" },
      { authorization: `Bearer ${missionControlToken}`, reason: "bearer token does not match" },
    ])("names the terminal gate for $reason without reaching protected effects", async ({ authorization, reason }) => {
      const { app, effect } = fixture();
      const res = await post(app, route, authorization);
      expect(res.status).toBe(401);
      expect(effect).not.toHaveBeenCalled();
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(["error", "message", "what_failed", "what_to_do", "why_it_matters"]);
      expect.soft(body).toMatchObject({ error: "unauthorized", message: `Terminal auth failed: ${reason}`, what_failed: reason });
      expect.soft(body.why_it_matters).toContain("Terminal and transport");
      expect.soft(body.what_to_do).toContain("OPENRIG_TERMINAL_BEARER_TOKEN");
      expect(body.what_to_do).toContain("OPENRIG_AUTH_BEARER_TOKEN");
      expect.soft(body.what_to_do).toContain("falls back");
      expect(body.what_to_do).toContain("Authorization: Bearer <token>");
      const text = JSON.stringify(body);
      for (const secret of [terminalToken, missionControlToken, "SYNTHETIC_HEADER_SECRET"]) expect(text).not.toContain(secret);
      expect(text).not.toContain("Mission Control auth failed");
    });

    it.each([
      { label: "separate terminal token", token: terminalToken, authorization: `Bearer ${terminalToken}` },
      { label: "terminal token supplied by the existing fallback", token: missionControlToken, authorization: `Bearer ${missionControlToken}` },
      { label: "no configured terminal gate", token: null, authorization: undefined },
    ])("preserves access with $label", async ({ token, authorization }) => {
      const { app, effect } = fixture(token);
      expect((await post(app, route, authorization)).status).toBe(200);
      expect(effect).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps default Mission Control diagnostics and refuses a separate terminal token", async () => {
    const { app, effect } = fixture();
    const denied = await app.request("/mission-control", { method: "POST", headers: { Authorization: `Bearer ${terminalToken}` } });
    expect(denied.status).toBe(401);
    const body = await denied.json();
    expect(body.message).toBe("Mission Control auth failed: bearer token does not match");
    expect(body.what_to_do).toBe("Set OPENRIG_AUTH_BEARER_TOKEN in the daemon's environment, restart the daemon, and resend the request with `Authorization: Bearer <token>`.");
    expect(body.why_it_matters).toContain("Mission Control write verbs");
    expect(JSON.stringify(body)).not.toContain(terminalToken);
    expect(JSON.stringify(body)).not.toContain(missionControlToken);
    expect(JSON.stringify(body)).not.toContain("OPENRIG_TERMINAL_BEARER_TOKEN");
    const accepted = await app.request("/mission-control", { method: "POST", headers: { Authorization: `Bearer ${missionControlToken}` } });
    expect(accepted.status).toBe(200);
    expect(effect).not.toHaveBeenCalled();
  });
});
