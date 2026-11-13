import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import * as nativePermissionStoreModule from "../src/domain/native-permission-store.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { RestoreOrchestratorDeps } from "../src/domain/restore-orchestrator.js";
import { observeCodexSandbox, type AppliedLaunchObservation } from "../src/domain/permission-drift.js";
import { codexMemberEnvelope, observeCodexEnvelope, type CodexMemberPermissions } from "../src/domain/codex-member-permissions.js";
import {
  buildCodexResumeDisplay,
  buildNativeResumeCommand,
  buildNativeResumeDisplay,
} from "../src/domain/native-resume-probe.js";
import {
  getNodeDetail,
  getNodeInventory,
  getNodeInventoryForAllRigs,
  getNodeInventoryForRigs,
} from "../src/domain/node-inventory.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// Offline unit/domain suite: forbid real child_process execution.
const processMocks = vi.hoisted(() => ({
  execFile: vi.fn(() => {
    throw new Error("Unexpected child_process.execFile in offline unit test");
  }),
  execSync: vi.fn<() => string>(() => {
    throw new Error("Unexpected child_process.execSync in offline unit test");
  }),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: processMocks.execFile,
  execSync: processMocks.execSync,
}));

const UPDATE_OFF = "'-c' 'check_for_update_on_startup=false'";
const HIDE_NOTICES = "'-c' 'notice.hide_full_access_warning=true' '-c' 'notice.hide_gpt5_1_migration_prompt=true'";

const workspaceEnvelope: CodexMemberPermissions = {
  sandbox: "workspace-write",
  approval: "never",
  network_access: false,
  writable_roots: ["/lease/shared"],
  exclude_tmpdir_env_var: false,
  exclude_slash_tmp: true,
};

const readOnlyOnRequestEnvelope: CodexMemberPermissions = {
  sandbox: "read-only",
  approval: "on-request",
};

const workspaceUntrustedEnvelope: CodexMemberPermissions = {
  sandbox: "workspace-write",
  approval: "untrusted",
  network_access: true,
  writable_roots: [],
  exclude_tmpdir_env_var: true,
  exclude_slash_tmp: false,
};

