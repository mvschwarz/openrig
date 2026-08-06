// OPR.0.3.4.3 — rig reconcile-session CLI.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createProgram } from "../src/index.js";
import http from "node:http";
import { Command } from "commander";
import { reconcileSessionCommand } from "../src/commands/reconcile-session.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

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
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

const OK_RESPONSE = {
  ok: true,
  result: {
    rigId: "rig-1",
    rigName: "my-rig",
    nodeId: "node-1",
    logicalId: "dev.impl",
    sessionName: "dev-impl@my-rig",
    sessionId: "sess-2",
    projectionDrift: ['runtime unverified: pane command "zsh" does not confirm runtime "claude-code"'],
    continuity: "unverified",
  },
};

describe("rig reconcile-session", () => {
  let server: http.Server;
  let port: number;
  let lastBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      let body = "";
      req.on("data", (c: Buffer) => { body += c; });
      req.on("end", () => {
        if (req.method === "POST" && url.includes("/reconcile")) {
          lastBody = JSON.parse(body || "{}");
          if (url.includes("dead-session")) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, code: "session_not_found", message: 'No live tmux session named "dead-session@my-rig".' }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(OK_RESPONSE));
          }
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function runningDeps(): StatusDeps {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-06-11T00:00:00Z" } as DaemonState)
          : null),
        fetch: vi.fn(async () => ({ ok: true })),
      },
      clientFactory: (url) => new DaemonClient(url),
    };
  }

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(reconcileSessionCommand(runningDeps()));
    return prog;
  }

  it("reconciles and prints the no-relaunch/no-input line + honest drift + continuity", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "reconcile-session", "dev-impl@my-rig", "--no-launch"]);
    });
    const out = logs.join("\n");
    expect(out).toContain("Reconciled dev-impl@my-rig into rig my-rig");
    expect(out).toContain("no relaunch, no input sent");
    expect(out).toContain("node id unchanged");
    expect(out).toContain("Projection drift");
    expect(out).toContain("runtime unverified");
    expect(out).toContain("Conversation continuity: unverified");
    expect(exitCode).toBeUndefined();
  });

  it("forwards --rig/--node together in the body", async () => {
    lastBody = null;
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "reconcile-session", "dev-impl@my-rig", "--rig", "rig-1", "--node", "dev.impl"]);
    });
    expect(lastBody).toEqual({ rigId: "rig-1", logicalId: "dev.impl" });
  });

  it("rejects --rig without --node before contacting the daemon", async () => {
    lastBody = null;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "reconcile-session", "dev-impl@my-rig", "--rig", "rig-1"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("--rig and --node must be provided together");
    expect(lastBody).toBeNull();
  });

  it("daemon error -> honest message + exit 1", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "reconcile-session", "dead-session@my-rig"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("No live tmux session");
  });

  it("--json passes the outcome through", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "reconcile-session", "dev-impl@my-rig", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.continuity).toBe("unverified");
    expect(parsed.result.projectionDrift).toHaveLength(1);
  });

  it("wired via createProgram", async () => {
    const program = createProgram();
    expect(program.commands.find((c) => c.name() === "reconcile-session")).toBeDefined();
  });
});
