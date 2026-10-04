import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";

const opened: Database.Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) {
    if (db.open) db.close();
  }
  vi.unstubAllEnvs();
});

function createTestDb() {
  const db = new Database(":memory:");
  opened.push(db);
  db.pragma("foreign_keys = ON");
  migrate(db, ALL_MIGRATIONS);
  return db;
}

function binding(nodeId: string): NodeBinding {
  return { nodeId, runtime: "claude-code", sessionName: "seat", cwd: "/inert" };
}

describe("Issue #611 Declarative Permission Policy Precedence & Cascade", () => {
  it("Level 1: explicit per-seat selection overrides member, rig, and system defaults", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    rigRepo.setRigPolicyProvenance(rig.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", permissionPolicy: "builtin:locked" });
    rigRepo.setNodePolicyProvenance(node.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/locked.policy.md",
      declaringDir: null,
      launchPosture: "floor",
    });

    const store = new NativePermissionStore(db);

    // Before explicit selection, member-level policy wins over rig
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "member_spec",
      launchPosture: "floor",
    });

    // Record explicit seat selection
    store.write(node.id, { runtime: "claude-code", mode: "full_bypass" }, "admin", "test elevation");

    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "full_bypass",
      source: "explicit",
      launchPosture: "full_bypass",
    });

    // Record explicit auto selection
    store.write(node.id, { runtime: "claude-code", mode: "auto" }, "admin", "auto mode");
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "explicit",
      permissionMode: "auto",
    });

    // Clearing explicit selection reverts to member_spec
    store.write(node.id, null, "admin", "clear");
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "member_spec",
      launchPosture: "floor",
    });
  });

  it("Level 2: member-level permission_policy resolves with member_spec source", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", permissionPolicy: "builtin:auto" });
    rigRepo.setNodePolicyProvenance(node.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const store = new NativePermissionStore(db);
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "member_spec",
      launchPosture: "auto",
      permissionMode: "auto",
    });
  });

  it("Precedence: member's own permission_policy is NEVER silently outranked by a rig-wide default", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    rigRepo.setRigPolicyProvenance(rig.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    // Member declares builtin:locked
    const lockedNode = rigRepo.addNode(rig.id, "locked-worker", { runtime: "claude-code", permissionPolicy: "builtin:locked" });
    rigRepo.setNodePolicyProvenance(lockedNode.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/locked.policy.md",
      declaringDir: null,
      launchPosture: "floor",
    });

    // Member declares none
    const noneNode = rigRepo.addNode(rig.id, "none-worker", { runtime: "claude-code", permissionPolicy: "none" });
    rigRepo.setNodePolicyProvenance(noneNode.id, {
      origin: "deliberate_none",
      resolvedTarget: null,
      declaringDir: null,
      launchPosture: "floor",
    });

    // Member declares builtin:yolo
    const yoloNode = rigRepo.addNode(rig.id, "yolo-worker", { runtime: "claude-code", permissionPolicy: "builtin:yolo" });
    rigRepo.setNodePolicyProvenance(yoloNode.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/yolo.policy.md",
      declaringDir: null,
      launchPosture: "full_bypass",
    });

    const store = new NativePermissionStore(db);

    // Locked member retains floor acceptEdits despite rig being builtin:auto
    expect(store.resolve(lockedNode.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "member_spec",
      launchPosture: "floor",
    });

    // None member retains floor acceptEdits despite rig being builtin:auto
    expect(store.resolve(noneNode.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "member_spec",
      launchPosture: "floor",
    });

    // Yolo member retains full_bypass
    expect(store.resolve(yoloNode.id, "claude-code")).toEqual({
      effectiveMode: "full_bypass",
      source: "member_spec",
      launchPosture: "full_bypass",
    });
  });

  it("Level 3: rig-level permission_policy: builtin:auto cascades to seats without member policy", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("test-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    rigRepo.setRigPolicyProvenance(rig.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = rigRepo.addNode(rig.id, "unspecified-worker", { runtime: "claude-code" });

    const store = new NativePermissionStore(db);
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "rig_spec",
      launchPosture: "auto",
      permissionMode: "auto",
    });
  });

  it("Heterogeneous rig safety: Codex seats safely fall back to floor on a builtin:auto rig", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("hetero-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    rigRepo.setRigPolicyProvenance(rig.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const claudeNode = rigRepo.addNode(rig.id, "claude-lead", { runtime: "claude-code" });
    const codexNode = rigRepo.addNode(rig.id, "codex-dev", { runtime: "codex" });
    const codexExplicitAuto = rigRepo.addNode(rig.id, "codex-auto", { runtime: "codex", permissionPolicy: "builtin:auto" });

    const store = new NativePermissionStore(db);

    // Claude seat gets auto
    expect(store.resolve(claudeNode.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "rig_spec",
      launchPosture: "auto",
      permissionMode: "auto",
    });

    // Codex seat falls back to floor because Codex does not support --permission-mode auto
    expect(store.resolve(codexNode.id, "codex")).toEqual({
      effectiveMode: "floor",
      source: "rig_spec",
      launchPosture: "floor",
    });

    // Even if Codex member declared builtin:auto, it safely falls back to floor
    expect(store.resolve(codexExplicitAuto.id, "codex")).toEqual({
      effectiveMode: "floor",
      source: "member_spec",
      launchPosture: "floor",
    });
  });

  it("Level 4: system default floor applies when neither member nor rig declares a policy", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("default-rig");
    const claudeNode = rigRepo.addNode(rig.id, "claude-seat", { runtime: "claude-code" });
    const codexNode = rigRepo.addNode(rig.id, "codex-seat", { runtime: "codex" });

    const store = new NativePermissionStore(db);

    expect(store.resolve(claudeNode.id, "claude-code")).toEqual({
      effectiveMode: "acceptEdits",
      source: "system_default",
      launchPosture: "floor",
    });

    expect(store.resolve(codexNode.id, "codex")).toEqual({
      effectiveMode: "floor",
      source: "system_default",
      launchPosture: "floor",
    });
  });

  it("Custom flag policy: policy with launch_posture: auto resolves correctly", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("custom-rig");
    const node = rigRepo.addNode(rig.id, "custom-seat", { runtime: "claude-code", permissionPolicy: "policies/my-auto.policy.md" });
    rigRepo.setNodePolicyProvenance(node.id, {
      origin: "custom",
      resolvedTarget: "/workspace/policies/my-auto.policy.md",
      declaringDir: "/workspace",
      launchPosture: "auto",
    });

    const store = new NativePermissionStore(db);
    expect(store.resolve(node.id, "claude-code")).toEqual({
      effectiveMode: "auto",
      source: "member_spec",
      launchPosture: "auto",
      permissionMode: "auto",
    });
  });
});

