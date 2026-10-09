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
//
// Liveness: an open socket is not proof that Slack delivers events to it. A connection on Build
// stayed "connected" for an hour while Slack delivered nothing, and two button presses were
// lost. Two signals catch that, each armed only once this connection has shown it: server pings
// (what Slack's own Node client watches; undici publishes each one on diagnostics_channel), and
// the echo of our own posts, which comes back as an event on a healthy connection. A failed
// signal replaces the connection: a new one opens first, then the old one goes.

import dc from "node:diagnostics_channel";
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

export interface PingChannel {
  subscribe(onMessage: (message: unknown) => void): void;
  unsubscribe(onMessage: (message: unknown) => void): void;
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
  /** Server WebSocket pings (default: undici's `undici:websocket:ping` diagnostics channel). */
  pingChannel?: PingChannel;
  /** Without a server ping for this long, once one has arrived, the connection is stale (default
   *  30s, the default of Slack's own Node client). */
  serverPingTimeoutMs?: number;
  /** A post of ours whose echo has not arrived after this long counts as missing (default 60s). */
  echoTimeoutMs?: number;
  /** Minimum gap between automatic replacements (default 5min). Slack's own refresh ignores it. */
  minAutoReplaceIntervalMs?: number;
  /** How often liveness is checked (default 5s). */
  livenessCheckMs?: number;
  receipts?: InboundReceiptStore;
  recovery?: { run(): Promise<void>; stop(): void };
  log?: (msg: string) => void;
}

export interface SocketInboundHandle {
  /** Resolves when the loop ends (maxConnects reached or stop() called). */
  done: Promise<void>;
  stop(): void;
  status(): SocketInboundStatus;
  /** A message we just posted (its Slack ts): a healthy connection receives it back as an event. */
  expectEcho(messageTs: string): void;
}

/** Delivery health, kept apart from the socket state so "connected" is never the only word. */
export type SocketDelivery = "unknown" | "delivering" | "no-server-pings" | "events-missing" | "socket-mode-disabled";

export interface SocketInboundStatus {
  generation: number;
  reconnects: number;
  state: "connecting" | "connected" | "disconnected" | "stopped";
  connectedAt?: string;
  disconnectedAt?: string;
  lastEventAt?: string;
  lastEventTs?: string;
  lastDisposition?: InboundReceiptStatus;
  delivery?: SocketDelivery;
  lastServerPingAt?: string;
  /** The oldest of our posts still waiting for its echo, once two have gone missing. */
  eventsMissingSince?: string;
  unechoedPosts?: number;
  lastAutoReconnect?: { at: string; reason: string };
  /** An automatic replacement the 5-minute limit is holding back, until this time. */
  autoReconnectSuppressedUntil?: string;
  /** Slack's `hello` count of this app's open connections, ours included. */
  numConnections?: number;
  /** Connections in `numConnections` that are not ours: above 0 means another consumer. */
  otherConnections?: number;
}

interface Conn {
  ws: WsLike;
  generation: number;
  opened: boolean;
  closed: boolean;
  /** Replaced: closing it must not schedule a reconnect. */
  retired: boolean;
  retiredFor?: string;
  lastPingAt: number;
  pingArmed: boolean;
  echoArmed: boolean;
}

const PING_CHANNEL = "undici:websocket:ping";
const defaultPingChannel = (): PingChannel => ({
  subscribe: (onMessage) => dc.subscribe(PING_CHANNEL, onMessage),
  unsubscribe: (onMessage) => { dc.unsubscribe(PING_CHANNEL, onMessage); },
});
/** How long a connection Slack asked to refresh may keep draining before we close it ourselves. */
const REFRESH_DRAIN_MS = 30_000;

