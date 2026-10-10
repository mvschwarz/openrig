import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { envCommand } from "../src/commands/env.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const failures = [
  { status: 503, data: { error: "rig_summary_unavailable" }, message: "rig_summary_unavailable" },
  { status: 503, data: {}, message: "Failed to list rigs (HTTP 503)" },
  { status: 200, data: {}, message: "The daemon returned an invalid rig summary." },
];
it.each(failures.flatMap((failure) => ["status", "logs", "down"].map((operation) => ({ ...failure, operation }))))(
  "preserves rig summary $status when running env $operation", async ({ operation, status, data, message }) => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const deps: StatusDeps = {
    lifecycleDeps: {
      readFile: (path: string) => path === STATE_FILE ? JSON.stringify({ pid: 123, port: address.port, db: "fixture" }) : null,
      exists: (path: string) => path === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }),
    } as StatusDeps["lifecycleDeps"],
    clientFactory: () => new DaemonClient(`http://127.0.0.1:${address.port}`),
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = new Command(); program.addCommand(envCommand(deps));
    await program.parseAsync(["node", "rig", "env", operation, "fixture"]);
    expect(error).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(1);
    expect(requests).toEqual(["GET /api/rigs/summary"]);
  } finally {
    error.mockRestore(); process.exitCode = previousExit;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
