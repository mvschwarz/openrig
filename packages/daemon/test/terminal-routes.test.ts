import { beginPrivateTerminalTmux, endPrivateTerminalTmux, privateTerminalTmuxDeps } from "../../../test/terminal-tmux-isolation.js";
// OPR.0.4.6.02 C3 — the terminal routes: canonical composer + rig-scoped thin
// alias. Pins the route wiring + status mapping + the one shared body contract:
//  - POST /api/terminal/open → the TerminalService result body verbatim;
//  - status mapping: ok → 200 · unknown_provider/view_required → 400 ·
//    view_not_found → 404 · provider-unavailable (honest-partial) → 200;
//  - GET /views + GET /status delegate;
//  - service absent → 503 (never a crash);
//  - the rig-scoped alias composes view = rig:<rigId> and delegates (arch R1).

import { afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { terminalRoutes, rigTerminalRoutes } from "../src/routes/terminal.js";
import type { OpenViewResult } from "../src/domain/terminal/terminal-provider.js";
import { HerdrAdapter } from "../src/domain/terminal/herdr-adapter.js";
import { RigViewerLedger, tmuxEndpointKey } from "../src/domain/terminal/rig-viewer-records.js";
import { TerminalService } from "../src/domain/terminal/terminal-service.js";

const terminalTmuxRoot = beginPrivateTerminalTmux(tmpdir());
afterAll(() => { endPrivateTerminalTmux(terminalTmuxRoot); });

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

  it.each(["herdr_unavailable", "rex_unavailable", "rex_session_failed"])("a provider-unavailable / honest-partial result (%s) is a truthful 200 body", async (code) => {
    const { app } = makeApp({
      openImpl: () => ({ provider: code.split("_")[0]!, ok: false, opened: [], absent: [], degraded: [], pages: 0, code, error: "no binary" }),
    });
    const res = await post(app, "/api/terminal/open", { view: "acme-build" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, code });
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


describe("measured welcome width at the HTTP boundary", () => {
  it.each([119, 120, 159, 160])("passes %i columns unchanged from preview to open", async viewportColumns => {
    const previewView = vi.fn(async () => ({ planId: "width-plan" }));
    const openView = vi.fn(async () => okResult("saved:kernel"));
    const { app } = makeApp({ service: { previewView, openView } });
    const preview = await app.request(`/api/terminal/preview?view=saved:kernel&provider=herdr&viewportColumns=${viewportColumns}`);
    expect(preview.status).toBe(200);
    expect(previewView).toHaveBeenCalledExactlyOnceWith({ view: "saved:kernel", provider: "herdr", viewportColumns });
    const opened = await post(app, "/api/terminal/open", { view: "saved:kernel", provider: "herdr", viewportColumns, expectedPlan: "width-plan" });
    expect(opened.status).toBe(200);
    expect(openView).toHaveBeenCalledExactlyOnceWith({ view: "saved:kernel", provider: "herdr", viewportColumns, expectedPlan: "width-plan" });
  });
});

describe("#3081 POST /api/terminal/open-all, /close-all, and /rig-viewers", () => {
  it.each([{ provider: null }, { provider: ["tmux"] }, { provider: {} }, { provider: 23 }, { provider: true }])("CR: refuses a non-string close-all provider $provider without delegation", async ({ provider }) => {
    const closeAll = vi.fn(async () => ({ ok: true, viewers: [] }));
    const { app } = makeApp({ service: { closeAll } });
    const response = await post(app, "/api/terminal/close-all", { provider });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "body_invalid", viewers: [] });
    expect(closeAll).not.toHaveBeenCalled();
  });

  it.each([undefined, "tmux", "herdr"])("CR: preserves valid close-all provider %j", async provider => {
    const closeAll = vi.fn(async () => ({ ok: true, viewers: [] }));
    const { app } = makeApp({ service: { closeAll } });
    const body = provider === undefined ? {} : { provider };
    const response = await post(app, "/api/terminal/close-all", body);
    expect(response.status).toBe(200);
    expect(closeAll).toHaveBeenCalledExactlyOnceWith(body);
  });

  it("delegates /open-all and maps unsupported_provider / body_invalid / 503", async () => {
    const openAll = vi.fn(async () => ({ provider: "herdr", ok: true, rigs: [{ rig: "a", view: "rig:a", outcome: "opened", opened: ["op@a"], absent: [], degraded: [], skipped: [] }] }));
    const { app } = makeApp({ service: { openAll } });
    const okRes = await post(app, "/api/terminal/open-all", { provider: "herdr", reuseLive: true });
    expect(okRes.status).toBe(200);
    expect(openAll).toHaveBeenCalledExactlyOnceWith({ provider: "herdr", reuseLive: true });

    const badJson = await app.request("/api/terminal/open-all", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect(badJson.status).toBe(400);

    const unsupApp = makeApp({ service: { openAll: async () => ({ provider: "cmux", ok: false, code: "unsupported_provider", error: "unsupported", rigs: [] }) } }).app;
    expect((await post(unsupApp, "/api/terminal/open-all", { provider: "cmux" })).status).toBe(400);

    const downApp = makeApp({ service: undefined }).app;
    expect((await post(downApp, "/api/terminal/open-all", {})).status).toBe(503);
  });

  it("delegates /close-all and leaves removed /rig-viewers routes unavailable", async () => {
    const closeAll = vi.fn(async () => ({ ok: true, viewers: [{ view: "rig:a", provider: "herdr", target: "w1", outcome: "closed" }] }));
    const registerRigViewer = vi.fn(async () => ({ ok: true }));
    const retireRigViewer = vi.fn(async () => ({ ok: true }));
    const { app } = makeApp({ service: { closeAll, registerRigViewer, retireRigViewer } });

    const closeRes = await post(app, "/api/terminal/close-all", { provider: "herdr" });
    expect(closeRes.status).toBe(200);
    expect(closeAll).toHaveBeenCalledExactlyOnceWith({ provider: "herdr" });

    const badViewer = await post(app, "/api/terminal/rig-viewers", { kind: "tmux" });
    expect(badViewer.status).toBe(404);

    const viewerPayload = {
      kind: "tmux", view: "rig:a", sessionName: "openrig-view-1", sessionId: "$1",
      nonce: "n1", windowIds: ["@1"], paneIds: ["%1"], phase: "created",
    };
    const regRes = await post(app, "/api/terminal/rig-viewers", viewerPayload);
    expect(regRes.status).toBe(404);
    expect(registerRigViewer).not.toHaveBeenCalled();

    const delRes = await app.request("/api/terminal/rig-viewers", {
      method: "DELETE",
      body: JSON.stringify({ kind: "tmux", sessionId: "$1", nonce: "n1" }),
      headers: { "content-type": "application/json" },
    });
    expect(delRes.status).toBe(404);
    expect(retireRigViewer).not.toHaveBeenCalled();

    // T3: DELETE /api/terminal/rig-viewers also accepts query parameters without body:
    const delQuery = await app.request("/api/terminal/rig-viewers?kind=tmux&sessionId=%241&nonce=n1", {
      method: "DELETE",
    });
    expect(delQuery.status).toBe(404);
    expect(retireRigViewer).not.toHaveBeenCalled();
  });

  it("J11: maps corrupt_ledger on POST /api/terminal/close-all to HTTP 500", async () => {
    const closeAll = vi.fn(async () => ({
      ok: false,
      code: "corrupt_ledger",
      error: "Rig-viewer journal is corrupt",
      viewers: [],
      notes: [],
    }));
    const { app } = makeApp({ service: { closeAll } });
    const res = await post(app, "/api/terminal/close-all", {});
    expect(res.status).toBe(500);
  });
});

describe("#3081 bf06 child B01/BT01 — HTTP /close-all and /close with real TerminalService", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function makeLiveServiceApp() {
    const dir = mkdtempSync(path.join(tmpdir(), "o3081-routes-b01-"));
    dirs.push(dir);
    const closedWorkspaces: string[] = [];
    const makeEndpoint = (socketPath: string, wid: string, view: string) => {
      let alive = true;
      return new HerdrAdapter({
        launch: { socketPath },
        transportFactory: () => ({
          probe: async () => ({ alive: true, version: "0.9.5", protocol: 22 }),
          request: async (method) => {
            if (method === "workspace.list") return { type: "workspace_list", workspaces: alive ? [{ workspace_id: wid, label: view }] : [] };
            if (method === "tab.list") return { type: "tab_list", tabs: alive ? [{ workspace_id: wid, tab_id: `t-${wid}`, label: `openrig:${view}#p1#k1/1` }] : [] };
            if (method === "pane.list") return { type: "pane_list", panes: alive ? [{ workspace_id: wid, tab_id: `t-${wid}`, pane_id: `p-${wid}`, label: "op" }] : [] };
            if (method === "workspace.close") { closedWorkspaces.push(wid); alive = false; return { type: "ok" }; }
            return { type: "ok" };
          },
        }),
      });
    };
    const def = makeEndpoint("/tmp/rt/herdr.sock", "ws-def", "rig:alpha");
    const work = makeEndpoint("/tmp/rt/sessions/work/herdr.sock", "ws-work", "rig:beta");
    const tmuxExec = vi.fn(async () => "$1|openrig-view-1|fixture-session-options");
    const closeViewCalls: Array<{ viewId: string; appHome: string }> = [];
    const ledger = new RigViewerLedger(dir);
    const service = new TerminalService({
      ...privateTerminalTmuxDeps(),
      resolveProvider: (n) => (n === "herdr" ? def : null),
      resolveSessionProvider: (n, s) => (n === "herdr" ? (s === "work" ? work : def) : null),
      resolveHerdrAppProvider: (target) => ({
        name: "herdr-app",
        appHome: target.appHome ?? "/default/home",
        status: async () => ({ provider: "herdr-app", available: true, capabilities: {} }),
        liveness: async () => ({ alive: true }),
        openView: async () => ({ provider: "herdr-app", ok: true, opened: [], absent: [], degraded: [], pages: 0 }),
        closeView: async (viewId) => {
          closeViewCalls.push({ viewId, appHome: target.appHome ?? "/default/home" });
          return { provider: "herdr-app", ok: true, opened: [], absent: [], degraded: [], pages: 0 };
        },
      }),
      viewsStore: { get: () => undefined, list: () => [] },
      listRigSeats: () => [],
      listPodSeats: () => [],
      listRigNames: () => [],
      resolveHost: () => null,
      hasSession: () => false,
      rigViewersDir: dir,
      tmuxServerArgs: () => ["-L", "rt-sock"],
      tmuxExec,
    });
    const { app } = makeApp({ service });
    return { app, ledger, def, work, closedWorkspaces, tmuxExec, closeViewCalls };
  }

  it.each(["", "   ", ".", "..", "a/b", "a\\b"])(
    "POST /api/terminal/close-all rejects invalid session %j with HTTP 400 invalid_terminal_session",
    async (badSession) => {
      const { app, closedWorkspaces, tmuxExec } = makeLiveServiceApp();
      const res = await post(app, "/api/terminal/close-all", { session: badSession });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, viewers: [], code: "invalid_terminal_session" });
      expect(closedWorkspaces).toEqual([]);
      expect(tmuxExec).not.toHaveBeenCalled();
    },
  );

  it("POST /api/terminal/close-all rejects provider=tmux + session=work with HTTP 400 unsupported_terminal_session", async () => {
    const { app, closedWorkspaces, tmuxExec } = makeLiveServiceApp();
    const res = await post(app, "/api/terminal/close-all", { provider: " tmux ", session: "work" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, viewers: [], code: "unsupported_terminal_session" });
    expect(closedWorkspaces).toEqual([]);
    expect(tmuxExec).not.toHaveBeenCalled();
  });

  it("POST /api/terminal/close-all with trimmed session=' work ' closes only work Herdr and keeps default + tmux", async () => {
    const { app, ledger, def, work, closedWorkspaces, tmuxExec } = makeLiveServiceApp();
    await ledger.upsert({ kind: "herdr", endpoint: def.endpointKey(), view: "rig:alpha", workspaceId: "ws-def", tabIds: ["t-ws-def"], tabLabels: ["openrig:rig:alpha#p1#k1/1"], paneIds: ["p-ws-def"], planId: "p1", createdAt: "2026-11-13T00:00:00Z", phase: "created" });
    await ledger.upsert({ kind: "herdr", endpoint: work.endpointKey(), view: "rig:beta", workspaceId: "ws-work", tabIds: ["t-ws-work"], tabLabels: ["openrig:rig:beta#p1#k1/1"], paneIds: ["p-ws-work"], planId: "p1", createdAt: "2026-11-13T00:00:00Z", phase: "created" });

    const res = await post(app, "/api/terminal/close-all", { session: " work " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(closedWorkspaces).toEqual([]);
    expect(body.viewers.find((v: { target: string }) => v.target === "ws-work")).toMatchObject({ outcome: "kept", code: "conditional_close_unavailable", reason: expect.stringContaining("herdr workspace close 'ws-work'") });
    expect(tmuxExec).not.toHaveBeenCalled();
    expect(body.viewers.some((v: { provider: string }) => v.provider === "tmux")).toBe(false);
    expect(body.viewers.find((v: { target: string }) => v.target === "ws-def")).toMatchObject({ outcome: "kept", code: "different_endpoint" });
  });

  it("POST /api/terminal/close maps unsupported session and non-herdr-app provider to HTTP 400 and preserves default herdr-app", async () => {
    const { app, closeViewCalls } = makeLiveServiceApp();

    const sessRes = await post(app, "/api/terminal/close", { view: "rv-1", session: "work" });
    expect(sessRes.status).toBe(400);
    expect(await sessRes.json()).toMatchObject({ ok: false, code: "unsupported_terminal_session" });

    const provRes = await post(app, "/api/terminal/close", { view: "rv-1", provider: "tmux" });
    expect(provRes.status).toBe(400);
    expect(await provRes.json()).toMatchObject({ ok: false, code: "close_unsupported" });
    expect(closeViewCalls).toEqual([]);

    const okRes = await post(app, "/api/terminal/close", { view: "rv-1", herdrApp: { appHome: "/app/one" } });
    expect(okRes.status).toBe(200);
    expect(closeViewCalls).toEqual([{ viewId: "rv-1", appHome: "/app/one" }]);
  });
});