/** Start the Socket Mode loop (the shipped runner's exact shape, service-ified with a stop()). */
export function startSocketInbound(appToken: string, router: InboundRouter, deps: SocketInboundDeps = {}): SocketInboundHandle {
  const log = deps.log ?? (() => {});
  const wsFactory = deps.wsFactory ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(url));
  const retryIntervalMs = deps.retryIntervalMs ?? 5 * 60 * 1000;
  const openTimeoutMs = deps.openTimeoutMs ?? 30_000;
  const serverPingTimeoutMs = deps.serverPingTimeoutMs ?? 30_000;
  const echoTimeoutMs = deps.echoTimeoutMs ?? 60_000;
  const minAutoReplaceIntervalMs = deps.minAutoReplaceIntervalMs ?? 5 * 60 * 1000;
  const pingChannel = deps.pingChannel ?? defaultPingChannel();
  let connects = 0;
  let backoff = 1000;
  let stopped = false;
  let disabledBySlack = false;
  let replacing = false;
  let lastAutoReplaceAt = 0;
  const conns = new Set<Conn>();
  let current: Conn | undefined;
  /** Our posts waiting for their echo: Slack ts → when we posted it (for its age) and its place
   *  in the order of registration (for which misses an echo forgives: several posts can register
   *  in the same millisecond). */
  const expected = new Map<string, { at: number; seq: number }>();
  let registrations = 0;
  /** Event ts seen in the last few minutes, with the connection that received it and how many
   *  posts had registered when it arrived: an echo can arrive before the post's ts is
   *  registered, and it counts only for that connection. */
  const recentEvents = new Map<string, { at: number; conn: Conn; seq: number }>();
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let finish: () => void = () => {};
  const status: SocketInboundStatus = { generation: 0, reconnects: 0, state: "disconnected", delivery: "unknown" };
  const stamp = () => new Date().toISOString();
  const unref = (t: unknown) => {
    if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
  };
  /** While a replacement is opening, the old connection may still be up: status follows it. */
  const oldStillOpen = (): boolean => replacing && !!current && !current.closed;
  /** A post of ours came back on `conn`. On the current connection it is delivering, and misses
   *  registered up to `throughSeq` end the failure episode, so only consecutive misses count. An
   *  echo the draining old connection received says nothing about the current one. Once Slack
   *  disables Socket Mode, status keeps saying so. */
  const echoed = (conn: Conn, throughSeq: number): void => {
    conn.echoArmed = true;
    if (conn !== current || disabledBySlack) return;
    for (const [ts, post] of expected) if (post.seq <= throughSeq) expected.delete(ts);
    status.delivery = "delivering";
    status.eventsMissingSince = undefined;
  };
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

  // A ping proves an open connection alive. undici 6 names no socket in the message, so an
  // unnamed ping credits a connection only when it is the one open; while two overlap, it could
  // be the draining one's. A later undici that names the socket credits only that one.
  const onPing = (message: unknown): void => {
    const target = (message as { websocket?: unknown } | null)?.websocket;
    const now = Date.now();
    const open = [...conns].filter((conn) => !conn.closed && conn.opened);
    for (const conn of open) {
      if (target !== undefined ? target !== conn.ws : open.length !== 1) continue;
      conn.lastPingAt = now;
      conn.pingArmed = true;
      if (conn !== current) continue;
      status.lastServerPingAt = new Date(now).toISOString();
      // Pings resumed on a connection whose replacement the five-minute limit held back: the ping
      // failure and the held-back reconnect are over. Delivery is unconfirmed until the next echo,
      // and events-missing, which a ping does not answer, stays.
      if (status.delivery === "no-server-pings") {
        status.delivery = "unknown";
        status.autoReconnectSuppressedUntil = undefined;
      }
    }
  };
  pingChannel.subscribe(onPing);

  let connectRef: (() => Promise<void>) | undefined;
  /** Open a replacement first, then let the old connection go: Slack may hand a payload to any
   *  open connection, so the old one keeps handling until it closes. */
  const replace = (reason: string, slackRequested = false): void => {
    if (stopped || disabledBySlack || replacing || !current) return;
    const now = Date.now();
    if (!slackRequested && lastAutoReplaceAt && now - lastAutoReplaceAt < minAutoReplaceIntervalMs) {
      const until = new Date(lastAutoReplaceAt + minAutoReplaceIntervalMs).toISOString();
      if (status.autoReconnectSuppressedUntil !== until) log(`automatic reconnect (${reason}) held back until ${until}: at most one per ${minAutoReplaceIntervalMs / 60_000} min`);
      status.autoReconnectSuppressedUntil = until;
      return;
    }
    if (!slackRequested) lastAutoReplaceAt = now;
    status.autoReconnectSuppressedUntil = undefined;
    replacing = true;
    current.retired = true;
    current.retiredFor = reason;
    expected.clear();
    status.lastAutoReconnect = { at: stamp(), reason };
    log(`replacing the socket (${reason}): opening a new connection before the old one goes`);
    receipt({ generation: current.generation, status: "replace-requested", reason });
    void connectRef?.();
  };

  const livenessTimer = setInterval(() => {
    const conn = current;
    if (stopped || disabledBySlack || !conn || conn.closed || !conn.opened || conn.retired) return;
    const now = Date.now();
    if (conn.pingArmed && now - conn.lastPingAt > serverPingTimeoutMs) {
      status.delivery = "no-server-pings";
      replace("no-server-pings");
      return;
    }
    for (const [ts, post] of expected) if (now - post.at > 10 * echoTimeoutMs) expected.delete(ts); // bound the map
    const overdue = [...expected.values()].map((post) => post.at).filter((at) => now - at > echoTimeoutMs).sort((a, b) => a - b);
    status.unechoedPosts = overdue.length;
    if (conn.echoArmed && overdue.length >= 2) {
      status.delivery = "events-missing";
      status.eventsMissingSince = new Date(overdue[0]!).toISOString();
      replace("events-missing");
    }
  }, deps.livenessCheckMs ?? 5_000);
  unref(livenessTimer);

  const closeConn = (conn: Conn): void => {
    conn.ws.onopen = conn.ws.onmessage = conn.ws.onclose = conn.ws.onerror = null;
    conn.closed = true;
    conns.delete(conn);
    try {
      conn.ws.close();
    } catch {
      /* ignore */
    }
  };

  const done = new Promise<void>((resolveDone) => {
    const resolve = (): void => {
      clearInterval(livenessTimer);
      pingChannel.unsubscribe(onPing);
      resolveDone();
    };
    finish = resolve;
    const connect = async (): Promise<void> => {
      if (stopped || disabledBySlack) return resolve();
      connects++;
      status.generation = connects;
      status.reconnects = Math.max(0, connects - 1);
      if (!oldStillOpen()) status.state = "connecting";
      receipt({ generation: connects, status: "connect-attempt" });
      const open = await openSocketConnection(appToken, deps.fetchImpl);
      // Slack may have disabled Socket Mode while the open was in flight.
      if (stopped || disabledBySlack) return resolve();
      if (!open.ok || !open.url) {
        log(`connect failed: ${open.error}`);
        if (!oldStillOpen()) {
          status.state = "disconnected";
          status.disconnectedAt = stamp();
        }
        receipt({ generation: connects, status: "connect-failed", reason: "connection-open-failed" });
        if (disabledBySlack || (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects)) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
        return;
      }
      const ws = wsFactory(open.url);
      const conn: Conn = { ws, generation: connects, opened: false, closed: false, retired: false, lastPingAt: 0, pingArmed: false, echoArmed: false };
      conns.add(conn);
      // Until the socket opens, onclose cannot be relied on to drive the reconnect: Node's
      // WebSocket (undici 6) fires onerror but never onclose when the handshake fails
      // (refused, reset, or its own 300s headers timeout), and an upgrade that is never
      // answered fires nothing at all. Either way the loop would stay "connecting" forever.
      // So a failure or timeout before onopen detaches the socket and schedules the retry here.
      const abandon = (reason: "socket-open-error" | "socket-open-timeout"): void => {
        clearTimeout(openTimer);
        openTimer = undefined;
        if (stopped) return;
        closeConn(conn);
        log(`socket did not open (${reason}); reconnect in ${backoff}ms`);
        if (!oldStillOpen()) {
          status.state = "disconnected";
          status.disconnectedAt = stamp();
        }
        receipt({ generation: conn.generation, status: "connect-failed", reason });
        if (disabledBySlack || (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects)) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
      };
      openTimer = setTimeout(() => abandon("socket-open-timeout"), openTimeoutMs);
      ws.onopen = () => {
        conn.opened = true;
        clearTimeout(openTimer);
        openTimer = undefined;
        if (stopped) return;
        if (disabledBySlack) return closeConn(conn); // opened after Slack disabled Socket Mode
        backoff = 1000;
        log("socket connected");
        const previous = current;
        current = conn;
        replacing = false;
        status.state = "connected";
        status.connectedAt = stamp();
        status.delivery = "unknown";
        status.eventsMissingSince = undefined;
        status.unechoedPosts = 0;
        receipt({ generation: conn.generation, status: "connected" });
        // A connection replaced for a failed signal is presumed broken: close it now. One Slack
        // asked to refresh stays open so it drains what it is handed, until Slack closes it.
        if (previous && previous !== conn && previous.retired && !previous.closed) {
          if (previous.retiredFor === "refresh_requested" || previous.retiredFor === "warning") {
            const drain = setTimeout(() => { if (!previous.closed) closeConn(previous); }, REFRESH_DRAIN_MS);
            unref(drain);
          } else closeConn(previous);
        }
        retryDeadLetters(); // drain on connect (cold-init)…
        // …AND periodically WHILE connected (B1: recovery after a queue outage
        // must not wait for the next Slack reconnect). Cleared on close.
        if (retryTimer) clearInterval(retryTimer);
        retryTimer = setInterval(retryDeadLetters, retryIntervalMs);
        unref(retryTimer);
      };
      ws.onmessage = (m) => {
        if (conn.closed) return;
        let env: SocketEnvelope;
        try {
          env = JSON.parse(String(m.data)) as SocketEnvelope;
        } catch {
          return;
        }
        const ev = env.payload?.event;
        status.lastEventAt = stamp();
        status.lastEventTs = ev?.ts;
        const helloCount = env.type === "hello" ? (env as { num_connections?: unknown }).num_connections : undefined;
        if (typeof helloCount === "number") {
          // During a refresh our own draining connection is still open, and Slack counts it.
          const ours = [...conns].filter((c) => c.opened && !c.closed).length;
          status.numConnections = helloCount;
          status.otherConnections = Math.max(0, helloCount - ours);
          if (status.otherConnections > 0) {
            log(`Slack reports ${helloCount} open connections for this app, ${ours} of them ours; another consumer may be taking events`);
          }
        }
        if (env.type === "disconnect") {
          if (env.reason === "link_disabled") {
            disabledBySlack = true;
            status.delivery = "socket-mode-disabled";
            log("Slack disabled Socket Mode for this app (link_disabled); not reconnecting");
            // Abandon a retry or a replacement already in flight: the timers and sockets this loop owns.
            if (pendingTimer) clearTimeout(pendingTimer);
            if (openTimer) clearTimeout(openTimer);
            for (const other of [...conns]) if (!other.opened) closeConn(other);
          } else if (conn === current && (env.reason === "warning" || env.reason === "refresh_requested")) {
            replace(env.reason, true);
          }
        }
        if (ev?.ts) {
          const now = Date.now();
          recentEvents.set(ev.ts, { at: now, conn, seq: registrations });
          for (const [ts, seen] of recentEvents) if (now - seen.at > 5 * 60_000) recentEvents.delete(ts);
          const post = expected.get(ev.ts);
          if (post !== undefined) {
            expected.delete(ev.ts);
            echoed(conn, post.seq);
          }
        }
        void handleEnvelope(
          env,
          () => env.envelope_id && ws.send(JSON.stringify({ envelope_id: env.envelope_id })),
          router,
          log,
          () => receipt({
            generation: conn.generation,
            status: "received",
            envelopeId: env.envelope_id,
            eventTs: ev?.ts,
            channel: ev?.channel,
            ...(typeof helloCount === "number" ? { connections: helloCount } : {}),
          }),
        )
          .then((disposition) => {
            status.lastDisposition = disposition.status;
            receipt({
              generation: conn.generation,
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
              generation: conn.generation,
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
        conn.closed = true;
        conns.delete(conn);
        receipt({ generation: conn.generation, status: "disconnected" });
        // A retired connection's close is the expected end of a replacement: nothing to reconnect.
        // If its replacement has not opened yet, no socket is up, and status must say so.
        if (conn.retired && conn === current) {
          if (retryTimer) clearInterval(retryTimer);
          status.state = "disconnected";
          status.disconnectedAt = stamp();
        }
        if (conn.retired || conn !== current) return;
        clearTimeout(openTimer);
        openTimer = undefined;
        if (retryTimer) clearInterval(retryTimer);
        status.state = stopped ? "stopped" : "disconnected";
        status.disconnectedAt = stamp();
        if (stopped) return resolve();
        if (disabledBySlack) return resolve();
        log(`socket closed; reconnect in ${backoff}ms`);
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
      };
      ws.onerror = () => {
        if (!conn.opened) return abandon("socket-open-error");
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };
    connectRef = connect;
    void connect();
  });

  return {
    done,
    stop: () => {
      stopped = true;
      deps.recovery?.stop();
      if (retryTimer) clearInterval(retryTimer);
      clearInterval(livenessTimer);
      pingChannel.unsubscribe(onPing);
      status.state = "stopped";
      if (pendingTimer) clearTimeout(pendingTimer);
      if (openTimer) clearTimeout(openTimer);
      for (const conn of [...conns]) {
        try { conn.ws.close(); } catch { /* best-effort */ }
      }
      finish(); // A canceled backoff has no future connect/close callback to settle done.
    },
    status: () => ({ ...status }),
    expectEcho: (messageTs: string) => {
      if (stopped || !/^\d+\.\d+$/.test(messageTs)) return;
      const early = recentEvents.get(messageTs);
      // The echo beat the registration: it counts for the connection that received it, and
      // forgives only posts registered before it arrived, not ones registered since.
      if (early) return echoed(early.conn, early.seq);
      expected.set(messageTs, { at: Date.now(), seq: ++registrations });
    },
  };
}