describe("RigSpec Schema, Codec & Validation for permission_policy", () => {
  it("parses, validates and serializes permission_policy: builtin:auto in rig.yaml", () => {
    const yaml = `
version: "0.2"
name: test-rig
permission_policy: builtin:auto
pods:
  - id: team
    label: Team
    members:
      - id: lead
        agent_ref: local:agents/lead
        profile: default
        runtime: claude-code
        cwd: .
        permission_policy: builtin:locked
      - id: dev
        agent_ref: local:agents/dev
        profile: default
        runtime: claude-code
        cwd: .
        permission_policy: builtin:auto
    edges: []
edges: []
`;
    const parsed = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    const spec = RigSpecSchema.normalize(parsed);
    expect(spec.permissionPolicy).toBe("builtin:auto");
    expect(spec.pods[0]?.members[0]?.permissionPolicy).toBe("builtin:locked");
    expect(spec.pods[0]?.members[1]?.permissionPolicy).toBe("builtin:auto");

    const serialized = RigSpecCodec.serialize(spec);
    expect(serialized).toContain("permission_policy: builtin:auto");
    expect(serialized).toContain("permission_policy: builtin:locked");
  });

  it("rejects unknown built-in policies and bare un-prefixed names", () => {
    const unknownYaml = `
version: "0.2"
name: test-rig
permission_policy: builtin:nonexistent
pods: []
edges: []
`;
    const unknownParsed = RigSpecCodec.parse(unknownYaml);
    const unknownValidation = RigSpecSchema.validate(unknownParsed);
    expect(unknownValidation.valid).toBe(false);
    expect(unknownValidation.errors.some(e => e.includes("unknown built-in policy 'nonexistent'"))).toBe(true);

    const bareYaml = `
version: "0.2"
name: test-rig
permission_policy: auto
pods: []
edges: []
`;
    const bareParsed = RigSpecCodec.parse(bareYaml);
    const bareValidation = RigSpecSchema.validate(bareParsed);
    expect(bareValidation.valid).toBe(false);
    expect(bareValidation.errors.some(e => e.includes("is a built-in policy name — use 'builtin:auto'"))).toBe(true);
  });

  it("roundtrips permission_policy through RigSpecExporter", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);

    const rig = rigRepo.createRig("export-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    const pod = podRepo.createPod(rig.id, "default", "Default Team");
    const node1 = rigRepo.addNode(rig.id, "agent1", { runtime: "claude-code", permissionPolicy: "builtin:locked", podId: pod.id });
    const node2 = rigRepo.addNode(rig.id, "agent2", { runtime: "claude-code", podId: pod.id });

    const exporter = new RigSpecExporter({ rigRepo, podRepo, sessionRegistry });
    const exported = exporter.exportRig(rig.id) as RigSpec;
    expect(exported.permissionPolicy).toBe("builtin:auto");
    expect(exported.pods[0]?.members.find(m => m.id === "agent1")?.permissionPolicy).toBe("builtin:locked");
    expect(exported.pods[0]?.members.find(m => m.id === "agent2")?.permissionPolicy).toBeUndefined();
  });
});

