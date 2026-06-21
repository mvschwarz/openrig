import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
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
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
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
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-06-20T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

const PS_DATA = [
  { rigId: "rig-a", name: "openrig-delivery", rigName: "openrig-delivery", nodeCount: 3, runningCount: 3, status: "running", lifecycleState: "running", uptime: "2h", latestSnapshot: null },
  { rigId: "rig-b", name: "openrig-comms", rigName: "openrig-comms", nodeCount: 2, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "1h", latestSnapshot: null },
];

function makeNode(rigId: string, rigName: string, logicalId: string, opts?: {
  lifecycleState?: string;
  sessionStatus?: string;
  resumeType?: string;
  resumeToken?: string;
  resumeCommand?: string;
  heldReason?: string;
  startupCompletedAt?: string;
}) {
  return {
    rigId,
    rigName,
    logicalId,
    podId: "pod-1",
    canonicalSessionName: `${logicalId.replace(".", "-")}@${rigName}`,
    nodeKind: "agent",
    runtime: "claude-code",
    sessionStatus: opts?.sessionStatus ?? "running",
    startupStatus: "ready",
    restoreOutcome: "n-a",
    lifecycleState: opts?.lifecycleState ?? "running",
    tmuxAttachCommand: null,
    resumeCommand: opts?.resumeCommand ?? null,
    latestError: null,
    hasAssignedWork: false,
    pendingWorkCount: 0,
    resumeType: opts?.resumeType ?? null,
    resumeToken: opts?.resumeToken ?? null,
    heldReason: opts?.heldReason ?? null,
    startupCompletedAt: opts?.startupCompletedAt ?? null,
  };
}

const NODES_BY_RIG: Record<string, unknown[]> = {
  "rig-a": [
    makeNode("rig-a", "openrig-delivery", "dev1.driver", {
      resumeType: "codex_id",
      resumeToken: "019e376e-secret-token-do-not-leak",
      resumeCommand: "codex resume 019e376e-secret-token-do-not-leak",
      heldReason: "operator hold",
      startupCompletedAt: "2026-06-20T23:00:00.000Z",
    }),
    makeNode("rig-a", "openrig-delivery", "dev1.qa"),
    makeNode("rig-a", "openrig-delivery", "dev1.guard", { lifecycleState: "recoverable", sessionStatus: "detached" }),
  ],
  "rig-b": [
    makeNode("rig-b", "openrig-comms", "orch1.lead"),
    makeNode("rig-b", "openrig-comms", "content1.writer", { lifecycleState: "attention_required" }),
  ],
};

