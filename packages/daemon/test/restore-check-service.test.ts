import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry } from "../src/domain/restore-check-service.js";

const REQUIRED_SESSION_START_COMPACT_COMMAND = "/Users/wrandom/code/substrate/shared-docs/control-plane/services/claude-hooks/bin/session-start-compact-context.sh";
const REQUIRED_USER_PROMPT_SUBMIT_COMMAND = "/Users/wrandom/code/substrate/shared-docs/control-plane/services/claude-hooks/bin/userpromptsubmit-queue-attention.sh";

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

function claudeSettings(options?: {
  sessionStartCommand?: string | null;
  sessionStartMatcher?: string;
  userPromptSubmitCommand?: string | null;
  wrongEventCommand?: string | null;
}): string {
  const sessionStartHooks = [];
  if (options?.sessionStartCommand !== null) {
    sessionStartHooks.push({
      type: "command",
      command: options?.sessionStartCommand ?? REQUIRED_SESSION_START_COMPACT_COMMAND,
    });
  }

  const userPromptSubmitHooks = [];
  if (options?.userPromptSubmitCommand !== null) {
    userPromptSubmitHooks.push({
      type: "command",
      command: options?.userPromptSubmitCommand ?? REQUIRED_USER_PROMPT_SUBMIT_COMMAND,
    });
  }

  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: options?.sessionStartMatcher ?? "compact",
          hooks: sessionStartHooks,
        },
        ...(options?.wrongEventCommand
          ? [{
              matcher: "wrong-event",
              hooks: [{ type: "command", command: options.wrongEventCommand }],
            }]
          : []),
      ],
      UserPromptSubmit: [
        {
          hooks: userPromptSubmitHooks,
        },
      ],
    },
  });
}

