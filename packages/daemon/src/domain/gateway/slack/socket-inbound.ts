// S10 — the Socket Mode INBOUND service, in-daemon. The loop is the shipped relay runner's
// (moved verbatim from the CLI `rig slack inbound` action, which retires with the cutover):
// open the ws via apps.connections.open, FAST-ACK every envelope, route human messages through
// the InboundRouter, drain the dead-letter on connect + periodically (B1), reconnect with
// backoff. Amendment A1 (M1 §3): inbound rides the PLATFORM socket — this service — never a
// gateway↔connector wire.
//
// Cold-init receipts (dual-path class "inbound cold-init"): on every (re)connect the router's
// dead-letter set drains before new traffic matters, and a fresh boot picks up where the
// durable seen/dead-letter stores left off — no replay storm, no drop.

import { openSocketConnection, type FetchImpl } from "./slack-api.js";
import { handleEnvelope, type InboundRouter, type SocketEnvelope } from "./inbound.js";
import type { InboundReceiptStore, InboundReceiptStatus } from "./state-store.js";

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, ev?: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null;
  onclose: ((this: unknown, ev?: unknown) => void) | null;
  onerror: ((this: unknown, ev?: unknown) => void) | null;
}

export interface SocketInboundDeps {
  fetchImpl?: FetchImpl;
  /** Open a Socket Mode WebSocket (default: global WebSocket). Injectable for tests. */
  wsFactory?: (url: string) => WsLike;
  /** Test seam: run N reconnect cycles then stop (default: forever, until stop()). */
  inboundMaxConnects?: number;
  /** Dead-letter retry cadence WHILE the socket stays connected (default 5min). */
  retryIntervalMs?: number;
  /** How long a new socket may stay opening before it is abandoned and retried (default 30s). */
  openTimeoutMs?: number;
  receipts?: InboundReceiptStore;
  recovery?: { run(): Promise<void>; stop(): void };
  log?: (msg: string) => void;
}

export interface SocketInboundHandle {
  /** Resolves when the loop ends (maxConnects reached or stop() called). */
  done: Promise<void>;
  stop(): void;
  status(): SocketInboundStatus;
}

export interface SocketInboundStatus {
  generation: number;
  reconnects: number;
  state: "connecting" | "connected" | "disconnected" | "stopped";
  connectedAt?: string;
  disconnectedAt?: string;
  lastEventAt?: string;
  lastEventTs?: string;
  lastDisposition?: InboundReceiptStatus;
}

