// The shared transport's per-call bounds, used by usage across hosts: a byte bound on the answer and redirects not
// followed. Both are off unless a call asks, so every other remote command keeps today's behaviour (the default cases
// below, beside remote-daemon-http.test.ts unchanged).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { remoteJsonRequest } from "../src/domain/hosts/remote-daemon-http.js";
import type { HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const servers: http.Server[] = [];
async function serve(handler: http.RequestListener): Promise<HttpHostEntry> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { id: "h", transport: "http", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
});

const json = (body: unknown, chunked = false): http.RequestListener => (_req, res) => {
  const text = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json", ...(chunked ? {} : { "content-length": Buffer.byteLength(text) }) });
  if (!chunked) return res.end(text);
  // No content-length: the bound must hold while streaming.
  for (let i = 0; i < text.length; i += 1024) res.write(text.slice(i, i + 1024));
  res.end();
};

describe("maxBytes", () => {
  it("an answer within the bound is read and parsed as before", async () => {
    const host = await serve(json({ ok: 1 }));
    expect(await remoteJsonRequest(host, "/x", { method: "GET", timeoutMs: 2_000, maxBytes: 100 })).toEqual({ ok: true, status: 200, payload: { ok: 1 } });
  });

  it("over the bound, by its declared length or while streaming, is a failure that is never parsed", async () => {
    for (const chunked of [false, true]) {
      const host = await serve(json({ pad: "x".repeat(10_000) }, chunked));
      expect(await remoteJsonRequest(host, "/x", { method: "GET", timeoutMs: 2_000, maxBytes: 4_096 })).toEqual({
        ok: false, kind: "network", status: 200, tooLarge: true, detail: "answer larger than 4096 bytes",
      });
    }
  });

  it("absent, there is no bound (today's default)", async () => {
    const host = await serve(json({ pad: "x".repeat(10_000) }, true));
    const res = await remoteJsonRequest(host, "/x", { method: "GET", timeoutMs: 2_000 });
    expect(res.ok && (res.payload as { pad: string }).pad.length).toBe(10_000);
  });
});

describe("redirect", () => {
  it("manual: a 3xx comes back as an http failure and the target sees nothing; absent: followed as before", async () => {
    const seen: string[] = [];
    const target = await serve((req, res) => { seen.push(`${req.method} ${req.url}`); json({ reached: true })(req, res); });
    const relay = await serve((req, res) => { res.writeHead(307, { Location: `${target.url}${req.url}` }); res.end(); });
    const manual = await remoteJsonRequest(relay, "/api/provider/usage/refresh", { method: "POST", body: { provider: "codex" }, timeoutMs: 2_000, redirect: "manual" });
    expect(manual).toMatchObject({ ok: false, kind: "http", status: 307 });
    expect(seen).toEqual([]);
    const followed = await remoteJsonRequest(relay, "/x", { method: "GET", timeoutMs: 2_000 });
    expect(followed).toEqual({ ok: true, status: 200, payload: { reached: true } });
    expect(seen).toEqual(["GET /x"]);
  });
});
