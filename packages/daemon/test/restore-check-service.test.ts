import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

  // --- Probe error → unknown (not not_restorable) ---

  it("probeDaemonHealth throw produces verdict unknown (not not_restorable)", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));
    const result = service.check({});
    expect(result.verdict).toBe("unknown");
    const daemon = result.checks.find((c) => c.check === "daemon.reachable");
    expect(daemon?.status).toBe("red");
    expect(daemon?.evidence).toContain("unable to determine");
  });

  it("listRigs probe error produces verdict unknown (not not_restorable)", () => {
    const service = new RestoreCheckService(mockDeps({
      listRigs: () => { throw new Error("database locked"); },
    }));
    const result = service.check({});
    expect(result.verdict).toBe("unknown");
    const probe = result.checks.find((c) => c.check === "probe.error");
    expect(probe?.status).toBe("red");
    expect(probe?.evidence).toContain("database locked");
  });

  it("getNodeInventory probe error produces verdict unknown", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => { throw new Error("query timeout"); },
    }));
    const result = service.check({});
    expect(result.verdict).toBe("unknown");
  });

  // --- Read-only invariant ---

  it("state-dir check does not create probe file or mutate directory mtime (read-only)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-readonly-"));
    const probePath = path.join(tmpDir, ".restore-check-probe");
    const previous = process.env["OPENRIG_HOME"];

    // Pin mtime to a known past value so any mutation is detectable
    fs.utimesSync(tmpDir, new Date(946684800000), new Date(946684800000));
    const before = fs.statSync(tmpDir).mtimeMs;

    process.env["OPENRIG_HOME"] = tmpDir;
    try {
      const service = new RestoreCheckService(mockDeps());
      const result = service.check({ noQueue: true, noHooks: true });

      // No probe file created
      expect(fs.existsSync(probePath)).toBe(false);
      // Directory mtime unchanged — no filesystem mutation
      expect(fs.statSync(tmpDir).mtimeMs).toBe(before);
      // Check itself ran and produced a result
      const stateDir = result.checks.find((c) => c.check === "host.state-dir-writable");
      expect(stateDir).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- Rig spec/root checks ---

  it("missing rig root produces spec-present red", () => {
    const service = new RestoreCheckService(mockDeps({
      exists: (p) => !p.includes("rigs/test-rig"),
    }));
    const result = service.check({});
    const spec = result.checks.find((c) => c.check === "rig.test-rig.spec-present");
    expect(spec?.status).toBe("red");
    expect(spec?.evidence).toContain("Rig root missing");
  });

  it("rig root exists but rig.yaml missing produces spec-present yellow", () => {
    const service = new RestoreCheckService(mockDeps({
      exists: (p) => !p.endsWith("rig.yaml"),
    }));
    const result = service.check({});
    const spec = result.checks.find((c) => c.check === "rig.test-rig.spec-present");
    expect(spec?.status).toBe("yellow");
    expect(spec?.evidence).toContain("rig.yaml missing");
  });

  it("rig root + rig.yaml present produces spec-present green", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    const spec = result.checks.find((c) => c.check === "rig.test-rig.spec-present");
    expect(spec?.status).toBe("green");
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

  it("terminal/infra node transcript check is exempt without creating a caveat", () => {
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
    expect(transcript?.status).toBe("green");
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

  it("hooks without --no-hooks are honestly yellow (not false-green)", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    const hookChecks = result.checks.filter((c) => c.check.includes("hooks"));
    expect(hookChecks.length).toBeGreaterThan(0);
    for (const hook of hookChecks) {
      expect(hook.status).toBe("yellow");
      expect(hook.evidence).toContain("not yet implemented");
    }
  });

  // --- Verdict aggregation ---

  it("all green produces verdict restorable (with --no-hooks to avoid yellow placeholder)", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true }) as any;
    expect(result.verdict).toBe("restorable");
    expect(result.counts.red).toBe(0);
    expect(result.fullyBack).toBe(true);
    expect(result.assertion).toEqual(expect.objectContaining({
      level: "host",
      status: "fully_back",
      reason: "observable_rigs_fully_back",
      blockingRigCount: 0,
      caveatRigCount: 0,
      unknownRigCount: 0,
    }));
    expect(result.hostInfra).toEqual(expect.objectContaining({
      status: "not_inspected",
    }));
    expect(result.rigs).toEqual([
      expect.objectContaining({
        rigId: "rig-1",
        rigName: "test-rig",
        status: "fully_back",
        expectedNodes: 1,
        runningReadyNodes: 1,
        blockedNodes: 0,
        caveatNodes: 0,
        blockingChecks: [],
        caveatChecks: [],
      }),
    ]);
  });

  it("any yellow (no red) produces verdict restorable_with_caveats", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({}) as any;
    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.fullyBack).toBe(false);
    expect(result.assertion.status).toBe("not_fully_back");
    expect(result.assertion.reason).toBe("caveats_present");
    expect(result.assertion.caveatRigCount).toBeGreaterThan(0);
    expect(result.counts.yellow).toBeGreaterThan(0);
    expect(result.counts.red).toBe(0);
  });

  it("any red produces verdict not_restorable", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
    }));
    const result = service.check({}) as any;
    expect(result.verdict).toBe("not_restorable");
    expect(result.fullyBack).toBe(false);
    expect(result.assertion.status).toBe("not_fully_back");
    expect(result.assertion.blockingRigCount).toBeGreaterThanOrEqual(0);
    expect(result.counts.red).toBeGreaterThan(0);
  });

  it("probe error produces unknown fully-back assertion, not false green", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));
    const result = service.check({}) as any;

    expect(result.verdict).toBe("unknown");
    expect(result.fullyBack).toBe(false);
    expect(result.assertion).toEqual(expect.objectContaining({
      status: "unknown",
      reason: "unknown_probe_state",
    }));
  });

  it("stopped infrastructure node is represented in readiness and prevents fully_back", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.board",
        podId: "infra", podNamespace: "infra",
        canonicalSessionName: "infra-board@test-rig",
        nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "stopped", startupStatus: "ready",
        tmuxAttachCommand: null, latestError: null,
      } as NodeInventoryEntry],
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.fullyBack).toBe(false);
    expect(result.assertion.blockingRigCount).toBe(1);
    expect(result.rigs[0]).toEqual(expect.objectContaining({
      expectedNodes: 1,
      runningReadyNodes: 0,
      blockedNodes: 1,
      status: "not_fully_back",
    }));
    expect(result.rigs[0].blockingChecks.some((check: { check: string }) => check.check.includes("readiness"))).toBe(true);
    expect(result.repairPacket?.some((step: { blocking: boolean; safe: boolean }) => step.blocking && step.safe === false)).toBe(true);
  });

  it("running infrastructure node counts ready while transcript-exempt", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.board",
        podId: "infra", podNamespace: "infra",
        canonicalSessionName: "infra-board@test-rig",
        nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "running", startupStatus: "ready",
        tmuxAttachCommand: "tmux attach -t infra-board@test-rig", latestError: null,
      } as NodeInventoryEntry],
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.verdict).toBe("restorable");
    expect(result.fullyBack).toBe(true);
    expect(result.rigs[0]).toEqual(expect.objectContaining({
      expectedNodes: 1,
      runningReadyNodes: 1,
      blockedNodes: 0,
      caveatNodes: 0,
    }));
    const transcript = result.checks.find((check: { check: string }) => check.check === "seat.infra-board@test-rig.transcript");
    expect(transcript.status).toBe("green");
  });

  it("missing canonical session identity blocks fully_back", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl",
        podId: "dev", podNamespace: "dev",
        canonicalSessionName: null,
        nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready",
        tmuxAttachCommand: null, latestError: null,
      } as NodeInventoryEntry],
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.fullyBack).toBe(false);
    expect(result.rigs[0].blockingChecks.some((check: { check: string; evidence: string }) => (
      check.check.includes("readiness") && check.evidence.includes("canonical session")
    ))).toBe(true);
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

  it("restorable result has repairPacket null", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    expect(result.verdict).toBe("restorable");
    expect(result.repairPacket).toBeNull();
  });

  it("not_restorable result includes blocking repair steps with explicit severity", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
    }));

    const result = service.check({ noHooks: true });

    expect(result.verdict).toBe("not_restorable");
    expect(result.repairPacket).toEqual([
      expect.objectContaining({
        step: 1,
        command: "Start the daemon with: rig daemon start",
        rationale: "Daemon not running",
        blocking: true,
        safe: expect.any(Boolean),
      }),
    ]);
  });

  it("restorable_with_caveats result includes non-blocking repair steps with prose actions", () => {
    const service = new RestoreCheckService(mockDeps({
      exists: (p) => !p.includes(".log"),
    }));

    const result = service.check({ noHooks: true });

    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.repairPacket).toEqual([
      expect.objectContaining({
        step: 1,
        command: "Transcript will be created on next session launch",
        rationale: expect.stringContaining("Transcript missing"),
        blocking: false,
        safe: expect.any(Boolean),
      }),
    ]);
  });

  it("repairPacket orders blockers before caveats and keeps 1-indexed steps", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
      hasSnapshot: () => false,
    }));

    const result = service.check({ noHooks: true });
    const packet = result.repairPacket as Array<{ step: number; command: string; blocking: boolean }> | null;

    expect(packet).not.toBeNull();
    expect(packet?.map((entry) => entry.step)).toEqual([1, 2]);
    expect(packet?.[0]).toEqual(expect.objectContaining({
      command: "Start the daemon with: rig daemon start",
      blocking: true,
    }));
    expect(packet?.[1]).toEqual(expect.objectContaining({
      command: "Create a snapshot with: rig snapshot <rigId>",
      blocking: false,
    }));
  });

  it("unknown result includes restore-blocking probe repair steps without changing verdict", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));

    const result = service.check({});

    expect(result.verdict).toBe("unknown");
    expect(result.repairPacket).toEqual([
      expect.objectContaining({
        step: 1,
        command: "Start the daemon with: rig daemon start",
        rationale: expect.stringContaining("unable to determine state"),
        blocking: true,
        safe: expect.any(Boolean),
      }),
    ]);
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

  // --- Slice 2: repair packet ---

  it("not_restorable verdict has repairPacket with blocking:true entries for red checks", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
    }));
    const result = service.check({ noQueue: true, noHooks: true });

    expect(result.verdict).toBe("not_restorable");
    expect(result.repairPacket).not.toBeNull();
    expect(result.repairPacket!.length).toBeGreaterThan(0);

    const blocker = result.repairPacket!.find((s) => s.blocking);
    expect(blocker).toBeDefined();
    expect(blocker!.step).toBe(1);
    expect(typeof blocker!.command).toBe("string");
    expect(blocker!.command.length).toBeGreaterThan(0);
    expect(typeof blocker!.rationale).toBe("string");
    // Daemon start is a mutating action → safe: false
    expect(blocker!.safe).toBe(false);
    expect(blocker!.blocking).toBe(true);
  });

  it("restorable_with_caveats has repairPacket with blocking:false entries for yellow checks", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({ noQueue: true, noHooks: true });

    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.repairPacket).not.toBeNull();

    const caveat = result.repairPacket!.find((s) => !s.blocking);
    expect(caveat).toBeDefined();
    // Snapshot creation is a mutating action → safe: false
    expect(caveat!.safe).toBe(false);
    expect(caveat!.blocking).toBe(false);
  });

  it("restorable verdict has repairPacket null (nothing to repair)", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });

    expect(result.verdict).toBe("restorable");
    expect(result.repairPacket).toBeNull();
  });

  it("repair packet orders blockers before caveats with 1-indexed steps", () => {
    // Red daemon + yellow missing snapshot = blocker first, caveat second
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
      hasSnapshot: () => false,
    }));
    const result = service.check({ noQueue: true, noHooks: true });

    expect(result.repairPacket).not.toBeNull();
    const steps = result.repairPacket!;
    expect(steps.length).toBeGreaterThanOrEqual(2);
    // First entry should be a blocker (daemon red)
    expect(steps[0]!.blocking).toBe(true);
    expect(steps[0]!.step).toBe(1);
    // Last entry should be a caveat (snapshot yellow)
    const lastCaveat = steps.find((s) => !s.blocking);
    expect(lastCaveat).toBeDefined();
    // Steps are sequential
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i]!.step).toBe(i + 1);
    }
  });

  it("unknown verdict has repairPacket with blocking:true entries", () => {
    const service = new RestoreCheckService(mockDeps({
      listRigs: () => { throw new Error("database locked"); },
    }));
    const result = service.check({});

    expect(result.verdict).toBe("unknown");
    expect(result.repairPacket).not.toBeNull();
    const entry = result.repairPacket![0]!;
    expect(entry.blocking).toBe(true);
  });

  it("repair entry command contains prose remediation, not shell command prefix", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({ noQueue: true, noHooks: true });

    expect(result.repairPacket).not.toBeNull();
    const snapshotStep = result.repairPacket!.find((s) => s.rationale.includes("snapshot"));
    expect(snapshotStep).toBeDefined();
    // Command is prose guidance, not prefixed with $ or auto-executable
    expect(snapshotStep!.command).not.toMatch(/^\$/);
    expect(snapshotStep!.command.length).toBeGreaterThan(0);
  });

  it("omitted remediationSafe defaults to safe:false (conservative)", () => {
    // getNodeInventory throw has remediation "Check daemon status" with no
    // explicit remediationSafe — conservative default must produce safe:false
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => { throw new Error("query timeout"); },
    }));
    const result = service.check({});

    expect(result.verdict).toBe("unknown");
    expect(result.repairPacket).not.toBeNull();
    const entry = result.repairPacket!.find((s) => s.rationale.includes("query timeout"));
    expect(entry).toBeDefined();
    // Omitted remediationSafe → safe:false (conservative default)
    expect(entry!.safe).toBe(false);
    expect(entry!.blocking).toBe(true);
  });

  it("new readiness repair steps preserve blocking severity versus execution safety", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl",
        podId: "dev", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-rig",
        nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "stopped", startupStatus: "failed",
        tmuxAttachCommand: null, latestError: "launch failed",
      } as NodeInventoryEntry],
    }));

    const result = service.check({ noHooks: true });
    const readinessRepair = result.repairPacket?.find((step) => step.rationale.includes("not running/ready"));

    expect(readinessRepair).toEqual(expect.objectContaining({
      blocking: true,
      safe: false,
    }));
  });
});