describe("StartupOrchestrator Declarative Integration", () => {
  it("delivers declarative permission_policy: builtin:auto to launchHarness on fresh start", async () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("start-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    rigRepo.setRigPolicyProvenance(rig.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    const session = registry.registerSession(node.id, "worker@start-rig");

    const launchHarness = vi.fn(async () => ({ ok: false as const, error: "offline stop" }));
    const adapter = {
      runtime: "claude-code",
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: [], failed: [] }),
      launchHarness,
    } as unknown as RuntimeAdapter;

    const orchestrator = new StartupOrchestrator({
      db,
      sessionRegistry: registry,
      eventBus,
      tmuxAdapter: {} as TmuxAdapter,
    });

    await orchestrator.startNode({
      rigId: rig.id,
      nodeId: node.id,
      sessionId: session.id,
      binding: binding(node.id),
      adapter,
      plan: { entries: [] } as never,
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
    });

    expect(launchHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: "auto",
        launchPosture: "auto",
      }),
      expect.anything(),
    );
  });
});

describe("Restore & Handover Continuity", () => {
  it("RestoreOrchestrator.attemptResume passes declarative auto mode to Claude resume", async () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = rigRepo.createRig("restore-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    rigRepo.setRigPolicyProvenance(rig.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const resume = vi.fn(async () => ({ ok: false, code: "offline", message: "stop" }));
    const ctx = {
      db,
      sessionRegistry: registry,
      appliedLaunchStore: new AppliedLaunchObservationStore(db),
      claudeResume: { canResume: () => true, resume },
      codexResume: { canResume: () => false, resume },
    };

    await (RestoreOrchestrator.prototype as any).attemptResume.call(
      ctx,
      node.id,
      "seat",
      "claude_id",
      "original",
      "/inert",
      null,
      "model",
      "floor",
    );

    expect(resume).toHaveBeenCalledWith(
      "seat",
      "claude_id",
      "original",
      "/inert",
      "auto",
      "model",
      "auto",
      node.id,
    );
  });

  it("SeatHandoverService passes declarative auto mode to successor launcher", async () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const discoveryRepo = new DiscoveryRepository(db);

    const rig = rigRepo.createRig("handover-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    rigRepo.setRigPolicyProvenance(rig.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const node = rigRepo.addNode(rig.id, "incumbent-seat", { runtime: "claude-code", cwd: "/test" });
    const incumbentSession = registry.registerSession(node.id, "incumbent-seat@handover-rig");

    const createSuccessor = vi.fn(async () => ({
      ok: false as const,
      code: "test_stop",
      step: "create_successor" as const,
      message: "test stop — only asserting call args",
      replacementStarted: false,
    }));

    const handoverService = new SeatHandoverService({
      db,
      rigRepo,
      sessionRegistry: registry,
      discoveryRepo,
      eventBus,
      successorLauncher: { createSuccessor } as any,
      tmuxAdapter: { capturePaneScreen: vi.fn(async () => "") } as any,
    });

    // Provide departing occupant
    rigRepo.recordHandoverResult?.(node.id, "resumed");

    const result = await handoverService.handover({
      seatRef: "incumbent-seat@handover-rig",
      reason: "rotation",
      operator: "test",
      source: "fresh",
    });

    expect(createSuccessor).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({
          launchPosture: "auto",
          permissionMode: "auto",
        }),
      }),
    );
  });
});

