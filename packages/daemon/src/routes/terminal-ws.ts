import type { Hono } from "hono";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { constantTimeEqual } from "../middleware/auth-bearer-token.js";
import { hostHeaderHostname } from "../middleware/origin-guard.js";
import {
  TerminalBrokerRegistry,
  type BrokerTmux,
  type TerminalSessionBroker,
  type TerminalSubscriber,
} from "../terminal/TerminalSessionBroker.js";

const MAX_EARLY_TERMINAL_FRAMES = 32;
const MAX_EARLY_TERMINAL_FRAME_BYTES = 256 * 1024;

/** The WebSocket route's guard: Origin check on upgrades, then the terminal bearer token when one is set. */
export function terminalAuthMiddleware(opts: { bearerToken: string | null }) {
  return async (c: { req: { header(name: string): string | undefined; query(name: string): string | undefined }; json(data: unknown, status: number): unknown }, next: () => Promise<void>) => {
    const upgrade = c.req.header("Upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      const origin = c.req.header("Origin");
      if (origin) {
        try {
          const originUrl = new URL(origin);
          const originHost = originUrl.hostname.toLowerCase();
          const requestHost = hostHeaderHostname(c.req.header("Host"));
          const isLoopbackIpv4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/.test(originHost);
          const isLocal =
            originHost === "localhost" ||
            originHost === "127.0.0.1" ||
            originHost === "::1" ||
            originHost === "[::1]" ||
            isLoopbackIpv4;

          const configuredAllowed = process.env.OPENRIG_ALLOWED_ORIGINS
            ? process.env.OPENRIG_ALLOWED_ORIGINS.split(",").map((s) => s.trim().toLowerCase())
            : [];

          const isExplicitlyAllowed = configuredAllowed.some((allowed) => {
            if (!allowed) return false;
            try {
              if (allowed.startsWith("http://") || allowed.startsWith("https://")) {
                const u = new URL(allowed);
                return u.origin.toLowerCase() === originUrl.origin.toLowerCase();
              }
              return allowed.toLowerCase() === originHost;
            } catch {
              return false;
            }
          });

          // In unauthenticated loopback mode (!opts.bearerToken), same-host matching
          // requires loopback or explicitly allowed origin to prevent DNS rebinding attacks.
          const isSameHost = Boolean(
            requestHost &&
            originHost === requestHost &&
            (opts.bearerToken !== null || isLocal || isExplicitlyAllowed),
          );

          const allowed = isLocal || isExplicitlyAllowed || isSameHost;
          if (!allowed) return c.json({ error: "origin_rejected", hint: `Origin ${origin} does not match host` }, 403);
        } catch {
          return c.json({ error: "origin_rejected", hint: "Malformed Origin header" }, 403);
        }
      }
    }
    const token = opts.bearerToken;
    if (!token) { await next(); return; }
    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    if (header) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match && constantTimeEqual(match[1]!.trim(), token)) { await next(); return; }
    }
    const queryToken = c.req.query("token");
    if (queryToken && constantTimeEqual(queryToken.trim(), token)) { await next(); return; }
    return c.json({ error: "unauthorized", hint: "Pass terminal token via Authorization header or ?token= query" }, 401);
  };
}

/** With the web UI off the WebSocket is not registered, but this same guard still runs in front of the HTTP
 *  terminal routes it matched before (GET /api/terminal/views, /preview, /status), so their behaviour is unchanged. */
export function registerTerminalAuthOnly(app: Hono, opts: { bearerToken: string | null }): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get("/api/terminal/:sessionName", terminalAuthMiddleware(opts));
}

