// S5b final fix, R2 F1 (row r054-s5b-final-fix) — `rig up` must RENDER the
// locked teaching refusal for rig_name_running verbatim, not the generic
// "Up failed: unknown error ... validate your spec" fallback. The stub serves
// the daemon's post-fix 409 shape; the pin is on the CLI's rendering.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";

const TEACHING =
  'A rig named "dupe-cli" is already RUNNING: 01RIGID with 1 running session(s) ' +
  "(checked: existing rigs with this name for sessions in status 'running'). " +
  "Nothing was created or launched. Alternatives: work with the running rig " +
  "(rig ps --nodes / rig send), stop it first with 'rig down dupe-cli', " +
  "or launch this spec under a different name.";

function mockLifecycleDeps(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) {
        return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-20T00:00:00Z" } as DaemonState);
      }
      return null;
    }),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

describe("rig up rendering — rig_name_running teaching refusal (S5b F1)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/up" && req.method === "POST") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          runId: "run-rnr",
          status: "failed",
          code: "rig_name_running",
          error: TEACHING,
          stages: [
            { stage: "resolve_spec", status: "ok" },
            { stage: "import_rig", status: "failed", detail: { code: "rig_name_running" } },
          ],
          errors: [TEACHING],
          warnings: [],
        }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  it("renders the teaching refusal verbatim — no unknown-error fallback, no spec-validate hint", async () => {
    const captured: string[] = [];
    const originalExit = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...args) => captured.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => captured.push(args.join(" ")));

    try {
      const prog = new Command();
      prog.exitOverride();
      const deps = {
        lifecycleDeps: mockLifecycleDeps(port),
        clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
        preflightExec: async () => "tmux 3.6a",
      };
      prog.addCommand(upCommand(deps as never));
      await prog.parseAsync(["node", "rig", "up", "somespec.yaml"]).catch(() => {});
    } finally {
      vi.restoreAllMocks();
    }
    const out = captured.join("\n");
    const exitCode = process.exitCode;
    process.exitCode = originalExit;

    // The locked teaching refusal, rendered.
    expect(out).toContain('A rig named "dupe-cli" is already RUNNING');
    expect(out).toContain("rig down dupe-cli");
    expect(out).toMatch(/nothing was created or launched/i);
    // Not the generic fallback noise.
    expect(out).not.toContain("unknown error");
    expect(out).not.toContain("validate your spec");
    expect(exitCode).toBe(1);
  });
});
