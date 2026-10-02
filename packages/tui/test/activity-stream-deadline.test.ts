import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { DaemonClient } from "../src/daemon-client.js";
import { subscribeActivityEvents } from "../src/live-events.js";

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

describe("activity stream header deadline", () => {
  it("rejects a reachable endpoint that never returns response headers", async () => {
    let closed = false;
    const server = createServer((_req, res) => { res.on("close", () => { closed = true; }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        client.openActivityEvents(),
        new Promise<string>(resolve => { guard = setTimeout(() => resolve("headers still pending"), 6_500); }),
      ])).rejects.toMatchObject({ name: "AbortError" });
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


describe("temporary activity stream opening failures", () => {
  it("reconnects after a slow daemon exceeds the header deadline and delivers its next event", async () => {
    let calls = 0;
    const late = new Set<ReturnType<typeof setTimeout>>();
    const server = createServer((_req, res) => {
      calls++;
      const answer = () => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"seat.activity_changed","seq":42}\n\n');
      };
      if (calls === 1) {
        const timer = setTimeout(() => { late.delete(timer); answer(); }, 5_500);
        late.add(timer);
      } else answer();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    const statuses: string[] = [];
    let received = false;
    const sub = subscribeActivityEvents({
      open: () => client.openActivityEvents(),
      reconnectDelayMs: 20,
      onEvent: event => { received = event.seq === 42; },
      onStatus: status => statuses.push(status),
    });
    try {
      const end = Date.now() + 6_500;
      while (!received && Date.now() < end) await delay(10);
      expect(received).toBe(true);
      expect(calls).toBe(2);
      expect(statuses).toContain("dropped");
      expect(statuses).toContain("reconnecting");
      expect(statuses).not.toContain("unavailable");
    } finally {
      sub.close();
      for (const timer of late) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 8_000);
});
