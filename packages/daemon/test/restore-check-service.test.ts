import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RestoreCheckService,
  type RestoreCheckDeps,
  type NodeInventoryEntry,
} from "../src/domain/restore-check-service.js";

const VALID_HOST_INFRA_DECLARATION = JSON.stringify({
  schemaVersion: 1,
  daemonBootstrap: {
    declared: true,
    mechanism: "launchd",
    evidence: "com.openrig.daemon",
  },
  supportingInfra: [
    {
      id: "supervisor-wake",
      declared: true,
      required: true,
      evidence: "kernel rig infra seat or host launch agent",
    },
  ],
});

function v2HostInfraDeclaration(overrides?: {
  daemonEvidencePaths?: string[];
  supportingInfra?: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    daemonBootstrap: {
      declared: true,
      mechanism: "launchd",
      evidence: "com.openrig.daemon",
      evidencePaths: overrides?.daemonEvidencePaths,
    },
    supportingInfra: overrides?.supportingInfra ?? [
      {
        id: "supervisor-wake",
        declared: true,
        required: true,
        evidence: "kernel rig infra seat or host launch agent",
        evidencePaths: ["${OPENRIG_HOME}/supervisor-wake/README.md"],
      },
    ],
  });
}

function claudeNode(overrides?: Partial<NodeInventoryEntry> & { cwd?: string | null }): NodeInventoryEntry {
  return {
    nodeId: "node-1",
    rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl",
    podId: "dev", podNamespace: "dev",
    canonicalSessionName: "dev-impl@test-rig",
    nodeKind: "agent", runtime: "claude-code",
    sessionStatus: "running", startupStatus: "ready",
    tmuxAttachCommand: "tmux attach -t dev-impl@test-rig",
    latestError: null,
    ...overrides,
  } as NodeInventoryEntry;
}

function startupContextProbe(options?: {
  status?: "ok" | "missing" | "malformed" | "probe_error";
  evidence?: string;
  resolvedStartupFiles?: Array<{ absolutePath: string; required: boolean; path?: string; deliveryHint?: string; ownerRoot?: string }>;
  projectionEntries?: Array<{ absolutePath: string; effectiveId?: string; category?: string; sourcePath?: string; resourceType?: string }>;
  runtime?: string;
}) {
  if (options?.status && options.status !== "ok") {
    return {
      status: options.status,
      evidence: options.evidence ?? "startup context unavailable",
    };
  }

  return {
    status: "ok",
    runtime: options?.runtime ?? "claude-code",
    resolvedStartupFiles: options?.resolvedStartupFiles ?? [],
    projectionEntries: options?.projectionEntries ?? [],
  };
}

