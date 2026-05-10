// PL-016 hardening v0+1 — `rig agent-image create` --image-version flag
// regression test.
//
// Pins:
//   - --image-version <v> propagates as body.version on the snapshot POST
//   - --version on the per-command surface no longer shadows Commander's
//     global --version (creating a separate per-command name resolves
//     the collision; absence of `--version` as a per-command option is
//     the contract this test enforces)

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { agentImageCommand } from "../src/commands/agent-image.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}

function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-05-04T00:00:00Z" };
}

function runningLifecycleDeps(port: number): LifecycleDeps {
  return mockLifecycleDeps({
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) return JSON.stringify(runningState(port));
      return null;
    }),
    fetch: vi.fn(async () => ({ ok: true })),
  });
}

interface CapturedCall {
  method: string;
  url: string;
  body: string;
}

function createMockDaemon(captured: CapturedCall[]) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agent-images/snapshot") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        captured.push({ method: req.method!, url: url.pathname, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          imageId: "agent-image:test:2",
          imagePath: "/tmp/agent-images/test",
          manifest: { name: "test", version: "2", runtime: "claude-code" },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
    listen: () => new Promise<number>((r) => {
      server.listen(0, () => {
        const addr = server.address();
        r(typeof addr === "object" && addr ? addr.port : 0);
      });
    }),
  };
}

describe("rig agent-image create — --image-version flag", () => {
  const captured: CapturedCall[] = [];
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon(captured);
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  it("--image-version <v> propagates as body.version on the snapshot POST", async () => {
    captured.length = 0;
    const program = new Command();
    program.exitOverride();
    program.addCommand(agentImageCommand({
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (url) => new DaemonClient(url),
    }));

    // Suppress console output for the test.
    const origLog = console.log;
    console.log = () => {};
    try {
      await program.parseAsync([
        "node", "rig", "agent-image", "create", "alice@rigA",
        "--name", "test",
        "--image-version", "2",
      ]);
    } finally {
      console.log = origLog;
    }

    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0]!.body);
    expect(body.version).toBe("2");
    expect(body.name).toBe("test");
    expect(body.sourceSession).toBe("alice@rigA");
  });

  it("the per-command create command does NOT register --version (avoids Commander.js global collision)", () => {
    const cmd = agentImageCommand();
    const createCmd = cmd.commands.find((c) => c.name() === "create");
    expect(createCmd).toBeDefined();
    const optionNames = createCmd!.options.map((o) => o.long);
    // Must include --image-version (the rename target); must NOT include
    // --version (which Commander.js intercepts as the global version flag).
    expect(optionNames).toContain("--image-version");
    expect(optionNames).not.toContain("--version");
  });
});
