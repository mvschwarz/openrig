import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { whoamiCommand, resolveIdentitySource } from "../src/commands/whoami.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" ")); console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-03T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

const WHOAMI_RESPONSE = {
  resolvedBy: "node_id",
  identity: {
    rigId: "rig-1", rigName: "my-rig", nodeId: "node-1", logicalId: "dev.impl",
    podId: "dev", podLabel: "Development", memberId: "impl", memberLabel: "Implementer",
    sessionName: "dev-impl@my-rig", runtime: "claude-code", cwd: "/tmp",
    agentRef: "local:agents/impl", profile: "default",
    resolvedSpecName: "impl", resolvedSpecVersion: "1.0",
  },
  peers: [{ logicalId: "dev.qa", sessionName: "dev-qa@my-rig", runtime: "codex", podId: "dev", memberId: "qa" }],
  edges: {
    outgoing: [{ kind: "delegates_to", to: { logicalId: "dev.qa", sessionName: "dev-qa@my-rig" } }],
    incoming: [],
  },
  transcript: { enabled: true, path: "/tmp/transcripts/my-rig/dev-impl@my-rig.log", tailCommand: "rigged transcript dev-impl@my-rig --tail 100", grepCommand: null },
  commands: { sendExamples: ["rigged send dev-qa@my-rig 'message' --verify"], captureExamples: ["rigged capture dev-qa@my-rig"] },
};

describe("Whoami CLI", () => {
  let server: http.Server;
  let port: number;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url.includes("/api/whoami") && url.includes("nodeId=node-1")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(WHOAMI_RESPONSE));
      } else if (url.includes("/api/whoami") && url.includes("sessionName=dev-impl")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...WHOAMI_RESPONSE, resolvedBy: "session_name" }));
      } else if (url.includes("/api/whoami") && url.includes("sessionName=unknown")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found in any managed rig. Check: rigged ps --nodes" }));
      } else if (url.includes("/api/whoami") && url.includes("sessionName=ambiguous")) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session 'ambiguous' is ambiguous — found in 2 rigs." }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  beforeEach(() => {
    savedEnv = {
      RIGGED_NODE_ID: process.env["RIGGED_NODE_ID"],
      RIGGED_SESSION_NAME: process.env["RIGGED_SESSION_NAME"],
      TMUX_PANE: process.env["TMUX_PANE"],
    };
    delete process.env["RIGGED_NODE_ID"];
    delete process.env["RIGGED_SESSION_NAME"];
    delete process.env["TMUX_PANE"];
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(whoamiCommand(runningDeps(port)));
    return prog;
  }

  it("--node-id flag resolves and prints identity", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami", "--node-id", "node-1"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("my-rig");
    expect(output).toContain("dev-impl@my-rig");
  });

  it("--session flag resolves and prints identity", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami", "--session", "dev-impl@my-rig"]);
    });
    expect(logs.join("\n")).toContain("my-rig");
  });

  it("RIGGED_NODE_ID env var resolves when no flags given", async () => {
    process.env["RIGGED_NODE_ID"] = "node-1";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami"]);
    });
    expect(logs.join("\n")).toContain("my-rig");
  });

  it("RIGGED_SESSION_NAME env var resolves when no node-id env", async () => {
    process.env["RIGGED_SESSION_NAME"] = "dev-impl@my-rig";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami"]);
    });
    expect(logs.join("\n")).toContain("my-rig");
  });

  it("TMUX_PANE resolves via tmux display-message to exact session name", () => {
    // Test the resolution function directly with a controlled tmux mock
    process.env["TMUX_PANE"] = "%42";
    const mockTmuxExec = vi.fn(() => "dev-impl@my-rig");

    const result = resolveIdentitySource({}, mockTmuxExec);

    expect(mockTmuxExec).toHaveBeenCalledOnce();
    expect(mockTmuxExec.mock.calls[0]![0]).toContain("%42");
    expect(result).toEqual({ sessionName: "dev-impl@my-rig" });
  });

  it("--json prints raw daemon JSON response", async () => {
    process.env["RIGGED_NODE_ID"] = "node-1";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.resolvedBy).toBe("node_id");
    expect(parsed.identity.logicalId).toBe("dev.impl");
    expect(parsed.peers).toBeDefined();
    expect(parsed.edges).toBeDefined();
  });

  it("no resolution source → exit 1 with guidance", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Cannot determine identity");
  });

  it("daemon 404 → exit 1 with not-found guidance", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami", "--session", "unknown"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("not found");
  });

  it("daemon 409 → exit 1 with ambiguity message", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami", "--session", "ambiguous"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("ambiguous");
  });

  it("human output includes rig, pod, session, peers, edges, transcript", async () => {
    process.env["RIGGED_NODE_ID"] = "node-1";
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "whoami"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Rig:");
    expect(output).toContain("my-rig");
    expect(output).toContain("Logical ID:");
    expect(output).toContain("dev.impl");
    expect(output).toContain("Pod:");
    expect(output).toContain("Session:");
    expect(output).toContain("dev-impl@my-rig");
    expect(output).toContain("Peers:");
    expect(output).toContain("dev.qa");
    expect(output).toContain("Edges:");
    expect(output).toContain("delegates_to");
    expect(output).toContain("Transcript:");
  });
});
