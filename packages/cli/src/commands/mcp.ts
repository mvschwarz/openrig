import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, type LifecycleDeps } from "../daemon-lifecycle.js";
import { createMcpServer } from "../mcp-server.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig mcp serve` — start MCP server wrapping the daemon API.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function mcpCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("mcp").description("MCP server for agent integration");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("serve")
    .description("Start MCP server (stdio transport)")
    .option("--port <port>", "Daemon port override")
    .action(async (opts: { port?: string }) => {
      const deps = getDepsF();

      let daemonPort: number;
      if (opts.port) {
        daemonPort = parseInt(opts.port, 10);
        if (isNaN(daemonPort)) {
          console.error("Invalid port number");
          process.exitCode = 1;
          return;
        }
      } else {
        const status = await getDaemonStatus(deps.lifecycleDeps);
        if (status.state !== "running" || status.healthy === false) {
          console.error("Daemon not running. Start with: rig daemon start");
          process.exitCode = 1;
          return;
        }
        daemonPort = status.port!;
      }

      const client = deps.clientFactory(`http://127.0.0.1:${daemonPort}`);
      const server = createMcpServer(client);
      const transport = new StdioServerTransport();
      await server.connect(transport);

      // Stay alive until transport closes
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => resolve());
        process.on("SIGTERM", () => resolve());
      });

      await server.close();
    });

  return cmd;
}
