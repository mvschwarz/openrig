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
  log?: (msg: string) => void;
}

export interface SocketInboundHandle {
  /** Resolves when the loop ends (maxConnects reached or stop() called). */
  done: Promise<void>;
  stop(): void;
}

/** Start the Socket Mode loop (the shipped runner's exact shape, service-ified with a stop()). */
export function startSocketInbound(appToken: string, router: InboundRouter, deps: SocketInboundDeps = {}): SocketInboundHandle {
  const log = deps.log ?? (() => {});
  const wsFactory = deps.wsFactory ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(url));
  const retryIntervalMs = deps.retryIntervalMs ?? 5 * 60 * 1000;
  let connects = 0;
  let backoff = 1000;
  let stopped = false;
  let liveWs: WsLike | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const done = new Promise<void>((resolve) => {
    const connect = async (): Promise<void> => {
      if (stopped) return resolve();
      connects++;
      const open = await openSocketConnection(appToken, deps.fetchImpl);
      if (stopped) return resolve();
      if (!open.ok || !open.url) {
        log(`connect failed: ${open.error}`);
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
        return;
      }
      const ws = wsFactory(open.url);
      liveWs = ws;
      let retryTimer: ReturnType<typeof setInterval> | undefined;
      ws.onopen = () => {
        backoff = 1000;
        log("socket connected");
        void router.retryDeadLetters(); // drain on connect (cold-init)…
        // …AND periodically WHILE connected (B1: recovery after a queue outage
        // must not wait for the next Slack reconnect). Cleared on close.
        retryTimer = setInterval(() => void router.retryDeadLetters(), retryIntervalMs);
        if (typeof (retryTimer as unknown as { unref?: () => void }).unref === "function") {
          (retryTimer as unknown as { unref: () => void }).unref();
        }
      };
      ws.onmessage = (m) => {
        let env: SocketEnvelope;
        try {
          env = JSON.parse(String(m.data)) as SocketEnvelope;
        } catch {
          return;
        }
        void handleEnvelope(env, () => env.envelope_id && ws.send(JSON.stringify({ envelope_id: env.envelope_id })), router, log);
      };
      ws.onclose = () => {
        if (retryTimer) clearInterval(retryTimer);
        liveWs = undefined;
        if (stopped) return resolve();
        log(`socket closed; reconnect in ${backoff}ms`);
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
      };
      ws.onerror = () => {
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
      if (pendingTimer) clearTimeout(pendingTimer);
      try { liveWs?.close(); } catch { /* best-effort */ }
    },
  };
}
