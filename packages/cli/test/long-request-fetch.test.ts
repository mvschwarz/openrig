import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { DaemonClient, DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "../src/client.js";
import { FETCH_HEADERS_TIMEOUT_MS, nodeHttpFetch } from "../src/long-request-fetch.js";

// Node's fetch gives up on a response whose headers haven't arrived within 300 s, and a waiting send answers only when its
// wait ends. So a request allowed 300 s or more goes over node:http, still as one request.
describe("a request allowed 300 s or more", () => {
  let server: http.Server;
  let baseUrl: string;
  const seen: Array<{ method?: string; path?: string; session?: string; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        if (req.url === "/hang") return;
        if (req.url === "/stall") {
          // The daemon answered, then its body stopped arriving.
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "64" });
          res.write('{"ok":true,"sent":tr');
          return;
        }
        if (req.url === "/cut") {
          // The daemon answered and acted, then the connection dropped partway through the body.
          seen.push({ method: req.method, path: req.url, session: undefined, body });
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "64" });
          res.write('{"ok":true,"sent":tr');
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        seen.push({ method: req.method, path: req.url, session: req.headers["x-openrig-session"] as string | undefined, body });
        if (req.url === "/empty") { res.writeHead(204); res.end(); return; }
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "wait_for_idle_timeout", sent: false }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

  it("goes over the long transport, and a shorter one over fetch", async () => {
    const long = vi.fn(nodeHttpFetch);
    const client = new DaemonClient(baseUrl, { longFetchImpl: long });
    await client.post("/api/transport/send", { waitForIdleMs: 400_000 }, { timeoutMs: 405_000 });
    expect(long.mock.calls.map(([url]) => String(url))).toEqual([`${baseUrl}/api/transport/send`]);
    await client.post("/api/transport/send", { waitForIdleMs: 10_000 }, { timeoutMs: 15_000 });
    expect(long).toHaveBeenCalledTimes(1);
    expect(FETCH_HEADERS_TIMEOUT_MS).toBe(300_000);
  });

  it("carries the method, the seat and the body, and returns the daemon's answer as it came", async () => {
    const client = new DaemonClient(baseUrl, { sessionName: "dev-impl@my-rig" });
    const res = await client.post("/api/transport/send", { session: "qa@my-rig", waitForIdleMs: 400_000 }, { timeoutMs: 405_000 });
    expect(res).toEqual({ status: 409, data: { ok: false, reason: "wait_for_idle_timeout", sent: false } });
    expect(seen.at(-1)).toEqual({ method: "POST", path: "/api/transport/send", session: "dev-impl@my-rig",
      body: JSON.stringify({ session: "qa@my-rig", waitForIdleMs: 400_000 }) });
  });

  it("a 204 answer has no body", async () => {
    const res = await nodeHttpFetch(`${baseUrl}/empty`, { method: "POST", body: "{}" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("ends when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = nodeHttpFetch(`${baseUrl}/hang`, { method: "POST", body: "{}", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a body cut off after the headers reads as the daemon having answered, as on fetch, never as not sent", async () => {
    const client = new DaemonClient(baseUrl);
    for (const timeoutMs of [15_000, 405_000]) {
      const err = await client.post("/cut", {}, { timeoutMs }).catch((e: unknown) => e);
      expect(err, `timeoutMs ${timeoutMs}`).toBeInstanceOf(DaemonResponseError);
      expect(err).not.toBeInstanceOf(DaemonConnectionError);
      expect((err as DaemonResponseError).status).toBe(200);
    }
  });

  it("the request's own deadline, reached while the body streams, stays a timeout on both paths", async () => {
    // A short deadline stands in for the long one; the second client sends every request over the long path.
    for (const client of [new DaemonClient(baseUrl), new DaemonClient(baseUrl, { fetchImpl: nodeHttpFetch })]) {
      const err = await client.post("/stall", {}, { timeoutMs: 150 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonTimeoutError);
      expect((err as Error).message).toContain("timed out after 150ms");
    }
  });

  it("refuses a body it can't send, rather than sending none", async () => {
    await expect(nodeHttpFetch(`${baseUrl}/empty`, { method: "POST", body: new Uint8Array([1, 2]) })).rejects.toThrow(TypeError);
  });

  it("a refused connection keeps its code, so it reads as not connected", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const err = await new DaemonClient(`http://127.0.0.1:${port}`).post("/api/transport/send", {}, { timeoutMs: 405_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonConnectionError);
    expect((err as DaemonConnectionError).causeCode).toBe("ECONNREFUSED");
  });
});
