import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PIPE_PANE_POLL_MS = 50;
const MAX_OUTPUT_BUFFER = 64 * 1024;

export function terminalWsRoutes(opts: { bearerToken: string | null }) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  if (opts.bearerToken) {
    app.use("*", authBearerTokenMiddleware({ expectedToken: opts.bearerToken }));
  }

  app.get(
    "/:sessionName",
    upgradeWebSocket((c) => {
      const sessionName = decodeURIComponent(c.req.param("sessionName")!);
      let pipeActive = false;
      let outputPath: string | null = null;
      let tailInterval: ReturnType<typeof setInterval> | null = null;
      let lastSize = 0;

      return {
        async onOpen(_evt, ws) {
          const tmux = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
          if (!tmux) {
            ws.close(1011, "tmux adapter unavailable");
            return;
          }

          const hasSession = await tmux.hasSession(sessionName);
          if (!hasSession) {
            ws.close(1008, `session not found: ${sessionName}`);
            return;
          }

          outputPath = path.join(os.tmpdir(), `openrig-term-${sessionName.replace(/[^a-zA-Z0-9@-]/g, "_")}-${Date.now()}.log`);
          fs.writeFileSync(outputPath, "", "utf-8");

          const pipeResult = await tmux.startPipePane(sessionName, outputPath);
          if (!pipeResult.ok) {
            ws.close(1011, `pipe-pane failed: ${pipeResult.message}`);
            return;
          }
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

        async onMessage(evt, ws) {
          const tmux = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
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
              const cols = msg.cols as number;
              const rows = msg.rows as number;
              if (cols > 0 && rows > 0) {
                const tmuxExec = (tmux as unknown as { exec: (cmd: string) => Promise<string> }).exec;
                if (tmuxExec) {
                  await tmuxExec(`tmux resize-window -t ${sessionName} -x ${cols} -y ${rows}`);
                }
              }
            }
          } catch {}
        },

        async onClose() {
          if (tailInterval) { clearInterval(tailInterval); tailInterval = null; }
          const tmux = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
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

  return { app, injectWebSocket };
}