export function registerTerminalWs(
  app: Hono,
  upgradeWebSocket: Parameters<typeof import("@hono/node-ws").createNodeWebSocket>[0] extends { app: infer _A } ? never : never,
  opts: { bearerToken: string | null },
): void;
export function registerTerminalWs(
  app: Hono,
  upgradeWebSocket: (createHandler: (c: unknown) => unknown) => unknown,
  opts: { bearerToken: string | null; livenessIntervalMs?: number },
): void {
  const terminalAuth = terminalAuthMiddleware(opts);

  // One daemon-owned broker registry shared across every WebSocket connection,
  // created lazily from the first connection's tmux adapter (a daemon
  // singleton). This is what makes many viewers of one seat share ONE pipe and
  // a fanned-out stream instead of fighting over per-connection pipes.
  let registry: TerminalBrokerRegistry | null = null;
  const getRegistry = (tmux: BrokerTmux): TerminalBrokerRegistry => {
    if (!registry) {
      registry = new TerminalBrokerRegistry(tmux, { livenessMs: opts.livenessIntervalMs });
    }
    return registry;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/api/terminal/:sessionName",
    terminalAuth,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upgradeWebSocket as any)((c: any) => {
      const sessionName = decodeURIComponent(c.req.param("sessionName")!);
      let broker: TerminalSessionBroker | null = null;
      let subscriber: TerminalSubscriber | null = null;
      // The WebSocket can close DURING the async attach (before the broker
      // reference resolves). Without this flag, onClose would find broker===null
      // and skip detach, leaving a phantom subscriber + a leaked pipe once attach
      // finally resolves. The flag lets onOpen re-detach after the fact.
      let closed = false;
      // A client is allowed to send the moment its ws.onopen fires (the CHAT
      // initialText frame does exactly that — OPR.0.4.4.20 delta-C), which can
      // land here while onOpen is still awaiting attach. Buffer those frames and
      // drain them once the broker resolves; dropping them loses the one
      // pre-populated CHAT frame every time attach is slower than the client.
      const earlyFrames: string[] = [];
      let earlyFrameBytes = 0;

      const handleFrame = async (data: string): Promise<void> => {
        if (!broker) return;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          if (msg.type === "keys" && Array.isArray(msg.keys)) {
            await broker.input({ type: "keys", keys: msg.keys as string[] });
          } else if (msg.type === "text" && typeof msg.text === "string") {
            await broker.input({ type: "text", text: msg.text });
          } else if (msg.type === "scroll" && typeof msg.offset === "number") {
            // OPR.0.4.0.39: per-subscriber scroll-back (tmux capture-pane window).
            // offset = lines above the live bottom; 0 = live. Per-connection so each
            // viewer scrolls independently (read-only on the shared pane).
            if (subscriber) await broker.scroll(subscriber, msg.offset);
          }
          // FR-7: there is intentionally NO resize branch. The broker owns the
          // fixed canonical geometry; a client-driven resize is ignored so
          // multiple viewers cannot shrink the shared pane.
        } catch { /* ignore malformed frames */ }
      };

      return {
        async onOpen(_evt: unknown, ws: { send(data: string): void; close(code: number, reason: string): void }) {
          const tmux = c.get("tmuxAdapter") as TmuxAdapter | undefined;
          if (!tmux) { ws.close(1011, "tmux adapter unavailable"); return; }
          // Adapt the WebSocket to a broker subscriber. The broker owns the pipe,
          // the seed, the fanout, honest session-death close, and cleanup.
          const sub: TerminalSubscriber = {
            send: (data: string) => { try { ws.send(data); } catch { /* closed socket */ } },
            close: (code: number, reason: string) => { try { ws.close(code, reason); } catch { /* already closed */ } },
          };
          subscriber = sub;
          const b = await getRegistry(tmux as unknown as BrokerTmux).attach(sessionName, sub);
          broker = b;
          // If the socket closed while attach was in flight, detach now so the
          // broker does not retain a dead subscriber (detach is idempotent).
          if (closed) { b.detach(sub); return; }
          // Drain any frames that arrived while attach was in flight, in order.
          while (earlyFrames.length > 0 && !closed) {
            const next = earlyFrames.shift()!;
            earlyFrameBytes -= Buffer.byteLength(next, "utf8");
            await handleFrame(next);
          }
        },

        async onMessage(evt: { data: unknown }, ws: { close(code: number, reason: string): void }) {
          if (closed) return;
          const data = typeof evt.data === "string" ? evt.data : "";
          if (!data) return;
          if (!broker) {
            const bytes = Buffer.byteLength(data, "utf8");
            if (
              earlyFrames.length >= MAX_EARLY_TERMINAL_FRAMES
              || earlyFrameBytes + bytes > MAX_EARLY_TERMINAL_FRAME_BYTES
            ) {
              closed = true;
              try { ws.close(1009, "terminal input before ready exceeded buffer limit"); } catch { /* already closed */ }
              return;
            }
            earlyFrames.push(data);
            earlyFrameBytes += bytes;
            return;
          }
          await handleFrame(data);
        },

        async onClose() {
          closed = true;
          if (broker && subscriber) {
            broker.detach(subscriber);
          }
        },
      };
    }),
  );
}
