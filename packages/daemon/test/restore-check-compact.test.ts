import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry, type RestoreCheckResult } from "../src/domain/restore-check-service.js";

function makeReadyNode(logicalId: string): NodeInventoryEntry {
  return {
    logicalId,
    canonicalSessionName: `${logicalId.replace(".", "-")}@test-rig`,
    sessionStatus: "running",
    startupStatus: "ready",
    cwd: "/project",
    latestError: null,
    tmuxAttachCommand: `tmux attach -t ${logicalId.replace(".", "-")}@test-rig`,
  } as NodeInventoryEntry;
}

function makeNotReadyNode(logicalId: string): NodeInventoryEntry {
  return {
    logicalId,
    canonicalSessionName: `${logicalId.replace(".", "-")}@test-rig`,
    sessionStatus: "exited",
    startupStatus: "failed",
    cwd: "/project",
    latestError: "Startup failed",
  } as NodeInventoryEntry;
}

function makeDeps(nodes: NodeInventoryEntry[]): RestoreCheckDeps {
  return {
    listRigs: () => [{ rigId: "rig-1", name: "test-rig" }],
    getNodeInventory: () => nodes,
    getStartupContext: () => ({ status: "missing" as const, evidence: "no context" }),
    hasSnapshot: () => true,
    getLatestSnapshot: () => ({ id: "snap-1", kind: "full" }),
    probeDaemonHealth: () => ({ healthy: true, evidence: "OK" }),
    exists: () => false,
    readFile: () => "",
  };
}

