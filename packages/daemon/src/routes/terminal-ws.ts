import type { Hono } from "hono";
import type { TmuxAdapter } from "../adapters/tmux.js";
import * as crypto from "node:crypto";
import {
  TerminalBrokerRegistry,
  type BrokerTmux,
  type TerminalSessionBroker,
  type TerminalSubscriber,
} from "../terminal/TerminalSessionBroker.js";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
  const terminalAuthMiddleware = async (c: { req: { header(name: string): string | undefined; query(name: string): string | undefined }; json(data: unknown, status: number): unknown }, next: () => Promise<void>) => {
    const upgrade = c.req.header("Upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      const origin = c.req.header("Origin");
      if (origin) {
        try {
          const originHost = new URL(origin).hostname;
          const requestHost = c.req.header("Host")?.split(":")[0] ?? "";
          const allowed = originHost === requestHost || originHost === "localhost" || originHost === "127.0.0.1";
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
    terminalAuthMiddleware,
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
          if (closed) b.detach(sub);
        },

        async onMessage(evt: { data: unknown }, _ws: unknown) {
          if (!broker || closed) return;
          const data = typeof evt.data === "string" ? evt.data : "";
          if (!data) return;
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
