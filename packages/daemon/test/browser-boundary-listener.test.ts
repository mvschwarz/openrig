// Browser boundary on a real Node listener (@hono/node-server) and the real WebSocket upgrade
// path (@hono/node-ws), plus real CLI/TUI/daemon-to-daemon request constructors. Inert handlers only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import WebSocket from "ws";
import { browserBoundary } from "../src/middleware/browser-boundary.js";
import { terminalAuthMiddleware } from "../src/routes/terminal-ws.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { remoteJsonRequest } from "../src/domain/hosts/remote-daemon-http.js";
import { DaemonClient as CliDaemonClient } from "../../cli/src/client.js";
import { DaemonClient as TuiDaemonClient } from "../../tui/src/daemon-client.js";

const SELF = "openrig-vm.taile8a08.ts.net";
type Server = ReturnType<typeof serve>;

function listen(app: Hono, hostname: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname }, (info) => resolve({ server, port: info.port }));
    (server as unknown as net.Server).once("error", reject);
  });
}

function raw(port: number, headers: Record<string, string>, path = "/api/ping", address = "127.0.0.1"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: address, port, path, method: "GET", headers, setHost: !("Host" in headers) }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function rawSocket(port: number, request: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(request));
    let data = "";
    sock.on("data", (d) => { data += d; });
    sock.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
    sock.on("error", () => resolve(data.split("\r\n")[0] ?? "error"));
    setTimeout(() => sock.destroy(), 1500);
  });
}

describe("mirror of the server.ts order on a real listener: boundary, then terminal guard, then upgrade", () => {
  const decisions: string[] = [];
  let handled = 0;
  let opened = 0;
  let server: Server;
  let port = 0;
  let v6: { server: Server; port: number } | null = null;

  beforeAll(async () => {
    const app = new Hono();
    const ws = createNodeWebSocket({ app });
    app.use("/api/*", browserBoundary({
      webUiEnabled: true, bearerTokens: [], hostName: () => "box-1.local",
      discoverSelfNames: async () => [SELF], warn: () => {},
      onDecision: (d) => decisions.push(d.code ?? d.outcome),
    }));
    app.get("/api/ping", (c) => { handled++; return c.json({ ok: true }); });
    app.get("/api/terminal/:s", terminalAuthMiddleware({ bearerToken: null }) as never,
      ws.upgradeWebSocket(() => ({ onOpen: (_e, socket) => { opened++; socket.close(); } })));
    ({ server, port } = await listen(app, "127.0.0.1"));
    ws.injectWebSocket(server);
    try { v6 = await listen(app, "::1"); } catch { v6 = null; }
    await new Promise((r) => setTimeout(r, 20));
  });
  afterAll(async () => {
    await new Promise<void>((r) => (server as unknown as net.Server).close(() => r()));
    if (v6) await new Promise<void>((r) => (v6!.server as unknown as net.Server).close(() => r()));
  });

  it("actual Node headers: accepted names reach the inert handler once each; others never", async () => {
    const before = handled;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `box-1.local:${port}`, `${SELF}:${port}`, `openrig-vm:${port}`]) {
      expect((await raw(port, { Host: host })).status, host).toBe(200);
    }
    expect(handled - before).toBe(5);
    // @hono/node-server 1.19.11 answers 400 "Invalid host header" before the app when the URL-normalized
    // hostname differs from the raw Host (case); a lowercase trailing dot passes through and the
    // boundary normalizes it.
    const upper = await raw(port, { Host: `LOCALHOST:${port}` });
    const dotted = await raw(port, { Host: `localhost.:${port}` });
    console.log(`ADAPTER-HOST-FORM LOCALHOST -> ${upper.status}; localhost. -> ${dotted.status}`);
    expect(upper.status).toBe(400);
    expect(dotted.status).toBe(200);
    expect(handled - before).toBe(6);
    for (const host of [`evil.example:${port}`, `other-vm.taile8a08.ts.net:${port}`]) {
      const r = await raw(port, { Host: host });
      expect(r.status, host).toBe(403);
      expect(JSON.parse(r.body).code).toBe("untrusted_host");
    }
    for (const host of ["a b", `x@y:${port}`]) {
      const r = await raw(port, { Host: host });
      console.log(`MALFORMED-HOST-FORM ${JSON.stringify(host)} -> ${r.status} ${r.body.slice(0, 80)}`);
      expect(r.status, host).not.toBe(200);
    }
    expect(handled - before).toBe(6);
  });

  it("IPv6 loopback listener: [::1] Host is accepted", async () => {
    if (!v6) { console.log("IPV6-LISTENER: unavailable on this host (control not run)"); return; }
    const r = await raw(v6.port, { Host: `[::1]:${v6.port}` }, "/api/ping", "::1");
    expect(r.status).toBe(200);
  });

  it("records what the real listener does with duplicate, missing and HTTP/1.0 Host forms", async () => {
    const dup = await rawSocket(port, `GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`);
    const missing11 = await rawSocket(port, "GET /api/ping HTTP/1.1\r\nConnection: close\r\n\r\n");
    const http10 = await rawSocket(port, "GET /api/ping HTTP/1.0\r\n\r\n");
    const dupOrigin = await rawSocket(port, `GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n`);
    console.log(`LISTENER-FORMS duplicateHost=[${dup}] missingHost11=[${missing11}] http10NoHost=[${http10}] duplicateOrigin=[${dupOrigin}]`);
    expect(dup).not.toMatch(/ 200 /);
    expect(dupOrigin).not.toMatch(/ 200 /);
  });

  it("real upgrade path: the guard runs exactly once per upgrade; refused upgrades never open", async () => {
    const attempt = (origin: string | undefined, host?: string) => new Promise<{ opened: boolean; status?: number }>((resolve) => {
      const headers: Record<string, string> = {};
      if (host) headers["Host"] = host;
      const sock = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/s1`, { headers, ...(origin ? { origin } : {}) });
      sock.on("open", () => { sock.close(); resolve({ opened: true }); });
      sock.on("unexpected-response", (_req, res) => { resolve({ opened: false, status: res.statusCode }); });
      sock.on("error", () => resolve({ opened: false }));
    });
    const d0 = decisions.length;
    const o0 = opened;
    expect(await attempt(`http://127.0.0.1:${port}`)).toEqual({ opened: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(decisions.length - d0).toBe(1);
    expect(opened - o0).toBe(1);
    const d1 = decisions.length;
    expect(await attempt("http://evil.example")).toEqual({ opened: false, status: 403 });
    expect(await attempt(undefined, `evil.example:${port}`)).toEqual({ opened: false, status: 403 });
    expect(await attempt(`http://localhost:5173`, `localhost:${port}`)).toEqual({ opened: false, status: 403 });
    await new Promise((r) => setTimeout(r, 50));
    expect(decisions.length - d1).toBe(3);
    expect(opened - o0).toBe(1);
  });
});

