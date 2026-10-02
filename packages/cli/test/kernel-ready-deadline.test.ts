import { describe, it, expect } from "vitest";
import http from "node:http";
import { waitForKernelReady } from "../src/daemon-lifecycle.js";

describe("waitForKernelReady deadline bounds", () => {
  it("bounds slow headers to the wait deadline", async () => {
    const server = http.createServer((_req, res) => {
      // Delay sending headers beyond the client wait deadline
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ kernel_state: "ready", variant: "fixture" }));
      }, 400);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const start = Date.now();
    const result = await waitForKernelReady(baseUrl, 150, 20);
    const elapsed = Date.now() - start;

    server.close();

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(350);
  });

  it("bounds delayed body chunk reads to the wait deadline", async () => {
    const server = http.createServer((_req, res) => {
      // Send headers and partial body immediately, delay the rest beyond the deadline
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"kernel_state":"');
      setTimeout(() => {
        res.end('ready","variant":"fixture"}');
      }, 400);
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const start = Date.now();
    const result = await waitForKernelReady(baseUrl, 150, 20);
    const elapsed = Date.now() - start;

    server.close();

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(350);
  });

  it("resolves promptly when kernel reports ready within deadline", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ kernel_state: "ready", variant: "fast" }));
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const result = await waitForKernelReady(baseUrl, 500, 20);
    server.close();

    expect(result.ok).toBe(true);
    expect(result.kernelState).toBe("ready");
    expect(result.variant).toBe("fast");
  });
});
