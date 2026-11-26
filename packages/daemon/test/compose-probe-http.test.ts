import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";

/** An adapter whose shell exec always throws — probeHttp must never reach it. */
function shellFreeAdapter(): ComposeServicesAdapter {
  return new ComposeServicesAdapter(vi.fn(async () => {
    throw new Error("probeHttp must not shell out");
  }));
}

async function withServer(
  handler: Parameters<typeof createServer>[0],
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("ComposeServicesAdapter.probeHttp (native http, no shell)", () => {
  it("passes on 2xx without touching the shell", async () => {
    await withServer((_req, res) => { res.writeHead(200); res.end("ok"); }, async (url) => {
      expect(await shellFreeAdapter().probeHttp(url, 2000)).toBe(true);
    });
  });

  it("passes on 3xx without following the redirect", async () => {
    let landed = 0;
    const server = createServer((req, res) => {
      if (req.url === "/landed") { landed += 1; res.writeHead(200); res.end(); return; }
      res.writeHead(302, { Location: "/landed" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ok = await shellFreeAdapter().probeHttp(`http://127.0.0.1:${port}/`, 2000);
      expect(ok).toBe(true);
      expect(landed).toBe(0);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails on 4xx", async () => {
    await withServer((_req, res) => { res.writeHead(404); res.end(); }, async (url) => {
      expect(await shellFreeAdapter().probeHttp(url, 2000)).toBe(false);
    });
  });

  it("passes on a URL with no scheme, the way curl defaulted to http", async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await shellFreeAdapter().probeHttp(`127.0.0.1:${port}/health`, 2000)).toBe(true);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends URL credentials as basic auth, which fetch refused to build", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization === "Basic dXNlcjpwYXNz") {
        res.writeHead(200); res.end(); return;
      }
      res.writeHead(401); res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await shellFreeAdapter().probeHttp(`http://user:pass@127.0.0.1:${port}/`, 2000)).toBe(true);
      expect(await shellFreeAdapter().probeHttp(`http://wrong@127.0.0.1:${port}/`, 2000)).toBe(false);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("probes a port on fetch's blocked list (6666)", async (ctx) => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end(); });
    try {
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(6666, "127.0.0.1", resolve));
    } catch {
      ctx.skip();
      return;
    }
    try {
      expect(await shellFreeAdapter().probeHttp("http://127.0.0.1:6666/", 2000)).toBe(true);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("answers at the response headers and releases a body that never ends", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "1000000" });
      res.write("partial");
      // Never ends: the probe must still answer and let the socket go.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await shellFreeAdapter().probeHttp(`http://127.0.0.1:${port}/`, 2000)).toBe(true);
      // The client dropped its side; the server socket must close without
      // waiting for the never-ending body or the probe's own timeout.
      const deadline = Date.now() + 2000;
      while (sockets.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(sockets.size).toBe(0);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails when the connection is refused", async () => {
    // Bind then close to get a port that refuses connections.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await shellFreeAdapter().probeHttp(`http://127.0.0.1:${port}/`, 500)).toBe(false);
  });

  it("fails when the target exceeds the timeout", async () => {
    await withServer((_req, res) => { setTimeout(() => { res.writeHead(200); res.end(); }, 400); }, async (url) => {
      expect(await shellFreeAdapter().probeHttp(url, 50)).toBe(false);
    });
  });
});
