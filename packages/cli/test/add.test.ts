import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { Command } from "commander";
import { addMemberCommand } from "../src/commands/add.js";
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
  result: {
    podId: "pod-123",
    podNamespace: "infra",
    node: { logicalId: "infra.server2", nodeId: "n2", status: "launched", sessionName: "infra-server2@test" },
    warnings: [],
  },
};

const CONFLICT_RESPONSE = {
  ok: false,
  code: "member_conflict",
  message: 'Member "infra.server" already exists in rig "test". Pick a different member id, or remove the existing seat first.',
};

const NOT_FOUND_RESPONSE = {
  ok: false,
  code: "pod_not_found",
  message: 'Pod "nope" not found in rig "test". Existing pods: infra. Check the namespace, or add a new pod with `rig expand`.',
};

const FAILED_LAUNCH_RESPONSE = {
  ok: true,
  result: {
    podId: "pod-123",
    podNamespace: "infra",
    node: { logicalId: "infra.server2", nodeId: "n2", status: "failed", error: "harness launch failed" },
    warnings: [],
  },
};

describe("rig add", () => {
  let server: http.Server;
  let port: number;
  let tmpDir: string;
  let fragmentPath: string;
  let capturedBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url?.includes("/members")) {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          capturedBody = parsed;
          const memberId = parsed.member?.id;
          if (req.url?.includes("/nope/")) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify(NOT_FOUND_RESPONSE));
          } else if (memberId === "server") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify(CONFLICT_RESPONSE));
          } else if (memberId === "failer") {
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(FAILED_LAUNCH_RESPONSE));
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
    tmpDir = join(tmpdir(), `add-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    fragmentPath = join(tmpDir, "member.yaml");
    writeFileSync(fragmentPath, `id: server2\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
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
    prog.addCommand(addMemberCommand(deps ?? runningDeps()));
    return prog;
  }

  it("parses rig-id, pod-namespace, and member-fragment-path", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    const output = logs.join("\n");
    expect(output).toContain("infra.server2");
    expect(output).toContain("OK");
  });

  it("--json returns the raw API response", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath, "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.node.logicalId).toBe("infra.server2");
  });

  it("human output shows the launched member with its session", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    const output = logs.join("\n");
    expect(output).toContain("[OK] infra.server2");
    expect(output).toContain("infra-server2@test");
  });

  it("duplicate member id -> exit 1 with the honest conflict message", async () => {
    writeFileSync(fragmentPath, `id: server\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    expect(exitCode).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("already exists");
    expect(output).toContain("Pick a different member id");
  });

  it("pod not found -> exit 1 with the honest not-found message", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "nope", fragmentPath]);
    });
    expect(exitCode).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("not found");
    expect(output).toContain("Existing pods: infra");
  });

  it("launched-but-failed node -> exit 1 (status surfaced)", async () => {
    writeFileSync(fragmentPath, `id: failer\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    expect(exitCode).toBe(1);
    const output = logs.join("\n");
    expect(output).toContain("[FAIL] infra.server2");
    expect(output).toContain("harness launch failed");
  });

  it("--json exits non-zero when the new node did not launch", async () => {
    writeFileSync(fragmentPath, `id: failer\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\n`);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath, "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.result.node.status).toBe("failed");
    expect(exitCode).toBe(1);
  });

  it("wired via createProgram", async () => {
    const { createProgram } = await import("../src/index.js");
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "add");
    expect(cmd).toBeDefined();
  });

  // Governance FM2: rig add must NOT silently strip pod-local edges from the
  // fragment file - they must reach the daemon, in both wrapper and bare forms.
  it("forwards wrapper-form edges to the daemon (not stripped)", async () => {
    capturedBody = null;
    writeFileSync(fragmentPath, `member:\n  id: server2\n  runtime: terminal\n  agent_ref: "builtin:terminal"\n  profile: none\n  cwd: /tmp\nedges:\n  - from: server2\n    to: server\n    kind: delegates_to\n`);
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    expect(capturedBody).not.toBeNull();
    expect((capturedBody as { member: { id: string } }).member.id).toBe("server2");
    expect((capturedBody as { edges: unknown[] }).edges).toEqual([{ from: "server2", to: "server", kind: "delegates_to" }]);
  });

  it("lifts bare-form top-level edges out to pod-local edges (not dropped into the member)", async () => {
    capturedBody = null;
    writeFileSync(fragmentPath, `id: server2\nruntime: terminal\nagent_ref: "builtin:terminal"\nprofile: none\ncwd: /tmp\nedges:\n  - from: server2\n    to: server\n    kind: delegates_to\n`);
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    const sent = capturedBody as { member: Record<string, unknown>; edges: unknown[] };
    expect(sent.edges).toEqual([{ from: "server2", to: "server", kind: "delegates_to" }]);
    // edges lifted OUT of the member, not silently carried as an ignored field.
    expect(sent.member["edges"]).toBeUndefined();
    expect(sent.member["id"]).toBe("server2");
  });

  it("rejects a present-but-non-array edges field (exit 1, never posted, no silent omit)", async () => {
    capturedBody = null;
    writeFileSync(fragmentPath, `member:\n  id: server2\n  runtime: terminal\n  agent_ref: "builtin:terminal"\n  profile: none\n  cwd: /tmp\nedges: not-an-array\n`);
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "add", "rig-123", "infra", fragmentPath]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("edges");
    // Rejected before the POST - never silently omitted and sent.
    expect(capturedBody).toBeNull();
  });
});
