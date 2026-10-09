// Socket Mode liveness. On Build (10-09) a connection reported "connected" for an hour while Slack
// delivered nothing to it, and two button presses were lost. These tests drive the real socket
// loop with a fake socket, a fake ping channel and fake timers: a stale or silent connection is
// replaced, a healthy quiet one is not, Slack's refresh opens the replacement before the old
// connection goes, link_disabled stops the loop, and hello's connection count is kept.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startSocketInbound, type WsLike, type PingChannel, type SocketInboundHandle } from "../src/domain/gateway/slack/socket-inbound.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, InboundReceiptStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    appendFileSync: (p, d) => { files.set(p, (files.get(p) ?? "") + d); },
    writeFileSync: (p, d) => files.set(p, d),
    rename: (from, to) => { files.set(to, files.get(from) ?? ""); files.delete(from); },
    mkdirp: () => {},
  };
}

interface FakeWs { ws: WsLike; sent: string[]; closed: boolean }
const openFetch: FetchImpl = async () =>
  new Response(JSON.stringify({ ok: true, url: "wss://fake-slack/ws" }), { status: 200, headers: { "content-type": "application/json" } });
const message = (ws: FakeWs, data: unknown) => ws.ws.onmessage!({ data: JSON.stringify(data) });
const botEcho = (ts: string) => ({ envelope_id: `e-${ts}`, type: "events_api", payload: { event: { type: "message", bot_id: "B1", text: "ours", ts, channel: "C1" } } });

