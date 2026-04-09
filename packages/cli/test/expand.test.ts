import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { Command } from "commander";
import { expandCommand } from "../src/commands/expand.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

function mockLifecycleDeps(): LifecycleDeps {
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
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

const OK_RESPONSE = {
  ok: true,
  status: "ok",
  podId: "pod-123",
  podNamespace: "infra",
  nodes: [{ logicalId: "infra.server", nodeId: "n1", status: "launched", sessionName: "infra.server@test" }],
  warnings: [],
  retryTargets: [],
};

const PARTIAL_RESPONSE = {
  ok: true,
  status: "partial",
  podId: "pod-123",
  podNamespace: "dev",
  nodes: [
    { logicalId: "dev.impl", nodeId: "n1", status: "launched", sessionName: "dev.impl@test" },
    { logicalId: "dev.qa", nodeId: "n2", status: "failed", error: "tmux unavailable" },
  ],
  warnings: [],
  retryTargets: ["dev.qa"],
};

describe("rig expand", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  let fragmentPath: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url?.includes("/expand")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          if (parsed.pod?.id === "fail-pod") {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, code: "rig_not_found", error: "Rig not found" }));
          } else if (parsed.pod?.id === "partial-pod") {
            res.writeHead(207, { "Content-Type": "application/json" });
            res.end(JSON.stringify(PARTIAL_RESPONSE));
          } else {
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(OK_RESPONSE));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  beforeEach(() => {
    tmpDir = join(tmpdir(), `expand-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    fragmentPath = join(tmpDir, "pod.yaml");
    writeFileSync(fragmentPath, `id: infra\nlabel: Infrastructure\nmembers:\n  - id: server\n    runtime: terminal\n    agent_ref: "builtin:terminal"\nedges: []\n`);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runningDeps(): StatusDeps {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => {
          if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-07T00:00:00Z" } as DaemonState);
          return null;
        }),
        fetch: vi.fn(async () => ({ ok: true })),
      },
      clientFactory: (url) => new DaemonClient(url),
    };
  }

  function makeCmd(deps?: StatusDeps): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(expandCommand(deps ?? runningDeps()));
    return prog;
  }

  // T1: Parses arguments
  it("parses rig-id and pod-fragment-path", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "expand", "rig-123", fragmentPath]);
    });
    expect(logs.join("\n")).toContain("infra");
    expect(logs.join("\n")).toContain("ok");
  });

  // T2: --json returns raw API response
  it("--json returns raw API response", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "expand", "rig-123", fragmentPath, "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("ok");
    expect(parsed.nodes).toBeDefined();
  });

  // T3a: Partial prints failed nodes + honest relaunch guidance
  it("partial result prints failed nodes with relaunch guidance", async () => {
    writeFileSync(fragmentPath, `id: partial-pod\nlabel: Dev\nmembers:\n  - id: impl\n    runtime: claude-code\n  - id: qa\n    runtime: codex\nedges: []\n`);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "expand", "rig-123", fragmentPath]);
    });

    const output = logs.join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("dev.qa");
    expect(output).toContain("rig launch rig-123 dev.qa");
    expect(exitCode).toBe(1);
  });

  it("partial output does not leak raw API relaunch routes", async () => {
    writeFileSync(fragmentPath, `id: partial-pod\nlabel: Dev\nmembers:\n  - id: impl\n    runtime: claude-code\n  - id: qa\n    runtime: codex\nedges: []\n`);

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "expand", "rig-123", fragmentPath]);
    });

    const output = logs.join("\n");
    expect(output).not.toContain("/api/rigs/");
    expect(output).not.toContain("/launch");
  });

  // T3b: Human output never suggests 'rig up' or 'rerun expand'
  it("partial output never suggests rig up or rerun expand", async () => {
    writeFileSync(fragmentPath, `id: partial-pod\nlabel: Dev\nmembers:\n  - id: impl\n    runtime: claude-code\n  - id: qa\n    runtime: codex\nedges: []\n`);

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "expand", "rig-123", fragmentPath]);
    });

    const output = logs.join("\n");
    expect(output).not.toContain("rig up");
    expect(output).not.toMatch(/rerun.*expand/i);
    expect(output).not.toMatch(/rig expand/i);
  });

  // T4: API error -> exit 1
  it("API error returns exit 1 with message", async () => {
    writeFileSync(fragmentPath, `id: fail-pod\nlabel: Fail\nmembers:\n  - id: x\n    runtime: terminal\nedges: []\n`);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "expand", "rig-123", fragmentPath]);
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("not found");
  });

  // T2b: --json exits non-zero for partial/failed
  it("--json exits non-zero for partial result", async () => {
    writeFileSync(fragmentPath, `id: partial-pod\nlabel: Dev\nmembers:\n  - id: impl\n    runtime: claude-code\n  - id: qa\n    runtime: codex\nedges: []\n`);

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "expand", "rig-123", fragmentPath, "--json"]);
    });

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("partial");
    expect(exitCode).toBe(1);
  });

  // T5: Wired via createProgram
  it("wired via createProgram", async () => {
    const { createProgram } = await import("../src/index.js");
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "expand");
    expect(cmd).toBeDefined();
  });

  // T6: Human output shows per-node status
  it("human output shows per-node status table", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "expand", "rig-123", fragmentPath]);
    });

    const output = logs.join("\n");
    expect(output).toContain("[OK]");
    expect(output).toContain("infra.server");
    expect(output).toContain("infra.server@test");
  });
});
