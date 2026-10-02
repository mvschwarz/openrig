import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { envCommand } from "../src/commands/env.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const cases = [
  { status: 404, data: { error: "rig_not_found" }, exit: 1 },
  { status: 503, data: { error: "service_status_unavailable" }, exit: 2 },
  { status: 200, data: { hasServices: false }, exit: 0 },
  { status: 200, data: { hasServices: true, kind: "compose", projectName: "fixture",
    receipt: { services: [{ name: "web", status: "running", health: "healthy" }] } }, exit: 0 },
];

it.each(cases.flatMap((entry) => [false, true].map((json) => ({ ...entry, json }))))(
  "reports HTTP $status with JSON=$json and exit=$exit",
  async ({ status, data, exit, json }) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/rigs/summary") res.end(JSON.stringify([{ id: "fixture-id", name: "fixture" }]));
      else { res.statusCode = status; res.end(JSON.stringify(data)); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const deps: StatusDeps = {
      lifecycleDeps: {
        readFile: (path: string) => path === STATE_FILE ? JSON.stringify({ pid: 123, port: address.port, db: "fixture" }) : null,
        exists: (path: string) => path === STATE_FILE, isProcessAlive: () => true,
        fetch: async () => ({ ok: true }),
      } as StatusDeps["lifecycleDeps"],
      clientFactory: () => new DaemonClient(`http://127.0.0.1:${address.port}`),
    };
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExit = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      program.addCommand(envCommand(deps));
      await program.parseAsync(["node", "rig", "env", "status", "fixture", ...(json ? ["--json"] : [])]);
      expect(process.exitCode ?? 0).toBe(exit);
      if (json) expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual(data);
      else if (status >= 400) {
        expect(error).toHaveBeenCalledWith(data.error);
        expect(output).not.toHaveBeenCalled();
      } else {
        expect(error).not.toHaveBeenCalled();
        expect(output).toHaveBeenCalledWith(data.hasServices ? "Env: compose (fixture)" : "No services configured for this rig.");
      }
    } finally {
      output.mockRestore(); error.mockRestore(); process.exitCode = previousExit;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  },
);