function mockDeps(overrides?: Partial<RestoreCheckDeps & {
  getStartupContext: (nodeId: string) => unknown;
}>): RestoreCheckDeps {
  return {
    listRigs: () => [{ rigId: "rig-1", name: "test-rig" }],
    getNodeInventory: () => [
      {
        nodeId: "node-1",
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
    getLatestSnapshot: () => null,
    probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running on port 7433" }),
    exists: () => true,
    readFile: () => VALID_HOST_INFRA_DECLARATION,
    getStartupContext: () => startupContextProbe(),
    probeQueueStore: () => ({ available: true, evidence: "SQLite queue store is available" }),
    getClaudeActivityHookEvents: () => ["SessionStart", "UserPromptSubmit"],
    ...overrides,
  };
}

describe("RestoreCheckService", () => {
  let previousOpenRigHome: string | undefined;
  let testOpenRigHome: string | null;

  beforeEach(() => {
    previousOpenRigHome = process.env["OPENRIG_HOME"];
    testOpenRigHome = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-openrig-home-"));
    process.env["OPENRIG_HOME"] = testOpenRigHome;
  });

  afterEach(() => {
    if (previousOpenRigHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = previousOpenRigHome;
    if (testOpenRigHome) fs.rmSync(testOpenRigHome, { recursive: true, force: true });
    testOpenRigHome = null;
  });

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

  // --- Host-infra declaration ---

  it("missing host-infra declaration is a non-blocking caveat and prevents ready", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-missing-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: (p) => p === declarationPath ? fs.existsSync(p) : true,
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check).toEqual(expect.objectContaining({
        status: "yellow",
      }));
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.remediation).toContain(declarationPath);
      expect(result.hostInfra.status).toBe("not_declared");
      expect(result.hostInfra.evidence).toContain(declarationPath);
      expect(result.verdict).toBe("restorable_with_caveats");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.readiness.reason).toBe("caveats_present");
      expect(result.repairPacket).toEqual([
        expect.objectContaining({
          command: expect.stringContaining(declarationPath),
          safe: false,
          blocking: false,
        }),
      ]);
      expect(fs.existsSync(declarationPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("unknown rig preserves missing host-infra declaration state on not_restorable result", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-missing-rig-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: (p) => p === declarationPath ? fs.existsSync(p) : true,
      }));
      const result = service.check({ rig: "missing-rig", noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(result.verdict).toBe("not_restorable");
      expect(check).toEqual(expect.objectContaining({
        status: "yellow",
        evidence: expect.stringContaining(declarationPath),
      }));
      expect(result.hostInfra).toEqual(expect.objectContaining({
        status: "not_declared",
        evidence: check?.evidence,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("unknown rig preserves declared host-infra state on not_restorable result", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-declared-rig-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => VALID_HOST_INFRA_DECLARATION,
      }));
      const result = service.check({ rig: "missing-rig", noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(result.verdict).toBe("not_restorable");
      expect(check).toEqual(expect.objectContaining({
        status: "green",
        evidence: expect.stringContaining(declarationPath),
      }));
      expect(result.hostInfra).toEqual(expect.objectContaining({
        status: "declared",
        evidence: check?.evidence,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("malformed host-infra declaration is yellow with exact path and parse error", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-malformed-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: (p) => p === declarationPath ? "{ bad json" : VALID_HOST_INFRA_DECLARATION,
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.evidence).toMatch(/parse|JSON/i);
      expect(result.hostInfra.status).toBe("not_declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining(declarationPath),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("arbitrary JSON is not accepted as a declared host-infra contract", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-invalid-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: (p) => p === declarationPath ? JSON.stringify({ arbitrary: true }) : VALID_HOST_INFRA_DECLARATION,
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.evidence).toContain("schemaVersion");
      expect(check?.evidence).toContain("daemonBootstrap.mechanism");
      expect(check?.evidence).toContain("supportingInfra");
      expect(result.hostInfra.status).toBe("not_declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("valid host-infra declaration is green declared-not-verified evidence", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-valid-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => VALID_HOST_INFRA_DECLARATION,
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("green");
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.evidence).toContain("declared, not verified");
      expect(check?.evidence).toContain("mechanism=launchd");
      expect(check?.evidence).toContain("requiredSupportingInfra=1");
      expect(result.hostInfra.status).toBe("declared");
      expect(result.hostInfra.evidence).toContain("declared, not verified");
      expect(result.verdict).toBe("restorable");
      expect(result.readiness.status).toBe("ready");
      expect(result.readiness.reason).toBe("all_observable_checks_green_host_infra_declared_not_verified");
      expect(result.repairPacket).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 with all evidence paths present is green without autostart overclaim", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-present-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const supportPath = path.join(tmpDir, "supervisor-wake", "README.md");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: [daemonPath],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("green");
      expect(check?.evidence).toContain("declared, evidence paths present, not autostart verified");
      expect(check?.evidence).toContain(daemonPath);
      expect(check?.evidence).toContain(supportPath);
      expect(result.hostInfra.status).toBe("declared");
      expect(result.hostInfra.evidence).toContain("not autostart verified");
      expect(result.verdict).toBe("restorable");
      expect(result.readiness.status).toBe("ready");
      expect(result.repairPacket).toBeNull();
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 requires daemonBootstrap evidencePaths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-no-daemon-evidence-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const supportPath = path.join(tmpDir, "supervisor-wake", "README.md");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration(),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain("daemonBootstrap.evidencePaths");
      expect(result.hostInfra.status).toBe("declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.readiness.reason).toBe("caveats_present");
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining("daemonBootstrap.evidencePaths"),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts real OPENRIG_HOME evidence inside a literal dot-prefixed directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "restore-dot-prefix-"));
    const evidence = path.join(root, "..cache", "launchd.plist");
    const declaration = path.join(root, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = root;
    fs.mkdirSync(path.dirname(evidence));
    fs.writeFileSync(evidence, "synthetic local launch evidence");
    fs.writeFileSync(declaration, v2HostInfraDeclaration({
      daemonEvidencePaths: ["${OPENRIG_HOME}/..cache/launchd.plist"], supportingInfra: [],
    }));
    try {
      const service = new RestoreCheckService(mockDeps({
        listRigs: () => [], exists: fs.existsSync,
        readFile: (candidate) => fs.readFileSync(candidate, "utf8"),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");
      expect(check?.status).toBe("green");
      expect(check?.evidence).toContain(evidence);
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 missing daemon evidence path is yellow with exact path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-missing-daemon-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const supportPath = path.join(tmpDir, "supervisor-wake", "README.md");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: (p) => p !== daemonPath,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(daemonPath);
      expect(result.hostInfra.status).toBe("declared");
      expect(result.hostInfra.evidence).toContain(daemonPath);
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining(daemonPath),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 missing required supporting evidence path is yellow with exact path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-missing-support-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const supportPath = path.join(tmpDir, "supervisor-wake", "README.md");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: (p) => p !== supportPath,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(supportPath);
      expect(result.hostInfra.status).toBe("declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining(supportPath),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 required supportingInfra without evidencePaths is insufficient evidence", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-required-no-evidence-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
          supportingInfra: [{
            id: "supervisor-wake",
            declared: true,
            required: true,
            evidence: "kernel rig infra seat or host launch agent",
          }],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain("supportingInfra[supervisor-wake].evidencePaths");
      expect(result.hostInfra.status).toBe("declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.repairPacket?.[0]).toEqual(expect.objectContaining({
        command: expect.stringContaining("supportingInfra[supervisor-wake].evidencePaths"),
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 optional supportingInfra without evidencePaths does not create a caveat", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-optional-no-evidence-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
          supportingInfra: [{
            id: "optional-dashboard",
            declared: true,
            required: false,
            evidence: "nice-to-have dashboard helper",
          }],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("green");
      expect(check?.evidence).toContain("declared, evidence paths present, not autostart verified");
      expect(result.verdict).toBe("restorable");
      expect(result.readiness.status).toBe("ready");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 rejects plain relative and traversal evidence paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-relative-reject-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(tmpDir, "daemon", "launchd.plist");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: () => v2HostInfraDeclaration({
          daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
          supportingInfra: [
            {
              id: "relative",
              declared: true,
              required: true,
              evidencePaths: ["relative/path.txt"],
            },
            {
              id: "traversal",
              declared: true,
              required: true,
              evidencePaths: ["${OPENRIG_HOME}/../escape.txt"],
            },
          ],
        }),
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain("relative/path.txt");
      expect(check?.evidence).toContain("${OPENRIG_HOME}/../escape.txt");
      expect(result.hostInfra.status).toBe("declared");
      expect(result.readiness.status).toBe("ready_with_caveats");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("schemaVersion 2 evidence path checks are read-only", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-v2-readonly-"));
    const daemonDir = path.join(tmpDir, "daemon");
    const supportDir = path.join(tmpDir, "supervisor-wake");
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(supportDir, { recursive: true });
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const daemonPath = path.join(daemonDir, "launchd.plist");
    const supportPath = path.join(supportDir, "README.md");
    fs.writeFileSync(daemonPath, "daemon evidence");
    fs.writeFileSync(supportPath, "support evidence");
    fs.utimesSync(tmpDir, new Date(946684800000), new Date(946684800000));
    const before = fs.statSync(tmpDir).mtimeMs;
    const readPaths: string[] = [];
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: (p) => {
          readPaths.push(p);
          return v2HostInfraDeclaration({
            daemonEvidencePaths: ["${OPENRIG_HOME}/daemon/launchd.plist"],
          });
        },
      }));
      const result = service.check({ noQueue: true, noHooks: true });

      expect(result.verdict).toBe("restorable");
      expect(readPaths).toEqual([declarationPath]);
      expect(fs.statSync(tmpDir).mtimeMs).toBe(before);
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("host-infra read exception is caught inside service as unknown caveat", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-host-infra-read-error-"));
    const declarationPath = path.join(tmpDir, "host-infra.json");
    const previous = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = tmpDir;

    try {
      const service = new RestoreCheckService(mockDeps({
        exists: () => true,
        readFile: (p) => {
          if (p === declarationPath) throw new Error("EACCES");
          return VALID_HOST_INFRA_DECLARATION;
        },
      }));
      const result = service.check({ noQueue: true, noHooks: true });
      const check = result.checks.find((entry) => entry.check === "host.bootstrap-autostart.declaration");

      expect(result.verdict).toBe("restorable_with_caveats");
      expect(result.readiness.status).toBe("ready_with_caveats");
      expect(result.readiness.reason).toBe("caveats_present");
      expect(result.hostInfra.status).toBe("unknown");
      expect(check?.status).toBe("yellow");
      expect(check?.evidence).toContain(declarationPath);
      expect(check?.evidence).toContain("EACCES");
    } finally {
      if (previous === undefined) delete process.env["OPENRIG_HOME"];
      else process.env["OPENRIG_HOME"] = previous;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- Rig spec/root checks ---

  it("missing rig root is a not-checked caveat, not a blocker (#130: rigs launch from specs elsewhere)", () => {
    const service = new RestoreCheckService(mockDeps({
      substrateRoot: "/shared-docs",
      exists: (p) => !p.includes(path.join("rigs", "test-rig")),
    }));
    const result = service.check({ noHooks: true });
    const spec = result.checks.find((c) => c.check === "rig.test-rig.spec-present");
    expect(spec?.status).toBe("yellow");
    expect(spec?.evidence).toContain("Not checked: no launch spec location could be established");
    expect(spec?.evidence).toContain(path.join("/shared-docs", "rigs", "test-rig", "rig.yaml"));
    expect(spec?.remediationSafe).toBe(true);
    expect(result.counts.red).toBe(0);
    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.rigs[0]).toEqual(expect.objectContaining({ status: "ready_with_caveats", blockingChecks: [] }));
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
        nodeId: "node-1",
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

  it("unavailable SQLite queue store produces yellow", () => {
    const service = new RestoreCheckService(mockDeps({
      probeQueueStore: () => ({ available: false, evidence: "queue_items table is unavailable" }),
    }));
    const result = service.check({});
    const queue = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.queue-store");
    expect(queue?.status).toBe("yellow");
    expect(queue?.evidence).toContain("unavailable");
  });

  it("SQLite queue-store probe errors remain a readable caveat", () => {
    const service = new RestoreCheckService(mockDeps({
      probeQueueStore: () => { throw new Error("database closed"); },
    }));
    const queue = service.check({}).checks.find((c) => c.check === "seat.dev-impl@test-rig.queue-store");
    expect(queue?.status).toBe("yellow");
    expect(queue?.evidence).toContain("database closed");
  });

  it("--no-queue skips SQLite queue-store checks", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noQueue: true });
    const queueChecks = result.checks.filter((c) => c.check.includes("queue-store"));
    expect(queueChecks).toHaveLength(0);
  });

  it("--no-hooks skips hook checks", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    const hookChecks = result.checks.filter((c) => c.check.includes("hooks"));
    expect(hookChecks).toHaveLength(0);
  });

  it.each([undefined, "*", "startup|resume", "startup, resume", "^(startup|resume)$"])("checks usable selected activity-hook matcher %s", (matcher) => {
    const cwd = path.join(os.tmpdir(), "restore-check-activity-seat");
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const relayPath = path.join(cwd, ".openrig", "hooks", "scripts", "activity-relay.cjs");
    const events = ["SessionStart", "UserPromptSubmit"];
    const settings = JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, [{ matcher, hooks: [
      { type: "command", command: `node '${relayPath}'` },
    ] }]])) });
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({ cwd })],
      getStartupContext: () => startupContextProbe({ projectionEntries: [{
        absolutePath: "/source/openrig-core", effectiveId: "shared:openrig-core",
        category: "runtime_resource", resourceType: "claude_activity_hooks",
      }] }),
      getClaudeActivityHookEvents: () => events,
      exists: (candidate) => candidate === settingsPath || candidate === relayPath || candidate.endsWith("host-infra.json"),
      readFile: (candidate) => candidate === settingsPath ? settings : VALID_HOST_INFRA_DECLARATION,
    }));

    const hook = service.check({}).checks.find((entry) => entry.check === "seat.dev-impl@test-rig.hooks");
    expect(hook?.status).toBe("green");
    expect(hook?.evidence).toContain("activity hooks are projected");
    expect(hook?.evidence).toContain(relayPath);
  });

  it.each(["disabled", "compact-only", "prompt-handler", "invalid-matcher", "substring-matcher"])("keeps %s selected activity hooks as a caveat", (kind) => {
    const cwd = path.join(os.tmpdir(), "restore-check-activity-seat-unusable");
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const relayPath = path.join(cwd, ".openrig", "hooks", "scripts", "activity-relay.cjs");
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({ cwd })],
      getStartupContext: () => startupContextProbe({ projectionEntries: [{
        absolutePath: "/source/openrig-core", category: "runtime_resource", resourceType: "claude_activity_hooks",
      }] }),
      getClaudeActivityHookEvents: () => ["SessionStart"],
      exists: (candidate) => candidate === settingsPath || candidate === relayPath || candidate.endsWith("host-infra.json"),
      readFile: (candidate) => candidate === settingsPath ? JSON.stringify({
        disableAllHooks: kind === "disabled",
        hooks: { SessionStart: [{
          ...(kind === "compact-only" ? { matcher: "compact" } : {}),
          ...(kind === "invalid-matcher" ? { matcher: "[" } : {}),
          ...(kind === "substring-matcher" ? { matcher: "start|sum" } : {}),
          hooks: [{ type: kind === "prompt-handler" ? "prompt" : "command", command: `node '${relayPath}'` }],
        }] },
      }) : VALID_HOST_INFRA_DECLARATION,
    }));
    const hook = service.check({}).checks.find((entry) => entry.check === "seat.dev-impl@test-rig.hooks");
    expect(hook?.status).toBe("yellow");
    expect(hook?.remediationSafe).toBe(false);
    expect(hook?.evidence).toContain(kind === "disabled" ? "disabled" : "SessionStart");
  });

  it("does not accept a similarly named command as the projected Claude activity hook", () => {
    const cwd = path.join(os.tmpdir(), "restore-check-activity-seat-lookalike");
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const relayPath = path.join(cwd, ".openrig", "hooks", "scripts", "activity-relay.cjs");
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({ cwd })],
      getStartupContext: () => startupContextProbe({ projectionEntries: [{
        absolutePath: "/source/openrig-core", effectiveId: "shared:openrig-core",
        category: "runtime_resource", resourceType: "claude_activity_hooks",
      }] }),
      getClaudeActivityHookEvents: () => ["SessionStart"],
      exists: (candidate) => candidate === settingsPath || candidate === relayPath || candidate.endsWith("host-infra.json"),
      readFile: (candidate) => candidate === settingsPath
        ? JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node '${relayPath}.backup'` }] }] } })
        : VALID_HOST_INFRA_DECLARATION,
    }));

    const hook = service.check({}).checks.find((entry) => entry.check === "seat.dev-impl@test-rig.hooks");
    expect(hook?.status).toBe("yellow");
    expect(hook?.evidence).toContain("SessionStart");
  });

  it("warns when a selected Claude activity hook event is not projected", () => {
    const cwd = path.join(os.tmpdir(), "restore-check-activity-seat-partial");
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const relayPath = path.join(cwd, ".openrig", "hooks", "scripts", "activity-relay.cjs");
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({ cwd })],
      getStartupContext: () => startupContextProbe({ projectionEntries: [{
        absolutePath: "/source/openrig-core", effectiveId: "shared:openrig-core",
        category: "runtime_resource", resourceType: "claude_activity_hooks",
      }] }),
      getClaudeActivityHookEvents: () => ["SessionStart", "UserPromptSubmit"],
      exists: (candidate) => candidate === settingsPath || candidate === relayPath || candidate.endsWith("host-infra.json"),
      readFile: (candidate) => candidate === settingsPath
        ? JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node '${relayPath}'` }] }] } })
        : VALID_HOST_INFRA_DECLARATION,
    }));

    const hook = service.check({}).checks.find((entry) => entry.check === "seat.dev-impl@test-rig.hooks");
    expect(hook?.status).toBe("yellow");
    expect(hook?.evidence).toContain("UserPromptSubmit");
  });

  it("treats deliberately unselected Claude activity hooks as not applicable", () => {
    const hook = new RestoreCheckService(mockDeps()).check({}).checks.find((entry) => entry.check === "seat.dev-impl@test-rig.hooks");
    expect(hook?.status).toBe("green");
    expect(hook?.evidence).toContain("not selected");
  });

  it("Codex and infrastructure hook checks are green not-applicable without hook repair steps", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [
        {
          nodeId: "node-1",
          rigId: "rig-1", rigName: "test-rig", logicalId: "dev.qa",
          podId: "dev", podNamespace: "dev",
          canonicalSessionName: "dev-qa@test-rig",
          nodeKind: "agent", runtime: "codex",
          sessionStatus: "running", startupStatus: "ready",
          tmuxAttachCommand: "tmux attach -t dev-qa@test-rig",
          latestError: null,
        } as NodeInventoryEntry,
        {
          rigId: "rig-1", rigName: "test-rig", logicalId: "infra.board",
          podId: "infra", podNamespace: "infra",
          canonicalSessionName: "infra-board@test-rig",
          nodeKind: "infrastructure", runtime: "terminal",
          sessionStatus: "running", startupStatus: "ready",
          tmuxAttachCommand: null,
          latestError: null,
        } as NodeInventoryEntry,
      ],
    }));
    const result = service.check({});
    const hookChecks = result.checks.filter((c) => c.check.includes("hooks"));

    expect(hookChecks).toHaveLength(2);
    for (const hook of hookChecks) {
      expect(hook.status).toBe("green");
      expect(hook.evidence).toContain("not applicable");
      expect(hook.remediation).toBe("");
    }
    expect(result.repairPacket?.some((step) => step.rationale.includes("Claude Code hook")) ?? false).toBe(false);
  });

  // --- Verdict aggregation ---

  it("all green produces verdict restorable (with --no-hooks to avoid yellow placeholder)", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true }) as any;
    expect(result.verdict).toBe("restorable");
    expect(result.counts.red).toBe(0);
    expect(result.readiness.status).toBe("ready");
    expect(result.readiness).toEqual(expect.objectContaining({
      status: "ready",
      reason: "all_observable_checks_green_host_infra_declared_not_verified",
      blockingRigCount: 0,
      caveatRigCount: 0,
      unknownRigCount: 0,
    }));
    expect(result.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
    }));
    expect(result.rigs).toEqual([
      expect.objectContaining({
        rigId: "rig-1",
        rigName: "test-rig",
        status: "ready",
        expectedNodes: 1,
        runningReadyNodes: 1,
        blockedNodes: 0,
        caveatNodes: 0,
        blockingChecks: [],
        caveatChecks: [],
      }),
    ]);
    expect(result.recovery).toEqual({
      status: "not_needed",
      summary: expect.stringContaining("no recovery action needed"),
      actions: [],
      blocked: [],
      unknown: [],
    });
  });

  it("any yellow (no red) produces verdict restorable_with_caveats", () => {
    const service = new RestoreCheckService(mockDeps({ hasSnapshot: () => false }));
    const result = service.check({}) as any;
    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.readiness.status).toBe("ready_with_caveats");
    expect(result.readiness.reason).toBe("caveats_present");
    expect(result.readiness.caveatRigCount).toBeGreaterThan(0);
    expect(result.counts.yellow).toBeGreaterThan(0);
    expect(result.counts.red).toBe(0);
    expect(result.recovery).toEqual({
      status: "not_needed",
      summary: expect.stringContaining("no recovery action needed"),
      actions: [],
      blocked: [],
      unknown: [],
    });
  });

  it("any red produces verdict not_restorable", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => ({ healthy: false, evidence: "Daemon not running" }),
    }));
    const result = service.check({}) as any;
    expect(result.verdict).toBe("not_restorable");
    expect(result.readiness.status).toBe("not_ready");
    expect(result.readiness.blockingRigCount).toBeGreaterThanOrEqual(0);
    expect(result.counts.red).toBeGreaterThan(0);
  });

  it("probe error produces unknown readiness, not false green", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));
    const result = service.check({}) as any;

    expect(result.verdict).toBe("unknown");
    expect(result.readiness.status).toBe("unknown");
    expect(result.readiness).toEqual(expect.objectContaining({
      status: "unknown",
      reason: "unknown_probe_state",
    }));
    expect(result.recovery).toEqual(expect.objectContaining({
      status: "unknown",
      actions: [],
      blocked: [],
      unknown: [
        expect.objectContaining({
          scope: "host",
          reason: expect.stringContaining("unable to determine"),
        }),
      ],
    }));
  });

  it("stopped snapshot-backed rig produces actionable recovery command", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({
        canonicalSessionName: "dev-impl@test-rig",
        sessionStatus: "stopped",
        startupStatus: "failed",
        tmuxAttachCommand: null,
        latestError: "seat crashed",
      })],
      getLatestSnapshot: () => ({ id: "snap-123", kind: "auto-pre-down" }),
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.readiness.status).toBe("not_ready");
    expect(result.recovery).toEqual({
      status: "actionable",
      summary: expect.stringContaining("1 rig can be recovered"),
      actions: [
        expect.objectContaining({
          scope: "rig",
          rigId: "rig-1",
          rigName: "test-rig",
          action: "restore_from_latest_snapshot",
          command: "rig up --existing test-rig",
          safe: false,
          blocking: true,
        }),
      ],
      blocked: [],
      unknown: [],
    });
  });

  it("missing canonical session identity with latest snapshot is blocked, not actionable", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({
        canonicalSessionName: null,
        sessionStatus: "stopped",
        startupStatus: "failed",
        tmuxAttachCommand: null,
        latestError: "seat crashed",
      })],
      getLatestSnapshot: () => ({ id: "snap-123", kind: "auto-pre-down" }),
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.readiness.status).toBe("not_ready");
    expect(result.recovery).toEqual({
      status: "blocked",
      summary: expect.stringContaining("1 rig blocked"),
      actions: [],
      blocked: [
        expect.objectContaining({
          scope: "rig",
          rigId: "rig-1",
          rigName: "test-rig",
          reason: expect.stringContaining("Missing canonical session identity"),
        }),
      ],
      unknown: [],
    });
  });

  it("running/ready node with persisted startup context and existing required files is green", () => {
    const requiredPath = path.join(os.tmpdir(), "restore-check-startup-required-present.md");
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        resolvedStartupFiles: [{ absolutePath: requiredPath, required: true }],
      }) as never,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "green",
      remediation: "",
    }));
    expect(startup.evidence).toContain(requiredPath);
    expect(result.repairPacket).toBeNull();
  });

  it("non-ready snapshot-backed node with missing startup context is blocked, not actionable", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({
        nodeId: "node-1" as never,
        sessionStatus: "stopped",
        startupStatus: "failed",
        latestError: "seat crashed",
      })],
      getStartupContext: () => startupContextProbe({
        status: "missing",
        evidence: "Persisted startup context missing for node node-1",
      }) as never,
      getLatestSnapshot: () => ({ id: "snap-123", kind: "auto-pre-down" }),
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "red",
    }));
    expect(startup.evidence).toContain("Persisted startup context missing");
    expect(result.recovery).toEqual(expect.objectContaining({
      status: "blocked",
      actions: [],
      blocked: [
        expect.objectContaining({
          scope: "rig",
          reason: expect.stringContaining("Persisted startup context missing"),
        }),
      ],
    }));
  });

  it("running/ready node with missing startup context is a yellow caveat, not a recovery block", () => {
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        status: "missing",
        evidence: "Persisted startup context missing for node node-1",
      }) as never,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
    }));
    expect(startup.evidence).toContain("Persisted startup context missing");
    expect(result.recovery).toEqual({
      status: "not_needed",
      summary: expect.stringContaining("no recovery action needed"),
      actions: [],
      blocked: [],
      unknown: [],
    });
  });

  it("non-ready node with missing required startup file is a red restore-input blocker", () => {
    const requiredPath = path.join(os.tmpdir(), "restore-check-startup-required-missing.md");
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [claudeNode({
        sessionStatus: "stopped",
        startupStatus: "failed",
        latestError: "seat crashed",
      })],
      getStartupContext: () => startupContextProbe({
        resolvedStartupFiles: [{ absolutePath: requiredPath, required: true }],
      }) as never,
      getLatestSnapshot: () => ({ id: "snap-123", kind: "auto-pre-down" }),
      exists: (p) => p !== requiredPath,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "red",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain(requiredPath);
    expect(result.recovery).toEqual(expect.objectContaining({
      status: "blocked",
      actions: [],
      blocked: [
        expect.objectContaining({
          scope: "rig",
          reason: expect.stringContaining(requiredPath),
        }),
      ],
    }));
  });

  // #261: restore-check inspects and REPORTS the paths replay will use. A stale old-install built-in or
  // shipped-spec resource is judged at the running install; red/yellow semantics are unchanged.
  describe("#261 stale old-install paths are judged at the running install", () => {
    const OLD = "/old-openrig/lib/node_modules/@openrig/cli/daemon";
    const RUN_ASSETS = path.resolve(import.meta.dirname, "../assets");
    const RUN_SPECS = path.resolve(import.meta.dirname, "../specs");
    const files = [{ path: "CULTURE-default.md", absolutePath: `${OLD}/assets/guidance/CULTURE-default.md`, ownerRoot: `${OLD}/assets`, required: true }];
    const entries = [{ absolutePath: `${OLD}/specs/agents/shared/runtime/claude-settings.fragment.json`, sourcePath: `${OLD}/specs/agents/shared`, effectiveId: "shared:claude-default-settings", category: "runtime_resource" }];
    const stoppedNode = () => claudeNode({ sessionStatus: "stopped", startupStatus: "failed", latestError: "seat crashed" });

    it("old install removed, current present: green, and evidence names only the running paths", () => {
      const service = new RestoreCheckService(mockDeps({
        getNodeInventory: () => [stoppedNode()],
        getStartupContext: () => startupContextProbe({ resolvedStartupFiles: files, projectionEntries: entries }) as never,
        getLatestSnapshot: () => ({ id: "snap-261", kind: "auto-pre-down" }),
        exists: (p) => !p.startsWith("/old-openrig"),
      }));
      const startup = (service.check({ noQueue: true, noHooks: true }) as any).checks.find((c: { check: string }) => c.check === "seat.dev-impl@test-rig.startup-context");
      expect(startup.status).toBe("green");
      expect(startup.evidence).toContain(path.join(RUN_ASSETS, "guidance", "CULTURE-default.md"));
      expect(startup.evidence).toContain(path.join(RUN_SPECS, "agents", "shared", "runtime", "claude-settings.fragment.json"));
      expect(startup.evidence).not.toContain("/old-openrig");
    });

    it("current built-in genuinely missing on a non-ready seat: still red, reporting the running path", () => {
      const runningCulture = path.join(RUN_ASSETS, "guidance", "CULTURE-default.md");
      const service = new RestoreCheckService(mockDeps({
        getNodeInventory: () => [stoppedNode()],
        getStartupContext: () => startupContextProbe({ resolvedStartupFiles: files }) as never,
        getLatestSnapshot: () => ({ id: "snap-261", kind: "auto-pre-down" }),
        exists: (p) => !p.startsWith("/old-openrig") && p !== runningCulture,
      }));
      const startup = (service.check({ noQueue: true, noHooks: true }) as any).checks.find((c: { check: string }) => c.check === "seat.dev-impl@test-rig.startup-context");
      expect(startup.status).toBe("red");
      expect(startup.evidence).toContain(runningCulture);
      expect(startup.remediation).toContain(runningCulture);
      expect(startup.evidence).not.toContain("/old-openrig");
    });

    it("shipped-spec rig culture: stale old path is judged at the running specs (green when present, red naming it when missing)", () => {
      const culture = [{ path: "culture/CULTURE.md", absolutePath: `${OLD}/specs/rigs/launch/kernel/culture/CULTURE.md`, ownerRoot: `${OLD}/specs/rigs/launch/kernel`, required: true }];
      const runningCulture = path.join(RUN_SPECS, "rigs", "launch", "kernel", "culture", "CULTURE.md");
      const check = (exists: (p: string) => boolean) => (new RestoreCheckService(mockDeps({
        getNodeInventory: () => [stoppedNode()],
        getStartupContext: () => startupContextProbe({ resolvedStartupFiles: culture }) as never,
        getLatestSnapshot: () => ({ id: "snap-261", kind: "auto-pre-down" }),
        exists,
      })).check({ noQueue: true, noHooks: true }) as any).checks.find((c: { check: string }) => c.check === "seat.dev-impl@test-rig.startup-context");
      const present = check((p) => !p.startsWith("/old-openrig"));
      expect(present.status).toBe("green");
      expect(present.evidence).toContain(runningCulture);
      const missing = check((p) => !p.startsWith("/old-openrig") && p !== runningCulture);
      expect(missing.status).toBe("red");
      expect(missing.evidence).toContain(runningCulture);
      expect(missing.evidence).not.toContain("/old-openrig");
    });

    it("current built-in missing on a running/ready seat stays yellow (red/yellow rule unchanged)", () => {
      const runningCulture = path.join(RUN_ASSETS, "guidance", "CULTURE-default.md");
      const service = new RestoreCheckService(mockDeps({
        getStartupContext: () => startupContextProbe({ resolvedStartupFiles: files }) as never,
        exists: (p) => !p.startsWith("/old-openrig") && p !== runningCulture,
      }));
      const startup = (service.check({ noQueue: true, noHooks: true }) as any).checks.find((c: { check: string }) => c.check === "seat.dev-impl@test-rig.startup-context");
      expect(startup.status).toBe("yellow");
    });

    it("a missing custom file with a built-in basename is reported as stored, still red on a non-ready seat", () => {
      const custom = [{ path: "CULTURE-default.md", absolutePath: "/user-rig/CULTURE-default.md", ownerRoot: "/user-rig", required: true }];
      const service = new RestoreCheckService(mockDeps({
        getNodeInventory: () => [stoppedNode()],
        getStartupContext: () => startupContextProbe({ resolvedStartupFiles: custom }) as never,
        getLatestSnapshot: () => ({ id: "snap-261", kind: "auto-pre-down" }),
        exists: (p) => p !== "/user-rig/CULTURE-default.md",
      }));
      const startup = (service.check({ noQueue: true, noHooks: true }) as any).checks.find((c: { check: string }) => c.check === "seat.dev-impl@test-rig.startup-context");
      expect(startup.status).toBe("red");
      expect(startup.evidence).toContain("/user-rig/CULTURE-default.md");
    });
  });

  it("running/ready node with missing required startup file is a yellow caveat", () => {
    const requiredPath = path.join(os.tmpdir(), "restore-check-startup-required-ready-missing.md");
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        resolvedStartupFiles: [{ absolutePath: requiredPath, required: true }],
      }) as never,
      exists: (p) => p !== requiredPath,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain(requiredPath);
    expect(result.recovery.status).toBe("not_needed");
  });

  it("missing optional startup file is a yellow caveat", () => {
    const optionalPath = path.join(os.tmpdir(), "restore-check-startup-optional-missing.md");
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        resolvedStartupFiles: [{ absolutePath: optionalPath, required: false }],
      }) as never,
      exists: (p) => p !== optionalPath,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain(optionalPath);
  });

  it("missing projection-entry source path is a yellow caveat, not a blocker", () => {
    const projectionPath = path.join(os.tmpdir(), "restore-check-projection-source-missing.md");
    const service = new RestoreCheckService(mockDeps({
      getStartupContext: () => startupContextProbe({
        projectionEntries: [{ absolutePath: projectionPath, effectiveId: "openrig-user", category: "guidance" }],
      }) as never,
      exists: (p) => p !== projectionPath,
    }));

    const result = service.check({ noQueue: true, noHooks: true }) as any;
    const startup = result.checks.find((check: { check: string }) => check.check === "seat.dev-impl@test-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain(projectionPath);
    expect(result.recovery.status).toBe("not_needed");
  });

  it("stopped rig without latest snapshot is actionable when durable current state is present", () => {
    const service = new RestoreCheckService(mockDeps({
      hasSnapshot: () => false,
      getNodeInventory: () => [claudeNode({
        canonicalSessionName: "dev-impl@test-rig",
        sessionStatus: "stopped",
        startupStatus: "failed",
        tmuxAttachCommand: null,
      })],
      getLatestSnapshot: () => null,
    }));

    const result = service.check({ noHooks: true }) as any;

    expect(result.readiness.status).toBe("not_ready");
    expect(result.recovery).toEqual({
      status: "actionable",
      summary: expect.stringContaining("1 rig can be recovered"),
      actions: [
        expect.objectContaining({
          scope: "rig",
          rigId: "rig-1",
          rigName: "test-rig",
          command: "rig up --existing test-rig",
          reason: expect.stringContaining("current DB state"),
        }),
      ],
      blocked: [],
      unknown: [],
    });
  });

  it("stopped infrastructure node is represented in readiness and prevents ready", () => {
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

    expect(result.readiness.status).toBe("not_ready");
    expect(result.readiness.blockingRigCount).toBe(1);
    expect(result.rigs[0]).toEqual(expect.objectContaining({
      expectedNodes: 1,
      runningReadyNodes: 0,
      blockedNodes: 1,
      status: "not_ready",
    }));
    expect(result.rigs[0].blockingChecks.some((check: { check: string }) => check.check.includes("readiness"))).toBe(true);
    expect(result.repairPacket?.some((step: { blocking: boolean; safe: boolean }) => step.blocking && step.safe === false)).toBe(true);
  });

  it("running infrastructure node counts ready while transcript-exempt", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [{
        nodeId: "node-1",
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
    expect(result.readiness.status).toBe("ready");
    expect(result.rigs[0]).toEqual(expect.objectContaining({
      expectedNodes: 1,
      runningReadyNodes: 1,
      blockedNodes: 0,
      caveatNodes: 0,
    }));
    const transcript = result.checks.find((check: { check: string }) => check.check === "seat.infra-board@test-rig.transcript");
    expect(transcript.status).toBe("green");
  });

  it("missing canonical session identity blocks ready", () => {
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

    expect(result.readiness.status).toBe("not_ready");
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

  // --- H62 absence proofs ---

  it("result has no top-level fullyBack field", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true }) as Record<string, unknown>;
    expect("fullyBack" in result).toBe(false);
  });

  it("result has no top-level assertion field", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true }) as Record<string, unknown>;
    expect("assertion" in result).toBe(false);
  });

  it("per-rig status uses readiness vocabulary, not fully_back/not_fully_back", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    for (const rig of result.rigs) {
      expect(["ready", "ready_with_caveats", "not_ready", "unknown"]).toContain(rig.status);
      expect(rig.status).not.toBe("fully_back");
      expect(rig.status).not.toBe("not_fully_back");
    }
  });

  // --- H62 continuity assertions ---

  it("continuity is always not_proven in v1 with populated unprovenCapabilities", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    expect(result.continuity.status).toBe("not_proven");
    expect(result.continuity.evidence).toBeTruthy();
    expect(result.continuity.unprovenCapabilities.length).toBeGreaterThan(0);
    expect(result.continuity.unprovenCapabilities).toContain("provider_session_resume");
    expect(result.continuity.unprovenCapabilities).toContain("context_window_preservation");
    expect(result.continuity.unprovenCapabilities).toContain("interrupted_work_functional_resume");
  });

  it("all-green observable rig still has continuity not_proven", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({ noHooks: true });
    expect(result.readiness.status).toBe("ready");
    expect(result.continuity.status).toBe("not_proven");
  });

  it("unknown/probe-error result has continuity not_proven", () => {
    const service = new RestoreCheckService(mockDeps({
      probeDaemonHealth: () => { throw new Error("socket unavailable"); },
    }));
    const result = service.check({});
    expect(result.readiness.status).toBe("unknown");
    expect(result.continuity.status).toBe("not_proven");
  });
});
