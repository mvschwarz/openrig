import { afterEach, expect, it, vi } from "vitest";
import http from "node:http";
import { agentImageCommand } from "../src/commands/agent-image.js";
import { pluginCommand } from "../src/commands/plugin.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

let server: http.Server | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  vi.restoreAllMocks(); process.exitCode = undefined;
});
it.each(["plugins", "agent-images"])("%s inventory rejects unsuccessful native HTTP responses in both output modes", async (kind) => {
  let status = 503;
  const route = kind === "plugins" ? "/api/plugins" : "/api/agent-images/library";
  const requests: string[] = [];
  server = http.createServer((req, res) => { requests.push(req.url!); res.writeHead(status, { "Content-Type": "application/json" }); res.end("[]"); });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const deps = { clientFactory: (base: string) => new DaemonClient(base), lifecycleDeps: {
    exists: (p: string) => p === STATE_FILE, readFile: () => JSON.stringify({ pid: process.pid, port, db: "fixture.sqlite", startedAt: new Date().toISOString() }),
    isProcessAlive: () => true, fetch: async () => ({ ok: true }),
  } as never };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const output of [[], ["--json"]]) {
    for (const code of [401, 503]) {
      status = code; process.exitCode = undefined; log.mockClear(); error.mockClear();
      const cmd = kind === "plugins" ? pluginCommand(deps) : agentImageCommand(deps);
      await cmd.parseAsync(["list", ...output], { from: "user" });
      expect(process.exitCode).toBe(1);
      expect(error.mock.calls.flat().join(" ")).toContain(`HTTP ${code}`);
      expect(log).not.toHaveBeenCalled();
    }
  }
  status = 200; process.exitCode = undefined; log.mockClear(); error.mockClear();
  const cmd = kind === "plugins" ? pluginCommand(deps) : agentImageCommand(deps);
  await cmd.parseAsync(["list", "--json"], { from: "user" });
  expect(process.exitCode).toBeUndefined(); expect(error).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual([]);
  expect(requests).toEqual(Array(5).fill(route));
});
