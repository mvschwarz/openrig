// ui.enabled controls pages, assets and SPA routes. Terminal API WebSockets remain available with the same
// authentication and browser boundary when the UI is off.
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { createFullTestDb, createTestApp, mockTmuxAdapter, unavailableCmuxAdapter } from "./helpers/test-app.js";
import { createApp, createAppWithWebSocket, WEB_UI_OFF_MESSAGE, type AppDeps } from "../src/server.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const UI_INDEX_HTML = "<!doctype html><html><head><title>OpenRig UI</title></head><body><div id=\"root\"></div></body></html>";
const TOKEN = "web-ui-off-token";

function tempUiDist(): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-ui-off-"));
  fs.mkdirSync(nodePath.join(dir, "assets"));
  fs.writeFileSync(nodePath.join(dir, "index.html"), UI_INDEX_HTML, "utf-8");
  fs.writeFileSync(nodePath.join(dir, "assets", "app.js"), "console.log('rig');", "utf-8");
  return dir;
}

function appDeps(db: ReturnType<typeof createFullTestDb>, uiDistDir: string, extra: Partial<AppDeps>): AppDeps {
  const s = createTestApp(db) as unknown as Record<string, unknown>;
  return {
    rigRepo: s.rigRepo, sessionRegistry: s.sessionRegistry, eventBus: s.eventBus, nodeLauncher: s.nodeLauncher,
    tmuxAdapter: s.tmuxAdapter ?? mockTmuxAdapter(), cmuxAdapter: s.cmuxAdapter ?? unavailableCmuxAdapter(),
    snapshotCapture: s.snapshotCapture, snapshotRepo: s.snapshotRepo, restoreOrchestrator: s.restoreOrchestrator,
    rigSpecExporter: s.rigSpecExporter, rigSpecPreflight: s.rigSpecPreflight, rigInstantiator: s.rigInstantiator,
    packageRepo: s.packageRepo, installRepo: s.installRepo, installEngine: s.installEngine, installVerifier: s.installVerifier,
    bootstrapOrchestrator: s.bootstrapOrchestrator, bootstrapRepo: s.bootstrapRepo, discoveryCoordinator: s.discoveryCoordinator,
    discoveryRepo: s.discoveryRepo, claimService: s.claimService, psProjectionService: s.psProjectionService, upRouter: s.upRouter,
    teardownOrchestrator: s.teardownOrchestrator, podInstantiator: s.podInstantiator, podBundleSourceResolver: s.podBundleSourceResolver,
    uiDistDir,
    ...extra,
  } as AppDeps;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture(extra: Partial<AppDeps>) {
  const db = createFullTestDb();
  const dir = tempUiDist();
  cleanups.push(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return appDeps(db, dir, extra);
}

async function listen(deps: AppDeps): Promise<number> {
  const { app, injectWebSocket } = createAppWithWebSocket(deps);
  let server: ServerType | undefined;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
  });
  injectWebSocket(server);
  cleanups.push(() => server?.close());
  return port;
}

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; upgraded: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, upgraded: false }));
    });
    req.on("upgrade", (_res, socket) => { socket.destroy(); resolve({ status: 101, body: "", upgraded: true }); });
    req.on("error", reject);
    req.end();
  });
}

// Non-browser upgrade shape (no Origin), so 404 vs not-404 isolates route registration.
const UPGRADE = {
  Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": Buffer.from("web-ui-off-key16").toString("base64"),
};

