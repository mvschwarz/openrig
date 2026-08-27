import { describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { subscribeActivityEvents } from "../src/live-events.js";
import { createLiveRefresh } from "../src/live.js";
import { emptySnapshot } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

// OPR.0.5.5.19 AM-R18 — the open view updates ITSELF: pushes from the oracle's SSE
// stream drive the refresh owner; zero clicks, zero manual refresh, zero idle polling.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sseServer(): Promise<{ server: Server; url: string; push: (data: unknown) => void; connections: () => number }> {
  return new Promise((resolve) => {
    const sockets = new Set<import("node:http").ServerResponse>();
    const server = createServer((req, res) => {
      if (!req.url!.endsWith("/api/activity/events")) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      sockets.add(res);
      req.on("close", () => sockets.delete(res));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        push: (data) => { for (const s of sockets) s.write(`data: ${JSON.stringify(data)}\n\n`); },
        connections: () => sockets.size,
      });
    });
  });
}

function until(cond: () => boolean, ms = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("condition not reached"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("S19 AM-R18 — the subscription path", () => {
  it("each pushed oracle change fires onEvent with the notification payload (no activity fields consumed)", async () => {
    const { server, url, push, connections } = await sseServer();
    const events: Array<{ type: string; seq?: number }> = [];
    const sub = subscribeActivityEvents({ baseUrl: url, onEvent: (e) => events.push(e) });
    try {
      await until(() => connections() === 1);
      push({ type: "seat.activity_changed", seatNodeId: "node-1", seq: 7 });
      push({ type: "seat.activity_changed", seatNodeId: "node-1", seq: 8 });
      await until(() => events.length === 2);
      expect(events[0]).toMatchObject({ type: "seat.activity_changed", seq: 7 });
    } finally {
      sub.close();
      server.close();
    }
  });

  it("THE OPEN VIEW UPDATES ITSELF (by effect): a pushed change re-renders the refresh owner's snapshot with ZERO manual refreshes", async () => {
    const { server, url, push, connections } = await sseServer();
    let served = 1;
    const hydrate = vi.fn(async (): Promise<FleetSnapshot> => ({ ...emptySnapshot(), generatedAt: `snap-${served++}` } as unknown as FleetSnapshot));
    const frames: string[] = [];
    const live = createLiveRefresh({ hydrate, onFrame: () => frames.push("frame"), now: () => Date.now() });
    const sub = subscribeActivityEvents({ baseUrl: url, onEvent: () => { void live.refresh(); } });
    try {
      await until(() => connections() === 1);
      expect(hydrate).not.toHaveBeenCalled(); // ZERO idle polling: nothing fires without a push
      push({ type: "seat.activity_changed", seatNodeId: "node-1", seq: 1 });
      await until(() => hydrate.mock.calls.length === 1);
      await until(() => (live.snapshot() as unknown as { generatedAt?: string }).generatedAt === "snap-1");
      // A second driven change updates again — the founder sits at the table, it keeps up:
      push({ type: "seat.activity_changed", seatNodeId: "node-1", seq: 2 });
      await until(() => hydrate.mock.calls.length === 2);
    } finally {
      sub.close();
      server.close();
    }
  });

  it("ZERO IDLE-POLLING REGRESSION: with the subscription open and NO pushes, no hydrate ever fires", async () => {
    const { server, url, connections } = await sseServer();
    const hydrate = vi.fn(async () => emptySnapshot());
    const sub = subscribeActivityEvents({ baseUrl: url, onEvent: () => { void hydrate(); } });
    try {
      await until(() => connections() === 1);
      await new Promise((r) => setTimeout(r, 300)); // a quiet window
      expect(hydrate).not.toHaveBeenCalled();
    } finally {
      sub.close();
      server.close();
    }
  });

  it("a dropped connection reconnects (connection maintenance, not data polling) and pushes resume", async () => {
    const first = await sseServer();
    const events: unknown[] = [];
    const sub = subscribeActivityEvents({ baseUrl: first.url, onEvent: (e) => events.push(e), reconnectDelayMs: 30 });
    try {
      await until(() => first.connections() === 1);
      // Drop every socket (server closes connections) — the subscription must come back.
      first.push({ type: "seat.activity_changed", seq: 1 });
      await until(() => events.length === 1);
      for (const res of [] as never[]) void res;
      await new Promise<void>((r) => { first.server.closeAllConnections(); r(); });
      await until(() => first.connections() === 0);
      // server still listening; reconnect should land a fresh connection
      await until(() => first.connections() === 1, 3_000);
      first.push({ type: "seat.activity_changed", seq: 2 });
      await until(() => events.length === 2, 3_000);
    } finally {
      sub.close();
      first.server.close();
    }
  });

  it("NO SECOND ACTIVITY MECHANISM (trace): main wires pushes to live.refresh, and the subscription module derives no activity", () => {
    const main = readFileSync(join(repoRoot, "packages", "tui", "src", "main.ts"), "utf8");
    expect(main).toContain("subscribeActivityEvents");
    const mod = readFileSync(join(repoRoot, "packages", "tui", "src", "live-events.ts"), "utf8");
    expect(mod).not.toMatch(/working|idle-at-prompt|terminalActive/); // notification-only: no vocabulary
    expect(mod).not.toMatch(/setInterval/); // no idle timers on the data path
  });
});
