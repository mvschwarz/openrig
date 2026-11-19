// The real TUI daemon client read path, over real HTTP, carries the browser boundary's
// refusal sentence (previously it reported only the status).
import { afterAll, beforeAll, expect, it } from "vitest";
import http from "node:http";
import { Hono } from "hono";
import { DaemonClient } from "../src/daemon-client.js";
import { browserBoundary } from "../../daemon/src/middleware/browser-boundary.js";
import { httpFixtureOrigin } from "./http-fixture.js";

let server: http.Server;
beforeAll(async () => {
  const daemon = new Hono();
  daemon.use("/api/*", browserBoundary({ webUiEnabled: false, bearerTokens: [], warn: () => {} }));
  daemon.all("/api/*", (c) => c.json({ ok: true }));
  const body = await (await daemon.request("/api/health", { headers: { Host: "unlisted.example:7433" } })).text();
  server = http.createServer((_q, r) => { r.writeHead(403, { "content-type": "application/json" }); r.end(body); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

it("a refused read names the remedy", async () => {
  const client = new DaemonClient({ baseUrl: httpFixtureOrigin(server) } as never);
  const message = await client.healthFindings(5).then(() => "", (e: Error) => e.message);
  expect(message).toContain("403");
  expect(message).toContain("OPENRIG_ALLOWED_HOSTS");
});
