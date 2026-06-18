import type { Hono } from "hono";
import type { TmuxAdapter } from "../adapters/tmux.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const PIPE_PANE_POLL_MS = 50;
const MAX_OUTPUT_BUFFER = 64 * 1024;

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
  opts: { bearerToken: string | null },
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/api/terminal/:sessionName",
    terminalAuthMiddleware,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upgradeWebSocket as any)((c: any) => {
      const sessionName = decodeURIComponent(c.req.param("sessionName")!);
      let pipeActive = false;
      let outputPath: string | null = null;
      let tailInterval: ReturnType<typeof setInterval> | null = null;
      let lastSize = 0;

      return {
        async onOpen(_evt: unknown, ws: { send(data: string): void; close(code: number, reason: string): void }) {
          const tmux = c.get("tmuxAdapter") as TmuxAdapter | undefined;
          if (!tmux) { ws.close(1011, "tmux adapter unavailable"); return; }
          const hasSession = await tmux.hasSession(sessionName);
          if (!hasSession) { ws.close(1008, `session not found: ${sessionName}`); return; }

          await tmux.setWindowOption(sessionName, "aggressive-resize", "on").catch(() => {});

          outputPath = path.join(os.tmpdir(), `openrig-term-${sessionName.replace(/[^a-zA-Z0-9@-]/g, "_")}-${Date.now()}.log`);
          fs.writeFileSync(outputPath, "", "utf-8");
          const pipeResult = await tmux.startPipePane(sessionName, outputPath);
          if (!pipeResult.ok) { ws.close(1011, `pipe-pane failed: ${pipeResult.message}`); return; }
          pipeActive = true;

          await tmux.sendKeys(sessionName, ["", ""]);

          tailInterval = setInterval(() => {
            if (!outputPath) return;
            try {
              const stat = fs.statSync(outputPath);
              if (stat.size > lastSize) {
                const fd = fs.openSync(outputPath, "r");
                const buf = Buffer.alloc(Math.min(stat.size - lastSize, MAX_OUTPUT_BUFFER));
                fs.readSync(fd, buf, 0, buf.length, lastSize);
                fs.closeSync(fd);
                lastSize = stat.size;
                try { ws.send(buf.toString("utf-8")); } catch {}
              }
            } catch {}
          }, PIPE_PANE_POLL_MS);
        },

        async onMessage(evt: { data: unknown }, _ws: unknown) {
          const tmux = c.get("tmuxAdapter") as TmuxAdapter | undefined;
          if (!tmux) return;
          const data = typeof evt.data === "string" ? evt.data : "";
          if (!data) return;
          try {
            const msg = JSON.parse(data) as Record<string, unknown>;
            if (msg.type === "keys" && Array.isArray(msg.keys)) {
              await tmux.sendKeys(sessionName, msg.keys as string[]);
            } else if (msg.type === "text" && typeof msg.text === "string") {
              await tmux.sendText(sessionName, msg.text);
            } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
              await tmux.resizeWindow(sessionName, msg.cols as number, msg.rows as number);
            }
          } catch {}
        },

        async onClose() {
          if (tailInterval) { clearInterval(tailInterval); tailInterval = null; }
          const tmux = c.get("tmuxAdapter") as TmuxAdapter | undefined;
          if (tmux && pipeActive) {
            await tmux.stopPipePane(sessionName).catch(() => {});
            pipeActive = false;
          }
          if (outputPath) {
            try { fs.unlinkSync(outputPath); } catch {}
            outputPath = null;
          }
        },
      };
    }),
  );
}
