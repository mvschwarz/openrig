import { describe, it, expect, vi, beforeEach } from "vitest";
import { restoreCheckCommand, type RestoreCheckDeps } from "../src/commands/restore-check.js";

function makeResult(overrides?: Record<string, unknown>) {
  return {
    verdict: "restorable",
    readiness: {
      status: "ready",
      reason: "all_observable_checks_green",
      blockingRigCount: 0,
      caveatRigCount: 0,
      unknownRigCount: 0,
    },
    continuity: {
      status: "not_proven",
      evidence: "Strict same-session/provider-context resume is not verified by restore-check v1. Observable readiness is verified.",
      provenCapabilities: [],
      unprovenCapabilities: ["provider_session_resume", "context_window_preservation", "interrupted_work_functional_resume"],
    },
    rigs: [{
      rigId: "rig-1",
      rigName: "test-rig",
      status: "ready",
      verdict: "restorable",
      expectedNodes: 1,
      runningReadyNodes: 1,
      blockedNodes: 0,
      caveatNodes: 0,
      blockingChecks: [],
      caveatChecks: [],
    }],
    hostInfra: {
      status: "not_inspected",
      evidence: "No host bootstrap/autostart source inspected by v0",
    },
    counts: { red: 0, yellow: 1, green: 5 },
    checks: [
      { check: "daemon.reachable", status: "green", evidence: "Daemon running on port 7433", remediation: "" },
      { check: "host.state-dir-writable", status: "green", evidence: "~/.openrig/ is writable", remediation: "" },
      { check: "rig.test-rig.snapshot", status: "yellow", evidence: "No snapshot found", remediation: "Create a snapshot" },
    ],
    repairPacket: null,
    recovery: {
      status: "not_needed",
      summary: "All observable rigs are already running/ready; no recovery action needed.",
      actions: [],
      blocked: [],
      unknown: [],
    },
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
    expect(json.readiness.status).toBe("ready");
    expect(json.continuity).toBeDefined();
    expect(json.rigs).toBeInstanceOf(Array);
    expect(json.hostInfra.status).toBe("not_inspected");
    expect(json.counts).toBeDefined();
    expect(json.checks).toBeInstanceOf(Array);
    expect(json.repairPacket).toBeNull();
    expect(json.recovery).toEqual(expect.objectContaining({
      status: "not_needed",
      actions: [],
      blocked: [],
      unknown: [],
    }));
    expect(json.checks[0].check).toBeDefined();
    expect(json.checks[0].status).toBeDefined();
    expect(json.checks[0].evidence).toBeDefined();
    expect(json.checks[0].remediation).toBeDefined();
  });

  it("JSON output preserves declared host-infra status and evidence", async () => {
    const { deps } = makeDeps({
      result: {
        hostInfra: {
          status: "declared",
          evidence: "Host infra declaration at /tmp/openrig/host-infra.json declared, not verified; daemonBootstrap mechanism=launchd; requiredSupportingInfra=1",
        },
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.hostInfra.status).toBe("declared");
    expect(json.hostInfra.evidence).toContain("declared, not verified");
    expect(json.hostInfra.evidence).toContain("mechanism=launchd");
  });

  it("human output includes verdict + check details + remediation", async () => {
    const { deps } = makeDeps({ result: { verdict: "restorable_with_caveats" } });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).toContain("RESTORE CHECK");
    expect(output).toContain("RESTORABLE WITH CAVEATS");
    expect(output).toContain("READINESS:");
    expect(output).toContain("Per-rig summary");
    expect(output).toContain("test-rig");
    expect(output).toContain("Host bootstrap/autostart");
    expect(output).toContain("RECOVERY:");
    expect(output).toContain("daemon.reachable");
  });

  it("human output includes exact recovery action commands", async () => {
    const { deps } = makeDeps({
      result: {
        verdict: "not_restorable",
        readiness: {
          status: "not_ready",
          reason: "blockers_present",
          blockingRigCount: 1,
          caveatRigCount: 0,
          unknownRigCount: 0,
        },
        recovery: {
          status: "actionable",
          summary: "1 rig can be recovered by known OpenRig command; 0 blocked; 0 unknown.",
          actions: [
            {
              scope: "rig",
              rigId: "rig-1",
              rigName: "test-rig",
              action: "restore_from_latest_snapshot",
              command: "rig up --existing test-rig",
              reason: "Rig has a latest snapshot and one or more seats are not running/ready.",
              safe: false,
              blocking: true,
            },
          ],
          blocked: [],
          unknown: [],
        },
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).toContain("RECOVERY: ACTIONABLE");
    expect(output).toContain("rig up --existing test-rig");
    expect(output).toContain("1 rig can be recovered");
  });

  it("human output shows declared-not-verified host-infra evidence", async () => {
    const { deps } = makeDeps({
      result: {
        readiness: {
          status: "ready",
          reason: "all_observable_checks_green_host_infra_declared_not_verified",
          blockingRigCount: 0,
          caveatRigCount: 0,
          unknownRigCount: 0,
        },
        hostInfra: {
          status: "declared",
          evidence: "Host infra declaration at /tmp/openrig/host-infra.json declared, not verified; daemonBootstrap mechanism=launchd; requiredSupportingInfra=1",
        },
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).toContain("READINESS: ready (all_observable_checks_green_host_infra_declared_not_verified)");
    expect(output).toContain("Host bootstrap/autostart: declared");
    expect(output).toContain("declared, not verified");
    expect(output).toContain("mechanism=launchd");
  });

  it("JSON output preserves host-infra evidence-path presence copy", async () => {
    const { deps } = makeDeps({
      result: {
        hostInfra: {
          status: "declared",
          evidence: "Host infra declaration at /tmp/openrig/host-infra.json declared, evidence paths present, not autostart verified; daemonBootstrap mechanism=launchd; requiredSupportingInfra=1; evidencePaths=/tmp/openrig/daemon/launchd.plist,/tmp/openrig/supervisor-wake/README.md",
        },
        checks: [
          { check: "host.bootstrap-autostart.declaration", status: "green", evidence: "declared, evidence paths present, not autostart verified", remediation: "" },
        ],
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.hostInfra.status).toBe("declared");
    expect(json.hostInfra.evidence).toContain("evidence paths present");
    expect(json.hostInfra.evidence).toContain("not autostart verified");
    expect(json.checks[0].evidence).toContain("not autostart verified");
  });

  it("human output preserves missing host-infra evidence-path repair guidance", async () => {
    const missingPath = "/tmp/openrig/supervisor-wake/README.md";
    const { deps } = makeDeps({
      result: {
        verdict: "restorable_with_caveats",
        readiness: {
          status: "ready_with_caveats",
          reason: "caveats_present",
          blockingRigCount: 0,
          caveatRigCount: 0,
          unknownRigCount: 0,
        },
        hostInfra: {
          status: "declared",
          evidence: `Host infra declaration at /tmp/openrig/host-infra.json declared with insufficient evidence paths; missing ${missingPath}`,
        },
        counts: { red: 0, yellow: 1, green: 4 },
        checks: [
          { check: "host.bootstrap-autostart.declaration", status: "yellow", evidence: `Missing required evidence path: ${missingPath}`, remediation: `Add or repair host infra evidence path: ${missingPath}` },
        ],
        repairPacket: [
          { step: 1, command: `Add or repair host infra evidence path: ${missingPath}`, rationale: `Missing required evidence path: ${missingPath}`, safe: false, blocking: false },
        ],
      },
    });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).toContain("RESTORABLE WITH CAVEATS");
    expect(output).toContain(missingPath);
    expect(output).toContain("Repair steps: 1");
    expect(output).toContain("0 blocking");
    expect(output).toContain("1 caveats");
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
    expect(json.readiness.status).toBe("not_ready");
    expect(json.rigs).toEqual([]);
    expect(json.hostInfra.status).toBe("unknown");
    expect(json.checks[0].check).toBe("daemon.reachable");
    expect(json.checks[0].status).toBe("red");
    expect(json.recovery).toEqual(expect.objectContaining({
      status: "blocked",
      actions: [],
      unknown: [],
      blocked: [
        expect.objectContaining({
          scope: "host",
          reason: expect.stringContaining("Daemon is not running"),
        }),
      ],
    }));
    // Daemon-down local result includes repairPacket with blocking step
    expect(json.repairPacket).not.toBeNull();
    expect(json.repairPacket[0].blocking).toBe(true);
    expect(json.repairPacket[0].command).toContain("rig daemon start");
    expect(process.exitCode).toBe(1);
    // Should NOT have called the daemon
    expect(requestedPaths).toHaveLength(0);
  });

  it("daemon 500 local fallback includes readiness shape", async () => {
    const { deps } = makeDeps({ serverError: true });
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect(json.verdict).toBe("unknown");
    expect(json.readiness).toEqual(expect.objectContaining({
      status: "unknown",
      reason: "unknown_probe_state",
    }));
    expect(json.rigs).toEqual([]);
    expect(json.hostInfra.status).toBe("unknown");
    expect(json.recovery).toEqual(expect.objectContaining({
      status: "unknown",
      actions: [],
      blocked: [],
      unknown: [
        expect.objectContaining({
          scope: "host",
          reason: expect.stringContaining("HTTP 500"),
        }),
      ],
    }));
    expect(json.repairPacket[0]).toEqual(expect.objectContaining({
      blocking: true,
      safe: true,
    }));
  });

  // --- H62 absence proofs ---

  it("JSON output has no fullyBack or assertion fields", async () => {
    const { deps } = makeDeps({});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect("fullyBack" in json).toBe(false);
    expect("assertion" in json).toBe(false);
    expect(json.readiness).toBeDefined();
    expect(json.continuity).toBeDefined();
  });

  it("human output has no FULLY BACK line", async () => {
    const { deps } = makeDeps({});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig"]);

    const output = logs.join("\n");
    expect(output).not.toContain("FULLY BACK");
    expect(output).toContain("READINESS:");
    expect(output).toContain("CONTINUITY:");
  });

  it("daemon-down CLI fallback emits readiness + continuity with no legacy fields", async () => {
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    (getDaemonStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "stopped", healthy: false });

    const { deps } = makeDeps({});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    expect("fullyBack" in json).toBe(false);
    expect("assertion" in json).toBe(false);
    expect(json.readiness.status).toBe("not_ready");
    expect(json.continuity.status).toBe("not_proven");
    expect(json.continuity.unprovenCapabilities.length).toBeGreaterThan(0);
  });

  it("per-rig status values use readiness vocabulary", async () => {
    const { deps } = makeDeps({});
    const cmd = restoreCheckCommand(deps);
    await cmd.parseAsync(["node", "rig", "--json"]);

    const json = JSON.parse(logs.join(""));
    for (const rig of json.rigs) {
      expect(["ready", "ready_with_caveats", "not_ready", "unknown"]).toContain(rig.status);
      expect(rig.status).not.toBe("fully_back");
      expect(rig.status).not.toBe("not_fully_back");
    }
  });
});
