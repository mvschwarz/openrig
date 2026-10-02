import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { PageRead } from "../src/page-read.js";

async function until(condition: () => boolean, timeout = 500) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started >= timeout) throw new Error("condition not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("page error response ownership", () => {
  it.each([false, true])("closes a real HTTP 503 body before returning a failed read (cached=%s)", async cached => {
    let disconnected = false;
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.write('{"error":"unavailable"'); // keep the rejected body open
      response.on("close", () => { disconnected = true; });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ps`;
    const page = new PageRead(() => 10);
    const read = page.fetch(fetch, new AbortController().signal);
    try {
      if (cached) {
        page.begin();
        const first = page.fetch(async () => Response.json({ prior: true }), new AbortController().signal);
        await first(url);
        page.end();
      }
      page.begin();
      if (cached) {
        const response = await read(url);
        expect(await response.json()).toEqual({ prior: true });
        expect(page.retainedAt).toBe(10);
      } else await expect(read(url)).rejects.toThrow("HTTP 503");
      expect(page.errors).toEqual(["/api/ps: HTTP 503"]);
      await until(() => disconnected);
    } finally { server.closeAllConnections(); server.close(); }
  });

  it("preserves the original HTTP failure if rejected body cancellation fails", async () => {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const response = new Response(new ReadableStream({ cancel }), { status: 500 });
    const page = new PageRead(() => 0);
    page.begin();
    await expect(page.fetch(async () => response, new AbortController().signal)("http://localhost/api/ps")).rejects.toThrow("HTTP 500");
    expect(cancel).toHaveBeenCalledOnce();
    expect(page.errors).toEqual(["/api/ps: HTTP 500"]);
  });

  it("keeps access refusal as a fresh answer and evicts the cached value", async () => {
    const denied = vi.fn();
    const page = new PageRead(() => 0, denied);
    const signal = new AbortController().signal;
    page.begin();
    await page.fetch(async () => Response.json({ old: true }), signal)("http://localhost/api/ps");
    page.end();
    page.begin();
    const refusal = Response.json({ error: "forbidden" }, { status: 403 });
    expect(await page.fetch(async () => refusal, signal)("http://localhost/api/ps")).toBe(refusal);
    expect(await refusal.json()).toEqual({ error: "forbidden" });
    expect(page.has("http://localhost/api/ps")).toBe(false);
    expect(denied).toHaveBeenCalledWith("http://localhost/api/ps");
  });

  it("consumes and caches an ordinary successful JSON response", async () => {
    const page = new PageRead(() => 12);
    page.begin();
    const response = await page.fetch(async () => Response.json({ healthy: true }), new AbortController().signal)("http://localhost/api/ps");
    expect(await response.json()).toEqual({ healthy: true });
    expect(page.errors).toEqual([]);
    expect(page.has("http://localhost/api/ps")).toBe(true);
  });
});