describe("OPR.0.4.0.29 — restore-check compact via service", () => {
  it("AC-1: compact produces fewer checks than full", () => {
    const nodes = [
      makeReadyNode("dev.impl"),
      makeReadyNode("dev.qa"),
      makeReadyNode("dev.guard"),
      makeNotReadyNode("dev.design"),
    ];

    const service = new RestoreCheckService(makeDeps(nodes));
    const full = service.check({ compact: false });
    const compact = service.check({ compact: true });

    expect(compact.checks.length).toBeLessThan(full.checks.length);
    expect(compact.rigs.length).toBe(full.rigs.length);
  });

  it("AC-3: compact skips per-seat detail for ready seats (FR-3/AC-4)", () => {
    const nodes = [
      makeReadyNode("dev.impl"),
      makeReadyNode("dev.qa"),
      makeNotReadyNode("dev.design"),
    ];

    const service = new RestoreCheckService(makeDeps(nodes));
    const compact = service.check({ compact: true });
    const full = service.check({ compact: false });

    const compactSeatChecks = compact.checks.filter((c) => c.check.startsWith("seat."));
    const fullSeatChecks = full.checks.filter((c) => c.check.startsWith("seat."));
    expect(compactSeatChecks.length).toBeLessThan(fullSeatChecks.length);

    const notReadyCheck = compact.checks.find((c) => c.status === "red" && c.check.includes("readiness"));
    expect(notReadyCheck).toBeDefined();
    expect(notReadyCheck!.evidence).toContain("not running/ready");
  });

  it("AC-7: readiness classes derive from real enums", () => {
    const nodes = [makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    const validStatuses = new Set(["ready", "ready_with_caveats", "not_ready", "unknown"]);
    expect(validStatuses.has(result.readiness.status)).toBe(true);
    for (const rig of result.rigs) {
      expect(validStatuses.has(rig.status)).toBe(true);
    }
  });

  it("AC-5: no compact option = full result (back-compat)", () => {
    const nodes = [makeReadyNode("dev.impl")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    const seatChecks = result.checks.filter((c) => c.check.startsWith("seat.") || c.check.includes("startup_context") || c.check.includes("transcript") || c.check.includes("resume"));
    expect(seatChecks.length).toBeGreaterThan(1);
  });

  it("AC-8: per-rig grouping shows rig rollup", () => {
    const nodes = [makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    expect(result.rigs.length).toBe(1);
    expect(result.rigs[0]!.rigName).toBe("test-rig");
    expect(result.rigs[0]!.expectedNodes).toBe(2);
  });

  // OPR.0.4.0.29 FR-8 / AC-7 — ready-confidence breakdown by the 5 real-enum classes.
  it("AC-7: classCounts breaks seats into the 5 real-enum classes (no invented status)", () => {
    const makeAttentionNode = (logicalId: string): NodeInventoryEntry => ({
      logicalId,
      canonicalSessionName: `${logicalId.replace(".", "-")}@test-rig`,
      sessionStatus: "running",
      startupStatus: "attention_required",
      cwd: "/project",
      latestError: "Awaiting operator",
    } as NodeInventoryEntry);

    // The two ready seats are GENUINELY clean (nodeId + ok startup context +
    // present files via exists:true + healthy daemon) so they count as plain
    // `ready` — keeping real coverage of the ready class. (Caveat detection in
    // default compact is covered by the two dedicated tests below; a bare
    // makeReadyNode with a missing startup context is ready_with_caveats, not
    // ready, and default compact now detects that.)
    const nodes = [
      { ...makeReadyNode("dev.impl"), nodeId: "node-impl" } as NodeInventoryEntry,
      { ...makeReadyNode("dev.qa"), nodeId: "node-qa" } as NodeInventoryEntry,
      makeNotReadyNode("dev.design"),
      makeAttentionNode("dev.synth"),
    ];
    const deps: RestoreCheckDeps = {
      ...makeDeps(nodes),
      exists: () => true,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      getStartupContext: () => ({ status: "ok" as const, runtime: null, resolvedStartupFiles: [], projectionEntries: [] }),
    };
    const result = new RestoreCheckService(deps).check({ compact: true });

    // Exactly the 5 real-enum class keys — no fresh-primed/awaiting-decision invented status.
    expect(Object.keys(result.classCounts).sort()).toEqual(
      ["attention_required", "not_ready", "ready", "ready_with_caveats", "unknown"],
    );
    expect(result.classCounts.ready).toBe(2);
    expect(result.classCounts.attention_required).toBe(1);
    expect(result.classCounts.not_ready).toBe(1);
    // The breakdown accounts for every seat.
    const total = Object.values(result.classCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
  });

  it("AC-7: per-rig classCounts sum to the fleet-wide classCounts", () => {
    const result = new RestoreCheckService(
      makeDeps([makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")]),
    ).check({});
    const rigSum = result.rigs.reduce((a, r) => a + Object.values(r.classCounts).reduce((x, y) => x + y, 0), 0);
    const fleetSum = Object.values(result.classCounts).reduce((a, b) => a + b, 0);
    expect(rigSum).toBe(fleetSum);
  });

  it("AC-7: a no-snapshot rig's running/ready seats count as unknown, not ready (real snapshot primitive)", () => {
    const deps: RestoreCheckDeps = { ...makeDeps([makeReadyNode("dev.impl"), makeReadyNode("dev.qa")]), hasSnapshot: () => false };
    const result = new RestoreCheckService(deps).check({ compact: true });
    // Without a snapshot the rig cannot be restored -> its ready seats are unknown.
    expect(result.classCounts.ready).toBe(0);
    expect(result.classCounts.unknown).toBe(2);
  });

  it("AC-7: no-snapshot does NOT hide failed seats (not_ready wins over no-snapshot)", () => {
    const deps: RestoreCheckDeps = { ...makeDeps([makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")]), hasSnapshot: () => false };
    const result = new RestoreCheckService(deps).check({ compact: true });
    // The failed seat stays not_ready (surfaced); only the clean seat -> unknown.
    expect(result.classCounts.not_ready).toBe(1);
    expect(result.classCounts.unknown).toBe(1);
    expect(result.classCounts.ready).toBe(0);
  });

  // OPR.0.4.0.29 QA-blocking forward-fix (qa-blocking-1f7b1282): the
  // restore-proof-caveat repro. A snapshot-backed, running/ready seat whose
  // startup context is MISSING is a real yellow caveat. The per-rig status +
  // caveatNodes already report it; classCounts must follow the caveat too —
  // ready_with_caveats wins over plain ready (but still loses to
  // attention/not_ready/no-snapshot, which are asserted above).
  it("AC-7: a running/ready seat with a real yellow caveat counts as ready_with_caveats, not ready", () => {
    // makeReadyNode is running+ready; with a missing startup context its
    // seat.<session>.startup-context check is yellow (buildStartupContextAvailabilityCheck).
    // includeReady forces the ready-seat detail to assemble (the --ready path the QA proof used).
    // exists:true + a healthy daemon clears the unrelated rig/host red checks
    // (spec-present, daemon.reachable, transcript/queue files) so the ONLY
    // non-green signal is the real startup-context caveat — isolating the bug.
    const deps: RestoreCheckDeps = {
      ...makeDeps([makeReadyNode("dev.impl")]),
      hasSnapshot: () => true,
      exists: () => true,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      getStartupContext: () => ({ status: "missing" as const, evidence: "Persisted startup context missing" }),
    };
    const result = new RestoreCheckService(deps).check({ compact: true, includeReady: true });

    const rig = result.rigs.find((r) => r.rigName === "test-rig")!;
    expect(rig.status).toBe("ready_with_caveats");
    expect(rig.caveatNodes).toBe(1);
    expect(result.classCounts.ready_with_caveats).toBe(1);
    expect(result.classCounts.ready).toBe(0);
  });

  // OPR.0.4.0.29 code-review BLOCKING forward-fix (qitem-...52809188): the DEFAULT
  // compact path the QA proof actually ran (rig restore-check, NOT --ready). Default
  // compact omits ready-seat DETAIL from the emitted output (token-safe), but the
  // summary must STILL detect the caveat -- a snapshot-backed running/ready seat with
  // a missing startup context is ready_with_caveats, not ready. The includeReady test
  // above is necessary but insufficient: it masks the default-compact detail skip.
  it("AC-7: DEFAULT compact (no includeReady) still counts a running/ready seat's yellow caveat as ready_with_caveats", () => {
    // nodeId set so the real getStartupContext-missing path produces the yellow
    // startup-context caveat. Clean deps so it is the ONLY non-green seat signal.
    const caveatNode = { ...makeReadyNode("dev.impl"), nodeId: "node-caveat" } as NodeInventoryEntry;
    const deps: RestoreCheckDeps = {
      ...makeDeps([caveatNode]),
      hasSnapshot: () => true,
      exists: () => true,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      getStartupContext: () => ({ status: "missing" as const, evidence: "Persisted startup context missing" }),
    };
    const result = new RestoreCheckService(deps).check({ compact: true });

    const rig = result.rigs.find((r) => r.rigName === "test-rig")!;
    expect(rig.status).toBe("ready_with_caveats");
    expect(rig.caveatNodes).toBe(1);
    expect(result.classCounts.ready_with_caveats).toBe(1);
    expect(result.classCounts.ready).toBe(0);
    // Token-safe: default compact does NOT dump the ready seat's detail rows.
    expect(result.checks.some((c) => c.check.endsWith(".startup-context"))).toBe(false);
  });

  // OPR.0.4.0.29 code-review BLOCKING (qitem-...4f06e820): AC-4/FR-3 require the
  // daemon to SKIP full ready-seat detail assembly in default compact, not just
  // hide it after assembling. Default compact computes ONLY the startup-context
  // caveat signal the FR-8 summary needs; transcript/resume/queue/hooks are NOT
  // assembled for a green ready seat. Behavioral no-call proof: a green ready
  // seat with a CLEAN startup context but NO attach command. If default compact
  // assembled detail it would run checkResumePath -> a yellow resume-path caveat
  // -> ready_with_caveats. Skipping it keeps the seat plain ready.
  it("AC-4: default compact does NOT assemble full ready-seat detail (resume/transcript/queue/hooks) for a green ready seat", () => {
    const cleanReadyNoAttach = { ...makeReadyNode("dev.impl"), nodeId: "node-clean", tmuxAttachCommand: undefined } as NodeInventoryEntry;
    const deps: RestoreCheckDeps = {
      ...makeDeps([cleanReadyNoAttach]),
      hasSnapshot: () => true,
      exists: () => true,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      // ok startup context -> startup-context is GREEN, so it is NOT the caveat.
      getStartupContext: () => ({ status: "ok" as const, runtime: null, resolvedStartupFiles: [], projectionEntries: [] }),
    };

    // Default compact: resume-path (and the rest of the detail) is NOT assembled,
    // so the missing attach command produces no caveat -> plain ready.
    const compact = new RestoreCheckService(deps).check({ compact: true });
    expect(compact.classCounts.ready).toBe(1);
    expect(compact.classCounts.ready_with_caveats).toBe(0);
    expect(compact.rigs.find((r) => r.rigName === "test-rig")!.status).toBe("ready");

    // --ready/includeReady DOES assemble detail -> the missing attach command is
    // a yellow resume-path caveat -> ready_with_caveats. Proves the detail set is
    // real and only the default-compact path skips it.
    const ready = new RestoreCheckService(deps).check({ compact: true, includeReady: true });
    expect(ready.classCounts.ready_with_caveats).toBe(1);
    expect(ready.classCounts.ready).toBe(0);
  });

  // OPR.0.4.0.29 rev1-r2 BLOCKING (qitem-...f13fc5b4): no-false-ready. A skipped
  // (computed-but-not-emitted) ready-seat startup-context caveat must STILL drive
  // the top-level verdict/readiness/counts, or default compact reports a false
  // top-level ready/restorable while the same payload admits a ready_with_caveats
  // rig. Clean host (green daemon + green host-infra declaration) so the ONLY
  // non-green signal is the hidden startup-context caveat.
  it("AC-4 / no-false-ready: a hidden ready-seat caveat drives the top-level verdict/readiness in default compact", () => {
    const caveatNode = { ...makeReadyNode("dev.impl"), nodeId: "node-caveat" } as NodeInventoryEntry;
    const hostInfra = JSON.stringify({ schemaVersion: 1, daemonBootstrap: { mechanism: "launchd", declared: true }, supportingInfra: [] });
    const deps: RestoreCheckDeps = {
      ...makeDeps([caveatNode]),
      hasSnapshot: () => true,
      exists: () => true,
      readFile: () => hostInfra,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      getStartupContext: () => ({ status: "missing" as const, evidence: "Persisted startup context missing" }),
    };
    const result = new RestoreCheckService(deps).check({ compact: true });

    // Top-level must NOT be a false ready/restorable.
    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.readiness.status).toBe("ready_with_caveats");
    expect(result.readiness.caveatRigCount).toBe(1);
    expect(result.counts.yellow).toBeGreaterThanOrEqual(1);
    // Rollup + classCounts agree.
    expect(result.classCounts.ready_with_caveats).toBe(1);
    expect(result.classCounts.ready).toBe(0);
    // AC-4 preserved: the startup-context detail ROW is still not emitted.
    expect(result.checks.some((c) => c.check.endsWith(".startup-context"))).toBe(false);
  });
});
