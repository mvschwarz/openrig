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

describe("Issue #2989 — native-resume-probe Codex show-and-label builder", () => {
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

  it("matches real CodexResumeAdapter flags across floor, full_bypass+nonInterruptive, kernel default, and member envelopes while ignoring ambient OPENRIG_YOLO", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");

    const teamRig = rigRepo.createRig("team-rig");
    db.prepare("UPDATE rigs SET non_interruptive = 1 WHERE id = ?").run(teamRig.id);

    const floorNode = rigRepo.addNode(teamRig.id, "dev.floor", { runtime: "codex", cwd: "/work/floor" });
    const sFloor = registry.registerSession(floorNode.id, "dev-floor@team-rig");
    registry.updateResumeToken(sFloor.id, "codex_id", "tok-floor", "hook");

    const bypassNode = rigRepo.addNode(teamRig.id, "dev.bypass", { runtime: "codex", cwd: "/work/bypass" });
    const sBypass = registry.registerSession(bypassNode.id, "dev-bypass@team-rig");
    registry.updateResumeToken(sBypass.id, "codex_id", "tok-bypass", "hook");
    permStore.write(bypassNode.id, { runtime: "codex", mode: "full_bypass" }, "op@team-rig", "Bypass");

    const envNode = rigRepo.addNode(teamRig.id, "dev.env", {
      runtime: "codex",
      cwd: "/work/env",
      codexConfigProfile: "lease-prof",
      codexPermissions: readOnlyOnRequestEnvelope,
    });
    const sEnv = registry.registerSession(envNode.id, "dev-env@team-rig");
    registry.updateResumeToken(sEnv.id, "codex_id", "tok-env", "hook");
    observations.recordGeneration(registry.currentOccupantTenure(envNode.id)!.generationUuid, {
      ...observeCodexEnvelope(codexMemberEnvelope(readOnlyOnRequestEnvelope)),
      daemonOptOut: true,
    });

    const kernelRig = rigRepo.createRig("kernel");
    const kernelNode = rigRepo.addNode(kernelRig.id, "ops.root", { runtime: "codex", cwd: "/work/root" });
    const sKernel = registry.registerSession(kernelNode.id, "ops-root@demo-rig");
    registry.updateResumeToken(sKernel.id, "codex_id", "tok-root", "hook");

    // Compare each seat's displayed resumeCommand against a real CodexResumeAdapter dispatch (stripping only the
    // launch-time allow_login_shell override that CodexResumeAdapter appends on live pane dispatch).
    const runRealResume = async (
      token: string,
      opts: {
        profile?: string | null;
        posture?: "floor" | "full_bypass" | "auto";
        nonInterruptive?: boolean;
        kernelAuthority?: boolean;
        teamPermissionDefault?: boolean;
        codexPermissions?: CodexMemberPermissions;
        daemonSupported?: boolean;
      },
    ): Promise<string> => {
      const sent: string[] = [];
      const adapter = new CodexResumeAdapter(makeMockTmux(sent), {
        sleep: async () => {},
        maxWaitMs: 0,
        exec: async () => "",
        ...(opts.daemonSupported ? { detectDaemonSupport: async () => ({ kind: "supported" as const }) } : {}),
      });
      const res = await adapter.resume(
        "pane-1",
        "codex_id",
        token,
        "/work",
        opts.profile ?? null,
        opts.posture ?? "floor",
        undefined,
        undefined,
        opts.nonInterruptive,
        opts.kernelAuthority,
        opts.teamPermissionDefault,
        undefined,
        opts.codexPermissions,
      );
      expect(res.ok).toBe(true);
      return sent[0]!.replace(" -c 'allow_login_shell=false'", "");
    };

    const teamEntries = new Map(getNodeInventory(db, teamRig.id).map((e) => [e.logicalId, e]));
    expect(teamEntries.get("dev.floor")?.resumeCommand).toBe(
      await runRealResume("tok-floor", { posture: "floor", nonInterruptive: true, teamPermissionDefault: true }),
    );
    expect(teamEntries.get("dev.floor")?.resumeCommand).not.toContain("danger-full-access");

    expect(teamEntries.get("dev.bypass")?.resumeCommand).toBe(
      await runRealResume("tok-bypass", { posture: "full_bypass", nonInterruptive: true }),
    );

    expect(teamEntries.get("dev.env")?.resumeCommand).toBe(
      await runRealResume("tok-env", {
        profile: "lease-prof",
        posture: "floor",
        nonInterruptive: true,
        codexPermissions: readOnlyOnRequestEnvelope,
        daemonSupported: true,
      }),
    );

    const kernelEntry = getNodeInventory(db, kernelRig.id)[0]!;
    expect(kernelEntry.resumeCommand).toBe(
      await runRealResume("tok-root", { posture: "full_bypass", kernelAuthority: true }),
    );
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

  it("exposes exact NativePermissionStore diagnostics without fabricating a floor command when real resume rejects invalid or conflicting settings", () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    const rig = rigRepo.createRig("demo-rig");

    const corruptNode = rigRepo.addNode(rig.id, "ops.corrupt", { runtime: "codex", cwd: "/work/c" });
    const sCorrupt = registry.registerSession(corruptNode.id, "ops-corrupt@demo-rig");
    registry.updateResumeToken(sCorrupt.id, "codex_id", "tok-corrupt", "hook");
    db.prepare("UPDATE nodes SET codex_permissions_json = '{bad json' WHERE id = ?").run(corruptNode.id);

    const conflictNode = rigRepo.addNode(rig.id, "ops.conflict", {
      runtime: "codex",
      cwd: "/work/k",
      codexPermissions: workspaceEnvelope,
    });
    const sConflict = registry.registerSession(conflictNode.id, "ops-conflict@demo-rig");
    registry.updateResumeToken(sConflict.id, "codex_id", "tok-conflict", "hook");
    db.prepare(
      "INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'codex', 'full_bypass', 'op', 'conflict', datetime('now'))",
    ).run(conflictNode.id);

    const mismatchNode = rigRepo.addNode(rig.id, "ops.mismatch", { runtime: "codex", cwd: "/work/m" });
    const sMismatch = registry.registerSession(mismatchNode.id, "ops-mismatch@demo-rig");
    registry.updateResumeToken(sMismatch.id, "codex_id", "tok-mismatch", "hook");
    db.prepare(
      "INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'claude-code', 'acceptEdits', 'op', 'old-runtime', datetime('now'))",
    ).run(mismatchNode.id);

    const claudeNode = rigRepo.addNode(rig.id, "ops.claude", { runtime: "claude-code", cwd: "/work/cl" });
    const sClaude = registry.registerSession(claudeNode.id, "ops-claude@demo-rig");
    registry.updateResumeToken(sClaude.id, "claude_id", "tok-claude", "hook");

    const single = getNodeInventory(db, rig.id);
    const bySet = getNodeInventoryForRigs(db, new Set([rig.id])).get(rig.id);
    const byAll = getNodeInventoryForAllRigs(db).get(rig.id);

    expect(bySet).toEqual(single);
    expect(byAll).toEqual(single);

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

      const entry = single.find((e) => e.logicalId === logicalId)!;
      expect(entry.resumeCommand).toBeNull();
      expect(entry.resumeCommandLabel).toBe(realRefusal);

      const detail = getNodeDetail(db, rig.id, logicalId)!;
      expect(detail.resumeCommand).toBeNull();
      expect(detail.resumeCommandLabel).toBe(realRefusal);
      expect(detail.recoveryGuidance?.commands).toEqual([]);
      expect(detail.recoveryGuidance?.notes).toEqual([realRefusal]);
    }

    const claudeEntry = single.find((e) => e.logicalId === "ops.claude")!;
    expect(claudeEntry.resumeCommandLabel).toBeNull();
  });

  it("QA-001 & QA-002: resolves display posture through real RestoreOrchestrator rules (legacy policy-without-provenance floor, node-over-rig provenance precedence, and kernel legacy policy suppression)", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");

    const restoreOrchestrator = new RestoreOrchestrator({
      db,
      rigRepo,
      sessionRegistry: registry,
      eventBus: new EventBus(db),
      snapshotRepo: { db },
      checkpointStore: { db },
      snapshotCapture: { db },
      nodeLauncher: { db },
    } as unknown as RestoreOrchestratorDeps);

    const runRealRestoreResolvedResume = async (nodeId: string, rigId: string, token: string): Promise<string> => {
      const resolvedPosture = restoreOrchestrator.resolveRestorePosture(nodeId, rigId);
      const override = permStore.launchOverride(nodeId, "codex");
      const effectivePosture = override.launchPosture ?? resolvedPosture;
      const nonInterruptive = rigRepo.getRigNonInterruptive(rigId);
      const profileRow = db
        .prepare("SELECT codex_config_profile FROM nodes WHERE id = ?")
        .get(nodeId) as { codex_config_profile: string | null } | undefined;
      const sent: string[] = [];
      const adapter = new CodexResumeAdapter(makeMockTmux(sent), {
        sleep: async () => {},
        maxWaitMs: 0,
        exec: async () => "",
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
        nonInterruptive,
        override.kernelAuthority === true,
        override.teamPermissionDefault === true,
        undefined,
        override.codexPermissions,
      );
      expect(res.ok).toBe(true);
      return sent[0]!.replace(" -c 'allow_login_shell=false'", "");
    };

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
      await runRealRestoreResolvedResume(legacyNode.id, legacyNodeRig.id, "tok-legacy-node"),
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
      await runRealRestoreResolvedResume(legacyRigNode.id, legacyRig.id, "tok-legacy-rig"),
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
      await runRealRestoreResolvedResume(floorOverYolo.id, precRig.id, "tok-locked"),
    );
    expect(precEntries.get("dev.inherit")?.resumeCommand).toBe(
      `codex -s danger-full-access -a never ${UPDATE_OFF} ${HIDE_NOTICES} resume 'tok-inherit'`,
    );
    expect(precEntries.get("dev.inherit")?.resumeCommand).toBe(
      await runRealRestoreResolvedResume(inheritRigYolo.id, precRig.id, "tok-inherit"),
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
      await runRealRestoreResolvedResume(kernelLegacyNode.id, kernelLegacyRig.id, "tok-kl"),
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

      const makeValidFlagPolicy = (posture: "floor" | "full_bypass"): string =>
        [
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

      const restoreOrchestrator = new RestoreOrchestrator({
        db,
        rigRepo,
        sessionRegistry: registry,
        eventBus: new EventBus(db),
        snapshotRepo: { db },
        checkpointStore: { db },
        snapshotCapture: { db },
        nodeLauncher: { db },
      } as unknown as RestoreOrchestratorDeps);

      const runRealRestoreResolvedResume = async (nodeId: string, rigId: string, token: string): Promise<string> => {
        const resolvedPosture = restoreOrchestrator.resolveRestorePosture(nodeId, rigId);
        const override = permStore.launchOverride(nodeId, "codex");
        const effectivePosture = override.launchPosture ?? resolvedPosture;
        const sent: string[] = [];
        const adapter = new CodexResumeAdapter(makeMockTmux(sent), {
          sleep: async () => {},
          maxWaitMs: 0,
          exec: async () => "",
        });
        const res = await adapter.resume(
          "pane-1",
          "codex_id",
          token,
          "/work",
          null,
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
      };

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
        await runRealRestoreResolvedResume(nodeCustom.id, rig.id, "tok-node-custom"),
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
        await runRealRestoreResolvedResume(rigCustomNode.id, rig.id, "tok-rig-custom"),
      );

      // Step B: Malformed custom policy file on disk retains persisted posture (full_bypass on rigCustomNode).
      fs.writeFileSync(rigPolicyPath, "---\nsource: custom\nsurface: flag\n---\ninvalid missing fields\n", "utf8");
      entries = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e]));
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-rig-custom'`,
      );
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(rigCustomNode.id, rig.id, "tok-rig-custom"),
      );

      // Step C: Deleted/unreadable custom policy file retains persisted posture (full_bypass on rigCustomNode, floor on nodeCustom).
      fs.unlinkSync(rigPolicyPath);
      fs.unlinkSync(nodePolicyPath);
      entries = new Map(getNodeInventory(db, rig.id).map((e) => [e.logicalId, e]));
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        `codex -s danger-full-access -a never ${UPDATE_OFF} resume 'tok-rig-custom'`,
      );
      expect(entries.get("dev.rigcustom")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(rigCustomNode.id, rig.id, "tok-rig-custom"),
      );
      expect(entries.get("dev.nodecustom")?.resumeCommand).toBe(
        `codex -s workspace-write ${UPDATE_OFF} resume 'tok-node-custom'`,
      );
      expect(entries.get("dev.nodecustom")?.resumeCommand).toBe(
        await runRealRestoreResolvedResume(nodeCustom.id, rig.id, "tok-node-custom"),
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
});
