// Exercise the production middleware stack and real WebSocket upgrades. The
// shared boundary's accepted origin must reach the route without a second veto.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type net from "node:net";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";

describe("one browser boundary on the production API and terminal routes", () => {
  let db: Database.Database;
  let server: ReturnType<typeof serve>;
  let port: number;
  let app: ReturnType<typeof createTestApp>["app"];
  const decisions: string[] = [];
  let routeEffects = 0;

  beforeAll(async () => {
    vi.stubEnv("OPENRIG_ALLOWED_ORIGINS", "chrome-extension://fixture,https://dashboard.example:443,tools.example.");
    db = createFullTestDb();
    const ok = async () => ({ ok: true });
    const built = createTestApp(db, {
      withWebSocket: true,
      tmux: {
        ...mockTmuxAdapter(), hasSession: async () => { routeEffects++; return true; },
        setWindowOption: ok, startPipePane: ok, stopPipePane: ok, sendKeys: ok, sendText: ok, resizeWindow: ok,
      } as never,
      appDeps: { webUiEnabled: true, browserBoundaryObserver: (d) => decisions.push(d.code ?? d.outcome) },
    });
    app = built.app;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => { port = info.port; resolve(); });
    });
    built.injectWebSocket!(server);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => (server as unknown as net.Server).close(() => resolve()));
    db.close();
    vi.unstubAllEnvs();
  });

  function upgrade(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, path: "/api/terminal/fixture", headers: {
          Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.from("fixture-key-1234").toString("base64"), ...headers,
        },
      });
      req.on("response", (response) => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
      req.on("upgrade", (response, socket) => { socket.destroy(); resolve(response.statusCode!); });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("fixture upgrade timeout")));
      req.end();
    });
  }

  for (const origin of ["chrome-extension://fixture", "https://dashboard.example:443", "https://dashboard.example/", "https://tools.example"]) {
    it(`honors the primary allowlist for API and WS: ${origin}`, async () => {
      const headers = { Host: `127.0.0.1:${port}`, Origin: origin };
      const before = decisions.length;
      expect((await app.request("/api/ps", { headers })).status).toBe(200);
      expect(await upgrade(headers)).toBe(101);
      expect(decisions.slice(before)).toEqual(["allow", "allow"]);
    });
  }

  it("admits the own UI on a non-loopback IP without a terminal token", async () => {
    const headers = { Host: `192.0.2.10:${port}`, Origin: `http://192.0.2.10:${port}` };
    expect((await app.request("/api/ps", { headers })).status).toBe(200);
    expect(await upgrade(headers)).toBe(101);
  });

  it("still refuses unlisted origins before the terminal route", async () => {
    const before = routeEffects;
    for (const origin of ["chrome-extension://other", "https://dashboard.example:444", "http://dashboard.example", "null", "invalid"]) {
      const headers = { Host: `127.0.0.1:${port}`, Origin: origin };
      const response = await app.request("/api/ps", { headers });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "browser_origin_refused" });
      expect(await upgrade(headers)).toBe(403);
    }
    expect(routeEffects).toBe(before);
  });
});
