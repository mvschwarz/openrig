import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { DaemonClient } from "../src/daemon-client.js";

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

describe("activity stream header deadline", () => {
  it("disables a reachable endpoint that never returns response headers", async () => {
    let closed = false;
    const server = createServer((_req, res) => { res.on("close", () => { closed = true; }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.openActivityEvents(),
        new Promise<string>(resolve => { guard = setTimeout(() => resolve("headers still pending"), 6_500); }),
      ]);
      expect(result).toBeNull();
      for (let i = 0; i < 20 && !closed; i++) await delay(10);
      expect(closed).toBe(true);
    } finally { if (guard) clearTimeout(guard); server.closeAllConnections(); server.close(); }
  }, 10_000);

  it("keeps an established SSE stream alive beyond the header deadline", async () => {
    let closed = false;
    let writeLater!: () => void;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      writeLater = () => res.write('data: {"type":"seat.activity_changed","seq":7}\n\n');
      res.on("close", () => { closed = true; });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await client.openActivityEvents();
      expect(response).not.toBeNull();
      reader = response!.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
      await delay(5_500);
      expect(closed).toBe(false);
      writeLater();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"seq":7');
    } finally { await reader?.cancel(); server.closeAllConnections(); server.close(); }
  }, 10_000);
});
