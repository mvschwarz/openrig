// Real command parsing and HTTP client, a task-owned simulated daemon, no service action.
import { createServer } from "node:http";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { envCommand } from "../src/commands/env.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const cases = [
  { name: "ambiguous", ref: "twin", rigs: [{ id: "rig-a", name: "twin" }, { id: "rig-b", name: "twin" }], expected: null },
  { name: "exact-id", ref: "chosen", rigs: [{ id: "rig-a", name: "chosen" }, { id: "chosen", name: "other" }], expected: "chosen" },
  { name: "unique-name", ref: "solo", rigs: [{ id: "rig-a", name: "solo" }], expected: "rig-a" },
];
it.each(cases.flatMap(c => ["status", "logs", "down"].map(operation => ({ ...c, operation }))))(
  "env $operation resolves $name before a service request", async ({ operation, ref, rigs, expected }) => {
  const requests: string[] = [];
  const payloads: unknown[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = ""; req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (body) payloads.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/rigs/summary" ? rigs.map(r => ({ ...r, archivedAt: null }))
        : { ok: true, hasServices: false, output: "fixture logs" }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const deps: StatusDeps = {
    lifecycleDeps: {
      readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "fixture" }) : null,
      exists: (p: string) => p === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }),
    } as StatusDeps["lifecycleDeps"],
    clientFactory: () => new DaemonClient(`http://127.0.0.1:${port}`),
  };
  const output: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { output.push(a.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...a) => { output.push(a.join(" ")); });
  const priorExitCode = process.exitCode; process.exitCode = undefined;
  try {
    const program = new Command(); program.addCommand(envCommand(deps));
    await program.parseAsync(["node", "rig", "env", operation, ref,
      ...(operation === "status" ? ["--json"] : operation === "down" ? ["--volumes"] : [])]);
    expect(["darwin", "linux"]).toContain(process.platform);
    expect(requests[0]).toBe("GET /api/rigs/summary");
    if (expected === null) {
      expect(requests).toEqual(["GET /api/rigs/summary"]);
      expect(payloads).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(output.join("\n")).toContain("rig_ambiguous");
      expect(output.join("\n")).toContain("rig-a"); expect(output.join("\n")).toContain("rig-b");
      if (operation === "status") expect(JSON.parse(output[0]!)).toMatchObject({ code: "rig_ambiguous", candidates: ["rig-a", "rig-b"] });
    } else {
      const route = `/api/rigs/${expected}/env` + (operation === "down" ? "/down" : operation === "logs" ? "/logs?tail=100" : "");
      expect(requests).toEqual(["GET /api/rigs/summary", `${operation === "down" ? "POST" : "GET"} ${route}`]);
      if (operation === "down") expect(payloads).toEqual([{ volumes: true }]);
      expect(process.exitCode).toBeUndefined();
    }
  } finally {
    log.mockRestore(); error.mockRestore(); process.exitCode = priorExitCode;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(server.listening).toBe(false);
  }
});
