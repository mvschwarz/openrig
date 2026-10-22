import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import { DaemonClient } from "../src/client.js";
import { ConfigStore } from "../src/config-store.js";
import { waitForKernelReady } from "../src/daemon-lifecycle.js";

describe("waitForKernelReady deadline bounds", () => {
  it("guard off keeps the admitted final request after the clock crosses its deadline", async () => {
    vi.stubEnv("OPENRIG_URL", ""); vi.stubEnv("RIGGED_URL", "");
    vi.stubEnv("OPENRIG_TRANSPORT_LOCAL_USER_GUARD", "false");
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(2);
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ kernel_state: "ready" })));
    try {
      expect(await waitForKernelReady("http://127.0.0.1:43219", 2, 1)).toMatchObject({ ok: true });
      expect(request).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });

  it("guard off resolves configuration before starting the readiness window", async () => {
    vi.stubEnv("OPENRIG_URL", ""); vi.stubEnv("RIGGED_URL", "");
    vi.stubEnv("OPENRIG_TRANSPORT_LOCAL_USER_GUARD", "false");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const setting = vi.spyOn(ConfigStore.prototype, "resolveWithSource").mockImplementation(() => {
      now = 1000; // Synchronous configuration I/O may take the entire former window.
      return { value: false } as never;
    });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ kernel_state: "ready" })));
    try {
      expect(await waitForKernelReady("http://127.0.0.1:43219", 5, 1)).toMatchObject({ ok: true });
      expect(setting).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });

  it("unknown enabled ownership keeps the admitted final request after its check used the remainder", async () => {
    vi.stubEnv("OPENRIG_URL", ""); vi.stubEnv("RIGGED_URL", "");
    vi.stubEnv("OPENRIG_TRANSPORT_LOCAL_USER_GUARD", "true");
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(DaemonClient.prototype, "assertLocalOwner").mockImplementation(async () => { now = 1000; });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ kernel_state: "ready" })));
    try {
      expect(await waitForKernelReady("http://127.0.0.1:43219", 5, 1)).toMatchObject({ ok: true });
      expect(request).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });

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
