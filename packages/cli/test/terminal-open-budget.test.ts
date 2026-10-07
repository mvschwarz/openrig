import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { terminalCommand } from "../src/commands/terminal.js";
import type { TerminalDeps } from "../src/commands/terminal.js";
import { HerdrAdapter, HERDR_PANES_PER_PAGE } from "../../daemon/src/domain/terminal/herdr-adapter.js";
import { createHerdrSocketRpc, createHerdrSocketTransport } from "../../daemon/src/domain/terminal/herdr-transport.js";
import { composeView } from "../../daemon/src/domain/terminal/view-composer.js";
import { terminalRoutes } from "../../daemon/src/routes/terminal.js";

describe("terminal open request budget", () => {
  it.skipIf(process.platform === "win32")("waits for two healthy page applications instead of abandoning a delivered open", async () => {
    const owned = mkdtempSync(join(tmpdir(), "or-terminal-"));
    const socketPath = join(owned, "provider.sock");
    const methods: string[] = [];
    const connections = new Set<net.Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let page = 0;
    const socketServer = net.createServer(socket => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.slice(0, input.indexOf("\n")));
        methods.push(request.method);
        let result: Record<string, unknown> = { type: request.method };
        if (request.method === "ping") result = { type: "pong", version: "0.7.1", protocol: 1 };
        if (request.method === "workspace.create") result = { type: "workspace_create", workspace: { workspace_id: "owned-workspace" } };
        if (request.method === "layout.apply") result = { type: "layout_apply", layout: { tab_id: `owned-tab-${++page}` } };
        if (request.method === "pane.list") result = { type: "pane_list", panes: [] };
        const reply = () => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "layout.apply") {
          // Each 2.8s response is within the real socket transport's 5s bound.
          // The sequential two-page operation legitimately exceeds the HTTP
          // client's read-class default of 5s.
          const timer = setTimeout(() => { timers.delete(timer); reply(); }, 2800);
          timers.add(timer);
        } else reply();
      });
    });
    await new Promise<void>(resolve => socketServer.listen(socketPath, resolve));
    const adapter = new HerdrAdapter({
      transportFactory: createHerdrSocketTransport(createHerdrSocketRpc(socketPath)),
    });
    const view = composeView("rig:owned-rig", Array.from({ length: 17 }, (_, index) => ({
      seat: `agent-${index}@owned-rig`, label: `Agent ${index}`, tmuxSession: `owned-${index}`,
      host: null, alive: true, readOnly: false,
    })), { resolveHost: () => null, panesPerPage: HERDR_PANES_PER_PAGE });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("terminalService" as never, {
        openView: () => adapter.openView(view),
        previewView: () => ({ planId: "owned-plan", composed: view, status: { launch: { socketPath } } }),
        status: () => ({ providers: [{ liveness: { alive: true } }] }),
      } as never);
      await next();
    });
    app.route("/api/terminal", terminalRoutes());
    const httpServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!httpServer.listening) await new Promise<void>(resolve => httpServer.once("listening", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const deps: TerminalDeps = {
      lifecycleDeps: {
        exists: () => true,
        readFile: () => JSON.stringify({ pid: process.pid, port, host: "127.0.0.1", db: "owned", startedAt: new Date().toISOString() }),
        isProcessAlive: () => true,
        fetch: async () => ({ ok: true }),
      } as TerminalDeps["lifecycleDeps"],
      clientFactory: baseUrl => new DaemonClient(baseUrl),
      // Exercise default window routing without launching a native terminal in CI.
      windowDeps: {
        platform: "linux", env: { DISPLAY: ":fixture" }, exists: () => false,
        exec: async (file, args) => file === "/usr/bin/env" && args.at(-1) === "list"
          ? JSON.stringify({ result: { workspaces: [] } })
          : args.includes("--version") ? "herdr 0.9.3" : "/fixture/bin/herdr",
        launch: async () => {}, sleep: async () => {}, id: () => "owned-budget",
      },
    };
    const command = new Command();
    command.addCommand(terminalCommand(deps));
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await command.parseAsync(["terminal", "open", "owned-rig", "--json"], { from: "user" });
      expect(process.exitCode).toBeUndefined();
      const result = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(result.opened).toHaveLength(17);
      expect(result.pages).toBe(2);
      expect(methods.filter(method => method === "workspace.create")).toHaveLength(1);
      expect(methods.filter(method => method === "layout.apply")).toHaveLength(2);
    } finally {
      process.exitCode = originalExit;
      log.mockRestore();
      httpServer.closeAllConnections();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
      for (const timer of timers) clearTimeout(timer);
      for (const socket of connections) socket.destroy();
      await new Promise<void>(resolve => socketServer.close(() => resolve()));
      rmSync(owned, { recursive: true, force: true });
    }
  });
});
