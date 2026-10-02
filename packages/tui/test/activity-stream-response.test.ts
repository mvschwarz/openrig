import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { DaemonClient } from "../src/daemon-client.js";

describe("activity stream response ownership", () => {
  for (const [status, contentType] of [[401, "text/event-stream"], [200, "application/json"]] as const) {
    it(`closes a rejected HTTP ${status} ${contentType} body`, async () => {
      let closed = false;
      const server = createServer((_req, res) => {
        res.writeHead(status, { "content-type": contentType });
        res.write("response remains open");
        res.on("close", () => { closed = true; });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as { port: number };
      const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${address.port}` });
      try {
        expect(await client.openActivityEvents()).toBeNull();
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1_000 });
      } finally { server.closeAllConnections(); server.close(); }
    });
  }

  it("hands accepted SSE body ownership to the subscriber", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } });
    const client = new DaemonClient({ fetchImpl: vi.fn(async () => response) as unknown as typeof fetch });
    expect(await client.openActivityEvents()).toBe(response);
    expect(cancel).not.toHaveBeenCalled();
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("still disables an unavailable leg when body cancellation rejects", async () => {
    const cancel = vi.fn(async () => { throw new Error("already closed"); });
    const response = new Response(new ReadableStream({ cancel }), { status: 503, headers: { "content-type": "text/event-stream" } });
    const client = new DaemonClient({ fetchImpl: vi.fn(async () => response) as unknown as typeof fetch });
    expect(await client.openActivityEvents()).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