describe("real request constructors against the real route table on a real listener", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    ({ server, port } = await listen(app as unknown as Hono, "127.0.0.1"));
  });
  afterAll(async () => { await new Promise<void>((r) => (server as unknown as net.Server).close(() => r())); });

  it("CLI DaemonClient (no Origin) reaches /api/ps by IP and localhost", async () => {
    for (const base of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const res = await new CliDaemonClient(base).get<unknown[]>("/api/ps?includeArchived=true");
      expect(res.status, base).toBe(200);
    }
  });

  it("records whether Node fetch honours an explicit Host header (needed to present an unlisted name without DNS)", async () => {
    const res = await new CliDaemonClient(`http://127.0.0.1:${port}`, { headers: { Host: "unlisted.example" } }).get<{ code?: string; error?: string }>("/api/ps");
    console.log(`CLI-HOST-OVERRIDE status=${res.status} code=${(res.data as { code?: string })?.code ?? "-"}`);
    if (res.status === 403) {
      expect(res.data.code).toBe("untrusted_host");
      expect(res.data.error).toContain("OPENRIG_ALLOWED_HOSTS");
    }
  });

  it("TUI client read path carries the refusal sentence; normal reads pass", async () => {
    const ok = new TuiDaemonClient({ baseUrl: `http://127.0.0.1:${port}` } as never);
    await expect(ok.healthFindings(5)).resolves.toBeDefined();
    const named = new TuiDaemonClient({ baseUrl: `http://127.0.0.1:${port}`, headers: { Host: "unlisted.example" } } as never);
    const err = await named.healthFindings(5).then(() => null, (e: Error) => e.message);
    console.log(`TUI-READ-REFUSAL ${err ?? "no refusal (Host override not honoured)"}`);
    if (err) expect(err).toContain("OPENRIG_ALLOWED_HOSTS");
  });

  it("daemon-to-daemon remoteJsonRequest (no Origin) reaches the daemon by IP and localhost", async () => {
    for (const url of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const r = await remoteJsonRequest({ id: "peer", transport: "http", url }, "/api/ps", { method: "GET", timeoutMs: 3000, env: {} });
      expect(r.ok, url).toBe(true);
    }
  });
});
