import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createApp } from "../src/server.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { RestoreCheckService } from "../src/domain/restore-check-service.js";

const CLAUDE_HOOKS_ROOT = path.join(
  os.homedir(),
  "code",
  "substrate",
  "shared-docs",
  "control-plane",
  "services",
  "claude-hooks",
);
const REQUIRED_SESSION_START_COMPACT_COMMAND = path.join(
  CLAUDE_HOOKS_ROOT,
  "bin",
  "session-start-compact-context.sh",
);
const REQUIRED_USER_PROMPT_SUBMIT_COMMAND = path.join(
  CLAUDE_HOOKS_ROOT,
  "bin",
  "userpromptsubmit-queue-attention.sh",
);

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
  supportingInfraEvidencePaths?: string[];
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    daemonBootstrap: {
      declared: true,
      mechanism: "launchd",
      evidence: "com.openrig.daemon",
      evidencePaths: overrides?.daemonEvidencePaths ?? ["${OPENRIG_HOME}/daemon/launchd.plist"],
    },
    supportingInfra: [
      {
        id: "supervisor-wake",
        declared: true,
        required: true,
        evidence: "kernel rig infra seat or host launch agent",
        evidencePaths: overrides?.supportingInfraEvidencePaths ?? ["${OPENRIG_HOME}/supervisor-wake/README.md"],
      },
    ],
  });
}

function claudeHookSettings(): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "compact",
          hooks: [{ type: "command", command: REQUIRED_SESSION_START_COMPACT_COMMAND }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: REQUIRED_USER_PROMPT_SUBMIT_COMMAND }],
        },
      ],
    },
  });
}