describe("web UI default off (ui.enabled)", () => {
  it("defaults to false and turns on through the existing setting", () => {
    const prior = process.env.OPENRIG_UI_ENABLED;
    try {
      delete process.env.OPENRIG_UI_ENABLED;
      expect(new SettingsStore().resolveOne("ui.enabled")).toMatchObject({ value: false, source: "default" });
      process.env.OPENRIG_UI_ENABLED = "true";
      expect(new SettingsStore().resolveOne("ui.enabled").value).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.OPENRIG_UI_ENABLED; else process.env.OPENRIG_UI_ENABLED = prior;
    }
  });

  it("serves no UI page, asset or SPA route by default, and names the setting", async () => {
    const app = createApp(fixture({ terminalBearerToken: TOKEN }));
    for (const path of ["/", "/index.html", "/specs", "/rigs/rig-1/nodes/dev.impl", "/assets/app.js", "/apiX"]) {
      const res = await app.request(path);
      const body = await res.text();
      expect(res.status, path).toBe(404);
      expect(res.headers.get("x-openrig-web-ui"), path).toBe("off");
      expect(body, path).toBe(WEB_UI_OFF_MESSAGE);
      expect(body, path).toContain("rig config set ui.enabled true");
      expect(body, path).not.toContain("OpenRig UI");
      expect(body, path).not.toContain(TOKEN);
    }
  });

  it("serves the UI again when enabled", async () => {
    const app = createApp(fixture({ webUiEnabled: true }));
    const res = await app.request("/specs");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UI_INDEX_HTML);
    expect((await app.request("/assets/app.js")).status).toBe(200);
  });

  it("answers health, API and HTTP terminal routes the same with the UI off and on", async () => {
    const off = createApp(fixture({ terminalBearerToken: TOKEN }));
    const on = createApp(fixture({ terminalBearerToken: TOKEN, webUiEnabled: true }));
    for (const path of ["/healthz", "/api/unknown", "/api/config", "/api/terminal/views", "/api/terminal/status", "/api/terminal/preview?view=x"]) {
      const a = await off.request(path), b = await on.request(path);
      expect(a.status, path).toBe(b.status);
      expect(a.headers.get("x-openrig-web-ui"), path).toBeNull();
    }
  });

  it("registers the production terminal WebSocket with the UI off or on; HTTP terminal auth is unchanged", async () => {
    const offPort = await listen(fixture({ terminalBearerToken: TOKEN }));
    const onPort = await listen(fixture({ terminalBearerToken: TOKEN, webUiEnabled: true }));

    const offUpgrade = await request(offPort, `/api/terminal/seat-1?token=${TOKEN}`, UPGRADE);
    expect(offUpgrade.upgraded).toBe(true);
    expect(offUpgrade.status).toBe(101);
    const onUpgrade = await request(onPort, `/api/terminal/seat-1?token=${TOKEN}`, UPGRADE);
    expect(onUpgrade.upgraded).toBe(true);
    expect(onUpgrade.status).toBe(101);
    // A browser upgrade (own-UI Origin) is refused by the /api browser boundary while the UI is off.
    const offBrowser = await request(offPort, `/api/terminal/seat-1?token=${TOKEN}`, { ...UPGRADE, Origin: `http://127.0.0.1:${offPort}` });
    expect(offBrowser.upgraded).toBe(false);
    expect(offBrowser.status).toBe(403);

    // The guard in front of the HTTP terminal routes stays the same either way.
    for (const [path, headers] of [
      ["/api/terminal/views", {}],
      ["/api/terminal/views", { Authorization: `Bearer ${TOKEN}` }],
      ["/api/terminal/status", {}],
      [`/api/terminal/status?token=${TOKEN}`, {}],
    ] as const) {
      const a = await request(offPort, path, headers), b = await request(onPort, path, headers);
      expect(a.status, `${path} ${JSON.stringify(headers)}`).toBe(b.status);
    }
    expect((await request(offPort, "/api/terminal/views")).status).toBe(401);
  });

  it.each([false, true])("keeps terminal bearer and browser checks with ui.enabled=%s", async (webUiEnabled) => {
    const previous = process.env.OPENRIG_ALLOWED_ORIGINS;
    try {
      process.env.OPENRIG_ALLOWED_ORIGINS = "https://terminal.example.test";
      const port = await listen(fixture({ terminalBearerToken: TOKEN, webUiEnabled }));
      const path = "/api/terminal/lead%40fixture";
      for (const [label, suffix, headers, expected] of [
        ["header", "", { Authorization: `Bearer ${TOKEN}` }, 101],
        ["query", `?token=${TOKEN}`, {}, 101],
        ["missing", "", {}, 401],
        ["wrong", "", { Authorization: "Bearer incorrect-fixture-value" }, 401],
        ["unlisted origin", "", { Authorization: `Bearer ${TOKEN}`, Origin: "https://unlisted.example.test" }, 403],
        ["allowed origin", "", { Authorization: `Bearer ${TOKEN}`, Origin: "https://terminal.example.test" }, 101],
        ["own origin", "", { Authorization: `Bearer ${TOKEN}`, Origin: `http://127.0.0.1:${port}` }, webUiEnabled ? 101 : 403],
        ["header host waiver", "", { Authorization: `Bearer ${TOKEN}`, Host: "unlisted.example.test" }, 101],
        ["query host", `?token=${TOKEN}`, { Host: "unlisted.example.test" }, 403],
      ] as const) {
        const result = await request(port, path + suffix, { ...UPGRADE, ...headers });
        expect(result.status, label).toBe(expected);
        expect(result.upgraded, label).toBe(expected === 101);
      }
    } finally {
      if (previous === undefined) delete process.env.OPENRIG_ALLOWED_ORIGINS;
      else process.env.OPENRIG_ALLOWED_ORIGINS = previous;
    }
  });

  it("keeps the trusted no-token terminal posture when the web UI is off", async () => {
    const port = await listen(fixture({ terminalBearerToken: null }));
    expect((await request(port, "/api/terminal/lead%40fixture", UPGRADE)).status).toBe(101);
    expect((await request(port, "/api/terminal/lead%40fixture", { ...UPGRADE, Host: "unlisted.example.test" })).status).toBe(403);
  });
});
