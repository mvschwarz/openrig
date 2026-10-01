import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { requirementsCommand } from "../src/commands/requirements.js";
import { bootstrapCommand } from "../src/commands/bootstrap.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

let server: http.Server | undefined;
let priorExitCode = process.exitCode;
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = priorExitCode;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("bootstrap error statuses cannot certify readiness", () => {
  it.each([400, 409, 500].flatMap((status) => [false, true].flatMap((json) => ["requirements", "bootstrap"].map((command) => ({ status, json, command })))))
   ("$command HTTP$status json=$json exits with the failure", async ({ status, json, command }) => {
      const body = { status: "failed", stages: [{ stage: "resolve_spec", status: "failed", detail: { code: "file_not_found" } }], errors: ["Spec file not found"] };
      server = http.createServer(async (req, res) => {
        for await (const _chunk of req) { /* actual wire request */ }
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const deps: StatusDeps = {
        lifecycleDeps: {
          spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(),
          readFile: (p) => p === STATE_FILE ? JSON.stringify({ pid: 1, port, db: "test.sqlite", startedAt: "2026-09-30T00:00:00Z" }) : null,
          writeFile: vi.fn(), removeFile: vi.fn(), exists: (p) => p === STATE_FILE,
          mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
        },
        clientFactory: (url) => new DaemonClient(url),
      };
      priorExitCode = process.exitCode;
      process.exitCode = undefined;
      const output: string[] = [];
      const errors: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.join(" ")));
      vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
      const program = new Command().exitOverride();
      program.addCommand(command === "requirements" ? requirementsCommand(deps) : bootstrapCommand(deps));
      await program.parseAsync(["node", "rig", command, "/missing/spec.yaml", ...(json ? ["--json"] : [])]);
      expect(process.exitCode).toBe(command === "bootstrap" ? (status === 409 ? 1 : 2) : (status >= 500 ? 2 : 1));
      expect(output.join("\n")).not.toContain("No requirements declared");
      if (json) expect(JSON.parse(output.join(""))).toEqual(body);
      else expect(errors.join("\n")).toContain("Spec file not found");
    });
});