describe("Socket Mode liveness", () => {
  let sockets: FakeWs[];
  let pings: Set<(m: unknown) => void>;
  let receipts: InboundReceiptStore;
  let landed: number;
  let handle: SocketInboundHandle | undefined;
  /** apps.connections.open: held while a gate is set, failing while openFails is set. */
  let openGate: Promise<void> | null;
  let openFails: boolean;
  let openCalls: number;
  const pingChannel: PingChannel = { subscribe: (fn) => { pings.add(fn); }, unsubscribe: (fn) => { pings.delete(fn); } };
  const ping = () => { for (const fn of pings) fn({ payload: Buffer.from("") }); };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    pings = new Set();
    landed = 0;
    openGate = null;
    openFails = false;
    openCalls = 0;
    const fsx = memFs();
    receipts = new InboundReceiptStore("/s/inbound-receipts.jsonl", fsx);
    const router = new InboundRouter({
      queue: { createQitem: async () => { landed += 1; return "qitem-x"; } },
      seen: new SeenStore("/s/seen.jsonl", fsx),
      deadLetter: new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fsx),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
      log: () => {},
    });
    handle = startSocketInbound("xapp-EXAMPLE-fake", router, {
      fetchImpl: async (...args) => {
        openCalls += 1;
        if (openGate) await openGate;
        return openFails ? new Response(JSON.stringify({ ok: false, error: "temporary outage" }), { status: 200 }) : openFetch(...args);
      },
      wsFactory: () => {
        const fake: FakeWs = { sent: [], closed: false, ws: undefined as unknown as WsLike };
        fake.ws = { send: (d) => fake.sent.push(d), close: () => { fake.closed = true; }, onopen: null, onmessage: null, onclose: null, onerror: null };
        sockets.push(fake);
        return fake.ws;
      },
      pingChannel,
      receipts,
      log: () => {},
    });
  });
  afterEach(() => { handle?.stop(); vi.useRealTimers(); });

  /** Let the loop create socket n, then open it. */
  async function openSocket(n: number): Promise<FakeWs> {
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(n));
    sockets[n - 1]!.ws.onopen!();
    return sockets[n - 1]!;
  }
  const replacements = () => receipts.readAll().filter((r) => r.status === "replace-requested");

  it("replaces a connection whose server pings stop, opening the new one before closing the old", async () => {
    const first = await openSocket(1);
    for (let i = 0; i < 3; i++) { ping(); await vi.advanceTimersByTimeAsync(10_000); }
    await vi.advanceTimersByTimeAsync(40_000); // pings stopped
    expect(replacements()).toEqual([expect.objectContaining({ generation: 1, reason: "no-server-pings" })]);
    expect(first.closed, "the old connection stays until the new one opens").toBe(false);
    await openSocket(2);
    expect(first.closed).toBe(true);
    expect(handle!.status()).toMatchObject({ state: "connected", generation: 2, lastAutoReconnect: { reason: "no-server-pings" } });
  });

  it("leaves a quiet connection alone: no pings yet means the ping rule never armed", async () => {
    await openSocket(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(replacements()).toEqual([]);
  });

  it("keeps a connection whose pings continue, however quiet its events", async () => {
    await openSocket(1);
    for (let i = 0; i < 30; i++) { ping(); await vi.advanceTimersByTimeAsync(10_000); }
    expect(sockets).toHaveLength(1);
  });

  it("after one echo, two of our posts without an echo mean events are missing: status says so and the connection is replaced", async () => {
    const first = await openSocket(1);
    handle!.expectEcho("100.000001");
    message(first, botEcho("100.000001"));
    expect(handle!.status().delivery).toBe("delivering");
    handle!.expectEcho("100.000002");
    handle!.expectEcho("100.000003");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(handle!.status()).toMatchObject({ delivery: "events-missing", unechoedPosts: 2 });
    expect(handle!.status().eventsMissingSince).toBeDefined();
    expect(replacements()).toEqual([expect.objectContaining({ reason: "events-missing" })]);
    await openSocket(2);
    expect(handle!.status()).toMatchObject({ delivery: "unknown", generation: 2 });
  });

  it("does not arm the echo rule on a connection that has never seen one of our posts come back", async () => {
    await openSocket(1);
    for (const ts of ["200.000001", "200.000002", "200.000003"]) handle!.expectEcho(ts);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(handle!.status().delivery).toBe("unknown");
  });

  it("treats a single missing echo as a note, not a reconnect", async () => {
    const first = await openSocket(1);
    handle!.expectEcho("300.000001");
    message(first, botEcho("300.000001"));
    handle!.expectEcho("300.000002");
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(handle!.status()).toMatchObject({ delivery: "delivering", unechoedPosts: 1 });
  });

  it("on Slack's refresh_requested opens the replacement first, and the old connection handles envelopes until Slack closes it", async () => {
    const first = await openSocket(1);
    message(first, { envelope_id: "d-1", type: "disconnect", reason: "refresh_requested" });
    await openSocket(2);
    expect(first.closed, "a refreshing connection drains instead of being closed").toBe(false);
    message(first, { envelope_id: "e-late", type: "events_api", payload: { event: { type: "message", user: "U1", text: "late", ts: "400.000001", channel: "C1" } } });
    await vi.advanceTimersByTimeAsync(10);
    expect(first.sent.some((s) => s.includes('"envelope_id":"e-late"'))).toBe(true);
    expect(landed).toBe(1);
    first.ws.onclose!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets, "the old connection's close is the end of the refresh, not a reconnect").toHaveLength(2);
    expect(handle!.status()).toMatchObject({ state: "connected", generation: 2 });
  });

  it("reports disconnected when the retired connection closes before its replacement opens", async () => {
    const first = await openSocket(1);
    for (let i = 0; i < 2; i++) { ping(); await vi.advanceTimersByTimeAsync(10_000); }
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2)); // the replacement is opening, not open
    expect(handle!.status().state).toBe("connected"); // the old one is still up
    first.ws.onclose!();
    expect(handle!.status().state, "no socket is open, so status must not say connected").toBe("disconnected");
  });

  it("counts an echo that arrives before the post's ts is registered", async () => {
    const first = await openSocket(1);
    handle!.expectEcho("500.000001");
    message(first, botEcho("500.000001")); // armed
    message(first, botEcho("500.000002")); // this echo beats its registration
    handle!.expectEcho("500.000002");
    handle!.expectEcho("500.000003"); // only this one is really missing
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sockets).toHaveLength(1);
    expect(handle!.status()).toMatchObject({ delivery: "delivering", unechoedPosts: 1 });
  });

  it("an early echo forgives only the posts registered before it arrived", async () => {
    const first = await openSocket(1);
    message(first, botEcho("550.000001")); // the echo beats its registration
    await vi.advanceTimersByTimeAsync(1_000);
    handle!.expectEcho("550.000002"); // posted after that echo arrived, and never echoed
    handle!.expectEcho("550.000003");
    await vi.advanceTimersByTimeAsync(1_000);
    handle!.expectEcho("550.000001"); // the early echo's own registration, late
    await vi.advanceTimersByTimeAsync(70_000);
    expect(handle!.status().delivery).toBe("events-missing");
    expect(replacements()).toEqual([expect.objectContaining({ reason: "events-missing" })]);
  });

  it("still counts a post registered in the same millisecond as an echoed one as a miss", async () => {
    const first = await openSocket(1);
    handle!.expectEcho("560.000001");
    handle!.expectEcho("560.000002"); // the same millisecond (the clock is frozen), and never echoed
    handle!.expectEcho("560.000003");
    message(first, botEcho("560.000001"));
    await vi.advanceTimersByTimeAsync(70_000);
    expect(handle!.status().delivery).toBe("events-missing");
    expect(replacements()).toEqual([expect.objectContaining({ reason: "events-missing" })]);
  });

  it("still counts a post registered in the same millisecond as an early echo's arrival as a miss", async () => {
    const first = await openSocket(1);
    message(first, botEcho("570.000001")); // the echo beats its registration
    handle!.expectEcho("570.000002"); // the same millisecond, after it arrived, and never echoed
    handle!.expectEcho("570.000003");
    handle!.expectEcho("570.000001"); // the early echo's own registration
    await vi.advanceTimersByTimeAsync(70_000);
    expect(handle!.status().delivery).toBe("events-missing");
    expect(replacements()).toEqual([expect.objectContaining({ reason: "events-missing" })]);
  });

  it("does not credit an unnamed ping to either connection while a refresh overlaps them", async () => {
    const first = await openSocket(1);
    message(first, { envelope_id: "d-3", type: "disconnect", reason: "refresh_requested" });
    await openSocket(2);
    ping(); // could be the draining connection's
    expect(handle!.status().lastServerPingAt).toBeUndefined();
    first.ws.onclose!();
    ping(); // one connection open: unambiguous
    expect(handle!.status().lastServerPingAt).toBeDefined();
  });

  it("does not call our own draining connection another consumer after a refresh", async () => {
    const first = await openSocket(1);
    message(first, { envelope_id: "d-4", type: "disconnect", reason: "refresh_requested" });
    const second = await openSocket(2);
    message(second, { type: "hello", num_connections: 2 }); // ours: the new one and the draining one
    expect(handle!.status()).toMatchObject({ numConnections: 2, otherConnections: 0 });
    message(second, { type: "hello", num_connections: 3 });
    expect(handle!.status().otherConnections).toBe(1);
  });

  it("does not arm the new connection with an echo the draining one received", async () => {
    const first = await openSocket(1);
    message(first, { envelope_id: "d-5", type: "disconnect", reason: "refresh_requested" });
    await openSocket(2);
    message(first, botEcho("600.000001")); // arrives on the draining connection, before registration
    handle!.expectEcho("600.000001");
    handle!.expectEcho("600.000002");
    handle!.expectEcho("600.000003");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sockets, "the new connection never echoed, so its echo rule is not armed").toHaveLength(2);
    expect(handle!.status().delivery).toBe("unknown");
  });

  it("abandons a replacement whose open is in flight when Slack reports link_disabled", async () => {
    const first = await openSocket(1);
    let release!: () => void;
    openGate = new Promise<void>((r) => { release = r; });
    message(first, { envelope_id: "d-6", type: "disconnect", reason: "refresh_requested" });
    await vi.waitFor(() => expect(openCalls).toBe(2)); // the replacement's open is waiting
    message(first, { envelope_id: "d-7", type: "disconnect", reason: "link_disabled" });
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets, "no socket opens after Slack disabled Socket Mode").toHaveLength(1);
    expect(handle!.status().delivery).toBe("socket-mode-disabled");
  });

  it("stops retrying a failed replacement open once Slack reports link_disabled", async () => {
    const first = await openSocket(1);
    openFails = true;
    message(first, { envelope_id: "d-8", type: "disconnect", reason: "refresh_requested" });
    await vi.waitFor(() => expect(openCalls).toBeGreaterThanOrEqual(2)); // failed; a retry is scheduled
    message(first, { envelope_id: "d-9", type: "disconnect", reason: "link_disabled" });
    const calls = openCalls;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(openCalls, "no retry after the disable").toBe(calls);
  });

  it("only counts consecutive missing echoes: echo, miss, echo, miss does not replace", async () => {
    const first = await openSocket(1);
    handle!.expectEcho("700.000001");
    message(first, botEcho("700.000001"));
    handle!.expectEcho("700.000002"); // miss
    await vi.advanceTimersByTimeAsync(1_000);
    handle!.expectEcho("700.000003");
    message(first, botEcho("700.000003")); // a later post came back: the earlier miss is forgiven
    handle!.expectEcho("700.000004"); // miss
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sockets).toHaveLength(1);
    expect(handle!.status()).toMatchObject({ delivery: "delivering", unechoedPosts: 1 });
  });

  it("says when the five-minute limit holds an automatic reconnect back", async () => {
    await openSocket(1);
    for (let i = 0; i < 2; i++) { ping(); await vi.advanceTimersByTimeAsync(10_000); }
    await vi.advanceTimersByTimeAsync(40_000); // first replacement: pings stopped
    await openSocket(2);
    for (let i = 0; i < 2; i++) { ping(); await vi.advanceTimersByTimeAsync(10_000); }
    await vi.advanceTimersByTimeAsync(40_000); // stalls again inside five minutes
    expect(sockets).toHaveLength(2);
    expect(handle!.status().autoReconnectSuppressedUntil).toBeDefined();
    expect(handle!.status().delivery).toBe("no-server-pings");
  });

  it("clears the ping failure when pings resume on a connection the five-minute limit kept", async () => {
    await openSocket(1);
    for (let i = 0; i < 2; i++) { ping(); await vi.advanceTimersByTimeAsync(10_000); }
    await vi.advanceTimersByTimeAsync(40_000); // first replacement: pings stopped
    await openSocket(2);
    for (let i = 0; i < 2; i++) { ping(); await vi.advanceTimersByTimeAsync(10_000); }
    await vi.advanceTimersByTimeAsync(40_000); // stalls again inside five minutes: held back
    expect(handle!.status().delivery).toBe("no-server-pings");
    ping(); // pings resume
    expect(handle!.status().delivery).toBe("unknown");
    expect(handle!.status().autoReconnectSuppressedUntil).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
    expect(handle!.status().delivery).toBe("unknown");
  });

  it("stops reconnecting when Slack reports link_disabled, and says why", async () => {
    const first = await openSocket(1);
    message(first, { envelope_id: "d-2", type: "disconnect", reason: "link_disabled" });
    first.ws.onclose!();
    await handle!.done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(handle!.status().delivery).toBe("socket-mode-disabled");
  });

  it("keeps saying Socket Mode is disabled while the open socket still echoes and then its pings stop", async () => {
    const first = await openSocket(1);
    for (let i = 0; i < 2; i++) { ping(); await vi.advanceTimersByTimeAsync(10_000); } // ping rule armed
    message(first, { envelope_id: "d-10", type: "disconnect", reason: "link_disabled" });
    handle!.expectEcho("950.000001");
    message(first, botEcho("950.000001")); // an echo after the disable
    expect(handle!.status().delivery).toBe("socket-mode-disabled");
    await vi.advanceTimersByTimeAsync(60_000); // and then the pings stop
    expect(handle!.status().delivery).toBe("socket-mode-disabled");
    expect(replacements()).toEqual([]);
  });

  it("keeps hello's count of open connections and records it on the receipt", async () => {
    const first = await openSocket(1);
    message(first, { type: "hello", num_connections: 2 });
    await vi.advanceTimersByTimeAsync(10);
    expect(handle!.status().numConnections).toBe(2);
    expect(receipts.readAll()).toEqual(expect.arrayContaining([expect.objectContaining({ status: "received", connections: 2 })]));
  });
});
