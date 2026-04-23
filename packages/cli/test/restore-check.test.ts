import { describe, it, expect, vi, beforeEach } from "vitest";
import { restoreCheckCommand, type RestoreCheckDeps } from "../src/commands/restore-check.js";

function makeResult(overrides?: Record<string, unknown>) {
  return {
    verdict: "restorable",
    counts: { red: 0, yellow: 1, green: 5 },
    checks: [
      { check: "daemon.reachable", status: "green", evidence: "Daemon running on port 7433", remediation: "" },
      { check: "host.state-dir-writable", status: "green", evidence: "~/.openrig/ is writable", remediation: "" },
      { check: "rig.test-rig.snapshot", status: "yellow", evidence: "No snapshot found", remediation: "Create a snapshot" },
    ],
    repairPacket: null,
    ...overrides,
  };
}

function makeDeps(overrides?: {
  daemonDown?: boolean;
  result?: Record<string, unknown>;
  serverError?: boolean;
}): { deps: RestoreCheckDeps; requestedPaths: string[] } {
  const requestedPaths: string[] = [];
  return {
    requestedPaths,
    deps: {
      lifecycleDeps: {} as RestoreCheckDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          requestedPaths.push(path);
          if (overrides?.serverError) return { status: 500, data: { error: "internal error" } };
          return { status: 200, data: makeResult(overrides?.result) };
        }),
      }) as unknown as ReturnType<RestoreCheckDeps["clientFactory"]>,
    },
  };
}

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

describe("rig restore-check", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });

  it("JSON output has verdict + counts + checks + repairPacket", async () => {
    const { deps } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("restorable");
    expect(json.counts).toBeDefined();
    expect(json.checks).toBeInstanceOf(Array);
    expect(json.repairPacket).toBeNull();
    expect(json.checks[0].check).toBeDefined();
    expect(json.checks[0].status).toBeDefined();
    expect(json.checks[0].evidence).toBeDefined();
    expect(json.checks[0].remediation).toBeDefined();
  });

  it("human output includes verdict + check details + remediation", async () => {
    const { deps } = makeDeps({ result: { verdict: "restorable_with_caveats" } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).toContain("RESTORE CHECK");
    expect(output).toContain("RESTORABLE WITH CAVEATS");
    expect(output).toContain("daemon.reachable");
  });

  it("exit 0 for restorable verdict", async () => {
    const { deps } = makeDeps({ result: { verdict: "restorable" } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("exit 0 for restorable_with_caveats verdict", async () => {
    const { deps } = makeDeps({ result: { verdict: "restorable_with_caveats" } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("exit 1 for not_restorable verdict", async () => {
    const { deps } = makeDeps({ result: { verdict: "not_restorable", counts: { red: 1, yellow: 0, green: 0 } } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);
    expect(process.exitCode).toBe(1);
  });

  it("exit 2 for unknown verdict", async () => {
    const { deps } = makeDeps({ result: { verdict: "unknown", counts: { red: 0, yellow: 0, green: 0 } } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);
    expect(process.exitCode).toBe(2);
  });

  it("exit 2 on daemon 500 error with blocking repairPacket", async () => {
    const { deps } = makeDeps({ serverError: true });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);
    expect(process.exitCode).toBe(2);
    const json = JSON.parse(logs.join(""));
    expect(json.repairPacket).not.toBeNull();
    expect(json.repairPacket[0].blocking).toBe(true);
    expect(json.repairPacket[0].command).toContain("rig daemon logs");
  });

  it("human output shows repair step count when repairPacket is non-null", async () => {
    const { deps } = makeDeps({ result: {
      verdict: "not_restorable",
      counts: { red: 1, yellow: 1, green: 3 },
      repairPacket: [
        { step: 1, command: "Start the daemon", rationale: "Daemon down", safe: false, blocking: true },
        { step: 2, command: "Create snapshot", rationale: "No snapshot", safe: false, blocking: false },
      ],
    }});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).toContain("Repair steps: 2");
    expect(output).toContain("1 blocking");
    expect(output).toContain("1 caveats");
  });

  it("--rig passes through to daemon route query", async () => {
    const { deps, requestedPaths } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--rig", "openrig-pm", "--json"]);

    expect(requestedPaths.some((p) => p.includes("rig=openrig-pm"))).toBe(true);
  });

  it("--no-queue passes through to daemon route query", async () => {
    const { deps, requestedPaths } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--no-queue", "--json"]);

    expect(requestedPaths.some((p) => p.includes("noQueue=true"))).toBe(true);
  });

  it("--no-hooks passes through to daemon route query", async () => {
    const { deps, requestedPaths } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--no-hooks", "--json"]);

    expect(requestedPaths.some((p) => p.includes("noHooks=true"))).toBe(true);
  });

  it("daemon-down produces not_restorable locally without daemon call", async () => {
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "stopped", healthy: false });

    const { deps, requestedPaths } = makeDeps();
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("not_restorable");
    expect(json.checks[0].check).toBe("daemon.reachable");
    expect(json.checks[0].status).toBe("red");
    // Daemon-down local result includes repairPacket with blocking step
    expect(json.repairPacket).not.toBeNull();
    expect(json.repairPacket[0].blocking).toBe(true);
    expect(json.repairPacket[0].command).toContain("rig daemon start");
    expect(process.exitCode).toBe(1);
    // Should NOT have called the daemon
    expect(requestedPaths).toHaveLength(0);
  });
});