describe("SeatStatusService Provenance Reporting", () => {
  it("reports honest effective permission provenance across cascade levels", () => {
    const db = createTestDb();
    const rigRepo = new RigRepository(db);
    const registry = new SessionRegistry(db);

    const rig = rigRepo.createRig("provenance-rig");
    rigRepo.setRigPermissionPolicy(rig.id, "builtin:auto");
    rigRepo.setRigPolicyProvenance(rig.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/auto.policy.md",
      declaringDir: null,
      launchPosture: "auto",
    });

    const memberNode = rigRepo.addNode(rig.id, "member-seat", { runtime: "claude-code", permissionPolicy: "builtin:locked" });
    rigRepo.setNodePolicyProvenance(memberNode.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/locked.policy.md",
      declaringDir: null,
      launchPosture: "floor",
    });

    const rigNode = rigRepo.addNode(rig.id, "rig-seat", { runtime: "claude-code" });
    registry.registerSession(memberNode.id, "member-seat@provenance-rig");
    registry.registerSession(rigNode.id, "rig-seat@provenance-rig");

    const statusService = new SeatStatusService({ rigRepo });

    // Member-level provenance: member's own builtin:locked is NOT outranked by rig
    const memberStatus = statusService.getStatus("member-seat@provenance-rig");
    expect(memberStatus).toMatchObject({
      ok: true,
      status: {
        permissions: {
          selectionState: "inherit",
          effective: {
            effectiveMode: "acceptEdits",
            source: "member_spec",
            launchPosture: "floor",
          },
        },
      },
    });

    // Rig-level provenance: inherits auto from rig
    const rigStatus = statusService.getStatus("rig-seat@provenance-rig");
    expect(rigStatus).toMatchObject({
      ok: true,
      status: {
        permissions: {
          selectionState: "inherit",
          effective: {
            effectiveMode: "auto",
            source: "rig_spec",
            launchPosture: "auto",
            permissionMode: "auto",
          },
        },
      },
    });

    // Explicit override provenance
    const store = new NativePermissionStore(db);
    store.write(rigNode.id, { runtime: "claude-code", mode: "full_bypass" }, "admin", "test");
    const explicitStatus = statusService.getStatus("rig-seat@provenance-rig");
    expect(explicitStatus).toMatchObject({
      ok: true,
      status: {
        permissions: {
          selectionState: "explicit",
          effective: {
            effectiveMode: "full_bypass",
            source: "explicit",
            launchPosture: "full_bypass",
          },
        },
      },
    });
  });
});