function claudeNode(overrides?: Partial<NodeInventoryEntry> & { cwd?: string | null }): NodeInventoryEntry {
  return {
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

function settingsDeps(input: {
  settings: Record<string, string>;
  nodes?: NodeInventoryEntry[];
  hostInfraDeclared?: boolean;
}): { deps: RestoreCheckDeps; readPaths: string[] } {
  const readPaths: string[] = [];
  const settingsPaths = new Set(Object.keys(input.settings));
  return {
    readPaths,
    deps: mockDeps({
      getNodeInventory: () => input.nodes ?? [claudeNode()],
      exists: (p) => {
        if (p.endsWith("host-infra.json")) return input.hostInfraDeclared ?? true;
        if (p.includes(`${path.sep}.claude${path.sep}settings`)) return settingsPaths.has(p);
        return true;
      },
      readFile: (p) => {
        readPaths.push(p);
        if (p.endsWith("host-infra.json")) return VALID_HOST_INFRA_DECLARATION;
        const value = input.settings[p];
        if (value === undefined) throw new Error(`unexpected read: ${p}`);
        return value;
      },
    }),
  };
}

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
    readFile: () => VALID_HOST_INFRA_DECLARATION,
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

  // --- Host-infra declaration ---

  it("missing host-infra declaration is a non-blocking caveat and prevents fully_back", () => {
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
      expect(result.fullyBack).toBe(false);
      expect(result.assertion.reason).toBe("caveats_present");
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
      expect(result.fullyBack).toBe(false);
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
      expect(result.fullyBack).toBe(false);
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
      expect(result.fullyBack).toBe(true);
      expect(result.assertion.reason).toBe("observable_rigs_fully_back_host_infra_declared_not_verified");
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
      expect(result.fullyBack).toBe(true);
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
      expect(result.fullyBack).toBe(false);
      expect(result.assertion.reason).toBe("caveats_present");
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
      expect(result.fullyBack).toBe(false);
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
      expect(result.fullyBack).toBe(false);
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
      expect(result.fullyBack).toBe(true);
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
      expect(result.fullyBack).toBe(false);
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
      expect(result.fullyBack).toBe(false);
      expect(result.assertion.reason).toBe("caveats_present");
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

  it("Claude hook check is green when project-local settings contain both required hooks", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-cwd-"));
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: { [settingsPath]: claudeSettings() },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("green");
      expect(hook?.evidence).toContain(settingsPath);
      expect(hook?.evidence).toContain("configuration present, not hook-execution verified");
      expect(hook?.evidence).not.toContain("not yet implemented");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Claude hook check is green from host-global settings when cwd is unavailable", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-global-home-"));
    const settingsPath = path.join(home, ".claude", "settings.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: { [settingsPath]: claudeSettings() },
        nodes: [claudeNode({ cwd: null })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("green");
      expect(hook?.evidence).toContain(settingsPath);
      expect(hook?.evidence).toContain("configuration present, not hook-execution verified");
      expect(hook?.evidence).not.toContain("cwd unavailable");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("Claude hook check is green when required hooks are split across host-global and project-local settings", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-merged-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-merged-cwd-"));
    const hostSettingsPath = path.join(home, ".claude", "settings.json");
    const localSettingsPath = path.join(cwd, ".claude", "settings.local.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {
          [hostSettingsPath]: claudeSettings({ userPromptSubmitCommand: null }),
          [localSettingsPath]: claudeSettings({ sessionStartCommand: null }),
        },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("green");
      expect(hook?.evidence).toContain("configuration present, not hook-execution verified");
      expect(hook?.evidence).toContain(hostSettingsPath);
      expect(hook?.evidence).toContain(localSettingsPath);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Claude hook check is yellow when only one required hook is configured", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-partial-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-partial-cwd-"));
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {
          [settingsPath]: claudeSettings({ userPromptSubmitCommand: null }),
        },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");
      const repair = result.repairPacket?.find((step) => step.rationale.includes("UserPromptSubmit"));

      expect(hook?.status).toBe("yellow");
      expect(hook?.evidence).toContain("UserPromptSubmit");
      expect(hook?.evidence).toContain(REQUIRED_USER_PROMPT_SUBMIT_COMMAND);
      expect(repair).toEqual(expect.objectContaining({
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("malformed applicable Claude settings keep hook check yellow even when another scope has hooks", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-malformed-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-malformed-cwd-"));
    const hostSettingsPath = path.join(home, ".claude", "settings.json");
    const localSettingsPath = path.join(cwd, ".claude", "settings.local.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {
          [hostSettingsPath]: "{ not json",
          [localSettingsPath]: claudeSettings(),
        },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("yellow");
      expect(hook?.evidence).toContain(hostSettingsPath);
      expect(hook?.evidence).toContain("configuration could not be trusted");
      expect(result.repairPacket?.find((step) => step.rationale.includes(hostSettingsPath))).toEqual(expect.objectContaining({
        safe: false,
        blocking: false,
      }));
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Codex and infrastructure hook checks are green not-applicable without hook repair steps", () => {
    const service = new RestoreCheckService(mockDeps({
      getNodeInventory: () => [
        {
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

  it("Claude hook check with missing cwd is yellow only when host-global settings do not satisfy hooks", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-no-cwd-home-"));
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {},
        nodes: [claudeNode({ cwd: null })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("yellow");
      expect(hook?.evidence).toContain("project settings were not inspected because cwd is unavailable");
      expect(hook?.evidence).toContain(path.join(home, ".claude", "settings.json"));
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("Claude hook matching is event-local and exact", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-event-local-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-event-local-cwd-"));
    const settingsPath = path.join(cwd, ".claude", "settings.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;

    try {
      const { deps } = settingsDeps({
        settings: {
          [settingsPath]: claudeSettings({
            sessionStartCommand: "./session-start-compact-context.sh",
            wrongEventCommand: REQUIRED_SESSION_START_COMPACT_COMMAND,
          }),
        },
        nodes: [claudeNode({ cwd })],
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});
      const hook = result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks");

      expect(hook?.status).toBe("yellow");
      expect(hook?.evidence).toContain("SessionStart matcher compact");
      expect(hook?.evidence).toContain(REQUIRED_SESSION_START_COMPACT_COMMAND);
      expect(hook?.evidence).not.toContain("configuration present");
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Claude hook inspection reads only existing settings files", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-readonly-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-hooks-readonly-cwd-"));
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    fs.utimesSync(cwd, new Date(946684800000), new Date(946684800000));
    const before = fs.statSync(cwd).mtimeMs;

    try {
      const { deps, readPaths } = settingsDeps({
        settings: { [settingsPath]: claudeSettings() },
        nodes: [claudeNode({ cwd })],
        hostInfraDeclared: false,
      });
      const service = new RestoreCheckService(deps);
      const result = service.check({});

      expect(result.checks.find((c) => c.check === "seat.dev-impl@test-rig.hooks")?.status).toBe("green");
      expect(readPaths).toEqual([settingsPath]);
      expect(readPaths).not.toContain(REQUIRED_SESSION_START_COMPACT_COMMAND);
      expect(readPaths).not.toContain(REQUIRED_USER_PROMPT_SUBMIT_COMMAND);
      expect(fs.statSync(cwd).mtimeMs).toBe(before);
    } finally {
      if (previousHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Claude hooks without configuration are yellow without the old placeholder", () => {
    const service = new RestoreCheckService(mockDeps());
    const result = service.check({});
    const hookChecks = result.checks.filter((c) => c.check.includes("hooks"));
    expect(hookChecks.length).toBeGreaterThan(0);
    for (const hook of hookChecks) {
      expect(hook.status).toBe("yellow");
      expect(hook.evidence).toContain("Claude Code hook configuration missing");
      expect(hook.evidence).not.toContain("not yet implemented");
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
      reason: "observable_rigs_fully_back_host_infra_declared_not_verified",
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