function makeMockTmux(capturedCommands?: string[]): TmuxAdapter {
  const sendText = vi.fn(async (_target: string, text: string) => {
    capturedCommands?.push(text);
    return { ok: true as const };
  });
  return mockShellCommand({
    sendText,
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.153.4)\n› Ask Codex to do anything"),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter);
}

function inertFsOps(): CodexAdapterFsOps {
  return {
    readFile: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFile: () => {},
    exists: () => false,
    mkdirp: () => {},
    listFiles: () => [],
  };
}

function makeMockClaudeTmux(capturedCommands?: string[]): TmuxAdapter {
  const sendText = vi.fn(async (_target: string, text: string) => {
    capturedCommands?.push(text);
    return { ok: true as const };
  });
  return mockShellCommand({
    sendText,
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code v2.1.0\n❯ "),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter);
}

function makeValidFlagPolicy(posture: "floor" | "full_bypass"): string {
  return [
    "---",
    "source: custom",
    "name: synthetic-flag-policy",
    "surface: flag",
    `launch_posture: ${posture}`,
    "policy_schema_version: 1",
    "description: Synthetic test flag policy",
    "---",
    "Policy prose body.",
    "",
  ].join("\n");
}

describe("Issue #2989 — native-resume-probe Codex show-and-label builder", () => {
  describe.each(["floor", "full_bypass", "auto"] as const)("filesystem policy with %s posture fallback", (resolvedPosture) => {
    it.each([false, true])("labels the omitted policy with recorded launch=%s, including wrappers", (hasRecord) => {
      const display = buildCodexResumeDisplay("tok-filesystem", {
        codexPermissions: { filesystem: { ":root": "read", "/work": "write" }, approval: "never" },
        resolvedPosture,
        recordedLaunch: hasRecord ? {
          runtime: "codex", axis: "sandbox", state: "observed", value: "permissions:openrig-seat",
          approvalPolicy: "never", reason: "emitted_launch_arguments",
        } : null,
        launchWrapper: ["env", "POLICY_WRAPPER=1"],
      });
      const fallback = buildCodexResumeDisplay("tok-filesystem", { resolvedPosture });
      expect(display.command).toBe(fallback.command);
      expect(display.command).not.toContain("default_permissions");
      expect(display.label).toContain("shown command uses posture fallback");
      expect(display.label).toContain("does not carry the agent's filesystem policy");
      expect(display.label).toContain("omits launch_wrapper");
      expect(display.label).not.toContain("a resume now uses");
      expect(display.status).toBe(hasRecord ? "recorded_uncertain" : "no_recorded_launch");
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives Codex resume commands from member envelope, resolvedPosture, and operationalLaunchArg instead of ambient OPENRIG_YOLO", () => {
    vi.stubEnv("OPENRIG_YOLO", "1");

    // Plain floor: ambient OPENRIG_YOLO=1 must NOT leak -s danger-full-access.
    expect(buildNativeResumeCommand("codex", "tok-floor")).toBe(
      `codex -s workspace-write ${UPDATE_OFF} resume 'tok-floor'`,
    );

    // Explicit full_bypass + nonInterruptive: emits -s danger-full-access -a never plus notice flags.
    const bypass = buildCodexResumeDisplay("tok-bypass", {
      resolvedPosture: "full_bypass",
      nonInterruptive: true,
      codexDaemonOptOut: true,
    });
    expect(bypass.command).toBe(
      `codex --no-daemon -s danger-full-access -a never ${UPDATE_OFF} ${HIDE_NOTICES} resume 'tok-bypass'`,
    );

    // Kernel authority default: emits full_bypass + notice flags even without rig nonInterruptive.
    const kernel = buildCodexResumeDisplay("tok-kernel", {
      resolvedPosture: "full_bypass",
      kernelAuthority: true,
    });
    expect(kernel.command).toBe(
      `codex -s danger-full-access -a never ${UPDATE_OFF} ${HIDE_NOTICES} resume 'tok-kernel'`,
    );

    // Member permission envelope replaces posture & suppresses full_bypass notice flags, while keeping -p profile.
    const envDisplay = buildCodexResumeDisplay("tok-env", {
      codexConfigProfile: "team-prof",
      codexPermissions: workspaceEnvelope,
      resolvedPosture: "full_bypass",
      nonInterruptive: true,
    });
    expect(envDisplay.command).toContain("codex -p 'team-prof' -s workspace-write -a never ");
    expect(envDisplay.command).toContain("sandbox_workspace_write.writable_roots=[\"/lease/shared\"]");
    expect(envDisplay.command).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(envDisplay.command).toContain(`${UPDATE_OFF} resume 'tok-env'`);
    expect(envDisplay.command).not.toContain("danger-full-access");
    expect(envDisplay.command).not.toContain("hide_full_access_warning");
  });

  it("covers recorded match, recorded uncertainty, recorded difference, and no-recorded-launch cases across sandbox and approval combinations in buildCodexResumeDisplay / buildNativeResumeDisplay", () => {
    // 1. Recorded match: requires a positively recorded non-null approval matching current settings (full_bypass and all three envelope approvals).
    expect(
      buildCodexResumeDisplay("tok-2", {
        resolvedPosture: "full_bypass",
        recordedLaunch: observeCodexSandbox("-s danger-full-access -a never"),
      }),
    ).toMatchObject({ status: "recorded_match", label: null });

    for (const perms of [workspaceEnvelope, readOnlyOnRequestEnvelope, workspaceUntrustedEnvelope]) {
      const obs = observeCodexEnvelope(codexMemberEnvelope(perms));
      expect(obs.approvalPolicy).toBe(perms.approval);
      const display = buildNativeResumeDisplay("codex", "tok-env", null, null, false, null, {
        codexPermissions: perms,
        recordedLaunch: obs,
      });
      expect(display).toMatchObject({
        status: "recorded_match",
        label: null,
      });
      expect(display?.command).toContain(`-s ${perms.sandbox} -a ${perms.approval}`);
    }

    // 1b. Recorded uncertainty (J01): workspace-write with approvalPolicy === null cannot distinguish a pre-upgrade
    // on-request/untrusted envelope from a plain floor launch without -a, so floor resume retains explicit uncertainty
    // while keeping the ordinary resume command copyable.
    expect(
      buildCodexResumeDisplay("tok-hist-ww-floor", {
        resolvedPosture: "floor",
        recordedLaunch: {
          runtime: "codex",
          axis: "sandbox",
          state: "observed",
          value: "workspace-write",
          approvalPolicy: null,
          reason: "emitted_launch_arguments",
        },
      }),
    ).toEqual({
      command: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-hist-ww-floor'`,
      status: "recorded_uncertain",
      label: "launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write",
    });

    expect(
      buildNativeResumeDisplay("codex", "tok-1", null, null, false, null, {
        resolvedPosture: "floor",
        recordedLaunch: observeCodexSandbox("-s workspace-write"),
      }),
    ).toEqual({
      command: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-1'`,
      status: "recorded_uncertain",
      label: "launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write",
    });

    // 2. Recorded difference: maintainer's exact example + approval-only + profile switch.
    const fullToFloor = buildCodexResumeDisplay("tok-diff", {
      resolvedPosture: "floor",
      recordedLaunch: observeCodexSandbox("-s danger-full-access -a never"),
    });
    expect(fullToFloor).toEqual({
      command: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-diff'`,
      status: "recorded_difference",
      label: "launched with -s danger-full-access -a never; a resume now uses -s workspace-write",
    });

    const approvalDiff = buildCodexResumeDisplay("tok-app", {
      codexPermissions: { ...workspaceEnvelope, approval: "on-request" },
      recordedLaunch: observeCodexEnvelope(codexMemberEnvelope(workspaceEnvelope)),
    });
    expect(approvalDiff.status).toBe("recorded_difference");
    expect(approvalDiff.label).toBe(
      "launched with -s workspace-write -a never; a resume now uses -s workspace-write -a on-request",
    );

    const toProfile = buildCodexResumeDisplay("tok-prof", {
      codexConfigProfile: "locked",
      resolvedPosture: "floor",
      recordedLaunch: observeCodexSandbox("-s danger-full-access -a never"),
    });
    expect(toProfile.status).toBe("recorded_difference");
    expect(toProfile.label).toBe(
      "launched with -s danger-full-access -a never; a resume now uses -p 'locked'",
    );

    // Historical NULL approval_policy neither infers an old approval value from current settings nor claims no -a was emitted.
    const historicalReadOnlyNull = buildCodexResumeDisplay("tok-hist-ro", {
      codexPermissions: readOnlyOnRequestEnvelope,
      recordedLaunch: {
        runtime: "codex",
        axis: "sandbox",
        state: "observed",
        value: "read-only",
        approvalPolicy: null,
        reason: "emitted_launch_arguments",
      },
    });
    expect(historicalReadOnlyNull).toEqual({
      command: `codex -s read-only -a on-request ${UPDATE_OFF} resume 'tok-hist-ro'`,
      status: "recorded_difference",
      label: "launched with -s read-only (approval unrecorded); a resume now uses -s read-only -a on-request",
    });

    const historicalWorkspaceNull = buildCodexResumeDisplay("tok-hist-ww", {
      codexPermissions: workspaceUntrustedEnvelope,
      recordedLaunch: {
        runtime: "codex",
        axis: "sandbox",
        state: "observed",
        value: "workspace-write",
        approvalPolicy: null,
        reason: "emitted_launch_arguments",
      },
    });
    expect(historicalWorkspaceNull.status).toBe("recorded_difference");
    expect(historicalWorkspaceNull.label).toBe(
      "launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write -a untrusted",
    );

    // 3. No recorded launch: absent observation or unresolved named-profile observation.
    expect(buildCodexResumeDisplay("tok-none", { resolvedPosture: "floor" })).toEqual({
      command: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-none'`,
      status: "no_recorded_launch",
      label: "flags from current settings",
    });

    expect(
      buildCodexResumeDisplay("tok-unknown", {
        codexConfigProfile: "locked",
        resolvedPosture: "floor",
        recordedLaunch: observeCodexSandbox("-p 'locked'"),
      }),
    ).toEqual({
      command: `codex -p 'locked' ${UPDATE_OFF} resume 'tok-unknown'`,
      status: "no_recorded_launch",
      label: "flags from current settings",
    });
  });
});

describe("Issue #2989 — node-inventory & getNodeDetail Codex show-and-label projection", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let observations: AppliedLaunchObservationStore;
  let permStore: NativePermissionStore;
  let lifecycle: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    observations = new AppliedLaunchObservationStore(db);
    permStore = new NativePermissionStore(db);
    const noopTmux = new Proxy({}, {
      get: (_target, key) => (key === "deliveryGuard" ? undefined : () => {
        throw new Error("Unexpected tmux call");
      }),
    }) as TmuxAdapter;
    lifecycle = new SeatLifecycleService({
      db,
      rigRepo,
      sessionRegistry: registry,
      eventBus: new EventBus(db),
      tmuxAdapter: noopTmux,
    });
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  function createRestoreOrchestrator(overrides: Partial<RestoreOrchestratorDeps> = {}): RestoreOrchestrator {
    return new RestoreOrchestrator({
      db,
      rigRepo,
      sessionRegistry: registry,
      eventBus: new EventBus(db),
      snapshotRepo: { db },
      checkpointStore: { db },
      snapshotCapture: { db },
      nodeLauncher: { db },
      ...overrides,
    } as unknown as RestoreOrchestratorDeps);
  }

  async function runRealRestoreResolvedResume(
    restoreOrchestrator: RestoreOrchestrator,
    nodeId: string,
    rigId: string,
    token: string,
    opts?: { daemonSupported?: boolean },
  ): Promise<string> {
    const resolvedPosture = restoreOrchestrator.resolveRestorePosture(nodeId, rigId);
    const override = permStore.launchOverride(nodeId, "codex");
    const effectivePosture = override.launchPosture ?? resolvedPosture;
    const profileRow = db
      .prepare("SELECT codex_config_profile FROM nodes WHERE id = ?")
      .get(nodeId) as { codex_config_profile: string | null } | undefined;
    const sent: string[] = [];
    const adapter = new CodexResumeAdapter(makeMockTmux(sent), {
      sleep: async () => {},
      maxWaitMs: 0,
      exec: async () => "",
      ...(opts?.daemonSupported ? { detectDaemonSupport: async () => ({ kind: "supported" as const }) } : {}),
    });
    const res = await adapter.resume(
      "pane-1",
      "codex_id",
      token,
      "/work",
      profileRow?.codex_config_profile ?? null,
      effectivePosture,
      undefined,
      undefined,
      rigRepo.getRigNonInterruptive(rigId),
      override.kernelAuthority === true,
      override.teamPermissionDefault === true,
      undefined,
      override.codexPermissions,
    );
    expect(res.ok).toBe(true);
    return sent[0]!.replace(" -c 'allow_login_shell=false'", "");
  }

  it("M1: shares one pure resolveLaunchOverrideFromFacts decision between NativePermissionStore.launchOverride and batched inventory across selection, envelope, kernel, team, runtime-switch target, and refusal cases", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");

    const resolveFromFacts = (nativePermissionStoreModule as Record<string, unknown>).resolveLaunchOverrideFromFacts as
      | ((facts: Record<string, unknown>) => Pick<NodeBinding, "launchPosture" | "permissionMode" | "kernelAuthority" | "teamPermissionDefault" | "claudePermissions" | "codexPermissions">)
      | undefined;
    expect(typeof resolveFromFacts).toBe("function");

    // Direct pure-facts coverage: runtime-switch target mode replaces even broken envelope JSON, and invalid selection
    // refuses before broken envelope JSON just as NativePermissionStore.launchOverride does.
    expect(
      resolveFromFacts!({
        nodeId: "node-switch",
        logicalId: "dev.switch",
        runtime: "codex",
        selection: { state: "unavailable", error: new Error("unused when target provided") },
        codexPermissionsJson: "{broken",
        target: { selection: { runtime: "codex", mode: "full_bypass" }, codexProfile: null },
      }),
    ).toEqual({ kernelAuthority: false, teamPermissionDefault: false, launchPosture: "full_bypass" });

    expect(() =>
      resolveFromFacts!({
        nodeId: "node-order",
        logicalId: "dev.order",
        runtime: "codex",
        selection: { state: "available", value: { runtime: "codex", mode: "auto" } },
        codexPermissionsJson: "{broken",
      }),
    ).toThrow("Invalid persisted native permission selection; launch refused.");

    const restoreOrchestrator = createRestoreOrchestrator();
    const teamRig = rigRepo.createRig("team-rig");
    db.prepare("UPDATE rigs SET non_interruptive = 1 WHERE id = ?").run(teamRig.id);

    const teamNode = rigRepo.addNode(teamRig.id, "dev.floor", { runtime: "codex", cwd: "/work/floor" });
    registry.updateResumeToken(registry.registerSession(teamNode.id, "dev-floor@team-rig").id, "codex_id", "tok-floor", "hook");

    const floorSelNode = rigRepo.addNode(teamRig.id, "dev.floor-sel", { runtime: "codex", cwd: "/work/floor-sel" });
    registry.updateResumeToken(registry.registerSession(floorSelNode.id, "dev-floor-sel@team-rig").id, "codex_id", "tok-floor-sel", "hook");
    permStore.write(floorSelNode.id, { runtime: "codex", mode: "floor" }, "op@team-rig", "Explicit floor");

    const bypassNode = rigRepo.addNode(teamRig.id, "dev.bypass", { runtime: "codex", cwd: "/work/bypass" });
    registry.updateResumeToken(registry.registerSession(bypassNode.id, "dev-bypass@team-rig").id, "codex_id", "tok-bypass", "hook");
    permStore.write(bypassNode.id, { runtime: "codex", mode: "full_bypass" }, "op@team-rig", "Bypass");

    const envNode = rigRepo.addNode(teamRig.id, "dev.env", {
      runtime: "codex",
      cwd: "/work/env",
      codexConfigProfile: "lease-prof",
      codexPermissions: readOnlyOnRequestEnvelope,
    });
    registry.updateResumeToken(registry.registerSession(envNode.id, "dev-env@team-rig").id, "codex_id", "tok-env", "hook");
    observations.recordGeneration(registry.currentOccupantTenure(envNode.id)!.generationUuid, {
      ...observeCodexEnvelope(codexMemberEnvelope(readOnlyOnRequestEnvelope)),
      daemonOptOut: true,
    });

    const policyFloorNode = rigRepo.addNode(teamRig.id, "dev.policy-floor", { runtime: "codex", cwd: "/work/pfloor" });
    rigRepo.setNodePermissionPolicy(policyFloorNode.id, "builtin:locked");
    rigRepo.setNodePolicyProvenance(policyFloorNode.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/locked.policy.md",
      declaringDir: null,
      launchPosture: "floor",
    });
    registry.updateResumeToken(registry.registerSession(policyFloorNode.id, "dev-policy-floor@team-rig").id, "codex_id", "tok-pfloor", "hook");

    const corruptNode = rigRepo.addNode(teamRig.id, "ops.corrupt", { runtime: "codex", cwd: "/work/c" });
    registry.updateResumeToken(registry.registerSession(corruptNode.id, "ops-corrupt@team-rig").id, "codex_id", "tok-corrupt", "hook");
    db.prepare("UPDATE nodes SET codex_permissions_json = '{bad json' WHERE id = ?").run(corruptNode.id);

    const conflictNode = rigRepo.addNode(teamRig.id, "ops.conflict", {
      runtime: "codex",
      cwd: "/work/k",
      codexPermissions: workspaceEnvelope,
    });
    registry.updateResumeToken(registry.registerSession(conflictNode.id, "ops-conflict@team-rig").id, "codex_id", "tok-conflict", "hook");
    db.prepare(
      "INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'codex', 'full_bypass', 'op', 'conflict', datetime('now'))",
    ).run(conflictNode.id);

    const mismatchNode = rigRepo.addNode(teamRig.id, "ops.mismatch", { runtime: "codex", cwd: "/work/m" });
    registry.updateResumeToken(registry.registerSession(mismatchNode.id, "ops-mismatch@team-rig").id, "codex_id", "tok-mismatch", "hook");
    db.prepare(
      "INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'claude-code', 'acceptEdits', 'op', 'old-runtime', datetime('now'))",
    ).run(mismatchNode.id);

    const kernelRig = rigRepo.createRig("kernel");
    const kernelNode = rigRepo.addNode(kernelRig.id, "ops.root", { runtime: "codex", cwd: "/work/root" });
    registry.updateResumeToken(registry.registerSession(kernelNode.id, "ops-root@demo-rig").id, "codex_id", "tok-root", "hook");

    const kernelProfiledNode = rigRepo.addNode(kernelRig.id, "ops.profiled", {
      runtime: "codex",
      cwd: "/work/root-prof",
      codexConfigProfile: "ops-profile",
    });
    registry.updateResumeToken(registry.registerSession(kernelProfiledNode.id, "ops-profiled@demo-rig").id, "codex_id", "tok-root-prof", "hook");

    const allByRig = getNodeInventoryForAllRigs(db);
    expect(getNodeInventoryForRigs(db, new Set([teamRig.id, kernelRig.id]))).toEqual(allByRig);
    const teamEntries = new Map(getNodeInventory(db, teamRig.id).map((e) => [e.logicalId, e]));
    const kernelEntries = new Map(getNodeInventory(db, kernelRig.id).map((e) => [e.logicalId, e]));
    expect(allByRig.get(teamRig.id)).toEqual([...teamEntries.values()]);
    expect(allByRig.get(kernelRig.id)).toEqual([...kernelEntries.values()]);

    // Positive matrix: every seat's displayed command agrees with real permStore.launchOverride + CodexResumeAdapter.
    for (const [entries, rigId, logicalId, nodeId, token, daemonSupported] of [
      [teamEntries, teamRig.id, "dev.floor", teamNode.id, "tok-floor", false],
      [teamEntries, teamRig.id, "dev.floor-sel", floorSelNode.id, "tok-floor-sel", false],
      [teamEntries, teamRig.id, "dev.bypass", bypassNode.id, "tok-bypass", false],
      [teamEntries, teamRig.id, "dev.env", envNode.id, "tok-env", true],
      [teamEntries, teamRig.id, "dev.policy-floor", policyFloorNode.id, "tok-pfloor", false],
      [kernelEntries, kernelRig.id, "ops.root", kernelNode.id, "tok-root", false],
      [kernelEntries, kernelRig.id, "ops.profiled", kernelProfiledNode.id, "tok-root-prof", false],
    ] as const) {
      const expected = await runRealRestoreResolvedResume(restoreOrchestrator, nodeId, rigId, token, { daemonSupported });
      expect(entries.get(logicalId)?.resumeCommand).toBe(expected);
      expect(getNodeDetail(db, rigId, logicalId)?.recoveryGuidance?.commands[0]).toBe(expected);
    }
    expect(teamEntries.get("dev.floor")?.resumeCommand).not.toContain("danger-full-access");
    expect(kernelEntries.get("ops.profiled")?.resumeCommand).not.toContain("danger-full-access");

    // Refusal matrix: every refused seat surfaces the exact error thrown by real permStore.launchOverride.
    for (const [logicalId, nodeId] of [
      ["ops.corrupt", corruptNode.id],
      ["ops.conflict", conflictNode.id],
      ["ops.mismatch", mismatchNode.id],
    ] as const) {
      let realRefusal = "";
      try {
        permStore.launchOverride(nodeId, "codex");
      } catch (err) {
        realRefusal = `Permission selection: ${(err as Error).message}`;
      }
      expect(realRefusal.length).toBeGreaterThan(0);
      expect(teamEntries.get(logicalId)?.resumeCommand).toBeNull();
      expect(teamEntries.get(logicalId)?.resumeCommandLabel).toBe(realRefusal);
      const detail = getNodeDetail(db, teamRig.id, logicalId)!;
      expect(detail.resumeCommand).toBeNull();
      expect(detail.resumeCommandLabel).toBe(realRefusal);
      expect(detail.recoveryGuidance?.commands).toEqual([]);
      expect(detail.recoveryGuidance?.notes).toEqual([realRefusal]);
    }
  });

  it("surfaces all three label cases in BOTH getNodeInventory (resumeCommandLabel) and getNodeDetail (recoveryGuidance.notes), including adapter-recorded approval values and generation rollover", async () => {
    const rig = rigRepo.createRig("label-rig");
    const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "codex", cwd: "/work/app" });
    const session = registry.registerSession(node.id, "dev-worker@label-rig");
    registry.updateResumeToken(session.id, "codex_id", "sess-789", "hook");

    // Case 3a: No recorded launch initially -> "flags from current settings" while keeping command visible.
    let entry = getNodeInventory(db, rig.id)[0]!;
    let detail = getNodeDetail(db, rig.id, "dev.worker")!;
    expect(entry.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'sess-789'`);
    expect(entry.resumeCommandLabel).toBe("flags from current settings");
    expect(detail.resumeCommandLabel).toBe("flags from current settings");
    expect(detail.recoveryGuidance?.commands[0]).toBe(entry.resumeCommand);
    expect(detail.recoveryGuidance?.notes).toContain("flags from current settings");

    // Launch via real CodexRuntimeAdapter with read-only + on-request envelope and record its appliedLaunch.
    await lifecycle.setPermissions({
      seatRef: "dev-worker@label-rig",
      codexPermissions: readOnlyOnRequestEnvelope,
      actor: "operator@label-rig",
      reason: "Set read-only on-request envelope",
    });
    const adapter = new CodexRuntimeAdapter({
      tmux: makeMockTmux(),
      fsOps: inertFsOps(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding: NodeBinding = permStore.apply({
      id: "b-1",
      nodeId: node.id,
      tmuxSession: "dev-worker@label-rig",
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: "/work/app",
      launchPosture: "floor",
    }, "codex");
    const launchRes = await adapter.launchHarness(binding, { name: "dev-worker@label-rig" });
    expect(launchRes.ok).toBe(true);
    const applied = (launchRes as { appliedLaunch?: AppliedLaunchObservation }).appliedLaunch!;
    expect(applied).toMatchObject({ state: "observed", value: "read-only", approvalPolicy: "on-request" });
    expect(observations.recordGeneration(registry.currentOccupantTenure(node.id)!.generationUuid, applied)).toBe(true);

    // Case 1: Recorded match -> command visible, resumeCommandLabel is null, no drift/unrecorded label in notes.
    entry = getNodeInventory(db, rig.id)[0]!;
    detail = getNodeDetail(db, rig.id, "dev.worker")!;
    expect(entry.resumeCommand).toBe(`codex -s read-only -a on-request ${UPDATE_OFF} resume 'sess-789'`);
    expect(entry.resumeCommandLabel).toBeNull();
    expect(detail.recoveryGuidance?.notes).not.toContain("flags from current settings");
    expect(detail.recoveryGuidance?.notes.some((n) => n.startsWith("launched with "))).toBe(false);

    // Case 2a: Change approval policy on current generation -> recorded difference shows both sandbox and approval.
    await lifecycle.setPermissions({
      seatRef: "dev-worker@label-rig",
      codexPermissions: { sandbox: "read-only", approval: "untrusted" },
      actor: "operator@label-rig",
      reason: "Tighten approval to untrusted",
    });
    entry = getNodeInventory(db, rig.id)[0]!;
    detail = getNodeDetail(db, rig.id, "dev.worker")!;
    expect(entry.resumeCommand).toBe(`codex -s read-only -a untrusted ${UPDATE_OFF} resume 'sess-789'`);
    expect(entry.resumeCommandLabel).toBe(
      "launched with -s read-only -a on-request; a resume now uses -s read-only -a untrusted",
    );
    expect(detail.recoveryGuidance?.notes).toContain(
      "launched with -s read-only -a on-request; a resume now uses -s read-only -a untrusted",
    );

    // Case 2b: Maintainer's exact example — launched with -s danger-full-access -a never, switched to floor.
    observations.recordGeneration(
      registry.currentOccupantTenure(node.id)!.generationUuid,
      observeCodexSandbox("-s danger-full-access -a never"),
    );
    await lifecycle.setPermissions({
      seatRef: "dev-worker@label-rig",
      mode: "floor",
      actor: "operator@label-rig",
      reason: "Return to floor",
    });
    entry = getNodeInventory(db, rig.id)[0]!;
    detail = getNodeDetail(db, rig.id, "dev.worker")!;
    expect(entry.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'sess-789'`);
    expect(entry.resumeCommandLabel).toBe(
      "launched with -s danger-full-access -a never; a resume now uses -s workspace-write",
    );
    expect(detail.recoveryGuidance?.commands[0]).toBe(entry.resumeCommand);
    expect(detail.recoveryGuidance?.notes).toContain(
      "launched with -s danger-full-access -a never; a resume now uses -s workspace-write",
    );

    // Case 3b: Invalidating the current generation clears the observation -> "flags from current settings".
    expect(observations.invalidateGeneration(registry.currentOccupantTenure(node.id)!.generationUuid)).toBe(true);
    entry = getNodeInventory(db, rig.id)[0]!;
    detail = getNodeDetail(db, rig.id, "dev.worker")!;
    expect(entry.resumeCommandLabel).toBe("flags from current settings");
    expect(detail.recoveryGuidance?.notes).toContain("flags from current settings");

    // Case 3c: New occupant generation minted without a launch observation does not inherit predecessor's record.
    const nextGen = registry.mintOccupantTenure(node.id, "handover");
    observations.recordGeneration(nextGen.generationUuid, observeCodexSandbox("-s danger-full-access -a never"));
    expect(getNodeInventory(db, rig.id)[0]!.resumeCommandLabel).toBe(
      "launched with -s danger-full-access -a never; a resume now uses -s workspace-write",
    );
    registry.mintOccupantTenure(node.id, "handover");
    entry = getNodeInventory(db, rig.id)[0]!;
    detail = getNodeDetail(db, rig.id, "dev.worker")!;
    expect(entry.resumeCommandLabel).toBe("flags from current settings");
    expect(detail.recoveryGuidance?.notes).toContain("flags from current settings");
  });

  it("includes the three-case label and real resume flags on tokenless --last recovery guidance without fabricating entry.resumeCommand", () => {
    const rig = rigRepo.createRig("tokenless-rig");
    const node = rigRepo.addNode(rig.id, "dev.notoken", { runtime: "codex", cwd: "/work/notoken" });
    registry.registerSession(node.id, "dev-notoken@tokenless-rig");

    // Unrecorded -> "flags from current settings" in recoveryGuidance.notes; entry.resumeCommand & label stay null.
    let entry = getNodeInventory(db, rig.id)[0]!;
    let detail = getNodeDetail(db, rig.id, "dev.notoken")!;
    expect(entry.resumeCommand).toBeNull();
    expect(entry.resumeCommandLabel).toBeNull();
    expect(detail.recoveryGuidance?.commands).toEqual([
      "cd /work/notoken",
      `codex -s workspace-write ${UPDATE_OFF} resume --last`,
    ]);
    expect(detail.recoveryGuidance?.notes).toContain("flags from current settings");

    // Recorded difference -> difference label in recoveryGuidance.notes; summary names actual full_bypass command when switched.
    observations.recordGeneration(
      registry.currentOccupantTenure(node.id)!.generationUuid,
      observeCodexSandbox("-s workspace-write"),
    );
    permStore.write(node.id, { runtime: "codex", mode: "full_bypass" }, "op@tokenless-rig", "Bypass");
    detail = getNodeDetail(db, rig.id, "dev.notoken")!;
    expect(detail.recoveryGuidance?.commands).toEqual([
      "cd /work/notoken",
      `codex -s danger-full-access -a never ${UPDATE_OFF} resume --last`,
    ]);
    expect(detail.recoveryGuidance?.summary).toContain(
      `codex -s danger-full-access -a never ${UPDATE_OFF} resume --last`,
    );
    expect(detail.recoveryGuidance?.notes).toContain(
      "launched with -s workspace-write (approval unrecorded); a resume now uses -s danger-full-access -a never",
    );
  });

  it("M3: distinguishes an unavailable node_permission_selections table from an empty table beside invalid-value checks, keeping inventory readable without guessing kernel or team defaults", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    const teamRig = rigRepo.createRig("demo-rig");
    const kernelRig = rigRepo.createRig("kernel");

    const invalidModeNode = rigRepo.addNode(teamRig.id, "ops.badmode", { runtime: "codex", cwd: "/work/bm" });
    registry.updateResumeToken(registry.registerSession(invalidModeNode.id, "ops-badmode@demo-rig").id, "codex_id", "tok-badmode", "hook");
    db.prepare(
      "INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'codex', 'auto', 'op', 'invalid-codex-mode', datetime('now'))",
    ).run(invalidModeNode.id);

    const invalidSyntaxNode = rigRepo.addNode(teamRig.id, "ops.badsyntax", { runtime: "codex", cwd: "/work/bs" });
    registry.updateResumeToken(registry.registerSession(invalidSyntaxNode.id, "ops-badsyntax@demo-rig").id, "codex_id", "tok-badsyntax", "hook");
    db.prepare(
      "INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'codex', 'bad-mode!', 'op', 'invalid-syntax', datetime('now'))",
    ).run(invalidSyntaxNode.id);

    const invalidRuntimeNode = rigRepo.addNode(teamRig.id, "ops.badruntime", { runtime: "codex", cwd: "/work/br" });
    registry.updateResumeToken(registry.registerSession(invalidRuntimeNode.id, "ops-badruntime@demo-rig").id, "codex_id", "tok-badruntime", "hook");
    db.prepare(
      "INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'claude-code', 'acceptEdits', 'op', 'runtime-changed', datetime('now'))",
    ).run(invalidRuntimeNode.id);

    const teamNode = rigRepo.addNode(teamRig.id, "dev.team", { runtime: "codex", cwd: "/work/team" });
    registry.updateResumeToken(registry.registerSession(teamNode.id, "dev-team@demo-rig").id, "codex_id", "tok-team", "hook");

    const tokenlessNode = rigRepo.addNode(teamRig.id, "dev.notoken", { runtime: "codex", cwd: "/work/notoken" });
    registry.registerSession(tokenlessNode.id, "dev-notoken@demo-rig");

    const claudeNode = rigRepo.addNode(teamRig.id, "ops.claude", { runtime: "claude-code", cwd: "/work/cl" });
    registry.updateResumeToken(registry.registerSession(claudeNode.id, "ops-claude@demo-rig").id, "claude_id", "tok-claude", "hook");

    const kernelNode = rigRepo.addNode(kernelRig.id, "ops.root", { runtime: "codex", cwd: "/work/root" });
    registry.updateResumeToken(registry.registerSession(kernelNode.id, "ops-root@demo-rig").id, "codex_id", "tok-root", "hook");

    // 1. Invalid-value checks: invalid persisted selection rows fail only their own seats with the exact launchOverride message.
    const initialTeam = new Map(getNodeInventory(db, teamRig.id).map((e) => [e.logicalId, e]));
    for (const [logicalId, nodeId, expectedMsg] of [
      ["ops.badmode", invalidModeNode.id, "Permission selection: Invalid persisted native permission selection; launch refused."],
      ["ops.badsyntax", invalidSyntaxNode.id, "Permission selection: Invalid persisted native permission selection; launch refused."],
      ["ops.badruntime", invalidRuntimeNode.id, "Permission selection: Seat runtime changed since permission selection; explicitly select again or inherit."],
    ] as const) {
      let realRefusal = "";
      try {
        permStore.launchOverride(nodeId, "codex");
      } catch (err) {
        realRefusal = `Permission selection: ${(err as Error).message}`;
      }
      expect(realRefusal).toBe(expectedMsg);
      expect(initialTeam.get(logicalId)?.resumeCommand).toBeNull();
      expect(initialTeam.get(logicalId)?.resumeCommandLabel).toBe(realRefusal);
      expect(getNodeDetail(db, teamRig.id, logicalId)?.recoveryGuidance?.commands).toEqual([]);
      expect(getNodeDetail(db, teamRig.id, logicalId)?.recoveryGuidance?.notes).toEqual([realRefusal]);
    }

    // 2. Empty table (readable with 0 rows): kernel and team Codex seats display their normal defaults.
    db.prepare("DELETE FROM node_permission_selections").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM node_permission_selections").get()).toEqual({ n: 0 });
    expect(getNodeInventory(db, kernelRig.id)[0]?.resumeCommand).toBe(
      `codex -s danger-full-access -a never ${UPDATE_OFF} ${HIDE_NOTICES} resume 'tok-root'`,
    );
    expect(new Map(getNodeInventory(db, teamRig.id).map((e) => [e.logicalId, e])).get("dev.team")?.resumeCommand).toBe(
      `codex -s workspace-write ${UPDATE_OFF} resume 'tok-team'`,
    );
    expect(getNodeDetail(db, teamRig.id, "dev.notoken")?.recoveryGuidance?.commands).toEqual([
      "cd /work/notoken",
      `codex -s workspace-write ${UPDATE_OFF} resume --last`,
    ]);

    // 3. Unavailable table (failed SQLite read): inventory & detail stay readable without throwing, real launchOverride /
    //    attemptResume keeps its existing SQLite error, and Codex entries show unknown/null instead of guessing defaults.
    db.exec("DROP TABLE node_permission_selections");
    let launchError = "";
    try {
      permStore.launchOverride(kernelNode.id, "codex");
    } catch (err) {
      launchError = (err as Error).message;
    }
    expect(launchError).toContain("no such table: node_permission_selections");
    const expectedDiagnostic = `Permission selection: ${launchError}`;

    const restoreOrchestrator = createRestoreOrchestrator({
      claudeResume: new ClaudeResumeAdapter(makeMockClaudeTmux(), { sleep: async () => {}, maxWaitMs: 0 }),
      codexResume: new CodexResumeAdapter(makeMockTmux(), { sleep: async () => {}, maxWaitMs: 0, exec: async () => "" }),
    });
    const realAttempt = await (restoreOrchestrator as unknown as {
      attemptResume: (...args: unknown[]) => Promise<{ kind: string; message?: string }>;
    }).attemptResume(kernelNode.id, "ops-root@demo-rig", "codex_id", "tok-root", "/work/root", null, null, "full_bypass");
    expect(realAttempt).toEqual({ kind: "failed", message: expectedDiagnostic });

    const singleTeam = getNodeInventory(db, teamRig.id);
    const singleKernel = getNodeInventory(db, kernelRig.id);
    const bySet = getNodeInventoryForRigs(db, new Set([teamRig.id, kernelRig.id]));
    const byAll = getNodeInventoryForAllRigs(db);
    expect(bySet.get(teamRig.id)).toEqual(singleTeam);
    expect(bySet.get(kernelRig.id)).toEqual(singleKernel);
    expect(byAll.get(teamRig.id)).toEqual(singleTeam);
    expect(byAll.get(kernelRig.id)).toEqual(singleKernel);

    // Kernel Codex must NOT display -s danger-full-access when selection table is unavailable.
    expect(singleKernel[0]?.resumeCommand).toBeNull();
    expect(singleKernel[0]?.resumeCommandLabel).toBe(expectedDiagnostic);
    const kernelDetail = getNodeDetail(db, kernelRig.id, "ops.root")!;
    expect(kernelDetail.resumeCommand).toBeNull();
    expect(kernelDetail.resumeCommandLabel).toBe(expectedDiagnostic);
    expect(kernelDetail.recoveryGuidance?.commands).toEqual([]);
    expect(kernelDetail.recoveryGuidance?.notes).toEqual([expectedDiagnostic]);

    // Team Codex (both token-bearing and tokenless) must NOT display -s workspace-write when selection table is unavailable.
    const unavailableTeamByLogical = new Map(singleTeam.map((e) => [e.logicalId, e]));
    expect(unavailableTeamByLogical.get("dev.team")?.resumeCommand).toBeNull();
    expect(unavailableTeamByLogical.get("dev.team")?.resumeCommandLabel).toBe(expectedDiagnostic);

    expect(unavailableTeamByLogical.get("dev.notoken")?.resumeCommand).toBeNull();
    expect(unavailableTeamByLogical.get("dev.notoken")?.resumeCommandLabel).toBeNull();
    const tokenlessDetail = getNodeDetail(db, teamRig.id, "dev.notoken")!;
    expect(tokenlessDetail.recoveryGuidance?.commands).toEqual([]);
    expect(tokenlessDetail.recoveryGuidance?.notes).toEqual([expectedDiagnostic]);
    expect(tokenlessDetail.recoveryGuidance?.summary).toBe(`Cannot derive Codex resume command — ${expectedDiagnostic}`);

    // Non-Codex inventory entries remain unaffected (Claude resume display still uses process.env OPENRIG_YOLO=1).
    const claudeEntry = unavailableTeamByLogical.get("ops.claude")!;
    expect(claudeEntry.resumeCommand).toBe("claude --dangerously-skip-permissions --resume 'tok-claude'");
    expect(claudeEntry.resumeCommandLabel).toBeNull();
  });

  it("QA-001 & QA-002: resolves display posture through real RestoreOrchestrator rules (legacy policy-without-provenance floor, node-over-rig provenance precedence, and kernel legacy policy suppression)", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");

    const restoreOrchestrator = createRestoreOrchestrator();

    // 1. Legacy node permission_policy = 'builtin:yolo' WITHOUT saved provenance (NULL origin/posture):
    //    real restore resolves "floor" (-s workspace-write), never raw builtinLaunchPosture('builtin:yolo').
    const legacyNodeRig = rigRepo.createRig("legacy-node-rig");
    const legacyNode = rigRepo.addNode(legacyNodeRig.id, "dev.legacy", { runtime: "codex", cwd: "/work/ln" });
    const sLegacyNode = registry.registerSession(legacyNode.id, "dev-legacy@legacy-node-rig");
    registry.updateResumeToken(sLegacyNode.id, "codex_id", "tok-legacy-node", "hook");
    db.prepare(
      "UPDATE nodes SET permission_policy = 'builtin:yolo', policy_origin = NULL, policy_launch_posture = NULL WHERE id = ?",
    ).run(legacyNode.id);
    observations.recordGeneration(
      registry.currentOccupantTenure(legacyNode.id)!.generationUuid,
      observeCodexSandbox("-s workspace-write"),
    );

    const legacyNodeEntry = getNodeInventory(db, legacyNodeRig.id)[0]!;
    const legacyNodeDetail = getNodeDetail(db, legacyNodeRig.id, "dev.legacy")!;
    expect(legacyNodeEntry.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-legacy-node'`);
    expect(legacyNodeEntry.resumeCommand).toBe(
      await runRealRestoreResolvedResume(restoreOrchestrator, legacyNode.id, legacyNodeRig.id, "tok-legacy-node"),
    );
    expect(legacyNodeEntry.resumeCommandLabel).toBe(
      "launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write",
    );
    expect(legacyNodeDetail.resumeCommandLabel).toBe(
      "launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write",
    );
    expect(legacyNodeDetail.recoveryGuidance?.commands[0]).toBe(legacyNodeEntry.resumeCommand);
    expect(legacyNodeDetail.recoveryGuidance?.notes).toContain(
      "launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write",
    );

    // 2. Legacy rig permission_policy = 'builtin:yolo' WITHOUT saved rig provenance (NULL rig_policy_origin/posture):
    //    real restore also resolves "floor" (-s workspace-write).
    const legacyRig = rigRepo.createRig("legacy-rig");
    db.prepare(
      "UPDATE rigs SET permission_policy = 'builtin:yolo', rig_policy_origin = NULL, rig_policy_launch_posture = NULL WHERE id = ?",
    ).run(legacyRig.id);
    const legacyRigNode = rigRepo.addNode(legacyRig.id, "dev.riglegacy", { runtime: "codex", cwd: "/work/lr" });
    const sLegacyRig = registry.registerSession(legacyRigNode.id, "dev-riglegacy@legacy-rig");
    registry.updateResumeToken(sLegacyRig.id, "codex_id", "tok-legacy-rig", "hook");

    const legacyRigEntry = getNodeInventory(db, legacyRig.id)[0]!;
    expect(legacyRigEntry.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-legacy-rig'`);
    expect(legacyRigEntry.resumeCommand).toBe(
      await runRealRestoreResolvedResume(restoreOrchestrator, legacyRigNode.id, legacyRig.id, "tok-legacy-rig"),
    );
    expect(legacyRigEntry.resumeCommandLabel).toBe("flags from current settings");

    // 3. Node provenance overrides rig provenance in BOTH directions.
    const precRig = rigRepo.createRig("prec-rig");
    db.prepare("UPDATE rigs SET non_interruptive = 1, permission_policy = 'builtin:yolo', rig_policy_origin = 'builtin', rig_policy_launch_posture = 'full_bypass' WHERE id = ?").run(precRig.id);

    const floorOverYolo = rigRepo.addNode(precRig.id, "dev.locked", { runtime: "codex", cwd: "/work/l" });
    rigRepo.setNodePermissionPolicy(floorOverYolo.id, "builtin:locked");
    rigRepo.setNodePolicyProvenance(floorOverYolo.id, {
      origin: "builtin",
      resolvedTarget: "policies/builtin/locked.policy.md",
      declaringDir: null,
      launchPosture: "floor",
    });
    const sLocked = registry.registerSession(floorOverYolo.id, "dev-locked@prec-rig");
    registry.updateResumeToken(sLocked.id, "codex_id", "tok-locked", "hook");

    const inheritRigYolo = rigRepo.addNode(precRig.id, "dev.inherit", { runtime: "codex", cwd: "/work/i" });
    const sInherit = registry.registerSession(inheritRigYolo.id, "dev-inherit@prec-rig");
    registry.updateResumeToken(sInherit.id, "codex_id", "tok-inherit", "hook");

    const precEntries = new Map(getNodeInventory(db, precRig.id).map((e) => [e.logicalId, e]));
    expect(precEntries.get("dev.locked")?.resumeCommand).toBe(
      `codex -s workspace-write ${UPDATE_OFF} resume 'tok-locked'`,
    );
    expect(precEntries.get("dev.locked")?.resumeCommand).toBe(
      await runRealRestoreResolvedResume(restoreOrchestrator, floorOverYolo.id, precRig.id, "tok-locked"),
    );
    expect(precEntries.get("dev.inherit")?.resumeCommand).toBe(
      `codex -s danger-full-access -a never ${UPDATE_OFF} ${HIDE_NOTICES} resume 'tok-inherit'`,
    );
    expect(precEntries.get("dev.inherit")?.resumeCommand).toBe(
      await runRealRestoreResolvedResume(restoreOrchestrator, inheritRigYolo.id, precRig.id, "tok-inherit"),
    );

    // 4. Kernel rig with legacy raw member permission_policy = 'builtin:yolo' and NULL provenance:
    //    member_policy suppresses kernel default AND missing provenance resolves to "floor".
    const kernelLegacyRig = rigRepo.createRig("kernel");
    const kernelLegacyNode = rigRepo.addNode(kernelLegacyRig.id, "ops.legacy", { runtime: "codex", cwd: "/work/kl" });
    const sKernelLegacy = registry.registerSession(kernelLegacyNode.id, "ops-legacy@demo-rig");
    registry.updateResumeToken(sKernelLegacy.id, "codex_id", "tok-kl", "hook");
    db.prepare(
      "UPDATE nodes SET permission_policy = 'builtin:yolo', policy_origin = NULL, policy_launch_posture = NULL WHERE id = ?",
    ).run(kernelLegacyNode.id);

    const klEntry = getNodeInventory(db, kernelLegacyRig.id)[0]!;
    expect(klEntry.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-kl'`);
    expect(klEntry.resumeCommand).toBe(
      await runRealRestoreResolvedResume(restoreOrchestrator, kernelLegacyNode.id, kernelLegacyRig.id, "tok-kl"),
    );
  });

  it("QA-002: reopens and re-derives readable valid custom policies while retaining persisted posture on malformed or missing files, matching RestoreOrchestrator", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-2989-custom-policy-"));
    try {
      const policiesDir = path.join(tmpDir, "policies");
      fs.mkdirSync(policiesDir, { recursive: true });
      const nodePolicyPath = path.join(policiesDir, "seat-flag.policy.md");
      const rigPolicyPath = path.join(policiesDir, "rig-flag.policy.md");

      const restoreOrchestrator = createRestoreOrchestrator();

      const rig = rigRepo.createRig("custom-rig");
      // Rig-level custom policy initially persisted as full_bypass, file later edited to floor.
      fs.writeFileSync(rigPolicyPath, makeValidFlagPolicy("floor"), "utf8");
      db.prepare(
        "UPDATE rigs SET permission_policy = ?, rig_policy_origin = 'custom', rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = 'full_bypass' WHERE id = ?",
      ).run("policies/rig-flag.policy.md", rigPolicyPath, tmpDir, rig.id);

      const rigCustomNode = rigRepo.addNode(rig.id, "dev.rigcustom", { runtime: "codex", cwd: "/work/rc" });
      const sRigCustom = registry.registerSession(rigCustomNode.id, "dev-rigcustom@custom-rig");
      registry.updateResumeToken(sRigCustom.id, "codex_id", "tok-rig-custom", "hook");

      // Node-level custom policy persisted as floor, file edited to full_bypass.
      fs.writeFileSync(nodePolicyPath, makeValidFlagPolicy("full_bypass"), "utf8");
      const nodeCustom = rigRepo.addNode(rig.id, "dev.nodecustom", { runtime: "codex", cwd: "/work/nc" });
      rigRepo.setNodePermissionPolicy(nodeCustom.id, "policies/seat-flag.policy.md");
      rigRepo.setNodePolicyProvenance(nodeCustom.id, {
        origin: "custom",
        resolvedTarget: nodePolicyPath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      const sNodeCustom = registry.registerSession(nodeCustom.id, "dev-nodecustom@custom-rig");
      registry.updateResumeToken(sNodeCustom.id, "codex_id", "tok-node-custom", "hook");
      observations.recordGeneration(
        registry.currentOccupantTenure(nodeCustom.id)!.generationUuid,
        observeCodexSandbox("-s workspace-write"),
      );

      // Step A: Readable changed valid custom policies re-derive in BOTH directions.
      let entries = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e]));
      expect(entries.get("dev.nodecustom")?.resumeCommand).toBe(
        `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-node-custom'`,
      );
      expect(entries.get("dev.nodecustom")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(restoreOrchestrator, nodeCustom.id, rig.id, "tok-node-custom"),
      );
      expect(entries.get("dev.nodecustom")?.resumeCommandLabel).toBe(
        "launched with -s workspace-write (approval unrecorded); a resume now uses -s danger-full-access -a never",
      );
      const nodeDetail = getNodeDetail(db, rig.id, "dev.nodecustom")!;
      expect(nodeDetail.recoveryGuidance?.commands[0]).toBe(entries.get("dev.nodecustom")?.resumeCommand);
      expect(nodeDetail.recoveryGuidance?.notes).toContain(
        "launched with -s workspace-write (approval unrecorded); a resume now uses -s danger-full-access -a never",
      );

      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        `codex -s workspace-write ${UPDATE_OFF} resume 'tok-rig-custom'`,
      );
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(restoreOrchestrator, rigCustomNode.id, rig.id, "tok-rig-custom"),
      );

      // Step B: Malformed custom policy file on disk retains persisted posture (full_bypass on rigCustomNode).
      fs.writeFileSync(rigPolicyPath, "---\nsource: custom\nsurface: flag\n---\ninvalid missing fields\n", "utf8");
      entries = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e]));
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-rig-custom'`,
      );
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(restoreOrchestrator, rigCustomNode.id, rig.id, "tok-rig-custom"),
      );

      // Step C: Deleted/unreadable custom policy file retains persisted posture (full_bypass on rigCustomNode, floor on nodeCustom).
      fs.unlinkSync(rigPolicyPath);
      fs.unlinkSync(nodePolicyPath);
      entries = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e]));
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-rig-custom'`,
      );
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(restoreOrchestrator, rigCustomNode.id, rig.id, "tok-rig-custom"),
      );
      expect(entries.get("dev.nodecustom")?.resumeCommand).toBe(
        `codex -s workspace-write ${UPDATE_OFF} resume 'tok-node-custom'`,
      );
      expect(entries.get("dev.nodecustom")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(restoreOrchestrator, nodeCustom.id, rig.id, "tok-node-custom"),
      );
      expect(entries.get("dev.nodecustom")?.resumeCommandLabel).toBe(
        "launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each(["never", "on-request", "untrusted"] as const)(
    "QA-003: persists approval=%s end-to-end through CodexRuntimeAdapter -> AppliedLaunchObservationStore -> getNodeInventory and getNodeDetail",
    async (approval) => {
      const rig = rigRepo.createRig(`env-${approval}`);
      const node = rigRepo.addNode(rig.id, "dev.envseat", { runtime: "codex", cwd: "/work/env" });
      const session = registry.registerSession(node.id, `dev-envseat@env-${approval}`);
      registry.updateResumeToken(session.id, "codex_id", `tok-${approval}`, "hook");

      const envelope: CodexMemberPermissions = { sandbox: "read-only", approval };
      await lifecycle.setPermissions({
        seatRef: `dev-envseat@env-${approval}`,
        codexPermissions: envelope,
        actor: `op@env-${approval}`,
        reason: `Test ${approval}`,
      });

      const adapter = new CodexRuntimeAdapter({
        tmux: makeMockTmux(),
        fsOps: inertFsOps(),
        listProcesses: () => [],
        sleep: async () => {},
      });
      const binding: NodeBinding = permStore.apply(
        {
          id: `b-${approval}`,
          nodeId: node.id,
          tmuxSession: `dev-envseat@env-${approval}`,
          tmuxWindow: null,
          tmuxPane: null,
          cmuxWorkspace: null,
          cmuxSurface: null,
          updatedAt: "",
          cwd: "/work/env",
          launchPosture: "floor",
        },
        "codex",
      );
      const launched = await adapter.launchHarness(binding, { name: `dev-envseat@env-${approval}` });
      expect(launched.ok).toBe(true);
      const applied = (launched as { appliedLaunch?: AppliedLaunchObservation }).appliedLaunch!;
      expect(applied).toMatchObject({
        runtime: "codex",
        axis: "sandbox",
        state: "observed",
        value: "read-only",
        approvalPolicy: approval,
      });

      const genUuid = registry.currentOccupantTenure(node.id)!.generationUuid;
      expect(observations.recordGeneration(genUuid, applied)).toBe(true);

      // Verify raw persisted SQLite row in applied_launch_observations.
      const rawRow = db
        .prepare("SELECT value, approval_policy FROM applied_launch_observations WHERE generation_uuid = ?")
        .get(genUuid) as { value: string | null; approval_policy: string | null } | undefined;
      expect(rawRow).toEqual({ value: "read-only", approval_policy: approval });

      // Recorded match -> label is null in both projections; command uses independent expected literal flags.
      let entry = getNodeInventory(db, rig.id)[0]!;
      let detail = getNodeDetail(db, rig.id, "dev.envseat")!;
      expect(entry.resumeCommand).toBe(`codex -s read-only -a ${approval} ${UPDATE_OFF} resume 'tok-${approval}'`);
      expect(entry.resumeCommandLabel).toBeNull();
      expect(detail.resumeCommandLabel).toBeNull();
      expect(detail.recoveryGuidance?.commands[0]).toBe(entry.resumeCommand);
      expect(detail.recoveryGuidance?.notes.some((n) => n.startsWith("launched with "))).toBe(false);

      // Switch seat to floor -> recorded_difference names the exact stored approval policy.
      await lifecycle.setPermissions({
        seatRef: `dev-envseat@env-${approval}`,
        mode: "floor",
        actor: `op@env-${approval}`,
        reason: "Switch to floor",
      });
      entry = getNodeInventory(db, rig.id)[0]!;
      detail = getNodeDetail(db, rig.id, "dev.envseat")!;
      const expectedLabel = `launched with -s read-only -a ${approval}; a resume now uses -s workspace-write`;
      expect(entry.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-${approval}'`);
      expect(entry.resumeCommandLabel).toBe(expectedLabel);
      expect(detail.resumeCommandLabel).toBe(expectedLabel);
      expect(detail.recoveryGuidance?.notes).toContain(expectedLabel);
    },
  );

  it("J01: retains explicit uncertainty when a persisted current-generation workspace-write / NULL-approval record transitions to floor across inventory and detail while keeping known-approval matches silent", async () => {
    const rig = rigRepo.createRig("j01-rig");

    // 1. Historical pre-upgrade workspace-write envelope (on-request/untrusted persisted as approval_policy = NULL)
    //    subsequently switched to plain floor selection: command stays copyable, label retains explicit uncertainty.
    const histNode = rigRepo.addNode(rig.id, "dev.hist-ww", {
      runtime: "codex",
      cwd: "/work/hist",
      codexPermissions: workspaceUntrustedEnvelope,
    });
    const sHist = registry.registerSession(histNode.id, "dev-hist-ww@j01-rig");
    registry.updateResumeToken(sHist.id, "codex_id", "tok-j01-hist", "hook");
    const histGen = registry.currentOccupantTenure(histNode.id)!.generationUuid;
    expect(
      observations.recordGeneration(histGen, {
        runtime: "codex",
        axis: "sandbox",
        state: "observed",
        value: "workspace-write",
        approvalPolicy: null,
        reason: "emitted_launch_arguments",
      }),
    ).toBe(true);
    expect(
      db.prepare("SELECT value, approval_policy FROM applied_launch_observations WHERE generation_uuid = ?").get(histGen),
    ).toEqual({ value: "workspace-write", approval_policy: null });

    await lifecycle.setPermissions({
      seatRef: "dev-hist-ww@j01-rig",
      mode: "floor",
      actor: "op@j01-rig",
      reason: "Move historical workspace-write seat to floor",
    });

    // 2. Modern floor launch recorded via observeCodexSandbox("-s workspace-write") stores the identical SQLite shape
    //    ({ value: "workspace-write", approval_policy: null }) without provenance, so it must also stay uncertain.
    const modernFloorNode = rigRepo.addNode(rig.id, "dev.floor-null", { runtime: "codex", cwd: "/work/floor-null" });
    const sFloorNull = registry.registerSession(modernFloorNode.id, "dev-floor-null@j01-rig");
    registry.updateResumeToken(sFloorNull.id, "codex_id", "tok-j01-floor", "hook");
    const floorGen = registry.currentOccupantTenure(modernFloorNode.id)!.generationUuid;
    expect(observations.recordGeneration(floorGen, observeCodexSandbox("-s workspace-write"))).toBe(true);
    expect(
      db.prepare("SELECT value, approval_policy FROM applied_launch_observations WHERE generation_uuid = ?").get(floorGen),
    ).toEqual({ value: "workspace-write", approval_policy: null });

    // 3. Tokenless seat with persisted workspace-write / NULL approval on floor surfaces the same uncertainty note on --last.
    const tokenlessNode = rigRepo.addNode(rig.id, "dev.tokenless-null", { runtime: "codex", cwd: "/work/tokenless" });
    registry.registerSession(tokenlessNode.id, "dev-tokenless-null@j01-rig");
    expect(
      observations.recordGeneration(
        registry.currentOccupantTenure(tokenlessNode.id)!.generationUuid,
        observeCodexSandbox("-s workspace-write"),
      ),
    ).toBe(true);

    // 4. Known complete workspace-write + untrusted record matching current settings stays silent (label: null).
    const matchNode = rigRepo.addNode(rig.id, "dev.known-match", {
      runtime: "codex",
      cwd: "/work/match",
      codexPermissions: workspaceUntrustedEnvelope,
    });
    const sMatch = registry.registerSession(matchNode.id, "dev-known-match@j01-rig");
    registry.updateResumeToken(sMatch.id, "codex_id", "tok-j01-match", "hook");
    expect(
      observations.recordGeneration(
        registry.currentOccupantTenure(matchNode.id)!.generationUuid,
        observeCodexEnvelope(codexMemberEnvelope(workspaceUntrustedEnvelope)),
      ),
    ).toBe(true);

    const expectedUncertainLabel =
      "launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write";

    const single = getNodeInventory(db, rig.id);
    const bySet = getNodeInventoryForRigs(db, new Set([rig.id])).get(rig.id);
    const byAll = getNodeInventoryForAllRigs(db).get(rig.id);
    expect(bySet).toEqual(single);
    expect(byAll).toEqual(single);

    const byLogicalId = new Map(single.map((e) => [e.logicalId, e]));

    for (const [logicalId, token] of [
      ["dev.hist-ww", "tok-j01-hist"],
      ["dev.floor-null", "tok-j01-floor"],
    ] as const) {
      const entry = byLogicalId.get(logicalId)!;
      const detail = getNodeDetail(db, rig.id, logicalId)!;
      const expectedCmd = `codex -s workspace-write ${UPDATE_OFF} resume '${token}'`;
      expect(entry.resumeCommand).toBe(expectedCmd);
      expect(entry.resumeCommandLabel).toBe(expectedUncertainLabel);
      expect(detail.resumeCommand).toBe(expectedCmd);
      expect(detail.resumeCommandLabel).toBe(expectedUncertainLabel);
      expect(detail.recoveryGuidance?.commands[0]).toBe(expectedCmd);
      expect(detail.recoveryGuidance?.notes).toContain(expectedUncertainLabel);
      expect(detail.recoveryGuidance?.notes).not.toContain("flags from current settings");
    }

    const tokenlessEntry = byLogicalId.get("dev.tokenless-null")!;
    const tokenlessDetail = getNodeDetail(db, rig.id, "dev.tokenless-null")!;
    expect(tokenlessEntry.resumeCommand).toBeNull();
    expect(tokenlessEntry.resumeCommandLabel).toBeNull();
    expect(tokenlessDetail.recoveryGuidance?.commands).toEqual([
      "cd /work/tokenless",
      `codex -s workspace-write ${UPDATE_OFF} resume --last`,
    ]);
    expect(tokenlessDetail.recoveryGuidance?.notes).toContain(expectedUncertainLabel);

    const matchEntry = byLogicalId.get("dev.known-match")!;
    const matchDetail = getNodeDetail(db, rig.id, "dev.known-match")!;
    expect(matchEntry.resumeCommand).toBe(
      `codex -s workspace-write -a untrusted -c 'sandbox_workspace_write.writable_roots=[]' -c 'sandbox_workspace_write.network_access=true' -c 'sandbox_workspace_write.exclude_tmpdir_env_var=true' -c 'sandbox_workspace_write.exclude_slash_tmp=false' ${UPDATE_OFF} resume 'tok-j01-match'`,
    );
    expect(matchEntry.resumeCommandLabel).toBeNull();
    expect(matchDetail.resumeCommandLabel).toBeNull();
    expect(matchDetail.recoveryGuidance?.notes.some((n) => n.startsWith("launched with "))).toBe(false);
  });

  it("M2: preserves public main RestoreOrchestrator.resolveRestorePosture pass-through and lazy lookup order across unknown strings, empty strings, and custom-node fallback while normalizing only for display", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-3043-m2-restore-main-"));
    try {
      vi.stubEnv("OPENRIG_HOME", tmpDir);
      vi.stubEnv("OPENRIG_YOLO", "1");

      const claudeSent: string[] = [];
      const codexSent: string[] = [];
      const restoreOrchestrator = createRestoreOrchestrator({
        claudeResume: new ClaudeResumeAdapter(makeMockClaudeTmux(claudeSent), {
          openrigHome: tmpDir,
          sleep: async () => {},
          maxWaitMs: 0,
        }),
        codexResume: new CodexResumeAdapter(makeMockTmux(codexSent), {
          sleep: async () => {},
          maxWaitMs: 0,
          exec: async () => "",
        }),
      });
      const callAttemptResume = (
        nodeId: string,
        sessionName: string,
        resumeType: string,
        resumeToken: string,
        cwd: string,
        posture: string,
      ) =>
        (restoreOrchestrator as unknown as {
          attemptResume: (
            nId: string,
            sName: string,
            rType: string,
            rToken: string,
            dir: string,
            profile: string | null,
            model: string | null,
            resolvedPosture: string,
          ) => Promise<{ kind: string; message?: string }>;
        }).attemptResume(nodeId, sessionName, resumeType, resumeToken, cwd, null, null, posture);

      const rig = rigRepo.createRig("m2-main-parity-rig");

      // 1. Unrecognized stored posture string ("legacy_custom_posture") with NO node/rig policy:
      //    main passes "legacy_custom_posture" through raw, so Claude restore skips teamPermissionDefault
      //    --settings (no Bash(rig:*) / claude-team-permissions.cjs), whereas display normalizes to floor.
      const unknownClaude = rigRepo.addNode(rig.id, "dev.unknown-claude", { runtime: "claude-code", cwd: "/work/m2-uc" });
      db.prepare(
        "UPDATE nodes SET permission_policy = NULL, policy_origin = 'builtin', policy_launch_posture = 'legacy_custom_posture' WHERE id = ?",
      ).run(unknownClaude.id);
      registry.updateResumeToken(registry.registerSession(unknownClaude.id, "dev-unknown-claude@m2").id, "claude_id", "tok-m2-uc", "hook");

      const unknownClaudePosture = restoreOrchestrator.resolveRestorePosture(unknownClaude.id, rig.id) as string;
      expect(unknownClaudePosture).toBe("legacy_custom_posture");
      claudeSent.length = 0;
      const ucRes = await callAttemptResume(
        unknownClaude.id,
        "dev-unknown-claude@m2",
        "claude_id",
        "tok-m2-uc",
        "/work/m2-uc",
        unknownClaudePosture,
      );
      expect(ucRes.kind).toBe("resumed");
      expect(claudeSent[0]).toContain("--permission-mode acceptEdits");
      expect(claudeSent[0]).not.toContain("Bash(rig:*)");
      expect(claudeSent[0]).not.toContain("claude-team-permissions.cjs");

      const unknownCodex = rigRepo.addNode(rig.id, "dev.unknown-codex", { runtime: "codex", cwd: "/work/m2-ux" });
      db.prepare(
        "UPDATE nodes SET permission_policy = NULL, policy_origin = 'builtin', policy_launch_posture = 'legacy_custom_posture' WHERE id = ?",
      ).run(unknownCodex.id);
      registry.updateResumeToken(registry.registerSession(unknownCodex.id, "dev-unknown-codex@m2").id, "codex_id", "tok-m2-ux", "hook");

      const unknownCodexPosture = restoreOrchestrator.resolveRestorePosture(unknownCodex.id, rig.id) as string;
      expect(unknownCodexPosture).toBe("legacy_custom_posture");
      const unknownCodexEntryBefore = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e])).get("dev.unknown-codex")!;
      expect(unknownCodexEntryBefore.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-m2-ux'`);
      expect(unknownCodexEntryBefore.resumeCommandLabel).toBe("flags from current settings");
      codexSent.length = 0;
      const uxRes = await callAttemptResume(
        unknownCodex.id,
        "dev-unknown-codex@m2",
        "codex_id",
        "tok-m2-ux",
        "/work/m2-ux",
        unknownCodexPosture,
      );
      expect(uxRes.kind).toBe("resumed");
      expect(codexSent[0]).toContain("codex -s workspace-write ");

      // 2. Empty-string stored posture ("") under OPENRIG_YOLO=1:
      //    main passes "" through raw so yoloEnabled(env, "") delegates to ambient OPENRIG_YOLO=1 on restore
      //    (both Claude and Codex), while Codex display keeps the copyable floor (-s workspace-write) and labels
      //    it as an empty-posture fallback rather than claiming managed resume uses -s workspace-write.
      const emptyClaude = rigRepo.addNode(rig.id, "dev.empty-claude", { runtime: "claude-code", cwd: "/work/m2-ec" });
      db.prepare(
        "UPDATE nodes SET permission_policy = 'builtin:yolo', policy_origin = 'builtin', policy_launch_posture = '' WHERE id = ?",
      ).run(emptyClaude.id);
      registry.updateResumeToken(registry.registerSession(emptyClaude.id, "dev-empty-claude@m2").id, "claude_id", "tok-m2-ec", "hook");

      const emptyClaudePosture = restoreOrchestrator.resolveRestorePosture(emptyClaude.id, rig.id) as string;
      expect(emptyClaudePosture).toBe("");
      claudeSent.length = 0;
      const ecRes = await callAttemptResume(
        emptyClaude.id,
        "dev-empty-claude@m2",
        "claude_id",
        "tok-m2-ec",
        "/work/m2-ec",
        emptyClaudePosture,
      );
      expect(ecRes.kind).toBe("resumed");
      expect(claudeSent[0]).toContain("--dangerously-skip-permissions");

      const emptyCodex = rigRepo.addNode(rig.id, "dev.empty-codex", { runtime: "codex", cwd: "/work/m2-ex" });
      db.prepare(
        "UPDATE nodes SET permission_policy = 'builtin:yolo', policy_origin = 'builtin', policy_launch_posture = '' WHERE id = ?",
      ).run(emptyCodex.id);
      registry.updateResumeToken(registry.registerSession(emptyCodex.id, "dev-empty-codex@m2").id, "codex_id", "tok-m2-ex", "hook");

      const expectedEmptyCodexCmd = `codex -s workspace-write ${UPDATE_OFF} resume 'tok-m2-ex'`;
      const expectedEmptyUnrecordedLabel =
        "saved posture empty, showing fallback -s workspace-write (managed resume posture unknown)";
      const expectedEmptyRecordedLabel =
        "launched with -s danger-full-access (approval unrecorded); saved posture empty, showing fallback -s workspace-write (managed resume posture unknown)";

      // Capture M2 empty-posture Case 1 & Case 2 (unrecorded launch observation across inventory and detail)
      // before running real RestoreOrchestrator resume, which records the danger-full-access launch observation.
      const emptyEntryUnrecorded = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e])).get("dev.empty-codex")!;
      const emptyDetailUnrecorded = getNodeDetail(db, rig.id, "dev.empty-codex")!;
      expect(emptyEntryUnrecorded.resumeCommand).toBe(expectedEmptyCodexCmd);
      expect(emptyDetailUnrecorded.resumeCommand).toBe(expectedEmptyCodexCmd);
      expect(emptyDetailUnrecorded.recoveryGuidance?.commands[0]).toBe(expectedEmptyCodexCmd);

      // Real managed restore under OPENRIG_YOLO=1 still launches danger-full-access and records that observation.
      const emptyCodexPosture = restoreOrchestrator.resolveRestorePosture(emptyCodex.id, rig.id) as string;
      expect(emptyCodexPosture).toBe("");
      codexSent.length = 0;
      const exRes = await callAttemptResume(
        emptyCodex.id,
        "dev-empty-codex@m2",
        "codex_id",
        "tok-m2-ex",
        "/work/m2-ex",
        emptyCodexPosture,
      );
      expect(exRes.kind).toBe("resumed");
      expect(codexSent[0]).toContain("codex -s danger-full-access ");
      expect(codexSent[0]).not.toContain("-a never");

      // Capture M2 empty-posture Case 3 & Case 4 (recorded launch observation across inventory and detail).
      const emptyEntryRecorded = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e])).get("dev.empty-codex")!;
      const emptyDetailRecorded = getNodeDetail(db, rig.id, "dev.empty-codex")!;
      expect(emptyEntryRecorded.resumeCommand).toBe(expectedEmptyCodexCmd);
      expect(emptyDetailRecorded.resumeCommand).toBe(expectedEmptyCodexCmd);
      expect(emptyDetailRecorded.recoveryGuidance?.commands[0]).toBe(expectedEmptyCodexCmd);

      // Effective-input controls: an empty saved policy_launch_posture overridden by an explicit mode selection or
      // a valid member envelope uses that override on both restore and display, so normal labels are preserved.
      const emptyModeOverride = rigRepo.addNode(rig.id, "dev.empty-mode-override", { runtime: "codex", cwd: "/work/m2-emo" });
      db.prepare(
        "UPDATE nodes SET permission_policy = 'builtin:yolo', policy_origin = 'builtin', policy_launch_posture = '' WHERE id = ?",
      ).run(emptyModeOverride.id);
      permStore.write(emptyModeOverride.id, { runtime: "codex", mode: "floor" }, "op@m2", "explicit floor");
      registry.updateResumeToken(
        registry.registerSession(emptyModeOverride.id, "dev-empty-mode-override@m2").id,
        "codex_id",
        "tok-m2-emo",
        "hook",
      );
      expect(
        new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e])).get("dev.empty-mode-override")?.resumeCommandLabel,
      ).toBe("flags from current settings");
      codexSent.length = 0;
      const emoRes = await callAttemptResume(
        emptyModeOverride.id,
        "dev-empty-mode-override@m2",
        "codex_id",
        "tok-m2-emo",
        "/work/m2-emo",
        restoreOrchestrator.resolveRestorePosture(emptyModeOverride.id, rig.id) as string,
      );
      expect(emoRes.kind).toBe("resumed");
      expect(codexSent[0]).toContain("codex -s workspace-write ");
      expect(
        new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e])).get("dev.empty-mode-override")?.resumeCommandLabel,
      ).toBe("launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write");

      const emptyEnvOverride = rigRepo.addNode(rig.id, "dev.empty-env-override", {
        runtime: "codex",
        cwd: "/work/m2-eeo",
        codexPermissions: readOnlyOnRequestEnvelope,
      });
      db.prepare(
        "UPDATE nodes SET permission_policy = 'builtin:yolo', policy_origin = 'builtin', policy_launch_posture = '' WHERE id = ?",
      ).run(emptyEnvOverride.id);
      registry.updateResumeToken(
        registry.registerSession(emptyEnvOverride.id, "dev-empty-env-override@m2").id,
        "codex_id",
        "tok-m2-eeo",
        "hook",
      );
      expect(
        new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e])).get("dev.empty-env-override")?.resumeCommandLabel,
      ).toBe("flags from current settings");
      codexSent.length = 0;
      const eeoRes = await callAttemptResume(
        emptyEnvOverride.id,
        "dev-empty-env-override@m2",
        "codex_id",
        "tok-m2-eeo",
        "/work/m2-eeo",
        restoreOrchestrator.resolveRestorePosture(emptyEnvOverride.id, rig.id) as string,
      );
      expect(eeoRes.kind).toBe("resumed");
      expect(codexSent[0]).toContain("codex -s read-only -a on-request ");
      expect(
        new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e])).get("dev.empty-env-override")?.resumeCommandLabel,
      ).toBeNull();

      // Rig-level empty saved posture (no node provenance) with launch_wrapper composes both the fallback label and wrapper omission.
      const emptyRig = rigRepo.createRig("m2-empty-rig");
      db.prepare(
        "UPDATE rigs SET permission_policy = 'builtin:yolo', rig_policy_origin = 'builtin', rig_policy_launch_posture = '' WHERE id = ?",
      ).run(emptyRig.id);
      const emptyRigWrapped = rigRepo.addNode(emptyRig.id, "dev.rig-empty-wrap", {
        runtime: "codex",
        cwd: "/work/m2-rew",
        launchWrapper: ["mtn", "sandbox", "--"],
      });
      registry.updateResumeToken(
        registry.registerSession(emptyRigWrapped.id, "dev-rig-empty-wrap@m2").id,
        "codex_id",
        "tok-m2-rew",
        "hook",
      );
      expect(restoreOrchestrator.resolveRestorePosture(emptyRigWrapped.id, emptyRig.id) as string).toBe("");
      const expectedWrappedEmptyLabel =
        `${expectedEmptyUnrecordedLabel}; omits launch_wrapper (managed resume uses the wrapper)`;
      expect(getNodeInventory(db, emptyRig.id)[0]?.resumeCommand).toBe(
        `codex -s workspace-write ${UPDATE_OFF} resume 'tok-m2-rew'`,
      );

      // Assert all 4 M2 empty-posture combinations (inventory/detail x unrecorded/recorded) plus wrapped rig-empty composition,
      // and verify even a recorded workspace-write observation on an empty-posture seat stays uncertain rather than matching.
      const sameSandboxEmptySeat = rigRepo.addNode(emptyRig.id, "dev.rig-empty-same-sbx", {
        runtime: "codex",
        cwd: "/work/m2-ress",
      });
      registry.updateResumeToken(
        registry.registerSession(sameSandboxEmptySeat.id, "dev-rig-empty-same-sbx@m2").id,
        "codex_id",
        "tok-m2-ress",
        "hook",
      );
      observations.recordGeneration(
        registry.currentOccupantTenure(sameSandboxEmptySeat.id)!.generationUuid,
        observeCodexSandbox("-s workspace-write"),
      );
      const emptyRigByLogical = new Map(getNodeInventory(db, emptyRig.id).map((e) => [e.logicalId, e]));
      const expectedSameSandboxEmptyLabel =
        "launched with -s workspace-write (approval unrecorded); saved posture empty, showing fallback -s workspace-write (managed resume posture unknown)";

      expect({
        inventoryUnrecorded: emptyEntryUnrecorded.resumeCommandLabel,
        detailUnrecorded: emptyDetailUnrecorded.resumeCommandLabel,
        detailUnrecordedNote: emptyDetailUnrecorded.recoveryGuidance?.notes[0],
        inventoryRecorded: emptyEntryRecorded.resumeCommandLabel,
        detailRecorded: emptyDetailRecorded.resumeCommandLabel,
        detailRecordedNote: emptyDetailRecorded.recoveryGuidance?.notes[0],
        rigWrappedInventory: emptyRigByLogical.get("dev.rig-empty-wrap")?.resumeCommandLabel,
        rigWrappedDetailNote: getNodeDetail(db, emptyRig.id, "dev.rig-empty-wrap")?.recoveryGuidance?.notes[0],
        rigSameSandboxInventory: emptyRigByLogical.get("dev.rig-empty-same-sbx")?.resumeCommandLabel,
      }).toEqual({
        inventoryUnrecorded: expectedEmptyUnrecordedLabel,
        detailUnrecorded: expectedEmptyUnrecordedLabel,
        detailUnrecordedNote: expectedEmptyUnrecordedLabel,
        inventoryRecorded: expectedEmptyRecordedLabel,
        detailRecorded: expectedEmptyRecordedLabel,
        detailRecordedNote: expectedEmptyRecordedLabel,
        rigWrappedInventory: expectedWrappedEmptyLabel,
        rigWrappedDetailNote: expectedWrappedEmptyLabel,
        rigSameSandboxInventory: expectedSameSandboxEmptyLabel,
      });
      expect(emptyDetailUnrecorded.recoveryGuidance?.notes).not.toContain("flags from current settings");
      expect(emptyDetailRecorded.recoveryGuidance?.notes.some((n) => n.includes("a resume now uses"))).toBe(false);

      // 3. Rig-level unknown stored posture when node provenance is absent also passes through raw on restore.
      const unknownRig = rigRepo.createRig("m2-unknown-rig");
      db.prepare(
        "UPDATE rigs SET permission_policy = NULL, rig_policy_origin = 'builtin', rig_policy_launch_posture = 'rig_custom_raw' WHERE id = ?",
      ).run(unknownRig.id);
      const rigSeat = rigRepo.addNode(unknownRig.id, "dev.rig-raw", { runtime: "codex", cwd: "/work/m2-rr" });
      registry.updateResumeToken(registry.registerSession(rigSeat.id, "dev-rig-raw@m2").id, "codex_id", "tok-m2-rr", "hook");
      expect(restoreOrchestrator.resolveRestorePosture(rigSeat.id, unknownRig.id) as string).toBe("rig_custom_raw");
      expect(getNodeInventory(db, unknownRig.id)[0]?.resumeCommand).toBe(
        `codex -s workspace-write ${UPDATE_OFF} resume 'tok-m2-rr'`,
      );
      expect(getNodeInventory(db, unknownRig.id)[0]?.resumeCommandLabel).toBe("flags from current settings");

      // 4. Lazy lookup order: when custom node provenance lacks declaringDir or resolvedTarget, main does NOT eagerly
      //    call rigRepo.getRigPermissionPolicy(rigId) (nor getRigPolicyProvenance when node provenance exists), so a
      //    throwing fallback read never clobbers saved launchPosture ("full_bypass") to "floor".
      const lazySeatNoDir = rigRepo.addNode(rig.id, "dev.lazy-nodir", { runtime: "codex", cwd: "/work/m2-l1" });
      db.prepare(
        "UPDATE nodes SET permission_policy = NULL, policy_origin = 'custom', policy_resolved_target = '/tmp/unused.policy.md', policy_declaring_dir = NULL, policy_launch_posture = 'full_bypass' WHERE id = ?",
      ).run(lazySeatNoDir.id);

      const lazySeatNoTarget = rigRepo.addNode(rig.id, "dev.lazy-notarget", { runtime: "codex", cwd: "/work/m2-l2" });
      db.prepare(
        "UPDATE nodes SET permission_policy = NULL, policy_origin = 'custom', policy_resolved_target = NULL, policy_declaring_dir = '/tmp', policy_launch_posture = 'full_bypass' WHERE id = ?",
      ).run(lazySeatNoTarget.id);

      const getRigPolicySpy = vi.spyOn(rigRepo, "getRigPermissionPolicy").mockImplementation(() => {
        throw new Error("eager getRigPermissionPolicy must not run when declaringDir/resolvedTarget is missing");
      });
      const getRigProvSpy = vi.spyOn(rigRepo, "getRigPolicyProvenance").mockImplementation(() => {
        throw new Error("eager getRigPolicyProvenance must not run when node provenance exists");
      });
      try {
        expect(restoreOrchestrator.resolveRestorePosture(lazySeatNoDir.id, rig.id)).toBe("full_bypass");
        expect(restoreOrchestrator.resolveRestorePosture(lazySeatNoTarget.id, rig.id)).toBe("full_bypass");
        expect(getRigPolicySpy).not.toHaveBeenCalled();
        expect(getRigProvSpy).not.toHaveBeenCalled();
      } finally {
        getRigPolicySpy.mockRestore();
        getRigProvSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("QA002 / F01: matches unchanged main RestoreOrchestrator posture in display when custom-origin provenance points at builtin:yolo or none", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-3043-f01-provenance-"));
    try {
      const policiesDir = path.join(tmpDir, "policies");
      fs.mkdirSync(policiesDir, { recursive: true });

      const restoreOrchestrator = createRestoreOrchestrator();

      const seatFloorPath = path.join(policiesDir, "seat-floor.policy.md");
      const seatBypassPath = path.join(policiesDir, "seat-bypass.policy.md");
      const rigFloorPath = path.join(policiesDir, "rig-floor.policy.md");
      const rigBypassPath = path.join(policiesDir, "rig-bypass.policy.md");
      const genuineSeatPath = path.join(policiesDir, "genuine-seat.policy.md");
      const genuineRigPath = path.join(policiesDir, "genuine-rig.policy.md");

      fs.writeFileSync(seatFloorPath, makeValidFlagPolicy("floor"), "utf8");
      fs.writeFileSync(seatBypassPath, makeValidFlagPolicy("full_bypass"), "utf8");
      fs.writeFileSync(rigFloorPath, makeValidFlagPolicy("floor"), "utf8");
      fs.writeFileSync(rigBypassPath, makeValidFlagPolicy("full_bypass"), "utf8");
      fs.writeFileSync(genuineSeatPath, makeValidFlagPolicy("full_bypass"), "utf8");
      fs.writeFileSync(genuineRigPath, makeValidFlagPolicy("floor"), "utf8");

      // 1. Node custom provenance persisted as floor over a stale builtin:yolo ref (and over inherited rig builtin:yolo when nodeRef is NULL),
      //    plus node custom provenance persisted as full_bypass over a stale deliberate 'none' ref.
      const nodeRig = rigRepo.createRig("f01-node-rig");
      db.prepare("UPDATE rigs SET permission_policy = 'builtin:yolo' WHERE id = ?").run(nodeRig.id);

      const staleNodeYolo = rigRepo.addNode(nodeRig.id, "dev.stale-node-yolo", { runtime: "codex", cwd: "/work/f01-a" });
      rigRepo.setNodePermissionPolicy(staleNodeYolo.id, "builtin:yolo");
      rigRepo.setNodePolicyProvenance(staleNodeYolo.id, {
        origin: "custom",
        resolvedTarget: seatFloorPath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      const sNodeYolo = registry.registerSession(staleNodeYolo.id, "dev-stale-node-yolo@f01-node-rig");
      registry.updateResumeToken(sNodeYolo.id, "codex_id", "tok-f01-node-yolo", "hook");

      const staleInheritedYolo = rigRepo.addNode(nodeRig.id, "dev.stale-inh-yolo", { runtime: "codex", cwd: "/work/f01-b" });
      rigRepo.setNodePolicyProvenance(staleInheritedYolo.id, {
        origin: "custom",
        resolvedTarget: seatFloorPath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      const sInhYolo = registry.registerSession(staleInheritedYolo.id, "dev-stale-inh-yolo@f01-node-rig");
      registry.updateResumeToken(sInhYolo.id, "codex_id", "tok-f01-inh-yolo", "hook");

      const staleNodeNone = rigRepo.addNode(nodeRig.id, "dev.stale-node-none", { runtime: "codex", cwd: "/work/f01-c" });
      rigRepo.setNodePermissionPolicy(staleNodeNone.id, "none");
      rigRepo.setNodePolicyProvenance(staleNodeNone.id, {
        origin: "custom",
        resolvedTarget: seatBypassPath,
        declaringDir: tmpDir,
        launchPosture: "full_bypass",
      });
      const sNodeNone = registry.registerSession(staleNodeNone.id, "dev-stale-node-none@f01-node-rig");
      registry.updateResumeToken(sNodeNone.id, "codex_id", "tok-f01-node-none", "hook");

      const genuineSeatNode = rigRepo.addNode(nodeRig.id, "dev.genuine-seat", { runtime: "codex", cwd: "/work/f01-d" });
      rigRepo.setNodePermissionPolicy(genuineSeatNode.id, "policies/genuine-seat.policy.md");
      rigRepo.setNodePolicyProvenance(genuineSeatNode.id, {
        origin: "custom",
        resolvedTarget: genuineSeatPath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      const sGenuineSeat = registry.registerSession(genuineSeatNode.id, "dev-genuine-seat@f01-node-rig");
      registry.updateResumeToken(sGenuineSeat.id, "codex_id", "tok-f01-genuine-seat", "hook");

      // 2. Rig custom provenance persisted as floor over stale builtin:yolo, persisted as full_bypass over stale 'none',
      //    and genuine custom rig policy re-deriving from full_bypass to floor.
      const staleRigYolo = rigRepo.createRig("f01-rig-yolo");
      db.prepare(
        "UPDATE rigs SET permission_policy = 'builtin:yolo', rig_policy_origin = 'custom', rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = 'floor' WHERE id = ?",
      ).run(rigFloorPath, tmpDir, staleRigYolo.id);
      const rigYoloSeat = rigRepo.addNode(staleRigYolo.id, "dev.rig-yolo", { runtime: "codex", cwd: "/work/f01-e" });
      const sRigYolo = registry.registerSession(rigYoloSeat.id, "dev-rig-yolo@f01-rig-yolo");
      registry.updateResumeToken(sRigYolo.id, "codex_id", "tok-f01-rig-yolo", "hook");

      const staleRigNone = rigRepo.createRig("f01-rig-none");
      db.prepare(
        "UPDATE rigs SET permission_policy = 'none', rig_policy_origin = 'custom', rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = 'full_bypass' WHERE id = ?",
      ).run(rigBypassPath, tmpDir, staleRigNone.id);
      const rigNoneSeat = rigRepo.addNode(staleRigNone.id, "dev.rig-none", { runtime: "codex", cwd: "/work/f01-f" });
      const sRigNone = registry.registerSession(rigNoneSeat.id, "dev-rig-none@f01-rig-none");
      registry.updateResumeToken(sRigNone.id, "codex_id", "tok-f01-rig-none", "hook");

      const genuineRig = rigRepo.createRig("f01-genuine-rig");
      db.prepare(
        "UPDATE rigs SET permission_policy = 'policies/genuine-rig.policy.md', rig_policy_origin = 'custom', rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = 'full_bypass' WHERE id = ?",
      ).run(genuineRigPath, tmpDir, genuineRig.id);
      const genuineRigSeat = rigRepo.addNode(genuineRig.id, "dev.genuine-rig", { runtime: "codex", cwd: "/work/f01-g" });
      const sGenuineRig = registry.registerSession(genuineRigSeat.id, "dev-genuine-rig@f01-genuine-rig");
      registry.updateResumeToken(sGenuineRig.id, "codex_id", "tok-f01-genuine-rig", "hook");

      // Unchanged main RestoreOrchestrator derives full_bypass for readable custom-origin builtin:yolo refs and floor for 'none'.
      expect(restoreOrchestrator.resolveRestorePosture(staleNodeYolo.id, nodeRig.id)).toBe("full_bypass");
      expect(restoreOrchestrator.resolveRestorePosture(staleInheritedYolo.id, nodeRig.id)).toBe("full_bypass");
      expect(restoreOrchestrator.resolveRestorePosture(staleNodeNone.id, nodeRig.id)).toBe("floor");
      expect(restoreOrchestrator.resolveRestorePosture(rigYoloSeat.id, staleRigYolo.id)).toBe("full_bypass");
      expect(restoreOrchestrator.resolveRestorePosture(rigNoneSeat.id, staleRigNone.id)).toBe("floor");

      const realNodeYoloCmd = await runRealRestoreResolvedResume(
        restoreOrchestrator,
        staleNodeYolo.id,
        nodeRig.id,
        "tok-f01-node-yolo",
      );
      const realInhYoloCmd = await runRealRestoreResolvedResume(
        restoreOrchestrator,
        staleInheritedYolo.id,
        nodeRig.id,
        "tok-f01-inh-yolo",
      );
      const realNodeNoneCmd = await runRealRestoreResolvedResume(
        restoreOrchestrator,
        staleNodeNone.id,
        nodeRig.id,
        "tok-f01-node-none",
      );
      const realRigYoloCmd = await runRealRestoreResolvedResume(
        restoreOrchestrator,
        rigYoloSeat.id,
        staleRigYolo.id,
        "tok-f01-rig-yolo",
      );
      const realRigNoneCmd = await runRealRestoreResolvedResume(
        restoreOrchestrator,
        rigNoneSeat.id,
        staleRigNone.id,
        "tok-f01-rig-none",
      );

      expect(realNodeYoloCmd).toBe(`codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-node-yolo'`);
      expect(realInhYoloCmd).toBe(`codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-inh-yolo'`);
      expect(realNodeNoneCmd).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-f01-node-none'`);
      expect(realRigYoloCmd).toBe(`codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-rig-yolo'`);
      expect(realRigNoneCmd).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-f01-rig-none'`);

      // Genuine custom seat and rig policies agree between display and real RestoreOrchestrator.
      const nodeEntries = new Map(getNodeInventory(db, nodeRig.id).map((e) => [e.logicalId, e]));
      expect(nodeEntries.get("dev.genuine-seat")?.resumeCommand).toBe(
        `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-genuine-seat'`,
      );
      expect(nodeEntries.get("dev.genuine-seat")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(restoreOrchestrator, genuineSeatNode.id, nodeRig.id, "tok-f01-genuine-seat"),
      );
      expect(getNodeInventory(db, genuineRig.id)[0]?.resumeCommand).toBe(
        `codex -s workspace-write ${UPDATE_OFF} resume 'tok-f01-genuine-rig'`,
      );
      expect(getNodeInventory(db, genuineRig.id)[0]?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(restoreOrchestrator, genuineRigSeat.id, genuineRig.id, "tok-f01-genuine-rig"),
      );

      // Display must match main's real restore command across both directions (builtin:yolo -> full_bypass and none -> floor).
      expect({
        staleNodeYoloInventory: nodeEntries.get("dev.stale-node-yolo")?.resumeCommand,
        staleNodeYoloDetail: getNodeDetail(db, nodeRig.id, "dev.stale-node-yolo")?.recoveryGuidance?.commands[0],
        staleInheritedYoloInventory: nodeEntries.get("dev.stale-inh-yolo")?.resumeCommand,
        staleInheritedYoloDetail: getNodeDetail(db, nodeRig.id, "dev.stale-inh-yolo")?.recoveryGuidance?.commands[0],
        staleNodeNoneInventory: nodeEntries.get("dev.stale-node-none")?.resumeCommand,
        staleNodeNoneDetail: getNodeDetail(db, nodeRig.id, "dev.stale-node-none")?.recoveryGuidance?.commands[0],
        staleRigYoloInventory: getNodeInventory(db, staleRigYolo.id)[0]?.resumeCommand,
        staleRigYoloDetail: getNodeDetail(db, staleRigYolo.id, "dev.rig-yolo")?.recoveryGuidance?.commands[0],
        staleRigNoneInventory: getNodeInventory(db, staleRigNone.id)[0]?.resumeCommand,
        staleRigNoneDetail: getNodeDetail(db, staleRigNone.id, "dev.rig-none")?.recoveryGuidance?.commands[0],
      }).toEqual({
        staleNodeYoloInventory: `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-node-yolo'`,
        staleNodeYoloDetail: `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-node-yolo'`,
        staleInheritedYoloInventory: `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-inh-yolo'`,
        staleInheritedYoloDetail: `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-inh-yolo'`,
        staleNodeNoneInventory: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-f01-node-none'`,
        staleNodeNoneDetail: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-f01-node-none'`,
        staleRigYoloInventory: `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-rig-yolo'`,
        staleRigYoloDetail: `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f01-rig-yolo'`,
        staleRigNoneInventory: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-f01-rig-none'`,
        staleRigNoneDetail: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-f01-rig-none'`,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("F02: guards display custom policy reads against non-regular files such as FIFOs and directories while keeping RestoreOrchestrator on main's direct readFileSync path", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-3043-f02-fifo-guard-"));
    const origStatSync = fs.statSync.bind(fs);
    const origReadFileSync = fs.readFileSync.bind(fs);
    try {
      const policiesDir = path.join(tmpDir, "policies");
      fs.mkdirSync(policiesDir, { recursive: true });

      // Backing files carry opposite postures from persisted provenance so any unguarded read changes the posture
      // deterministically without ever opening a real blocking writerless FIFO.
      const fifoNodePath = path.join(policiesDir, "fifo-seat.policy.md");
      const fifoRigPath = path.join(policiesDir, "fifo-rig.policy.md");
      const dirPolicyPath = path.join(policiesDir, "dir-seat.policy.md");
      const regularPolicyPath = path.join(policiesDir, "regular-seat.policy.md");

      fs.writeFileSync(fifoNodePath, makeValidFlagPolicy("full_bypass"), "utf8");
      fs.writeFileSync(fifoRigPath, makeValidFlagPolicy("floor"), "utf8");
      fs.mkdirSync(dirPolicyPath);
      fs.writeFileSync(regularPolicyPath, makeValidFlagPolicy("full_bypass"), "utf8");

      const restoreOrchestrator = createRestoreOrchestrator();

      const rig = rigRepo.createRig("f02-fifo-rig");
      db.prepare(
        "UPDATE rigs SET permission_policy = 'policies/fifo-rig.policy.md', rig_policy_origin = 'custom', rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = 'full_bypass' WHERE id = ?",
      ).run(fifoRigPath, tmpDir, rig.id);

      const fifoRigSeat = rigRepo.addNode(rig.id, "dev.fifo-rig", { runtime: "codex", cwd: "/work/f02-rig" });
      const sFifoRig = registry.registerSession(fifoRigSeat.id, "dev-fifo-rig@f02-fifo-rig");
      registry.updateResumeToken(sFifoRig.id, "codex_id", "tok-f02-fifo-rig", "hook");

      const fifoNodeSeat = rigRepo.addNode(rig.id, "dev.fifo-node", { runtime: "codex", cwd: "/work/f02-node" });
      rigRepo.setNodePermissionPolicy(fifoNodeSeat.id, "policies/fifo-seat.policy.md");
      rigRepo.setNodePolicyProvenance(fifoNodeSeat.id, {
        origin: "custom",
        resolvedTarget: fifoNodePath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      const sFifoNode = registry.registerSession(fifoNodeSeat.id, "dev-fifo-node@f02-fifo-rig");
      registry.updateResumeToken(sFifoNode.id, "codex_id", "tok-f02-fifo-node", "hook");

      const dirNodeSeat = rigRepo.addNode(rig.id, "dev.dir-node", { runtime: "codex", cwd: "/work/f02-dir" });
      rigRepo.setNodePermissionPolicy(dirNodeSeat.id, "policies/dir-seat.policy.md");
      rigRepo.setNodePolicyProvenance(dirNodeSeat.id, {
        origin: "custom",
        resolvedTarget: dirPolicyPath,
        declaringDir: tmpDir,
        launchPosture: "full_bypass",
      });
      const sDirNode = registry.registerSession(dirNodeSeat.id, "dev-dir-node@f02-fifo-rig");
      registry.updateResumeToken(sDirNode.id, "codex_id", "tok-f02-dir-node", "hook");

      const regularNodeSeat = rigRepo.addNode(rig.id, "dev.regular-node", { runtime: "codex", cwd: "/work/f02-reg" });
      rigRepo.setNodePermissionPolicy(regularNodeSeat.id, "policies/regular-seat.policy.md");
      rigRepo.setNodePolicyProvenance(regularNodeSeat.id, {
        origin: "custom",
        resolvedTarget: regularPolicyPath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      const sRegularNode = registry.registerSession(regularNodeSeat.id, "dev-regular-node@f02-fifo-rig");
      registry.updateResumeToken(sRegularNode.id, "codex_id", "tok-f02-reg-node", "hook");

      const statCheckedPaths: string[] = [];
      const readAttemptedFifoPaths: string[] = [];

      const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
        const realStats = origStatSync(target, options as never);
        const asStr = String(target);
        statCheckedPaths.push(asStr);
        if (asStr === fifoNodePath || asStr === fifoRigPath) {
          return Object.assign(Object.create(Object.getPrototypeOf(realStats)), realStats, {
            isFile: () => false,
            isFIFO: () => true,
          });
        }
        return realStats;
      }) as typeof fs.statSync);

      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
        const asStr = String(target);
        if (asStr === fifoNodePath || asStr === fifoRigPath) {
          readAttemptedFifoPaths.push(asStr);
        }
        return origReadFileSync(target, options as never);
      }) as typeof fs.readFileSync);

      try {
        const entries = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e]));
        const fifoNodeDetail = getNodeDetail(db, rig.id, "dev.fifo-node")!;
        const fifoRigDetail = getNodeDetail(db, rig.id, "dev.fifo-rig")!;

        // Display checks statSync().isFile() and NEVER calls readFileSync on FIFO paths.
        expect(entries.get("dev.fifo-node")?.resumeCommand).toBe(
          `codex -s workspace-write ${UPDATE_OFF} resume 'tok-f02-fifo-node'`,
        );
        expect(fifoNodeDetail.recoveryGuidance?.commands[0]).toBe(
          `codex -s workspace-write ${UPDATE_OFF} resume 'tok-f02-fifo-node'`,
        );
        expect(entries.get("dev.fifo-rig")?.resumeCommand).toBe(
          `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f02-fifo-rig'`,
        );
        expect(fifoRigDetail.recoveryGuidance?.commands[0]).toBe(
          `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f02-fifo-rig'`,
        );
        expect(entries.get("dev.dir-node")?.resumeCommand).toBe(
          `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f02-dir-node'`,
        );
        expect(entries.get("dev.regular-node")?.resumeCommand).toBe(
          `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f02-reg-node'`,
        );
        expect(statCheckedPaths).toContain(fifoNodePath);
        expect(statCheckedPaths).toContain(fifoRigPath);
        expect(readAttemptedFifoPaths).toEqual([]);

        // RestoreOrchestrator stays on main's direct readFileSync path (no statSync guard on restore).
        statCheckedPaths.length = 0;
        expect(restoreOrchestrator.resolveRestorePosture(dirNodeSeat.id, rig.id)).toBe("full_bypass");
        expect(restoreOrchestrator.resolveRestorePosture(regularNodeSeat.id, rig.id)).toBe("full_bypass");
        expect(restoreOrchestrator.resolveRestorePosture(fifoNodeSeat.id, rig.id)).toBe("full_bypass");
        expect(statCheckedPaths).toEqual([]);
        expect(readAttemptedFifoPaths).toEqual([fifoNodePath]);
      } finally {
        readSpy.mockRestore();
        statSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("F03: resolves Codex resume inputs once per getNodeDetail call so policy mutations during detail projection cannot split command, label, and recoveryGuidance", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-3043-f03-single-detail-"));
    const origReadFileSync = fs.readFileSync.bind(fs);
    try {
      const policiesDir = path.join(tmpDir, "policies");
      fs.mkdirSync(policiesDir, { recursive: true });
      const seatPolicyPath = path.join(policiesDir, "single-seat.policy.md");
      const tokenlessPolicyPath = path.join(policiesDir, "single-last.policy.md");

      fs.writeFileSync(seatPolicyPath, makeValidFlagPolicy("full_bypass"), "utf8");
      fs.writeFileSync(tokenlessPolicyPath, makeValidFlagPolicy("full_bypass"), "utf8");

      const rig = rigRepo.createRig("f03-detail-rig");
      const node = rigRepo.addNode(rig.id, "dev.single", { runtime: "codex", cwd: "/work/f03" });
      rigRepo.setNodePermissionPolicy(node.id, "policies/single-seat.policy.md");
      rigRepo.setNodePolicyProvenance(node.id, {
        origin: "custom",
        resolvedTarget: seatPolicyPath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      const session = registry.registerSession(node.id, "dev-single@f03-detail-rig");
      registry.updateResumeToken(session.id, "codex_id", "tok-f03", "hook");
      observations.recordGeneration(
        registry.currentOccupantTenure(node.id)!.generationUuid,
        {
          ...observeCodexEnvelope(codexMemberEnvelope(readOnlyOnRequestEnvelope)),
          daemonOptOut: true,
        },
      );

      const tokenless = rigRepo.addNode(rig.id, "dev.single-last", { runtime: "codex", cwd: "/work/f03-last" });
      rigRepo.setNodePermissionPolicy(tokenless.id, "policies/single-last.policy.md");
      rigRepo.setNodePolicyProvenance(tokenless.id, {
        origin: "custom",
        resolvedTarget: tokenlessPolicyPath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      registry.registerSession(tokenless.id, "dev-single-last@f03-detail-rig");

      let seatPolicyReads = 0;
      let tokenlessPolicyReads = 0;

      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
        const content = origReadFileSync(target, options as never);
        const asStr = String(target);
        if (asStr === seatPolicyPath) {
          seatPolicyReads += 1;
          if (seatPolicyReads === 1) {
            // Mutate on-disk policy from full_bypass -> floor immediately after the first read so any second
            // resolution inside getNodeDetail produces a conflicting floor command and label.
            fs.writeFileSync(seatPolicyPath, makeValidFlagPolicy("floor"), "utf8");
          }
        } else if (asStr === tokenlessPolicyPath) {
          tokenlessPolicyReads += 1;
          if (tokenlessPolicyReads === 1) {
            fs.writeFileSync(tokenlessPolicyPath, makeValidFlagPolicy("floor"), "utf8");
          }
        }
        return content;
      }) as typeof fs.readFileSync);

      try {
        const detail = getNodeDetail(db, rig.id, "dev.single")!;
        const expectedCommand = `codex --no-daemon -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-f03'`;
        const expectedLabel = "launched with -s read-only -a on-request; a resume now uses -s danger-full-access -a never";

        expect(seatPolicyReads).toBe(1);
        expect(tokenlessPolicyReads).toBe(1);
        expect(detail.resumeCommand).toBe(expectedCommand);
        expect(detail.resumeCommandLabel).toBe(expectedLabel);
        expect(detail.recoveryGuidance?.commands[0]).toBe(expectedCommand);
        expect(detail.recoveryGuidance?.summary).toBe(`Try native Codex resume first (${expectedCommand}).`);
        expect(detail.recoveryGuidance?.notes).toContain(expectedLabel);
        expect(detail.recoveryGuidance?.notes.some((n) => n.includes("Not recorded whether this seat's last managed launch used --no-daemon"))).toBe(false);

        // Reset counters and verify tokenless detail also resolves its policy once (after the earlier mutation to floor,
        // flip back to full_bypass first so a second read would again diverge to floor).
        fs.writeFileSync(tokenlessPolicyPath, makeValidFlagPolicy("full_bypass"), "utf8");
        tokenlessPolicyReads = 0;
        const lastDetail = getNodeDetail(db, rig.id, "dev.single-last")!;
        const expectedLastCommand = `codex -s danger-full-access -a never ${UPDATE_OFF} resume --last`;
        expect(tokenlessPolicyReads).toBe(1);
        expect(lastDetail.resumeCommand).toBeNull();
        expect(lastDetail.resumeCommandLabel).toBeNull();
        expect(lastDetail.recoveryGuidance?.commands).toEqual(["cd /work/f03-last", expectedLastCommand]);
        expect(lastDetail.recoveryGuidance?.summary).toBe(
          `No stored Codex resume token. Try ${expectedLastCommand} from the seat workspace.`,
        );
      } finally {
        readSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("F04: keeps bare Codex resume commands copyable for wrapped seats while composing a visible launch_wrapper omission warning across display, inventory, and detail guidance", async () => {
    const wrapper = ["mtn", "sandbox", "exec", "--seat", "synthetic", "--"] as const;
    const expectedOmission = "omits launch_wrapper (managed resume uses the wrapper)";

    // 1. Direct display builder coverage across recorded_match, no_recorded_launch, recorded_difference, empty wrapper, and Claude Code.
    const matchedWrapped = buildCodexResumeDisplay("tok-wrap-direct", {
      codexPermissions: readOnlyOnRequestEnvelope,
      recordedLaunch: observeCodexEnvelope(codexMemberEnvelope(readOnlyOnRequestEnvelope)),
      launchWrapper: wrapper,
    });
    expect(matchedWrapped).toEqual({
      command: `codex -s read-only -a on-request ${UPDATE_OFF} resume 'tok-wrap-direct'`,
      status: "recorded_match",
      label: expectedOmission,
    });

    const unrecordedWrapped = buildCodexResumeDisplay("tok-wrap-unrec", {
      launchWrapper: wrapper,
    });
    expect(unrecordedWrapped).toEqual({
      command: `codex -s workspace-write ${UPDATE_OFF} resume 'tok-wrap-unrec'`,
      status: "no_recorded_launch",
      label: `flags from current settings; ${expectedOmission}`,
    });

    const diffWrapped = buildNativeResumeDisplay(
      "codex",
      "tok-wrap-diff",
      null,
      null,
      true,
      null,
      {
        resolvedPosture: "floor",
        recordedLaunch: {
          runtime: "codex",
          axis: "sandbox",
          state: "observed",
          value: "danger-full-access",
          approvalPolicy: "never",
          daemonOptOut: true,
          reason: "emitted_launch_arguments",
        },
        launchWrapper: wrapper,
      },
    );
    expect(diffWrapped).toEqual({
      command: `codex --no-daemon -s workspace-write ${UPDATE_OFF} resume 'tok-wrap-diff'`,
      status: "recorded_difference",
      label: `launched with -s danger-full-access -a never; a resume now uses -s workspace-write; ${expectedOmission}`,
    });

    expect(buildCodexResumeDisplay("tok-empty-wrap", { launchWrapper: [] }).label).toBe("flags from current settings");
    expect(buildNativeResumeDisplay("claude-code", "tok-claude-wrap")?.label).toBeNull();

    // 2. End-to-end inventory, multi-rig inventory, and detail recoveryGuidance coverage.
    const rig = rigRepo.createRig("f04-wrap-rig");

    const wrapMatchNode = rigRepo.addNode(rig.id, "dev.wrap-match", {
      runtime: "codex",
      cwd: "/work/wrap-match",
      codexPermissions: readOnlyOnRequestEnvelope,
      launchWrapper: [...wrapper],
    });
    const sWrapMatch = registry.registerSession(wrapMatchNode.id, "dev-wrap-match@f04-wrap-rig");
    registry.updateResumeToken(sWrapMatch.id, "codex_id", "tok-wrap-match", "hook");
    observations.recordGeneration(
      registry.currentOccupantTenure(wrapMatchNode.id)!.generationUuid,
      observeCodexEnvelope(codexMemberEnvelope(readOnlyOnRequestEnvelope)),
    );

    const wrapUncertainNode = rigRepo.addNode(rig.id, "dev.wrap-uncertain", {
      runtime: "codex",
      cwd: "/work/wrap-uncertain",
      launchWrapper: [...wrapper],
    });
    const sWrapUncertain = registry.registerSession(wrapUncertainNode.id, "dev-wrap-uncertain@f04-wrap-rig");
    registry.updateResumeToken(sWrapUncertain.id, "codex_id", "tok-wrap-uncertain", "hook");
    observations.recordGeneration(
      registry.currentOccupantTenure(wrapUncertainNode.id)!.generationUuid,
      observeCodexSandbox("-s workspace-write"),
    );

    const wrapTokenlessNode = rigRepo.addNode(rig.id, "dev.wrap-tokenless", {
      runtime: "codex",
      cwd: "/work/wrap-tokenless",
      launchWrapper: [...wrapper],
    });
    registry.registerSession(wrapTokenlessNode.id, "dev-wrap-tokenless@f04-wrap-rig");

    const wrapRefusedNode = rigRepo.addNode(rig.id, "dev.wrap-refused", {
      runtime: "codex",
      cwd: "/work/wrap-refused",
      codexPermissions: readOnlyOnRequestEnvelope,
      launchWrapper: [...wrapper],
    });
    const sWrapRefused = registry.registerSession(wrapRefusedNode.id, "dev-wrap-refused@f04-wrap-rig");
    registry.updateResumeToken(sWrapRefused.id, "codex_id", "tok-wrap-refused", "hook");
    db.prepare(
      "INSERT INTO node_permission_selections (node_id, runtime, mode, updated_at, actor, reason) VALUES (?, 'codex', 'floor', '2026-11-12T00:00:00Z', 'op@f04-wrap-rig', 'conflict')",
    ).run(wrapRefusedNode.id);

    const single = getNodeInventory(db, rig.id);
    expect(getNodeInventoryForRigs(db, new Set([rig.id])).get(rig.id)).toEqual(single);
    expect(getNodeInventoryForAllRigs(db).get(rig.id)).toEqual(single);
    const byLogical = new Map(single.map((e) => [e.logicalId, e]));

    const matchEntry = byLogical.get("dev.wrap-match")!;
    const matchDetail = getNodeDetail(db, rig.id, "dev.wrap-match")!;
    const expectedMatchCmd = `codex -s read-only -a on-request ${UPDATE_OFF} resume 'tok-wrap-match'`;
    expect(matchEntry.resumeCommand).toBe(expectedMatchCmd);
    expect(matchEntry.resumeCommandLabel).toBe(expectedOmission);
    expect(matchDetail.resumeCommand).toBe(expectedMatchCmd);
    expect(matchDetail.resumeCommandLabel).toBe(expectedOmission);
    expect(matchDetail.recoveryGuidance?.commands[0]).toBe(expectedMatchCmd);
    expect(matchDetail.recoveryGuidance?.notes).toContain(expectedOmission);

    const uncertainEntry = byLogical.get("dev.wrap-uncertain")!;
    const uncertainDetail = getNodeDetail(db, rig.id, "dev.wrap-uncertain")!;
    const expectedUncertainWrapped =
      `launched with -s workspace-write (approval unrecorded); a resume now uses -s workspace-write; ${expectedOmission}`;
    expect(uncertainEntry.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-wrap-uncertain'`);
    expect(uncertainEntry.resumeCommandLabel).toBe(expectedUncertainWrapped);
    expect(uncertainDetail.resumeCommandLabel).toBe(expectedUncertainWrapped);
    expect(uncertainDetail.recoveryGuidance?.notes).toContain(expectedUncertainWrapped);

    const tokenlessEntry = byLogical.get("dev.wrap-tokenless")!;
    const tokenlessDetail = getNodeDetail(db, rig.id, "dev.wrap-tokenless")!;
    expect(tokenlessEntry.resumeCommand).toBeNull();
    expect(tokenlessEntry.resumeCommandLabel).toBeNull();
    expect(tokenlessDetail.recoveryGuidance?.commands).toEqual([
      "cd /work/wrap-tokenless",
      `codex -s workspace-write ${UPDATE_OFF} resume --last`,
    ]);
    expect(tokenlessDetail.recoveryGuidance?.notes).toContain(`flags from current settings; ${expectedOmission}`);

    const refusedEntry = byLogical.get("dev.wrap-refused")!;
    const refusedDetail = getNodeDetail(db, rig.id, "dev.wrap-refused")!;
    expect(refusedEntry.resumeCommand).toBeNull();
    expect(refusedEntry.resumeCommandLabel).toContain("Permission selection:");
    expect(refusedEntry.resumeCommandLabel).not.toContain(expectedOmission);
    expect(refusedDetail.recoveryGuidance?.commands).toEqual([]);
    expect(refusedDetail.recoveryGuidance?.notes[0]).toContain("Permission selection:");
    expect(refusedDetail.recoveryGuidance?.notes.some((n) => n.includes(expectedOmission))).toBe(false);
  });

  it("M4: reads each distinct custom-policy resolvedTarget at most once per inventory build while keeping per-seat fallback postures honest and avoiding persistent cross-call cache", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-3043-m4-policy-cache-"));
    const origStatSync = fs.statSync.bind(fs);
    const origReadFileSync = fs.readFileSync.bind(fs);
    try {
      const policiesDir = path.join(tmpDir, "policies");
      fs.mkdirSync(policiesDir, { recursive: true });
      const sharedNodePath = path.join(policiesDir, "shared-node.policy.md");
      const sharedRigPath = path.join(policiesDir, "shared-rig.policy.md");
      const modeOnlyPath = path.join(policiesDir, "mode-only.policy.md");

      fs.writeFileSync(sharedNodePath, makeValidFlagPolicy("full_bypass"), "utf8");
      fs.writeFileSync(sharedRigPath, makeValidFlagPolicy("floor"), "utf8");
      fs.writeFileSync(modeOnlyPath, makeValidFlagPolicy("floor"), "utf8");

      const rigA = rigRepo.createRig("m4-cache-rig-a");
      db.prepare(
        "UPDATE rigs SET permission_policy = 'policies/shared-rig.policy.md', rig_policy_origin = 'custom', rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = 'full_bypass' WHERE id = ?",
      ).run(sharedRigPath, tmpDir, rigA.id);

      const sharedA = rigRepo.addNode(rigA.id, "dev.shared-a", { runtime: "codex", cwd: "/work/m4-a" });
      rigRepo.setNodePermissionPolicy(sharedA.id, "policies/shared-node.policy.md");
      rigRepo.setNodePolicyProvenance(sharedA.id, {
        origin: "custom",
        resolvedTarget: sharedNodePath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      registry.updateResumeToken(registry.registerSession(sharedA.id, "dev-shared-a@m4").id, "codex_id", "tok-m4-a", "hook");

      const sharedB = rigRepo.addNode(rigA.id, "dev.shared-b", { runtime: "codex", cwd: "/work/m4-b" });
      rigRepo.setNodePermissionPolicy(sharedB.id, "policies/shared-node.policy.md");
      rigRepo.setNodePolicyProvenance(sharedB.id, {
        origin: "custom",
        resolvedTarget: sharedNodePath,
        declaringDir: tmpDir,
        launchPosture: "full_bypass",
      });
      registry.updateResumeToken(registry.registerSession(sharedB.id, "dev-shared-b@m4").id, "codex_id", "tok-m4-b", "hook");

      const rigInherit1 = rigRepo.addNode(rigA.id, "dev.rig-inh-1", { runtime: "codex", cwd: "/work/m4-r1" });
      registry.updateResumeToken(registry.registerSession(rigInherit1.id, "dev-rig-inh-1@m4").id, "codex_id", "tok-m4-r1", "hook");

      const rigInherit2 = rigRepo.addNode(rigA.id, "dev.rig-inh-2", { runtime: "codex", cwd: "/work/m4-r2" });
      registry.updateResumeToken(registry.registerSession(rigInherit2.id, "dev-rig-inh-2@m4").id, "codex_id", "tok-m4-r2", "hook");

      // Explicit permission selection overrides posture, so modeOnlyPath does not need to be read at all.
      const modeSeat = rigRepo.addNode(rigA.id, "dev.mode-override", { runtime: "codex", cwd: "/work/m4-mode" });
      rigRepo.setNodePermissionPolicy(modeSeat.id, "policies/mode-only.policy.md");
      rigRepo.setNodePolicyProvenance(modeSeat.id, {
        origin: "custom",
        resolvedTarget: modeOnlyPath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      registry.updateResumeToken(registry.registerSession(modeSeat.id, "dev-mode-override@m4").id, "codex_id", "tok-m4-mode", "hook");
      permStore.write(modeSeat.id, { runtime: "codex", mode: "full_bypass" }, "op@m4", "override");

      // Second rig sharing sharedNodePath so getNodeInventoryForAllRigs exercises cross-rig per-build caching.
      const rigB = rigRepo.createRig("m4-cache-rig-b");
      const sharedCrossRig = rigRepo.addNode(rigB.id, "dev.shared-cross", { runtime: "codex", cwd: "/work/m4-cross" });
      rigRepo.setNodePermissionPolicy(sharedCrossRig.id, "policies/shared-node.policy.md");
      rigRepo.setNodePolicyProvenance(sharedCrossRig.id, {
        origin: "custom",
        resolvedTarget: sharedNodePath,
        declaringDir: tmpDir,
        launchPosture: "floor",
      });
      registry.updateResumeToken(registry.registerSession(sharedCrossRig.id, "dev-shared-cross@m4b").id, "codex_id", "tok-m4-cross", "hook");

      const statCounts = new Map<string, number>();
      const readCounts = new Map<string, number>();
      const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
        const key = String(target);
        statCounts.set(key, (statCounts.get(key) ?? 0) + 1);
        return origStatSync(target, options as never);
      }) as typeof fs.statSync);
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
        const key = String(target);
        readCounts.set(key, (readCounts.get(key) ?? 0) + 1);
        return origReadFileSync(target, options as never);
      }) as typeof fs.readFileSync);

      try {
        // 1. Single-rig inventory build reads each distinct target once across multiple seats and skips modeOnlyPath.
        const invA = new Map(getNodeInventory(db, rigA.id).map((e) => [e.logicalId, e]));
        expect(readCounts.get(sharedNodePath)).toBe(1);
        expect(statCounts.get(sharedNodePath)).toBe(1);
        expect(readCounts.get(sharedRigPath)).toBe(1);
        expect(statCounts.get(sharedRigPath)).toBe(1);
        expect(readCounts.get(modeOnlyPath) ?? 0).toBe(0);
        expect(statCounts.get(modeOnlyPath) ?? 0).toBe(0);
        expect(invA.get("dev.shared-a")?.resumeCommand).toBe(`codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-m4-a'`);
        expect(invA.get("dev.shared-b")?.resumeCommand).toBe(`codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-m4-b'`);
        expect(invA.get("dev.rig-inh-1")?.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-m4-r1'`);
        expect(invA.get("dev.rig-inh-2")?.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-m4-r2'`);
        expect(invA.get("dev.mode-override")?.resumeCommand).toBe(`codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-m4-mode'`);

        // 2. All-rigs inventory build reads sharedNodePath ONCE across rigA + rigB.
        statCounts.clear();
        readCounts.clear();
        const allInv = getNodeInventoryForAllRigs(db);
        expect(readCounts.get(sharedNodePath)).toBe(1);
        expect(statCounts.get(sharedNodePath)).toBe(1);
        expect(readCounts.get(sharedRigPath)).toBe(1);
        expect(allInv.get(rigB.id)?.[0]?.resumeCommand).toBe(`codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-m4-cross'`);

        // 3. No persistent cross-call cache: editing sharedNodePath on disk is observed on the next build, still in 1 read.
        fs.writeFileSync(sharedNodePath, makeValidFlagPolicy("floor"), "utf8");
        statCounts.clear();
        readCounts.clear();
        const invAfterEdit = new Map(getNodeInventory(db, rigA.id).map((e) => [e.logicalId, e]));
        expect(readCounts.get(sharedNodePath)).toBe(1);
        expect(invAfterEdit.get("dev.shared-a")?.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-m4-a'`);
        expect(invAfterEdit.get("dev.shared-b")?.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-m4-b'`);

        // 4. Unreadable shared target: probed ONCE per build, and each seat falls back to its OWN persisted posture.
        fs.unlinkSync(sharedNodePath);
        statCounts.clear();
        readCounts.clear();
        const invAfterUnlink = new Map(getNodeInventory(db, rigA.id).map((e) => [e.logicalId, e]));
        expect(statCounts.get(sharedNodePath)).toBe(1);
        expect(readCounts.get(sharedNodePath) ?? 0).toBe(0);
        expect(invAfterUnlink.get("dev.shared-a")?.resumeCommand).toBe(`codex -s workspace-write ${UPDATE_OFF} resume 'tok-m4-a'`);
        expect(invAfterUnlink.get("dev.shared-b")?.resumeCommand).toBe(
          `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-m4-b'`,
        );
      } finally {
        readSpy.mockRestore();
        statSpy.mockRestore();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