function minimalSnapshotData(rigId: string, rigName: string) {
  return {
    rig: {
      id: rigId,
      name: rigName,
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
    nodes: [],
    edges: [],
    sessions: [],
    checkpoints: {},
  };
}

function insertStartupContextRow(db: Database.Database, nodeId: string, options?: {
  projectionEntriesJson?: string;
  resolvedFilesJson?: string;
  startupActionsJson?: string;
  runtime?: string;
}) {
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run(
    nodeId,
    options?.projectionEntriesJson ?? "[]",
    options?.resolvedFilesJson ?? "[]",
    options?.startupActionsJson ?? "[]",
    options?.runtime ?? "claude-code",
  );
}

describe("Restore check routes", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotRepo: SnapshotRepository;
  let openRigHome: string;
  let originalOpenRigHome: string | undefined;

  beforeEach(() => {
    originalOpenRigHome = process.env["OPENRIG_HOME"];
    openRigHome = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-route-openrig-home-"));
    process.env["OPENRIG_HOME"] = openRigHome;

    db = createFullTestDb();
    const setup = createTestApp(db);
    app = createApp(setup);
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotRepo = setup.snapshotRepo;
  });

  afterEach(() => {
    db.close();
    if (originalOpenRigHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = originalOpenRigHome;
    fs.rmSync(openRigHome, { recursive: true, force: true });
  });

  it("GET /api/restore-check returns JSON with verdict + checks + repairPacket", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verdict).toBeDefined();
    expect(["restorable", "restorable_with_caveats", "not_restorable", "unknown"]).toContain(body.verdict);
    expect(body.readiness).toBeDefined();
    expect(["ready", "ready_with_caveats", "not_ready", "unknown"]).toContain(body.readiness.status);
    expect(body.continuity).toBeDefined();
    expect(body.rigs).toBeInstanceOf(Array);
    expect(body.hostInfra).toBeDefined();
    expect(body.counts).toBeDefined();
    expect(body.checks).toBeInstanceOf(Array);
    // repairPacket is null when restorable, array when caveats/blockers exist
    if (body.verdict === "restorable") {
      expect(body.repairPacket).toBeNull();
    } else {
      expect(body.repairPacket).toBeInstanceOf(Array);
    }

    // Every check has required fields
    for (const check of body.checks) {
      expect(typeof check.check).toBe("string");
      expect(["green", "yellow", "red"]).toContain(check.status);
      expect(typeof check.evidence).toBe("string");
      expect(typeof check.remediation).toBe("string");
    }
  });

  it("GET /api/restore-check?rig=test-rig filters to named rig", async () => {
    rigRepo.createRig("rig-a");
    rigRepo.createRig("rig-b");

    const res = await app.request("/api/restore-check?rig=rig-a");
    const body = await res.json();

    const rigChecks = body.checks.filter((c: { check: string }) => c.check.includes("rig."));
    expect(rigChecks.every((c: { check: string }) => !c.check.includes("rig-b"))).toBe(true);
  });

  it("GET /api/restore-check?rig=unknown returns not_restorable with red check", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent");
    const body = await res.json();

    expect(body.verdict).toBe("not_restorable");
    const notFound = body.checks.find((c: { check: string }) => c.check.includes("nonexistent"));
    expect(notFound).toBeDefined();
    expect(notFound.status).toBe("red");
  });

  it("GET /api/restore-check?noQueue=true skips queue checks", async () => {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?noQueue=true");
    const body = await res.json();

    const queueChecks = body.checks.filter((c: { check: string }) => c.check.includes("queue-file"));
    expect(queueChecks).toHaveLength(0);
  });

  it("GET /api/restore-check?noHooks=true skips hook checks", async () => {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?noHooks=true");
    const body = await res.json();

    const hookChecks = body.checks.filter((c: { check: string }) => c.check.includes("hooks"));
    expect(hookChecks).toHaveLength(0);
  });

  it("GET /api/restore-check uses node cwd to inspect project-local Claude hook settings", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-route-hook-cwd-"));
    const settingsDir = path.join(projectDir, ".claude");
    const settingsPath = path.join(settingsDir, "settings.local.json");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, claudeHookSettings());
    const rig = rigRepo.createRig("hooked-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: projectDir });

    try {
      const res = await app.request("/api/restore-check?rig=hooked-rig");
      const body = await res.json();
      const hook = body.checks.find((c: { check: string }) => c.check.includes(".hooks"));

      expect(res.status).toBe(200);
      expect(hook).toEqual(expect.objectContaining({
        status: "green",
        remediation: "",
      }));
      expect(hook.evidence).toContain(settingsPath);
      expect(hook.evidence).toContain("configuration present, not hook-execution verified");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("GET /api/restore-check returns actionable recovery for a snapshot-backed stopped rig", async () => {
    const rig = rigRepo.createRig("recoverable-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@recoverable-rig");
    sessionRegistry.updateStatus(session.id, "stopped");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    insertStartupContextRow(db, node.id);
    snapshotRepo.createSnapshot(rig.id, "auto-pre-down", minimalSnapshotData(rig.id, rig.name) as never);

    const res = await app.request("/api/restore-check?rig=recoverable-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.recovery).toEqual({
      status: "actionable",
      summary: expect.stringContaining("1 rig can be recovered"),
      actions: [
        expect.objectContaining({
          scope: "rig",
          rigId: rig.id,
          rigName: "recoverable-rig",
          command: "rig up --existing recoverable-rig",
          safe: false,
          blocking: true,
        }),
      ],
      blocked: [],
      unknown: [],
    });
  });

  it("GET /api/restore-check blocks recovery when a stopped snapshot-backed rig is missing startup context", async () => {
    const rig = rigRepo.createRig("recoverable-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@recoverable-rig");
    sessionRegistry.updateStatus(session.id, "stopped");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    snapshotRepo.createSnapshot(rig.id, "auto-pre-down", minimalSnapshotData(rig.id, rig.name) as never);

    const res = await app.request("/api/restore-check?rig=recoverable-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const startup = body.checks.find((c: { check: string }) => c.check === "seat.dev-impl@recoverable-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "red",
    }));
    expect(startup.evidence).toContain("startup context");
    expect(body.recovery).toEqual({
      status: "blocked",
      summary: expect.stringContaining("1 rig blocked"),
      actions: [],
      blocked: [
        expect.objectContaining({
          scope: "rig",
          rigId: rig.id,
          rigName: "recoverable-rig",
          reason: expect.stringContaining("startup context"),
        }),
      ],
      unknown: [],
    });
  });

  it("GET /api/restore-check returns structured JSON for malformed startup-context rows", async () => {
    const rig = rigRepo.createRig("malformed-startup-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@malformed-startup-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    insertStartupContextRow(db, node.id, {
      resolvedFilesJson: "{",
    });

    const res = await app.request("/api/restore-check?rig=malformed-startup-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const startup = body.checks.find((c: { check: string }) => c.check === "seat.dev-impl@malformed-startup-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain("JSON");
    expect(startup.evidence).toContain("resolved_files_json");
    expect(body.readiness.reason).not.toBe("unknown_probe_state");
    expect(body.checks.some((c: { check: string }) => c.check === "probe.error")).toBe(false);
  });

  it("GET /api/restore-check does not false-green malformed startup_actions_json", async () => {
    const rig = rigRepo.createRig("malformed-startup-actions-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@malformed-startup-actions-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    insertStartupContextRow(db, node.id, {
      startupActionsJson: "{",
    });

    const res = await app.request("/api/restore-check?rig=malformed-startup-actions-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const startup = body.checks.find((c: { check: string }) => c.check === "seat.dev-impl@malformed-startup-actions-rig.startup-context");

    expect(startup).toBeDefined();
    expect(startup.status).not.toBe("green");
    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain("startup_actions_json");
    expect(body.readiness.reason).not.toBe("unknown_probe_state");
    expect(body.checks.some((c: { check: string }) => c.check === "probe.error")).toBe(false);
  });

  it("daemon.reachable is green inside daemon route (self-proof)", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    const body = await res.json();

    const daemon = body.checks.find((c: { check: string }) => c.check === "daemon.reachable");
    expect(daemon).toBeDefined();
    expect(daemon.status).toBe("green");
    expect(daemon.evidence).toContain("Daemon running");
  });

  it("GET /api/restore-check returns non-null repairPacket with blocking field for broken fixture", async () => {
    // Create a rig with a node — hooks are yellow by default (Slice 2 unimplemented),
    // producing restorable_with_caveats and a non-null repairPacket
    const rig = rigRepo.createRig("broken-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?rig=broken-rig");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.readiness).toBeDefined();
    expect(body.readiness.status).not.toBe("ready");
    expect(body.rigs).toBeInstanceOf(Array);
    expect(body.rigs[0]).toEqual(expect.objectContaining({
      rigId: rig.id,
      rigName: "broken-rig",
      expectedNodes: 1,
      runningReadyNodes: expect.any(Number),
      blockedNodes: expect.any(Number),
      caveatNodes: expect.any(Number),
      blockingChecks: expect.any(Array),
      caveatChecks: expect.any(Array),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "not_declared",
    }));
    // Hooks yellow → restorable_with_caveats → repairPacket populated
    expect(body.repairPacket).toBeInstanceOf(Array);
    expect(body.repairPacket.length).toBeGreaterThan(0);

    // Each repair step has the required fields including blocking
    for (const step of body.repairPacket) {
      expect(typeof step.step).toBe("number");
      expect(typeof step.command).toBe("string");
      expect(typeof step.rationale).toBe("string");
      expect(typeof step.safe).toBe("boolean");
      expect(typeof step.blocking).toBe("boolean");
    }

    // Yellow hooks are non-blocking caveats
    const hookStep = body.repairPacket.find((s: { rationale: string }) => s.rationale.includes("Hook"));
    if (hookStep) {
      expect(hookStep.blocking).toBe(false);
    }
  });

  it("GET /api/restore-check surfaces declared host-infra state from OPENRIG_HOME", async () => {
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), VALID_HOST_INFRA_DECLARATION);
    rigRepo.createRig("declared-rig");

    const res = await app.request("/api/restore-check?rig=declared-rig");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(check).toEqual(expect.objectContaining({
      status: "green",
    }));
    expect(check.evidence).toContain(path.join(openRigHome, "host-infra.json"));
    expect(check.evidence).toContain("declared, not verified");
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
      evidence: expect.stringContaining("declared, not verified"),
    }));
  });

  it("GET /api/restore-check surfaces schemaVersion 2 evidence paths present", async () => {
    const daemonPath = path.join(openRigHome, "daemon", "launchd.plist");
    const supportPath = path.join(openRigHome, "supervisor-wake", "README.md");
    fs.mkdirSync(path.dirname(daemonPath), { recursive: true });
    fs.mkdirSync(path.dirname(supportPath), { recursive: true });
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), v2HostInfraDeclaration());
    fs.writeFileSync(daemonPath, "daemon evidence");
    fs.writeFileSync(supportPath, "support evidence");
    rigRepo.createRig("declared-rig");

    const res = await app.request("/api/restore-check?rig=declared-rig");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(check).toEqual(expect.objectContaining({
      status: "green",
    }));
    expect(check.evidence).toContain("declared, evidence paths present, not autostart verified");
    expect(check.evidence).toContain(daemonPath);
    expect(check.evidence).toContain(supportPath);
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
      evidence: expect.stringContaining("not autostart verified"),
    }));
  });

  it("GET /api/restore-check surfaces schemaVersion 2 missing evidence path as caveat", async () => {
    const daemonPath = path.join(openRigHome, "daemon", "launchd.plist");
    const supportPath = path.join(openRigHome, "supervisor-wake", "README.md");
    fs.mkdirSync(path.dirname(daemonPath), { recursive: true });
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), v2HostInfraDeclaration());
    fs.writeFileSync(daemonPath, "daemon evidence");
    rigRepo.createRig("declared-rig");

    const res = await app.request("/api/restore-check?rig=declared-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(check).toEqual(expect.objectContaining({
      status: "yellow",
    }));
    expect(check.evidence).toContain(supportPath);
    expect(body.hostInfra.status).toBe("declared");
    expect(body.repairPacket.some((step: { command: string; safe: boolean; blocking: boolean }) => (
      step.command.includes(supportPath) && step.safe === false && step.blocking === false
    ))).toBe(true);
  });

  it("GET /api/restore-check?rig=nonexistent preserves missing host-infra state", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(body.verdict).toBe("not_restorable");
    expect(check).toEqual(expect.objectContaining({
      status: "yellow",
      evidence: expect.stringContaining(path.join(openRigHome, "host-infra.json")),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "not_declared",
      evidence: check.evidence,
    }));
  });

  it("GET /api/restore-check?rig=nonexistent preserves declared host-infra state", async () => {
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), VALID_HOST_INFRA_DECLARATION);
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(body.verdict).toBe("not_restorable");
    expect(check).toEqual(expect.objectContaining({
      status: "green",
      evidence: expect.stringContaining(path.join(openRigHome, "host-infra.json")),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
      evidence: check.evidence,
    }));
  });

  it("GET /api/restore-check route catch returns actionable repairPacket", async () => {
    const spy = vi.spyOn(RestoreCheckService.prototype, "check").mockImplementationOnce(() => {
      throw new Error("route boom");
    });

    try {
      const res = await app.request("/api/restore-check");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.verdict).toBe("unknown");
      expect(body.readiness.status).toBe("unknown");
      expect(body.readiness.reason).toBe("unknown_probe_state");
      expect(body.recovery).toEqual({
        status: "unknown",
        summary: expect.stringContaining("could not be inspected"),
        actions: [],
        blocked: [],
        unknown: [
          expect.objectContaining({
            scope: "host",
            reason: expect.stringContaining("route boom"),
          }),
        ],
      });
      expect(body.checks[0]).toEqual(expect.objectContaining({
        check: "probe.error",
        status: "red",
        remediation: "Check daemon logs with: rig daemon logs",
      }));
      expect(body.checks[0].evidence).toContain("route boom");
      expect(body.repairPacket).toEqual([{
        step: 1,
        command: "Check daemon logs with: rig daemon logs",
        rationale: expect.stringContaining("route boom"),
        safe: true,
        blocking: true,
      }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("GET /api/restore-check?rig=nonexistent returns repairPacket with blocking:true entry", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent");
    const body = await res.json();

    expect(body.verdict).toBe("not_restorable");
    expect(body.repairPacket).toBeInstanceOf(Array);
    const blocker = body.repairPacket.find((s: { blocking: boolean }) => s.blocking);
    expect(blocker).toBeDefined();
    expect(blocker.command).toContain("rig ps");
  });

  // --- H62 absence proofs ---

  it("GET /api/restore-check response has no fullyBack or assertion fields", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    const body = await res.json();

    expect("fullyBack" in body).toBe(false);
    expect("assertion" in body).toBe(false);
    expect(body.readiness).toBeDefined();
    expect(body.continuity).toBeDefined();
  });

  it("route 500 fallback emits readiness + continuity with no legacy fields", async () => {
    const spy = vi.spyOn(RestoreCheckService.prototype, "check").mockImplementationOnce(() => {
      throw new Error("fallback test");
    });

    try {
      const res = await app.request("/api/restore-check");
      expect(res.status).toBe(500);
      const body = await res.json();

      expect("fullyBack" in body).toBe(false);
      expect("assertion" in body).toBe(false);
      expect(body.readiness).toBeDefined();
      expect(body.readiness.status).toBe("unknown");
      expect(body.continuity).toBeDefined();
      expect(body.continuity.status).toBe("not_proven");
      expect(body.continuity.unprovenCapabilities).toBeInstanceOf(Array);
      expect(body.continuity.unprovenCapabilities.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("continuity is always not_proven in route responses", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    const body = await res.json();

    expect(body.continuity.status).toBe("not_proven");
    expect(body.continuity.evidence).toBeTruthy();
    expect(body.continuity.unprovenCapabilities).toContain("provider_session_resume");
  });
});
