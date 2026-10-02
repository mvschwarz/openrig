// F1/F2 controls on actual Node listeners. F1 drives the production createAppWithWebSocket and its
// registered terminal route with raw socket requests, so duplicate and empty header forms reach the
// adapters exactly as sent. F2 checks the refusal log's emitted content.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";

type Server = ReturnType<typeof serve>;
const listen = (fetch: Hono["fetch"]) => new Promise<{ server: Server; port: number }>((resolve) => {
  const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve({ server, port: info.port }));
});
const close = (s: Server) => new Promise<void>((r) => (s as unknown as net.Server).close(() => r()));

/** Send raw request lines and return the status line. */
function rawRequest(port: number, requestLine: string, headerLines: string[]): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(`${requestLine}\r\n${headerLines.join("\r\n")}\r\n\r\n`));
    let data = "";
    const done = () => resolve(data.split("\r\n")[0] ?? "");
    sock.on("data", (d) => { data += d; if (data.includes("\r\n")) { sock.destroy(); } });
    sock.on("close", done);
    sock.on("error", done);
    setTimeout(() => sock.destroy(), 1500);
  });
}
const UPGRADE = ["Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${Buffer.from("bb-ws-key-123456").toString("base64")}`];
const settle = () => new Promise((r) => setTimeout(r, 120));

describe("F1: production createAppWithWebSocket + registered terminal route, raw header forms", () => {
  let db: Database.Database;
  let server: Server;
  let port = 0;
  let hasSessionCalls = 0;
  const decisions: string[] = [];

  beforeAll(async () => {
    db = createFullTestDb();
    const ok = async () => ({ ok: true });
    const tmux = {
      ...mockTmuxAdapter(),
      hasSession: async () => { hasSessionCalls++; return true; },
      setWindowOption: ok, startPipePane: ok, stopPipePane: ok, sendKeys: ok, sendText: ok, resizeWindow: ok,
    };
    const built = createTestApp(db, {
      tmux: tmux as never,
      withWebSocket: true,
      appDeps: { webUiEnabled: true, browserBoundaryObserver: (d) => decisions.push(d.code ?? d.outcome) },
    });
    ({ server, port } = await listen(built.app.fetch as Hono["fetch"]));
    built.injectWebSocket!(server);
  });
  afterAll(async () => { await close(server); db.close(); });

  async function upgradeCase(headers: string[]) {
    const d0 = decisions.length, h0 = hasSessionCalls;
    const status = await rawRequest(port, "GET /api/terminal/seat-1 HTTP/1.1", [...headers, ...UPGRADE]);
    await settle();
    return { status, decisions: decisions.slice(d0), routeEffects: hasSessionCalls - h0 };
  }

  it("positive control: own UI origin upgrades once, one allow decision, route effect present", async () => {
    const r = await upgradeCase([`Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`]);
    console.log("F1-UPGRADE own", JSON.stringify(r));
    expect(r.status).toContain("101");
    expect(r.decisions).toEqual(["allow"]);
    expect(r.routeEffects).toBeGreaterThan(0);
  });

  it("foreign origin control: 403, one refusal, zero route effects", async () => {
    const r = await upgradeCase([`Host: 127.0.0.1:${port}`, "Origin: http://evil.example"]);
    console.log("F1-UPGRADE foreign", JSON.stringify(r));
    expect(r.status).toContain("403");
    expect(r.decisions).toEqual(["browser_origin_refused"]);
    expect(r.routeEffects).toBe(0);
  });

  for (const [name, headers, code] of [
    ["duplicate Host", (p: number) => [`Host: 127.0.0.1:${p}`, "Host: evil.example", `Origin: http://127.0.0.1:${p}`], "untrusted_host"],
    ["empty Host", (p: number) => ["Host: ", `Origin: http://127.0.0.1:${p}`], "untrusted_host"],
    ["empty Host, no Origin", (_p: number) => ["Host: "], "untrusted_host"],
    ["empty Origin", (p: number) => [`Host: 127.0.0.1:${p}`, "Origin: "], "browser_origin_refused"],
    ["duplicate Origin", (p: number) => [`Host: 127.0.0.1:${p}`, `Origin: http://127.0.0.1:${p}`, "Origin: http://evil.example"], "browser_origin_refused"],
  ] as const) {
    it(`${name}: refused on the upgrade path with one decision and zero route effects`, async () => {
      const r = await upgradeCase(headers(port));
      console.log(`F1-UPGRADE ${name}`, JSON.stringify(r));
      expect(r.status).toContain("403");
      expect(r.decisions).toEqual([code]);
      expect(r.routeEffects).toBe(0);
    });
  }

  it("the same shapes over plain HTTP are refused as well", async () => {
    for (const headers of [
      [`Host: 127.0.0.1:${port}`, "Host: evil.example"],
      ["Host: "],
      [`Host: 127.0.0.1:${port}`, "Origin: "],
    ]) {
      const status = await rawRequest(port, "GET /api/ps HTTP/1.1", [...headers, "Connection: close"]);
      console.log("F1-HTTP", JSON.stringify(headers), status);
      expect(status).not.toContain(" 200 ");
    }
  });

  it("genuinely absent Host (HTTP/1.0, non-browser) is still admitted", async () => {
    const status = await rawRequest(port, "GET /api/ps HTTP/1.0", []);
    expect(status).toContain("200");
  });
});

describe("F2: refusal log content on an actual listener", () => {
  const lines: string[] = [];
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    const app = new Hono();
    app.use("/api/*", browserBoundary({ webUiEnabled: false, bearerTokens: [], warn: (l) => lines.push(l) }));
    app.all("/api/*", (c) => c.json({ ok: true }));
    ({ server, port } = await listen(app.fetch));
  });
  afterAll(async () => { await close(server); });

  it("an encoded control character in the path is replaced in the log; a long path is bounded; the query never appears", async () => {
    await rawRequest(port, "GET /api/a%1Bb?token=SECRET HTTP/1.1", ["Host: evil-1.example", "Connection: close"]);
    await rawRequest(port, `GET /api/${"x".repeat(9000)} HTTP/1.1`, ["Host: evil-2.example", "Connection: close"]);
    console.log("F2-LOG", JSON.stringify(lines.map((l) => ({ length: l.length, hasEsc: l.includes("\u001b"), head: l.slice(0, 120) }))));
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("\u001b");
    expect(lines[0]).toContain("/api/a?b");
    expect(lines[0]).not.toContain("SECRET");
    expect(lines[1]!.length).toBeLessThan(400);
  });
});
