import { describe, it, expect } from "vitest";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry } from "../src/domain/restore-check-service.js";

function mockDeps(overrides?: Partial<RestoreCheckDeps>): RestoreCheckDeps {
  return {
    listRigs: () => [{ rigId: "rig-1", name: "test-rig" }],
    getNodeInventory: () => [
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl",
        podId: "dev", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-rig",
        nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready",
        tmuxAttachCommand: "tmux attach -t dev-impl@test-rig",
        latestError: null,
      } as NodeInventoryEntry,
    ],
    hasSnapshot: () => true,
    probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running on port 7433" }),
    exists: () => true,
    ...overrides,
  };
}

describe("RestoreCheckService", () => {
  // --- Daemon false-green regression matrix ---

  it("daemon-down: exact 'Daemon not running' text produces red", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running — start it with: rig daemon start" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
  });

  it("daemon-down: lowercase 'daemon not running' produces red", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "daemon not running" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
  });

  it("daemon-down: empty output produces red", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
  });

  it("daemon-down: suspicious text containing 'running' non-anchored produces red", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: true, evidence: "Something is running but not the daemon" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
  });

  it("daemon-up: canonical anchored 'Daemon running' produces green", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running on port 7433" }),
    }));
    const result = service.check({});
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("green");
  });

  // --- Rig-level checks ---

  it("missing snapshot produces yellow (not red)", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({});
    const snap = result.checks.find((c) => c.check === "rig.test-rig.snapshot");
    expect(snap?.status).toBe("yellow");
  });

  // --- Seat-level checks ---

  it("missing transcript for agent node produces yellow", () => {
    const service = new RestoreCheckService(mockDeps({ exists: (p) => !p.includes(".log") }));
    const result = service.check({});
    const transcript = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.transcript");
    expect(transcript?.status).toBe("yellow");
    expect(transcript?.evidence).toContain("missing");
  });

  it("terminal/infra node transcript check is exempt (yellow, never red)", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.board",
        podId: "infra", podNamespace: "infra",
        canonicalSessionName: "infra-board@test-rig",
        nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "running", startupStatus: "ready",
        tmuxAttachCommand: null, latestError: null,
      } as NodeInventoryEntry],
      exists: () => false,
    }));
    const result = service.check({});
    const transcript = result.checks.find((c) => c.check === "seat.infra-board@test-rig.transcript");
    expect(transcript?.status).toBe("yellow");
    expect(transcript?.evidence).toContain("exempt");
  });

  it("missing queue file produces yellow", () => {
    const service = new RestoreCheckService(mockDeps({
      exists: (p) => !p.includes("queue.md"),
    }));
    const result = service.check({});
    const queue = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.queue-file");
    expect(queue?.status).toBe("yellow");
    expect(queue?.evidence).toContain("missing");
  });

  it("--no-queue skips queue file checks", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noQueue: true });
    const queueChecks = result.checks.filter((c) => c.check.includes("queue-file"));
    expect(queueChecks).toHaveLength(0);
  });

  it("--no-hooks skips hook checks", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    const hookChecks = result.checks.filter((c) => c.check.includes("hooks"));
    expect(hookChecks).toHaveLength(0);
  });

  // --- Verdict aggregation ---

  it("all green produces verdict restorable", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    expect(result.verdict).toBe("restorable");
    expect(result.counts.red).toBe(0);
    expect(result.counts.yellow).toBeGreaterThanOrEqual(0);
  });

  it("any yellow (no red) produces verdict restorable_with_caveats", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({});
    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.counts.yellow).toBeGreaterThan(0);
    expect(result.counts.red).toBe(0);
  });

  it("any red produces verdict not_restorable", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
    }));
    const result = service.check({});
    expect(result.verdict).toBe("not_restorable");
    expect(result.counts.red).toBeGreaterThan(0);
  });

  // --- Rig filter ---

  it("--rig filters to named rig only", () => {
    const service = new RestoreCheckService(mockDeps({
      listRigs: () => [
        { rigId: "rig-1", name: "rig-a" },
        { rigId: "rig-2", name: "rig-b" },
      ],
    }));
    const result = service.check({ rig: "rig-a" });
    // Only rig-specific + seat checks present — no rig-b contamination
    const rigSpecificChecks = result.checks.filter((c) => c.check.startsWith("rig.") || c.check.startsWith("seat."));
    expect(rigSpecificChecks.length).toBeGreaterThan(0);
    expect(rigSpecificChecks.some((c) => c.check.includes("rig-b"))).toBe(false);
  });

  it("--rig with unknown name produces red", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ rig: "nonexistent" });
    expect(result.verdict).toBe("not_restorable");
    const notFound = result.checks.find((c) => c.check.includes("nonexistent"));
    expect(notFound?.status).toBe("red");
  });

  // --- JSON shape ---

  it("result has repairPacket null", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    expect(result.repairPacket).toBeNull();
  });

  it("every check has check/status/evidence/remediation fields", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    for (const check of result.checks) {
      expect(typeof check.check).toBe("string");
      expect(["green", "yellow", "red"]).toContain(check.status);
      expect(typeof check.evidence).toBe("string");
      expect(typeof check.remediation).toBe("string");
    }
  });
});