/** Start the Socket Mode loop (the shipped runner's exact shape, service-ified with a stop()). */
export function startSocketInbound(appToken: string, router: InboundRouter, deps: SocketInboundDeps = {}): SocketInboundHandle {
  const log = deps.log ?? (() => {});
  const wsFactory = deps.wsFactory ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(url));
  const retryIntervalMs = deps.retryIntervalMs ?? 5 * 60 * 1000;
  const openTimeoutMs = deps.openTimeoutMs ?? 30_000;
  let connects = 0;
  let backoff = 1000;
  let stopped = false;
  let liveWs: WsLike | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let finish: () => void = () => {};
  const status: SocketInboundStatus = { generation: 0, reconnects: 0, state: "disconnected" };
  const stamp = () => new Date().toISOString();
  const receipt = (entry: Parameters<InboundReceiptStore["append"]>[0]): void => {
    try {
      deps.receipts?.append(entry);
    } catch (error) {
      // Observability must never become the reason an already-ACKed human message is lost.
      log(`inbound receipt write failed (${entry.status}): ${(error as Error).message}`);
    }
  };

  const retryDeadLetters = (): void => {
    if (stopped) return;
    void deps.recovery?.run().catch(() => log("channel recovery failed; checkpoint retained"));
    void router.retryDeadLetters().catch((error) => {
      log(`dead-letter retry failed: ${(error as Error).message}`);
    });
  };

  const done = new Promise<void>((resolve) => {
    finish = resolve;
    const connect = async (): Promise<void> => {
      if (stopped) return resolve();
      connects++;
      status.generation = connects;
      status.reconnects = Math.max(0, connects - 1);
      status.state = "connecting";
      receipt({ generation: connects, status: "connect-attempt" });
      const open = await openSocketConnection(appToken, deps.fetchImpl);
      if (stopped) return resolve();
      if (!open.ok || !open.url) {
        log(`connect failed: ${open.error}`);
        status.state = "disconnected";
        status.disconnectedAt = stamp();
        receipt({ generation: connects, status: "connect-failed", reason: "connection-open-failed" });
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
        return;
      }
      const ws = wsFactory(open.url);
      liveWs = ws;
      // Until the socket opens, onclose cannot be relied on to drive the reconnect: Node's
      // WebSocket (undici 6) fires onerror but never onclose when the handshake fails
      // (refused, reset, or its own 300s headers timeout), and an upgrade that is never
      // answered fires nothing at all. Either way the loop would stay "connecting" forever.
      // So a failure or timeout before onopen detaches the socket and schedules the retry here.
      let opened = false;
      const abandon = (reason: "socket-open-error" | "socket-open-timeout"): void => {
        clearTimeout(openTimer);
        openTimer = undefined;
        if (stopped) return;
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        liveWs = undefined;
        log(`socket did not open (${reason}); reconnect in ${backoff}ms`);
        status.state = "disconnected";
        status.disconnectedAt = stamp();
        receipt({ generation: connects, status: "connect-failed", reason });
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
      };
      openTimer = setTimeout(() => abandon("socket-open-timeout"), openTimeoutMs);
      ws.onopen = () => {
        opened = true;
        clearTimeout(openTimer);
        openTimer = undefined;
        if (stopped) return;
        backoff = 1000;
        log("socket connected");
        status.state = "connected";
        status.connectedAt = stamp();
        receipt({ generation: connects, status: "connected" });
        retryDeadLetters(); // drain on connect (cold-init)…
        // …AND periodically WHILE connected (B1: recovery after a queue outage
        // must not wait for the next Slack reconnect). Cleared on close.
        retryTimer = setInterval(retryDeadLetters, retryIntervalMs);
        if (typeof (retryTimer as unknown as { unref?: () => void }).unref === "function") {
          (retryTimer as unknown as { unref: () => void }).unref();
        }
      };
      ws.onmessage = (m) => {
        if (stopped) return;
        let env: SocketEnvelope;
        try {
          env = JSON.parse(String(m.data)) as SocketEnvelope;
        } catch {
          return;
        }
        const ev = env.payload?.event;
        status.lastEventAt = stamp();
        status.lastEventTs = ev?.ts;
        void handleEnvelope(
          env,
          () => env.envelope_id && ws.send(JSON.stringify({ envelope_id: env.envelope_id })),
          router,
          log,
          () => receipt({
            generation: connects,
            status: "received",
            envelopeId: env.envelope_id,
            eventTs: ev?.ts,
            channel: ev?.channel,
          }),
        )
          .then((disposition) => {
            status.lastDisposition = disposition.status;
            receipt({
              generation: connects,
              status: disposition.status,
              envelopeId: env.envelope_id,
              eventTs: ev?.ts,
              channel: ev?.channel,
              reason: disposition.reason,
            });
          })
          .catch((error) => {
            status.lastDisposition = "handler-failed";
            receipt({
              generation: connects,
              status: "handler-failed",
              envelopeId: env.envelope_id,
              eventTs: ev?.ts,
              channel: ev?.channel,
              reason: "handler-threw",
            });
            log(`inbound handler failed ts=${ev?.ts ?? "-"}: ${(error as Error).message}`);
          });
      };
      ws.onclose = () => {
        clearTimeout(openTimer);
        openTimer = undefined;
        if (retryTimer) clearInterval(retryTimer);
        liveWs = undefined;
        status.state = stopped ? "stopped" : "disconnected";
        status.disconnectedAt = stamp();
        receipt({ generation: connects, status: "disconnected" });
        if (stopped) return resolve();
        log(`socket closed; reconnect in ${backoff}ms`);
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
      };
      ws.onerror = () => {
        if (!opened) return abandon("socket-open-error");
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };
    void connect();
  });

  return {
    done,
    stop: () => {
      stopped = true;
      deps.recovery?.stop();
      if (retryTimer) clearInterval(retryTimer);
      status.state = "stopped";
      if (pendingTimer) clearTimeout(pendingTimer);
      if (openTimer) clearTimeout(openTimer);
      try { liveWs?.close(); } catch { /* best-effort */ }
      finish(); // A canceled backoff has no future connect/close callback to settle done.
    },
    status: () => ({ ...status }),
  };
}
