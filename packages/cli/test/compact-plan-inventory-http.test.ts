import { afterEach, expect, it, vi } from "vitest";
import http from "node:http";
import { compactPlanCommand } from "../src/commands/compact-plan.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

let server: http.Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it("marks partial native HTTP inventory while preserving healthy rigs", async () => {
  let failedRoute = "/api/ps";
  let status = 503;
  let malformedNodes = false;
  let malformedRigs = false;
  const requests: Array<{ method: string; path: string }> = [];
  const candidate = {
    rigId: "rig-a", rigName: "alpha", logicalId: "orch.lead", canonicalSessionName: "orch-lead@alpha",
    runtime: "claude-code", sessionStatus: "running", startupStatus: "ready",
    tmuxAttachCommand: "tmux attach -t orch-lead@alpha", resumeCommand: null,
    contextUsage: { usedPercentage: 90, remainingPercentage: 10, contextWindowSize: 1_000_000,
      source: "claude_statusline_json", availability: "known", sampledAt: new Date().toISOString(), fresh: true },
  };
  server = http.createServer((req, res) => {
    requests.push({ method: req.method!, path: req.url! });
    if (req.url === failedRoute && status === 0) { req.socket.destroy(); return; }
    const code = req.url === failedRoute ? status : 200;
    const data = req.url === "/api/ps"
      ? code === 200 ? malformedRigs ? null : [{ rigId: "rig-a", name: "alpha" }, { rigId: "rig-b", name: "beta" }] : []
      : req.url === "/api/rigs/rig-a/nodes" ? [candidate] : code === 200 && !malformedNodes ? [] : { error: "inventory unavailable" };
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const deps = { clientFactory: (base: string) => new DaemonClient(base), lifecycleDeps: {
    exists: (p: string) => p === STATE_FILE,
    readFile: () => JSON.stringify({ pid: process.pid, port, db: "fixture.sqlite", startedAt: new Date().toISOString() }),
    isProcessAlive: () => true, fetch: async () => ({ ok: true }),
  } as never };
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const output of [[], ["--json"]]) {
    for (const route of ["/api/ps", "/api/rigs/rig-b/nodes"]) {
      for (const code of [401, 503]) {
        failedRoute = route; status = code; process.exitCode = undefined;
        log.mockClear(); error.mockClear(); requests.length = 0;
        await compactPlanCommand(deps).parseAsync(output, { from: "user" });
        expect.soft(process.exitCode).toBe(route === "/api/ps" ? 2 : 1);
        if (route === "/api/ps") {
          expect.soft(error.mock.calls.flat().join(" ")).toContain(`HTTP ${code}`);
          expect.soft(log).not.toHaveBeenCalled();
        } else if (output.length) {
          const plan = JSON.parse(String(log.mock.calls[0]?.[0] ?? "{}"));
          expect.soft(plan.incompleteRigs).toEqual([{ rig: "beta", status: code }]);
          expect.soft(plan.candidates?.[0]?.session).toBe("orch-lead@alpha");
        } else {
          expect.soft(log.mock.calls.flat().join(" ")).toContain("orch-lead@alpha");
          expect.soft(error.mock.calls.flat().join(" ")).toContain(`beta (HTTP ${code})`);
        }
        expect(requests.every((request) => request.method === "GET")).toBe(true);
      }
    }
  }
  failedRoute = ""; malformedRigs = true; process.exitCode = undefined; log.mockClear(); error.mockClear();
  await compactPlanCommand(deps).parseAsync(["--json"], { from: "user" });
  expect(process.exitCode).toBe(2); expect(error.mock.calls.flat().join(" ")).toContain("Rig inventory is not an array");
  expect(log).not.toHaveBeenCalled();
  malformedRigs = false; malformedNodes = true; process.exitCode = undefined; log.mockClear(); error.mockClear();
  await compactPlanCommand(deps).parseAsync(["--json"], { from: "user" });
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]![0])).incompleteRigs).toEqual([{ rig: "beta", status: "invalid_inventory" }]);
  process.exitCode = undefined; log.mockClear(); error.mockClear();
  await compactPlanCommand(deps).parseAsync(["--rig", "beta", "--json"], { from: "user" });
  expect(process.exitCode).toBe(2); expect(log).not.toHaveBeenCalled();
  expect(error.mock.calls.flat().join(" ")).toContain("is not an array");
  malformedNodes = false; failedRoute = "/api/rigs/rig-b/nodes"; status = 503;
  process.exitCode = undefined; log.mockClear(); error.mockClear();
  await compactPlanCommand(deps).parseAsync(["--rig", "beta", "--json"], { from: "user" });
  expect(process.exitCode).toBe(2); expect(log).not.toHaveBeenCalled();
  expect(error.mock.calls.flat().join(" ")).toContain("HTTP 503");
  status = 0; process.exitCode = undefined; log.mockClear(); error.mockClear();
  await compactPlanCommand(deps).parseAsync(["--json"], { from: "user" });
  const partial = JSON.parse(String(log.mock.calls[0]![0]));
  expect(process.exitCode).toBe(1);
  expect(partial.incompleteRigs).toEqual([{ rig: "beta", status: "request_failed" }]);
  expect(partial.candidates[0].session).toBe("orch-lead@alpha");
  failedRoute = ""; process.exitCode = undefined; log.mockClear(); error.mockClear();
  await compactPlanCommand(deps).parseAsync(["--json"], { from: "user" });
  expect(process.exitCode).toBeUndefined(); expect(error).not.toHaveBeenCalled();
  expect(JSON.parse(String(log.mock.calls[0]![0])).summary.candidateCount).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]![0])).incompleteRigs).toEqual([]);
});
