import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { sendCommand } from "../src/commands/send.js";
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

function runningDeps(port: number, clientFactory?: StatusDeps["clientFactory"]): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: clientFactory ?? ((baseUrl) => new DaemonClient(baseUrl)),
  };
}

describe("Send CLI", () => {
  let server: http.Server;
  let port: number;
  let lastSendBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && url === "/api/transport/send") {
          const parsed = JSON.parse(body);
          lastSendBody = parsed;
          if (parsed.session === "dev-impl@my-rig") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "dev-impl@my-rig" }));
          } else if (parsed.session === "busy-session") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, sessionName: "busy-session", reason: "mid_work", error: "Target pane appears mid-task. Use force: true to send anyway." }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "not found" }));
          }
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(deps: StatusDeps = runningDeps(port)): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(sendCommand(deps));
    return prog;
  }

  beforeEach(() => {
    lastSendBody = null;
  });

  it("send prints success output", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello world"]);
    });
    expect(logs.join("\n")).toContain("Sent to dev-impl@my-rig");
  });

  it("send with 409 mid-work prints error and exits non-zero", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "busy-session", "hello"]);
    });
    expect(logs.join("\n")).toContain("mid-task");
    expect(exitCode).toBe(1);
  });

  it("send --json prints raw JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.sessionName).toBe("dev-impl@my-rig");
  });

  it("send --wait-for-idle posts waitForIdleMs and extends request timeout", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    const deps = runningDeps(port, () => ({ post: postFn } as unknown as DaemonClient));
    const { logs } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "30", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(postFn).toHaveBeenCalledWith(
      "/api/transport/send",
      expect.objectContaining({
        session: "dev-impl@my-rig",
        text: expect.stringContaining("hello"),
        waitForIdleMs: 30000,
      }),
      { timeoutMs: 35000 },
    );
    const sentText = postFn.mock.calls[0]?.[1] as { text: string } | undefined;
    expect(sentText?.text).toContain("To: dev-impl@my-rig");
    expect(sentText?.text).toContain("---\nhello\n---");
    expect(sentText?.text).toContain('↩ Reply: rig send');
  });

  it("send without wait-for-idle uses default client timeout path", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    const deps = runningDeps(port, () => ({ post: postFn } as unknown as DaemonClient));
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(postFn.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("send rejects invalid wait-for-idle values before contacting daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "0"]);
    });
    expect(logs.join("\n")).toContain("positive number");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  it("send rejects wait-for-idle with force before contacting daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "30", "--force"]);
    });
    expect(logs.join("\n")).toContain("cannot be combined");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  it("send --help includes rediscovery examples", () => {
    const cmd = sendCommand(runningDeps(port));
    const helpText = cmd.helpInformation();
    expect(helpText).toContain("--verify");
    expect(helpText).toContain("--force");
    expect(helpText).toContain("--wait-for-idle");
    expect(helpText).toContain("pane only");
    expect(helpText).toContain("dev-impl@my-rig");
  });
});
