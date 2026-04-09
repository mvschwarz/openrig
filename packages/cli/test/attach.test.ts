import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { attachCommand, resolveAttachContext } from "../src/commands/attach.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

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

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
  };
}

describe("Attach CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/rigs/rig-1/attach-self" && req.method === "POST") {
        const parsed = body ? JSON.parse(body) : {};
        const logicalId = parsed.logicalId ?? `${parsed.podNamespace}.${parsed.memberName}`;
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          nodeId: "node-1",
          logicalId,
          sessionId: "sess-1",
          sessionName: "orch1-lead@rigged-buildout",
          attachmentType: "external_cli",
          env: {
            OPENRIG_NODE_ID: "node-1",
            OPENRIG_SESSION_NAME: "orch1-lead@rigged-buildout",
          },
        }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.configureOutput({
      writeOut: (str) => console.log(str.trimEnd()),
      writeErr: (str) => console.error(str.trimEnd()),
    });
    prog.addCommand(attachCommand(runningDeps(port)));
    return prog;
  }

  it("attach --self --node prints a human summary", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--self", "--rig", "rig-1", "--node", "orch1.lead"]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("Attached this shell to node orch1.lead");
    expect(output).toContain("external_cli");
    expect(output).toContain("inbound tmux transport unavailable");
  });

  it("attach --self --print-env prints shell exports only", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--self", "--rig", "rig-1", "--node", "orch1.lead", "--print-env"]);
    });

    expect(exitCode).toBeUndefined();
    expect(logs).toEqual([
      "export OPENRIG_NODE_ID='node-1'",
      "export OPENRIG_SESSION_NAME='orch1-lead@rigged-buildout'",
    ]);
  });

  it("attach rejects missing --self", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--rig", "rig-1", "--node", "orch1.lead"]).catch(() => undefined);
    });

    expect(exitCode).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("attach rejects incomplete pod mode before calling the daemon", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "attach", "--self", "--rig", "rig-1", "--pod", "orch1", "--member", "lead"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.some((line) => line.includes("Pod attach requires"))).toBe(true);
  });

  it("resolveAttachContext detects tmux session metadata when TMUX_PANE is set", () => {
    const savedPane = process.env["TMUX_PANE"];
    process.env["TMUX_PANE"] = "%42";
    const mockTmuxExec = vi.fn(() => "dev1-impl2@rigged-buildout\n@12\n%42");

    const result = resolveAttachContext(mockTmuxExec);

    if (savedPane === undefined) delete process.env["TMUX_PANE"];
    else process.env["TMUX_PANE"] = savedPane;

    expect(result).toEqual({
      attachmentType: "tmux",
      tmuxSession: "dev1-impl2@rigged-buildout",
      tmuxWindow: "@12",
      tmuxPane: "%42",
    });
  });
});
