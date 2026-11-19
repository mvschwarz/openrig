import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { Duplex } from "node:stream";
import { DaemonClient, DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "../src/client.js";
import { daemonFetch } from "../src/daemon-transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: http.Server, protocol = "http:"): Promise<string> {
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
  return `${protocol}//127.0.0.1:${address.port}`;
}

async function fixture(mode: "allow" | "deny" | "hang-connect" = "allow", tlsMode: "none" | "target" | "both" = "none") {
  let tlsOptions: https.ServerOptions | undefined;
  let ca: string | undefined;
  if (tlsMode !== "none") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-proxy-cert-"));
    ca = path.join(root, "certificate.pem");
    const key = path.join(root, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
      "-out", ca, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    tlsOptions = { key: fs.readFileSync(key), cert: fs.readFileSync(ca) };
    cleanup.push(async () => { fs.rmSync(root, { recursive: true }); });
  }
  const requests: Array<{ method: string | undefined; url: string | undefined; auth: string | undefined; sender: string | string[] | undefined; principal: string | string[] | undefined; body: string }> = [];
  const handle: http.RequestListener = async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization,
      sender: req.headers["x-openrig-session"], principal: req.headers["x-openrig-principal"], body });
    if (req.url === "/hang") return;
    if (req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      return;
    }
    if (req.url === "/cut" || req.url === "/stall") {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "80" });
      res.write('{"accepted":');
      if (req.url === "/cut") setTimeout(() => res.destroy(), 20);
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Fixture-Header", "retained");
    res.end(JSON.stringify(req.url === "/healthz" ? { selfHostId: "fixture-instance" } : { ok: true }));
  };
  const target = await listen(tlsOptions ? https.createServer(tlsOptions, handle) : http.createServer(handle), tlsOptions ? "https:" : "http:");
  const connects: Array<{ destination: string | undefined; auth: string | undefined }> = [];
  const tunnels = new Set<Duplex>();
  const handleProxy: http.RequestListener = (_req, res) => { res.writeHead(500).end(); };
  const proxy = tlsMode === "both" ? https.createServer(tlsOptions, handleProxy) : http.createServer(handleProxy);
  proxy.on("connect", (req, client, head) => {
    const auth = req.headers["proxy-authorization"];
    connects.push({ destination: req.url, auth: typeof auth === "string" ? auth : undefined });
    tunnels.add(client);
    client.once("close", () => tunnels.delete(client));
    if (mode === "hang-connect") {
      // CONNECT hands ownership of this paused, half-open socket to the fixture. Consume FIN so the server can
      // observe cancellation instead of retaining its own unread half of an already closed client connection.
      client.once("end", () => client.destroy());
      client.resume();
      return;
    }
    if (mode === "deny" || req.url !== new URL(target).host) {
      const body = JSON.stringify({ error: "fixture_proxy_denied" });
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const url = new URL(target);
    const upstream = net.connect(Number(url.port), url.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    tunnels.add(upstream);
    upstream.once("close", () => tunnels.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  });
  const proxyUrl = await listen(proxy, tlsMode === "both" ? "https:" : "http:");
  cleanup.push(async () => { for (const socket of tunnels) socket.destroy(); });
  const configure = (sandbox = "1") => {
    vi.stubEnv("SANDBOX_RUNTIME", sandbox);
    vi.stubEnv("http_proxy", proxyUrl);
    vi.stubEnv("HTTP_PROXY", proxyUrl);
    vi.stubEnv("https_proxy", proxyUrl);
    vi.stubEnv("HTTPS_PROXY", proxyUrl);
    vi.stubEnv("NO_PROXY", "localhost,127.0.0.1,::1");
    vi.stubEnv("no_proxy", "localhost,127.0.0.1,::1");
  };
  return { target, proxyUrl, connects, requests, tunnels, configure, ca };
}

describe("daemon requests through the sandbox's supplied HTTP proxy", () => {
  it.each([5_000, 405_000])("preserves health identity, authenticated reads, one write and response headers at %i ms", async (timeoutMs) => {
    const f = await fixture();
    f.configure();
    const client = new DaemonClient(f.target, { timeoutMs, sessionName: "builder@fixture",
      principal: { source: "file", id: "fixture-principal" } });
    client.originSelfHostId = "fixture-instance";
    const headers = { Authorization: "Bearer synthetic-fixture-token" };
    const read = await client.get("/read", { headers });
    const write = await client.post("/write", { action: "once" }, { headers });
    expect(read.data).toEqual({ ok: true });
    expect(write.headers?.get("x-fixture-header")).toBe("retained");
    expect(f.requests.filter((r) => r.url === "/write")).toEqual([{ method: "POST", url: "/write",
      auth: headers.Authorization, sender: "builder@fixture", principal: JSON.stringify({ source: "file", id: "fixture-principal" }),
      body: '{"action":"once"}' }]);
    expect(f.requests.some((r) => r.url === "/healthz")).toBe(true);
    expect(f.connects.length).toBe(f.requests.length);
    expect(f.connects.every((r) => r.destination === new URL(f.target).host)).toBe(true);
    expect(process.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(process.env.no_proxy).toBe("localhost,127.0.0.1,::1");
  });

  it("retains direct routing outside the sandbox context", async () => {
    const f = await fixture();
    f.configure("0");
    expect((await new DaemonClient(f.target).get("/read")).data).toEqual({ ok: true });
    expect(f.requests).toHaveLength(1);
    expect(f.connects).toHaveLength(0);
  });

  it("leaves an unrelated origin on its existing transport", async () => {
    const f = await fixture();
    const other = await fixture();
    f.configure();
    const response = await daemonFetch(f.target)(`${other.target}/read`);
    expect(await response.json()).toEqual({ ok: true });
    expect(other.requests).toHaveLength(1);
    expect(f.connects).toHaveLength(0);
    expect(other.connects).toHaveLength(0);
  });

  it("retains the normal transport when no HTTP proxy is supplied", async () => {
    const f = await fixture();
    f.configure();
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("HTTP_PROXY", "");
    expect((await new DaemonClient(f.target).get("/read")).data).toEqual({ ok: true });
    expect(f.connects).toHaveLength(0);
  });

  it("rejects an invalid supplied proxy without exposing it or trying a direct write", async () => {
    const f = await fixture();
    f.configure();
    vi.stubEnv("http_proxy", "socks://fixture-user:fixture-password@127.0.0.1:1");
    const error: unknown = await new DaemonClient(f.target).post("/write", {}).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DaemonConnectionError);
    expect(String(error)).toContain("valid HTTP(S) URL");
    expect(String(error)).not.toMatch(/fixture-user|fixture-password/);
    expect(f.requests).toHaveLength(0);
    expect(f.connects).toHaveLength(0);
  });

  it("sends proxy credentials only to CONNECT, preserving the daemon Authorization header", async () => {
    const f = await fixture();
    f.configure();
    const proxy = new URL(f.proxyUrl);
    proxy.username = "fixture-user";
    proxy.password = "fixture-password";
    vi.stubEnv("http_proxy", proxy.href);
    await new DaemonClient(f.target).get("/read", { headers: { Authorization: "Bearer fixture-daemon" } });
    expect(f.connects[0]?.auth).toBe(`Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`);
    expect(f.requests[0]?.auth).toBe("Bearer fixture-daemon");
  });

  it("returns a streamed response before its body ends and closes the tunnel when its reader cancels", async () => {
    const f = await fixture();
    f.configure();
    const response = await daemonFetch(f.target)(`${f.target}/stream`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing streamed response");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    await reader.cancel();
    await expect.poll(() => f.tunnels.size).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(f.connects).toHaveLength(1);
  });

  it.each([5_000, 405_000])("keeps proxy refusal truthful without a direct retry or a write at %i ms", async (timeoutMs) => {
    const f = await fixture("deny");
    f.configure();
    const response = await new DaemonClient(f.target, { timeoutMs }).post("/write", { action: "once" });
    expect(response).toMatchObject({ status: 403, data: { error: "fixture_proxy_denied" } });
    expect(f.requests).toHaveLength(0);
    expect(f.connects).toHaveLength(1);
  });

  it("does not dispatch an already canceled request", async () => {
    const f = await fixture();
    f.configure();
    await expect(new DaemonClient(f.target).get("/read", { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(DaemonConnectionError);
    expect(f.connects).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  it("closes a proxy connection whose CONNECT response never arrives at the deadline", async () => {
    const f = await fixture("hang-connect");
    f.configure();
    await expect(new DaemonClient(f.target, { timeoutMs: 120 }).get("/read")).rejects.toBeInstanceOf(DaemonTimeoutError);
    expect(f.connects).toHaveLength(1);
    await expect.poll(() => f.tunnels.size).toBe(0);
    expect(f.requests).toHaveLength(0);
  });

  it.each([5_000, 405_000])("preserves caller cancellation after headers and never retries the write at %i ms", async (timeoutMs) => {
    const f = await fixture();
    f.configure();
    const controller = new AbortController();
    const result = new DaemonClient(f.target, { timeoutMs }).post("/stall", { action: "once" }, { signal: controller.signal })
      .catch((error: unknown) => error);
    await expect.poll(() => f.requests.length).toBe(1);
    controller.abort();
    expect(await result).toBeInstanceOf(DaemonResponseError);
    expect(f.connects).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
    await expect.poll(() => f.tunnels.size).toBe(0);
  });

  it.each([5_000, 405_000])("reports an interrupted response as an unknown write outcome at %i ms", async (timeoutMs) => {
    const f = await fixture();
    f.configure();
    await expect(new DaemonClient(f.target, { timeoutMs }).post("/cut", { action: "once" })).rejects.toBeInstanceOf(DaemonResponseError);
    expect(f.requests).toHaveLength(1);
    expect(f.connects).toHaveLength(1);
  });

  it("keeps the deadline active through the response body", async () => {
    const f = await fixture();
    f.configure();
    await expect(new DaemonClient(f.target, { timeoutMs: 120 }).get("/stall")).rejects.toBeInstanceOf(DaemonTimeoutError);
    expect(f.requests).toHaveLength(1);
    expect(f.connects).toHaveLength(1);
    await expect.poll(() => f.tunnels.size).toBe(0);
  });

  it.each(["target", "both"] as const)("preserves HTTPS certificate verification (%s TLS)", async (tlsMode) => {
    const f = await fixture("allow", tlsMode);
    f.configure();
    await expect(new DaemonClient(f.target).post("/write", {})).rejects.toBeInstanceOf(DaemonConnectionError);
    expect(f.requests).toHaveLength(0);
  });

  it.each(["target", "both"] as const)("performs authenticated HTTPS reads and one write per path with a trusted fixture CA (%s TLS)", async (tlsMode) => {
    const f = await fixture("allow", tlsMode);
    f.configure();
    const source = new URL("../src/client.ts", import.meta.url).href;
    const script = `import { DaemonClient } from ${JSON.stringify(source)};
      const result = [];
      for (const timeoutMs of [5000, 405000]) {
        const client = new DaemonClient(${JSON.stringify(f.target)}, { timeoutMs, sessionName: "builder@fixture" });
        const headers = { Authorization: "Bearer fixture-tls" };
        const health = await client.get("/healthz", { headers });
        const read = await client.get("/read", { headers });
        const write = await client.post("/write", { action: "once" }, { headers });
        result.push([health.status, read.status, write.status, write.headers.get("x-fixture-header")]);
      }
      console.log(JSON.stringify(result));`;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { env: { ...process.env, NODE_EXTRA_CA_CERTS: f.ca }, encoding: "utf8", timeout: 10_000 });
    expect(JSON.parse(stdout)).toEqual([[200, 200, 200, "retained"], [200, 200, 200, "retained"]]);
    expect(f.requests.filter((r) => r.url === "/write")).toHaveLength(2);
    expect(f.requests.every((r) => r.auth === "Bearer fixture-tls" && r.sender === "builder@fixture")).toBe(true);
    expect(f.connects).toHaveLength(6);
  });
});
