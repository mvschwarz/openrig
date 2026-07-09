// OPR.0.4.6.02 C3 — the terminal routes: canonical composer + rig-scoped thin
// alias. Pins the route wiring + status mapping + the one shared body contract:
//  - POST /api/terminal/open → the TerminalService result body verbatim;
//  - status mapping: ok → 200 · unknown_provider/view_required → 400 ·
//    view_not_found → 404 · provider-unavailable (honest-partial) → 200;
//  - GET /views + GET /status delegate;
//  - service absent → 503 (never a crash);
//  - the rig-scoped alias composes view = rig:<rigId> and delegates (arch R1).

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { terminalRoutes, rigTerminalRoutes } from "../src/routes/terminal.js";
import type { OpenViewResult } from "../src/domain/terminal/terminal-provider.js";

type OpenReq = { provider?: string; view: string };

function okResult(view: string): OpenViewResult {
  return { provider: "herdr", ok: true, opened: [`${view}-seat`], absent: [], degraded: [], pages: 1 };
}

/** Build an app with a fake terminalService recording the openView requests. */
function makeApp(opts: {
  service?: unknown;
  openImpl?: (req: OpenReq) => OpenViewResult;
} = {}) {
  const openCalls: OpenReq[] = [];
  const service =
    "service" in opts
      ? opts.service
      : {
          openView: async (req: OpenReq) => {
            openCalls.push(req);
            return (opts.openImpl ?? okResult)(req.view);
          },
          listViews: async () => ({ saved: [{ id: "watchtower", name: "Watchtower", members: [] }], rigs: ["acme-build"] }),
          status: async (p?: string) => ({ providers: [{ name: p ?? "herdr", status: { provider: p ?? "herdr", available: true, capabilities: {} }, liveness: { alive: true } }] }),
        };
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c.set.bind(c) as (k: string, v: unknown) => void)("terminalService", service);
    await next();
  });
  app.route("/api/terminal", terminalRoutes());
  app.route("/api/rigs/:rigId/terminal", rigTerminalRoutes);
  return { app, openCalls };
}

function post(app: Hono, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/terminal/open", () => {
  it("returns the TerminalService result body at 200 on success", async () => {
    const { app, openCalls } = makeApp();
    const res = await post(app, "/api/terminal/open", { view: "acme-build", provider: "herdr" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "herdr", ok: true, opened: ["acme-build-seat"] });
    expect(openCalls[0]).toEqual({ view: "acme-build", provider: "herdr" });
  });

  it("maps unknown_provider → 400", async () => {
    const { app } = makeApp({
      openImpl: () => ({ provider: "tmate", ok: false, opened: [], absent: [], degraded: [], pages: 0, code: "unknown_provider", error: "x" }),
    });
    const res = await post(app, "/api/terminal/open", { view: "acme-build", provider: "tmate" });
    expect(res.status).toBe(400);
  });

  it("maps view_not_found → 404", async () => {
    const { app } = makeApp({
      openImpl: () => ({ provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0, code: "view_not_found", error: "x" }),
    });
    const res = await post(app, "/api/terminal/open", { view: "nope" });
    expect(res.status).toBe(404);
  });

  it("a provider-unavailable / honest-partial result is a truthful 200 body", async () => {
    const { app } = makeApp({
      openImpl: () => ({ provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0, code: "herdr_unavailable", error: "no binary" }),
    });
    const res = await post(app, "/api/terminal/open", { view: "acme-build" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, code: "herdr_unavailable" });
  });

  it("a non-JSON body → 400 body_invalid", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/terminal/open", { method: "POST", body: "not json", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "body_invalid" });
  });

  it("service absent → 503 (never a crash)", async () => {
    const { app } = makeApp({ service: undefined });
    const res = await post(app, "/api/terminal/open", { view: "acme-build" });
    expect(res.status).toBe(503);
  });
});

describe("GET /api/terminal/views + /status", () => {
  it("views delegates", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/terminal/views");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rigs: ["acme-build"] });
  });

  it("status passes the provider query through", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/terminal/status?provider=cmux");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ providers: [{ name: "cmux" }] });
  });
});

describe("POST /api/rigs/:rigId/terminal/open — thin alias", () => {
  it("composes view = rig:<rigId> and delegates to the same service", async () => {
    const { app, openCalls } = makeApp();
    const res = await post(app, "/api/rigs/rig-id-1/terminal/open", {});
    expect(res.status).toBe(200);
    expect(openCalls[0]?.view).toBe("rig:rig-id-1");
  });

  it("carries a provider from the body while still composing the rig view", async () => {
    const { app, openCalls } = makeApp();
    await post(app, "/api/rigs/rig-id-1/terminal/open", { provider: "cmux" });
    expect(openCalls[0]).toEqual({ view: "rig:rig-id-1", provider: "cmux" });
  });
});
