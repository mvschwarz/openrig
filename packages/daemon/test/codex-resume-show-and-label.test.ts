import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
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

  it("covers all three label cases across sandbox and approval combinations in buildCodexResumeDisplay / buildNativeResumeDisplay", () => {
    // 1. Recorded match: floor, full_bypass, and all three approval values (never, on-request, untrusted).
    expect(
      buildCodexResumeDisplay("tok-1", {
        resolvedPosture: "floor",
        recordedLaunch: observeCodexSandbox("-s workspace-write"),
      }),
    ).toMatchObject({ status: "recorded_match", label: null });

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
});