describe("OPR.0.4.0.34 — rig ps current-rig default", () => {
  let server: http.Server;
  let port: number;
  let savedSession: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const m = req.url?.match(/^\/api\/rigs\/([^/]+)\/nodes/);
      if (m && req.method === "GET") {
        const rigId = decodeURIComponent(m[1]!);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(NODES_BY_RIG[rigId] ?? []));
      } else if (req.url?.startsWith("/api/ps") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(PS_DATA));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  afterEach(() => {
    if (savedSession === undefined) delete process.env.OPENRIG_SESSION_NAME;
    else process.env.OPENRIG_SESSION_NAME = savedSession;
    savedSession = undefined;
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(runningDeps(port)));
    return prog;
  }

  function setSession(name: string) {
    savedSession = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = name;
  }

  // AC-1: rig-level defaults to current rig
  it("AC-1: bare rig ps --json returns only the caller's rig", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].rigName ?? parsed[0].name).toBe("openrig-delivery");
  });

  // AC-1: node-level defaults to current rig
  it("AC-1: bare rig ps --nodes --json returns only the current rig's nodes", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(Array.isArray(nodes)).toBe(true);
    expect(nodes.length).toBe(3);
    for (const n of nodes) {
      expect(n.rigName).toBe("openrig-delivery");
    }
  });

  // AC-1: -A restores fleet breadth
  it("AC-1: -A shows all rigs", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--json", "-A"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.length).toBe(2);
  });

  // AC-1: explicit --rig overrides caller default
  it("AC-1: explicit --rig overrides caller default", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--rig", "openrig-comms"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.length).toBe(1);
    expect(parsed[0].rigName ?? parsed[0].name).toBe("openrig-comms");
  });

  // AC-2: all-states preserved (non-running nodes visible by default)
  it("AC-2: non-running nodes appear in default (all-states)", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json"]);
    });
    const nodes = JSON.parse(logs.join(""));
    const detached = nodes.find((n: Record<string, unknown>) => n.canonicalSessionName === "dev1-guard@openrig-delivery");
    expect(detached).toBeDefined();
  });

  // AC-4: compact row has resumeType + resumeTokenPresent, NOT the token value
  it("AC-4: compact includes resumeType+resumeTokenPresent, excludes token value and resumeCommand", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json"]);
    });
    const nodes = JSON.parse(logs.join(""));
    const driver = nodes.find((n: Record<string, unknown>) => n.canonicalSessionName === "dev1-driver@openrig-delivery");
    expect(driver).toBeDefined();
    expect(driver.resumeType).toBe("codex_id");
    expect(driver.resumeTokenPresent).toBe(true);
    expect(driver.resumeToken).toBeUndefined();
    expect(driver.resumeCommand).toBeUndefined();
    const output = logs.join("");
    expect(output).not.toContain("019e376e-secret-token-do-not-leak");
  });

  // OPR.0.4.0.34 guard fix-back: compact rows must carry the full FR-4 orch
  // field set (source-available), not an underspecified subset.
  it("FR-4: compact rows carry the orch field set (rigId/logicalId/sessionStatus/startupStatus/lastActivity/heldReason) with no secret leak", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json"]);
    });
    const nodes = JSON.parse(logs.join(""));
    const driver = nodes.find((n: Record<string, unknown>) => n.canonicalSessionName === "dev1-driver@openrig-delivery");
    expect(driver).toBeDefined();
    // Required FR-4 orch identity + state fields, all present in the compact row.
    for (const key of [
      "rigId", "rigName", "logicalId", "canonicalSessionName",
      "sessionStatus", "startupStatus", "lifecycleState",
      "agentActivity", "hasAssignedWork", "pendingWorkCount",
      "resumeType", "resumeTokenPresent", "lastActivity",
    ]) {
      expect(driver, `compact row missing FR-4 key: ${key}`).toHaveProperty(key);
    }
    expect(driver.rigId).toBe("rig-a");
    expect(driver.logicalId).toBe("dev1.driver");
    expect(driver.sessionStatus).toBe("running");
    expect(driver.startupStatus).toBe("ready");
    // updated/age proxy: agentActivity.sampledAt then startupCompletedAt then null.
    expect(driver.lastActivity).toBe("2026-06-20T23:00:00.000Z");
    // held/attention reason surfaced (short).
    expect(driver.heldReason).toBe("operator hold");
    // Secret absence holds even with the wider field set.
    expect(driver.resumeToken).toBeUndefined();
    expect(driver.resumeCommand).toBeUndefined();
  });

  // AC-4: --full includes the token value
  it("AC-4: --full includes resumeToken and resumeCommand", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--full"]);
    });
    const nodes = JSON.parse(logs.join(""));
    const driver = nodes.find((n: Record<string, unknown>) => n.canonicalSessionName === "dev1-driver@openrig-delivery");
    expect(driver.resumeToken).toBe("019e376e-secret-token-do-not-leak");
    expect(driver.resumeCommand).toBe("codex resume 019e376e-secret-token-do-not-leak");
  });

  // AC-5: --running is alias for --active
  it("AC-5: --running is alias for --active", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs: activeLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--active"]);
    });
    const { logs: runningLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--running"]);
    });
    expect(activeLogs.join("")).toBe(runningLogs.join(""));
  });

  // AC-5: --running + --filter conflict
  it("AC-5: --running + --filter is rejected", async () => {
    setSession("dev1-driver@openrig-delivery");
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--running", "--filter", "status=running"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("cannot be combined"))).toBe(true);
  });
});
