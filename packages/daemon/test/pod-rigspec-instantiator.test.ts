import { createHash } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { reconcileSkillLoadout } from "../src/domain/skill-catalog.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ContinuityPolicyMaterializer } from "../src/domain/continuity-policy-materializer.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { parseWatchdogSpec } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { reconcileSeatPoolNode } from "../src/domain/seat-pool-registration.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { stringify as stringifyYaml } from "yaml";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";
import { seatSkillPaths } from "../src/domain/seat-skill-storage.js";
import { seatLaunchAdditions } from "../src/domain/seat-launch-additions.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: "/project", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 4242),
    getPaneCommand: vi.fn(async () => "claude"),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockAdapter(runtime = "claude-code"): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

const RIG_ROOT = "/project/rigs/my-rig";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function makeRigSpec(overrides?: Partial<RigSpec>): RigSpec {
  return {
    version: "0.2", name: "test-rig",
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
    edges: [],
    ...overrides,
  };
}

describe("PodRigInstantiator", () => {
  function setup(
    fsFiles?: Record<string, string>,
    extraAdapters?: Record<string, RuntimeAdapter>,
    topologyRootResolver?: () => string,
    onboardingEnabledResolver?: () => boolean,
    continuityPolicyMaterializer?: Pick<ContinuityPolicyMaterializer, "arm">,
    extraDeps?: Record<string, unknown>,
    launcherDeps?: Record<string, unknown>,
  ) {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, ...(launcherDeps ?? {}) });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => {},
      listProcesses: async () => [{ pid: 4242, ppid: 1, pgid: 4242, tpgid: 4242, executableName: "codex",
        command: "codex", argv: ["codex"], startedAt: "Sat Jan  1 12:00:00 2000" }] });
    const adapter = mockAdapter();
    const codexAdapter = mockAdapter("codex");
    const files = fsFiles ?? { [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") };
    const fsOps = mockFs(files);

    const instDeps: any = {
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal"), ...(extraAdapters ?? {}) },
      tmuxAdapter: tmux,
      ...(topologyRootResolver ? { topologyRootResolver } : {}),
      ...(onboardingEnabledResolver ? { onboardingEnabledResolver } : {}),
      ...(continuityPolicyMaterializer ? { continuityPolicyMaterializer } : {}),
      ...(extraDeps ?? {}),
    };
    const inst = new PodRigInstantiator(instDeps);

    return { db, rigRepo, podRepo, sessionRegistry, eventBus, inst, adapter, codexAdapter, tmux };
  }

  // #2871: a seat that asks who's on its team while `rig up` is still building it is told so; once built, the answer is today's.
  it("whoami says the team is still being built during instantiate, and answers as before once it's built", async () => {
    const files = { [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"), [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa") };
    const { db, rigRepo, sessionRegistry, inst } = setup(files);
    const whoami = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore: new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true }) });
    const spec = makeRigSpec({ pods: [{ id: "dev", label: "Dev", members: [
      { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
      { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
    ], edges: [{ from: "impl", to: "qa", kind: "delegates_to" }] }] });
    const early: Array<ReturnType<WhoamiService["resolve"]>> = [];
    let firstNode: string | undefined;
    const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT, { recordCreated: (_rigId, nodeId) => {
      if (!nodeId) return;
      firstNode ??= nodeId;
      early.push(whoami.resolve({ nodeId: firstNode }));
    } });
    expect(result.ok).toBe(true);
    // Mid-launch: the first seat sees only what exists so far, and is told the team isn't complete.
    expect(early[0]).toMatchObject({ rosterState: "building", peers: [], edges: { outgoing: [], incoming: [] } });
    expect(early[0]!.peersNote).toMatch(/^rosterState = building: `rig up` is still creating this team's seats and edges/);
    // Built: the full roster and edges, with no building state and today's note.
    const done = whoami.resolve({ nodeId: firstNode! });
    expect(done).not.toHaveProperty("rosterState");
    expect(done.peersNote).toBe("peers = this rig's roster excluding self (no edge filter); edges = directional relationships; use `rig ps --nodes` for node inventory including self + live state");
    expect(done.peers.map((peer) => peer.logicalId)).toEqual(["dev.qa"]);
    expect(done.edges.outgoing).toMatchObject([{ kind: "delegates_to", to: { logicalId: "dev.qa" } }]);
  });

  it("notifies started agents only after the complete roster is visible", async () => {
    const files = { [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"), [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa") };
    let observed: unknown;
    const notice = vi.fn(async (rigId: string, sessions: string[]) => {
      const first = rigRepo.getRig(rigId)!.nodes.find(node => node.logicalId === "dev.impl")!;
      observed = whoami.resolve({ nodeId: first.id });
      expect(sessions).toHaveLength(2);
      return [];
    });
    const { db, rigRepo, sessionRegistry, inst } = setup(files, undefined, undefined, undefined, undefined, { rosterReadyNotice: notice });
    const whoami = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore: new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true }) });
    const spec = makeRigSpec({ pods: [{ id: "dev", label: "Dev", members: [
      { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
      { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
    ], edges: [{ from: "impl", to: "qa", kind: "delegates_to" }] }] });
    try {
      const outcome = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(notice).toHaveBeenCalledOnce();
      expect(observed).not.toHaveProperty("rosterState");
      expect(observed).toMatchObject({ edges: { outgoing: [{ kind: "delegates_to", to: { logicalId: "dev.qa" } }] } });
    } finally { db.close(); }
  });

  it("does not report a complete roster when an edge could not be recorded", async () => {
    const notice = vi.fn(async () => []);
    const files = { [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"), [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa") };
    const { db, rigRepo, inst } = setup(files, undefined, undefined, undefined, undefined, { rosterReadyNotice: notice });
    vi.spyOn(rigRepo, "addEdge").mockImplementation(() => { throw new Error("write failed"); });
    const spec = makeRigSpec();
    spec.pods[0]!.members.push({ id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." });
    spec.pods[0]!.edges = [{ from: "impl", to: "qa", kind: "delegates_to" }];
    try {
      const outcome = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (outcome.ok) expect(outcome.result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("dev.impl -> dev.qa (delegates_to) could not be recorded")]));
      expect(notice).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it.each(["lookup", "callback"])("keeps a successful launch when roster notification %s fails", async failure => {
    const notice = vi.fn(async () => {
      if (failure === "callback") throw new Error("notice callback failed");
      return [];
    });
    const adapter = mockAdapter();
    adapter.launchHarness = vi.fn(async () => ({ ok: true, warnings: ["prior launch warning"] }));
    const { db, rigRepo, eventBus, inst, tmux } = setup(undefined, { "claude-code": adapter }, undefined, undefined, undefined, { rosterReadyNotice: notice });
    try {
      if (failure === "lookup") {
        const emit = eventBus.emit.bind(eventBus);
        vi.spyOn(eventBus, "emit").mockImplementation(event => {
          const result = emit(event);
          if (event.type === "rig.imported") vi.spyOn(rigRepo, "getRig").mockImplementation(() => { throw new Error("roster lookup failed"); });
          return result;
        });
      }
      const outcome = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.nodes[0]?.status).toBe("launched");
      expect(outcome.result.warnings).toEqual(expect.arrayContaining([expect.stringContaining(failure === "lookup" ? "roster lookup failed" : "notice callback failed")]));
      expect(outcome.result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("prior launch warning")]));
      expect(tmux.killSession).not.toHaveBeenCalled();
      if (failure === "lookup") expect(notice).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); db.close(); }
  });

  it("does not send roster notices for a failed build", async () => {
    const notice = vi.fn(async () => []);
    const { db, inst } = setup({}, undefined, undefined, undefined, undefined, { rosterReadyNotice: notice });
    try {
      expect((await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT)).ok).toBe(false);
      expect(notice).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it.each(["pi", "omp", "claude-code", "codex", "stub"])("limits Core-observed pane forwarding to grant-owning runtimes: %s", async runtime => {
    const adapter = mockAdapter(runtime);
    const { db, inst, tmux, sessionRegistry } = setup(undefined, { [runtime]: adapter });
    try {
      vi.mocked(tmux.listPanes).mockResolvedValue([{ id: "%47" } as Awaited<ReturnType<TmuxAdapter["listPanes"]>>[number]]);
      const spec = makeRigSpec(); spec.pods[0]!.members[0]!.runtime = runtime;
      const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
      expect(result.ok).toBe(true);
      const binding = vi.mocked(adapter.launchHarness!).mock.calls[0]?.[0];
      expect(binding).toBeDefined();
      expect(binding!.tmuxPane).toBe(runtime === "pi" || runtime === "omp" ? "%47" : null);
      expect(sessionRegistry.getBindingForNode(binding!.nodeId)?.tmuxPane).toBe("%47");
    } finally { db.close(); }
  });

  it.each(["pi", "omp"])("does not invent an unresolved launch pane for grant-owning %s", async runtime => {
    const adapter = mockAdapter(runtime);
    const { db, inst, tmux } = setup(undefined, { [runtime]: adapter });
    vi.mocked(tmux.listPanes).mockResolvedValue([]);
    try {
      const spec = makeRigSpec(); spec.pods[0]!.members[0]!.runtime = runtime;
      expect((await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT)).ok).toBe(true);
      expect(vi.mocked(adapter.launchHarness!).mock.calls[0]?.[0].tmuxPane).toBeNull();
    } finally { db.close(); }
  });

  // T1: valid rig instantiates pods + nodes + edges
  it("instantiates pods + nodes correctly", async () => {
    const { db, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.rigId).toBeDefined();
      expect(result.result.nodes).toHaveLength(1);
    }
    db.close();
  });

  it.each(["rig", "pod"])("imports and exports a %s-level deferred escalation before its destination rig exists", async level => {
    const { db, rigRepo, sessionRegistry, inst } = setup();
    try {
      const expected = [{ from: "dev.impl", to: "review-advisor@coord", kind: "escalates_to" }];
      const spec = makeRigSpec({ edges: level === "rig" ? expected : [] });
      if (level === "pod") spec.pods[0]!.edges = [{ from: "impl", to: "review-advisor@coord", kind: "escalates_to" }];
      const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const rig = rigRepo.getRig(result.result.rigId)!;
      expect(rig.edges).toHaveLength(1);
      expect(rig.edges[0]).toMatchObject({ targetRef: "review-advisor@coord", kind: "escalates_to" });
      const { RigSpecExporter } = await import("../src/domain/rigspec-exporter.js");
      const exported = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo: new PodRepository(db) }).exportRig(result.result.rigId) as RigSpec;
      expect(exported.edges).toEqual(expected);
      expect(RigSpecCodec.parse(RigSpecCodec.serialize(exported)).edges).toEqual(expected);
    } finally { db.close(); }
  });

  it("#1631 bootstrap instantiate retains the member-only startup root for export", async () => {
    const { db, rigRepo, sessionRegistry, inst } = setup({ [nodePath.resolve(RIG_ROOT, "agents/impl/agent.yaml")]: agentYaml("impl") });
    try {
      const spec = makeRigSpec();
      spec.pods[0]!.members[0]!.startup = { files: [{ path: "member.md", deliveryHint: "auto", required: false, appliesOn: ["fresh_start", "restore"] }], actions: [] };
      const result = await inst.instantiate(RigSpecCodec.serialize(spec), nodePath.resolve(RIG_ROOT));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(rigRepo.getRigStartupLayers(result.result.rigId)?.root).toBe(nodePath.resolve(RIG_ROOT));
      const { RigSpecExporter } = await import("../src/domain/rigspec-exporter.js");
      const exporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo: new PodRepository(db) });
      const exported = exporter.exportRig(result.result.rigId) as RigSpec;
      expect(exported.pods[0]!.members[0]!.startup?.files[0]?.path).toBe("member.md");
      expect(exporter.memberStartupNotCarried(result.result.rigId)).toEqual([]);
    } finally { db.close(); }
  });

  it("#1631 bootstrap instantiate preserves action-only pod startup for export", async () => {
    const root = nodePath.resolve(RIG_ROOT);
    const { db, rigRepo, sessionRegistry, inst } = setup({ [nodePath.resolve(root, "agents/impl/agent.yaml")]: agentYaml("impl") });
    try {
      const spec = makeRigSpec();
      spec.pods[0]!.startup = { files: [], actions: [{ type: "send_text", value: "orient pod", phase: "after_ready", idempotent: true, appliesOn: ["fresh_start"] }] };
      const result = await inst.instantiate(RigSpecCodec.serialize(spec), root);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const { RigSpecExporter } = await import("../src/domain/rigspec-exporter.js");
      const exporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo: new PodRepository(db) });
      const exported = exporter.exportRig(result.result.rigId) as RigSpec;
      expect(exported.pods[0]!.startup).toEqual(spec.pods[0]!.startup);
      expect(rigRepo.getRigStartupLayers(result.result.rigId)?.root).toBe(root);
    } finally { db.close(); }
  });

  // T2: resolved spec identity persisted
  it("persists resolved spec identity on node", async () => {
    const { db, rigRepo, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      const node = rig!.nodes[0]!;
      expect(node.resolvedSpecName).toBe("impl");
      expect(node.resolvedSpecVersion).toBe("1.0.0");
      expect(node.resolvedSpecHash).toBeTruthy();
    }
    db.close();
  });

  // T3: startup orchestrator called
  it("calls startup orchestrator with adapter", async () => {
    const { db, inst, adapter } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    expect(adapter.project).toHaveBeenCalled();
    expect(adapter.checkReady).toHaveBeenCalled();
    db.close();
  });

  it("launches members in one project with their own recorded Claude rules", async () => {
    const { db, inst, adapter } = setup();
    try {
      const spec = makeRigSpec();
      const member = spec.pods[0]!.members[0]!;
      spec.pods[0]!.members = [
        { ...member, id: "reader", claudePermissions: { allow: ["Read"], deny: ["Write"] } },
        { ...member, id: "writer", claudePermissions: { allow: ["Write"], deny: ["Read(./private/**)"] } },
      ];
      const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const calls = vi.mocked(adapter.launchHarness!).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![0].cwd).toBe(calls[1]![0].cwd);
      for (let i = 0; i < 2; i++) expect(calls[i]![0]).toMatchObject({
        claudePermissions: spec.pods[0]!.members[i]!.claudePermissions, teamPermissionDefault: true,
      });
    } finally { db.close(); }
  });

  // Slice 51-01 stub-runtime — TEST-ONLY RED (undisputed mechanical FACT 2): the NORMAL-SEAT
  // preflight→materialize→instantiate path DISPATCHES to the runtime: stub adapter that is injected into
  // the instantiator — proven by the injected adapter's REAL lifecycle methods being invoked. RED now
  // because instantiate() runs rigPreflight first (rigspec-instantiator.ts:1039) and SUPPORTED_RUNTIMES
  // rejects "stub" (same source gate as FACT1), so dispatch never happens. This is NOT a production-
  // registry proof — the startup.ts :710/:898 registration is a SEPARATE first-production RED in the
  // revised packet (composition via createDaemon/assembled instantiator + real restore/successor path);
  // this test must not be read as satisfying that requirement by direct injection. NO disputed surface.
  it("FACT2: normal-seat instantiate DISPATCHES to the injected stub adapter (real lifecycle calls) [RED until preflight accepts stub]", async () => {
    const stubAdapter = mockAdapter("stub");
    const { db, inst } = setup(undefined, { stub: stubAdapter });
    const spec = makeRigSpec({
      pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "stub", cwd: "." }], edges: [] }],
    });
    const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
    expect(result.ok, `instantiate must succeed for runtime: stub; got: ${JSON.stringify(result)}`).toBe(true);
    // dispatch proof: the injected stub adapter's REAL lifecycle methods were actually invoked.
    expect(stubAdapter.project, "instantiate must dispatch project() to the injected stub adapter").toHaveBeenCalled();
    expect(stubAdapter.checkReady, "instantiate must dispatch checkReady() to the injected stub adapter").toHaveBeenCalled();
    if (result.ok) expect(result.result.nodes).toHaveLength(1);
    db.close();
  });

  it("passes RigSpec member model into the Codex runtime binding", async () => {
    const { db, inst, codexAdapter } = setup();
    const spec = makeRigSpec({
      pods: [{
        id: "dev",
        label: "Dev",
        members: [{
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "codex",
          model: "gpt-5.5",
          cwd: ".",
        }],
        edges: [],
      }],
    });

    const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);

    expect(result.ok).toBe(true);
    const launchHarness = codexAdapter.launchHarness as ReturnType<typeof vi.fn>;
    expect(launchHarness).toHaveBeenCalled();
    expect(launchHarness.mock.calls[0]?.[0].model).toBe("gpt-5.5");
    db.close();
  });

  // A member's declared working folder that isn't there yet is created before the seat's terminal starts, so the seat
  // starts in it, as the kernel creates its own folder. A restore never creates one (restore-guidance-after-down.test.ts).
  it("creates a member's declared working folder before its terminal starts, when it isn't there yet", async () => {
    const parent = fs.mkdtempSync(nodePath.join(os.tmpdir(), "declared-folder-"));
    const project = nodePath.join(parent, "new", "project");
    const createFolder = vi.fn((dir: string) => { fs.mkdirSync(dir, { recursive: true }); });
    const { db, inst, tmux } = setup(undefined, undefined, undefined, undefined, undefined, undefined, { createFolder });
    const presentAtStart: boolean[] = [];
    vi.mocked(tmux.createSession).mockImplementation(async (_name: string, cwd?: string) => {
      presentAtStart.push(!!cwd && fs.existsSync(cwd));
      return { ok: true as const };
    });
    try {
      const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec({ pods: [{ id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: project }], edges: [] }] })), RIG_ROOT);
      expect(result.ok).toBe(true);
      expect(createFolder).toHaveBeenCalledWith(project);
      expect(presentAtStart).toEqual([true]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      db.close();
    }
  });

  it("uses cwdOverride for launched nodes without changing spec-relative agent resolution", async () => {
    const { db, rigRepo, sessionRegistry, inst, adapter } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT, { cwdOverride: "/workspace/project" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId)!;
      expect(rig.nodes[0]!.cwd).toBe("/workspace/project");
      const sessions = sessionRegistry.getSessionsForRig(result.result.rigId);
      expect(sessions[0]!.startupStatus).toBe("ready");
      const planArg = (adapter.project as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(planArg.cwd).toBe("/workspace/project");
    }
    db.close();
  });

  it("refuses to start a harness when managed skill projection fails", async () => {
    const skillReconciler = vi.fn(() => ({
      ok: false,
      applied: false,
      freshLaunchRequired: false,
      runtime: "claude-code",
      targetRoot: "/project/.claude/skills",
      manifestPath: "/project/.openrig/skill-loadouts/claude-code.json",
      receipts: [],
      removed: [],
      errors: [{ code: "target_conflict", message: "operator-owned skill differs" }],
    }));
    const { db, inst, adapter } = setup(undefined, undefined, undefined, undefined, undefined, { skillReconciler });

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);

    expect(result.ok).toBe(false);
    expect(skillReconciler).toHaveBeenCalledOnce();
    expect(adapter.project).not.toHaveBeenCalled();
    if (!result.ok && "message" in result) expect(result.message).toContain("target_conflict: operator-owned skill differs");
    db.close();
  });

  it("uses the configured catalog for both preflight and launch resolution", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-instantiator-skill-catalog-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const catalog = nodePath.join(root, "managed-skills");
      const project = nodePath.join(root, "project");
      fs.mkdirSync(nodePath.join(catalog, "topology-skill"), { recursive: true });
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(nodePath.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      fs.writeFileSync(
        nodePath.join(catalog, "topology-skill", "SKILL.md"),
        "---\nname: topology-skill\ndescription: Use when testing configured catalog launch resolution.\n---\n\n# Topology skill\n",
      );
      execFileSync("git", ["-C", catalog, "init", "-q"]);
      execFileSync("git", ["-C", catalog, "config", "user.email", "test@openrig.invalid"]);
      execFileSync("git", ["-C", catalog, "config", "user.name", "OpenRig Test"]);
      execFileSync("git", ["-C", catalog, "add", "."]);
      execFileSync("git", ["-C", catalog, "commit", "-qm", "fixture"]);

      const skillReconciler = vi.fn(() => ({
        ok: true,
        applied: false,
        freshLaunchRequired: false,
        runtime: "codex",
        targetRoot: nodePath.join(project, ".agents", "skills"),
        manifestPath: nodePath.join(project, ".openrig", "skill-loadouts", "codex.json"),
        receipts: [],
        removed: [],
        errors: [],
      }));
      const files = {
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl
version: "1.0.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [topology-skill]`,
        [`${RIG_ROOT}/agents/shared/agent.yaml`]: "name: shared\nversion: \"1.0.0\"\nresources:\n  skills: []\nprofiles: {}\n",
      };
      const setupResult = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: mockFs(files),
        skillsRootResolver: () => catalog,
        skillReconciler,
      });
      db = setupResult.db;
      const rig = makeRigSpec({
        pods: [{
          id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: project }],
          edges: [],
        }],
      });

      const result = await setupResult.inst.instantiate(RigSpecCodec.serialize(rig), RIG_ROOT);

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(skillReconciler).toHaveBeenCalledOnce();
      expect(skillReconciler.mock.calls[0]?.[0].loadout.entries.map((entry: { id: string }) => entry.id)).toContain("topology-skill");
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Every entry under a folder with its mode, and each file's bytes as a hash, sorted.
  function listTree(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        const full = nodePath.join(d, e.name);
        const mode = (fs.lstatSync(full).mode & 0o777).toString(8);
        if (e.isDirectory()) { out.push(`${r}/ ${mode}`); walk(full, r); }
        else out.push(`${r} ${mode} ${createHash("sha256").update(fs.readFileSync(full)).digest("hex").slice(0, 16)}`);
      }
    };
    walk(dir, "");
    return out.sort();
  }

  // OPR.0.7.0.13 — a Claude seat's skills go to its own storage (rig, logical seat); Codex's still go to the cwd.
  const seatSkillsRoot = (rigId: string, logicalId: string, runtime: "claude-code" | "codex" = "claude-code") =>
    seatSkillPaths({ rigId, logicalId, runtime }, process.env["OPENRIG_HOME"]).skillsRoot;

  it.each(["claude-code", "codex"] as const)("reports bundle precedence after real %s reconciliation", async (runtime) => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-bundle-precedence-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const installed = nodePath.join(root, "installed");
      const catalog = nodePath.join(root, "catalog");
      const project = nodePath.join(root, "project");
      const skill = (body: string) => `---\nname: shared\ndescription: Skill fixture\n---\n${body}\n`;
      for (const dir of ["installed/agents/impl", "installed/agents/impl/skills/shared", "catalog/shared", "project"]) fs.mkdirSync(nodePath.join(root, dir), { recursive: true });
      fs.writeFileSync(nodePath.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      fs.writeFileSync(nodePath.join(catalog, "shared/SKILL.md"), skill("Catalog"));
      fs.writeFileSync(nodePath.join(installed, "agents/impl/skills/shared/SKILL.md"), skill("Bundle"));
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nresources:\n  skills:\n    - id: shared\n      path: skills/shared\nprofiles:\n  default:\n    uses:\n      skills: [shared]\n');
      execFileSync("git", ["init", "-q", catalog]);
      execFileSync("git", ["-C", catalog, "add", "."]);
      execFileSync("git", ["-C", catalog, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "catalog"]);
      const reconciler = vi.fn(reconcileSkillLoadout);
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
        skillsRootResolver: () => catalog, skillReconciler: reconciler,
      });
      db = fixture.db;
      const rig = makeRigSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime, cwd: project },
      ] }] });
      const result = await fixture.inst.instantiate(RigSpecCodec.serialize(rig), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(reconciler).toHaveBeenCalledOnce();
      expect(reconciler.mock.results[0]?.value.ok).toBe(true);
      const owner = reconciler.mock.calls[0]![0].topologyOwner;
      expect(JSON.stringify(result)).toContain(`${owner}: skill_bundle_precedence`);
      expect(JSON.stringify(result)).toContain("the managed catalog was not changed");
      const selected = reconciler.mock.calls[0]![0].loadout.entries.find(e => e.id === "shared")!;
      expect(selected.sourceDir).toBe(nodePath.join(installed, "agents/impl/skills/shared"));
      // Both runtimes keep a seat's skills in its own storage; the project gets none of them.
      const landed = seatSkillsRoot(result.ok ? result.result.rigId : "", "dev.impl", runtime);
      expect(fs.readFileSync(nodePath.join(landed, "shared/SKILL.md"), "utf8")).toBe(skill("Bundle"));
      expect(fs.existsSync(nodePath.join(project, runtime === "codex" ? ".agents" : ".claude"))).toBe(false);
      const seatAdapter = runtime === "codex" ? fixture.codexAdapter : fixture.adapter;
      expect(vi.mocked(seatAdapter.project).mock.calls[0]![1].seatSkillsRoot).toBe(landed);
      const adapter = runtime === "codex" ? fixture.codexAdapter : fixture.adapter;
      const plan = vi.mocked(adapter.project).mock.calls[0]![0];
      expect(plan.entries.find(e => e.effectiveId === "shared")?.absolutePath).toContain("installed/agents/impl/skills/shared");
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("rig up with a linked state/seats and no Codex catalog yet: each seat gets a named refusal and the next member is still handled (OPR.0.7.0.13, round 5)", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-linked-anchor-"));
    const savedHome = process.env["OPENRIG_HOME"];
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const home = nodePath.join(root, "home");
      const moved = nodePath.join(root, "moved-seats");
      fs.mkdirSync(nodePath.join(home, "state"), { recursive: true });
      fs.mkdirSync(moved);
      fs.symlinkSync(moved, nodePath.join(home, "state", "seats"));
      process.env["OPENRIG_HOME"] = home;
      const installed = nodePath.join(root, "installed");
      const project = nodePath.join(root, "project");
      fs.mkdirSync(nodePath.join(installed, "agents/impl"), { recursive: true });
      fs.mkdirSync(project);
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nprofiles:\n  default:\n    uses: {}\n');
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
      });
      db = fixture.db;
      const rig = makeRigSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: project },
        { id: "qa", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: project },
      ] }] });
      // Nothing escapes: the rig's launch returns, with a result for each member.
      const result = await fixture.inst.instantiate(RigSpecCodec.serialize(rig), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes.map((n) => n.logicalId).sort()).toEqual(["dev.impl", "dev.qa"]);
      const text = JSON.stringify(result);
      expect(text).toContain("seat_catalog_refused");
      expect(text).toContain("is not inside this seat's storage (a link on the way)");
      expect(text).not.toContain("differs from what OpenRig last wrote");
      // Nothing was written through the link.
      expect(listTree(moved)).toEqual([]);
    } finally {
      if (savedHome === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = savedHome;
      db?.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("under a linked state/seats, a Claude member's launch additions are named and the seat starts; a missing source still fails by name (OPR.0.7.0.13)", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-linked-additions-"));
    const savedHome = process.env["OPENRIG_HOME"];
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const home = nodePath.join(root, "home");
      const moved = nodePath.join(root, "moved-seats");
      fs.mkdirSync(nodePath.join(home, "state"), { recursive: true });
      fs.mkdirSync(moved);
      fs.symlinkSync(moved, nodePath.join(home, "state", "seats"));
      process.env["OPENRIG_HOME"] = home;
      const installed = nodePath.join(root, "installed");
      const project = nodePath.join(root, "project");
      for (const dir of ["agents/impl", "claude/plugins/review"]) fs.mkdirSync(nodePath.join(installed, dir), { recursive: true });
      fs.mkdirSync(project);
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nprofiles:\n  default:\n    uses: {}\n');
      fs.writeFileSync(nodePath.join(installed, "claude/reviewer.md"), "---\nname: reviewer\n---\nReview.\n");
      fs.writeFileSync(nodePath.join(installed, "claude/house.md"), "House rules.\n");
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
      });
      db = fixture.db;
      const member = { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: project };
      const rig = makeRigSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { ...member, agentFile: "claude/reviewer.md", appendSystemPromptFile: "claude/house.md", pluginDirs: ["claude/plugins/review"] },
        { ...member, id: "qa", agentFile: "claude/missing.md" },
      ] }] } as never);
      const result = await fixture.inst.instantiate(RigSpecCodec.serialize(rig), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const impl = result.result.nodes.find((n) => n.logicalId === "dev.impl");
      expect(impl?.status).toBeDefined();
      expect(impl?.status).not.toBe("failed");
      for (const ref of ["claude/reviewer.md", "claude/house.md", "claude/plugins/review"]) {
        expect(JSON.stringify(result)).toContain(`seat_launch_addition_not_delivered: ${ref}: `);
      }
      expect(result.result.nodes.find((n) => n.logicalId === "dev.qa")).toMatchObject({ status: "failed", error: expect.stringMatching(/addition_missing: .*claude\/missing\.md/) });
      expect(listTree(moved)).toEqual([]);
      expect(listTree(project)).toEqual([]);
    } finally {
      if (savedHome === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = savedHome;
      db?.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a Claude member's agent, prompt file and plugin folder from the spec become its launch additions; a missing one fails that seat by name (OPR.0.7.0.9)", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-additions-"));
    const savedHome = process.env["OPENRIG_HOME"];
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      process.env["OPENRIG_HOME"] = nodePath.join(root, "home");
      const installed = nodePath.join(root, "installed");
      const project = nodePath.join(root, "project");
      for (const dir of ["agents/impl", "claude/plugins/review/skills/check", "claude/prompts"]) fs.mkdirSync(nodePath.join(installed, dir), { recursive: true });
      fs.mkdirSync(project);
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nprofiles:\n  default:\n    uses: {}\n');
      fs.writeFileSync(nodePath.join(installed, "claude/reviewer.md"), "---\nname: reviewer\ndescription: Reviews\n---\nReview carefully.\n");
      fs.writeFileSync(nodePath.join(installed, "claude/prompts/house.md"), "House rules.\n");
      fs.writeFileSync(nodePath.join(installed, "claude/plugins/review/skills/check/SKILL.md"), "---\nname: check\n---\nCheck.\n");
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
      });
      db = fixture.db;
      const member = { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: project };
      const rig = makeRigSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { ...member, agentFile: "claude/reviewer.md", appendSystemPromptFile: "claude/prompts/house.md", pluginDirs: ["claude/plugins/review"],
          pluginChannels: ["plugin:example-channel@example"] },
        { ...member, id: "qa", agentFile: "claude/missing.md" },
      ] }] } as never);
      const result = await fixture.inst.instantiate(RigSpecCodec.serialize(rig), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const additions = seatLaunchAdditions(seatSkillPaths({ rigId: result.result.rigId, logicalId: "dev.impl", runtime: "claude-code" }));
      expect(additions).toMatchObject({ agent: "openrig:reviewer", pluginDirs: [expect.stringContaining("review")], pluginChannels: ["plugin:example-channel@example"] });
      expect(fs.readFileSync(additions!.appendSystemPromptFile!, "utf8")).toBe("House rules.\n"); // the seat's own copy
      const qa = result.result.nodes.find((n) => n.logicalId === "dev.qa");
      expect(JSON.stringify(qa)).toMatch(/addition_missing: .*claude\/missing\.md/);
      expect(JSON.stringify(qa)).not.toContain("addition_missing: addition_missing");
    } finally {
      if (savedHome === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = savedHome;
      db?.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["a linked seat-storage ancestor starts the seat without its skills, names the loss, and writes nothing through the link or into the project", "link"],
    ["any other reconciliation error still fails the seat by name", "other"],
  ] as const)("rig up when the seat's storage is linked outside the anchor: %s (OPR.0.7.0.13 F1)", async (_title, mode) => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-linked-seat-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const installed = nodePath.join(root, "installed");
      const catalog = nodePath.join(root, "catalog");
      const project = nodePath.join(root, "project");
      const moved = nodePath.join(root, "moved-runtime");
      const skill = `---\nname: shared\ndescription: Skill fixture\n---\nCatalog\n`;
      for (const dir of ["installed/agents/impl", "catalog/shared", "project"]) fs.mkdirSync(nodePath.join(root, dir), { recursive: true });
      fs.writeFileSync(nodePath.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      fs.writeFileSync(nodePath.join(catalog, "shared/SKILL.md"), skill);
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nprofiles:\n  default:\n    uses:\n      skills: [shared]\n');
      execFileSync("git", ["init", "-q", catalog]);
      execFileSync("git", ["-C", catalog, "add", "."]);
      execFileSync("git", ["-C", catalog, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "catalog"]);
      let movedBefore: string[] = [];
      const reconciler = vi.fn((input: Parameters<typeof reconcileSkillLoadout>[0]): ReturnType<typeof reconcileSkillLoadout> => {
        if (mode === "other") return { ok: false, applied: false, freshLaunchRequired: false, runtime: input.runtime, targetRoot: "", manifestPath: "",
          receipts: [], removed: [], errors: [{ code: "skill_conflict", message: "shared differs from the catalog", path: "" }] } as never;
        if (input.location) {
          // The seat's runtime storage (made by the launch just before this) moved out, and a link left in its place.
          const runtimeRoot = nodePath.dirname(nodePath.dirname(input.location.targetRoot));
          fs.renameSync(runtimeRoot, moved);
          fs.symlinkSync(moved, runtimeRoot);
          movedBefore = listTree(moved);
        }
        return reconcileSkillLoadout(input);
      });
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
        skillsRootResolver: () => catalog, skillReconciler: reconciler,
      });
      db = fixture.db;
      const rig = makeRigSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: project },
      ] }] });
      const result = await fixture.inst.instantiate(RigSpecCodec.serialize(rig), installed);
      expect(reconciler).toHaveBeenCalled();
      const seat = result.ok ? result.result.nodes.find((n) => n.logicalId === "dev.impl") : undefined;
      if (mode === "other") {
        expect(seat?.status ?? "failed").toBe("failed"); // a rig whose only seat failed is itself refused
        expect(JSON.stringify(result)).toContain("skill_conflict: shared differs from the catalog");
        return;
      }
      expect(reconciler.mock.results[0]?.value).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "seat_storage_refused" })] });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(seat?.status).toBeDefined();
      expect(seat?.status).not.toBe("failed");
      expect(JSON.stringify(result)).toContain("seat_skills_not_delivered: shared: seat_storage_refused");
      // The moved tree is exactly as it was: no skill written, no staging folder, no manifest. Nothing fell back into the project.
      expect(listTree(moved)).toEqual(movedBefore);
      expect(listTree(project).filter((file) => file.includes("shared"))).toEqual([]);
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("projects a selected plugin's skills for claude-code into the seat's own storage, leaving the project's same-name skill alone", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-plugin-skills-seat-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const installed = nodePath.join(root, "installed");
      const plugin = nodePath.join(installed, "agents/impl/plugins/core");
      const project = nodePath.join(root, "project");
      const skill = (id: string, body: string) => `---\nname: ${id}\ndescription: Skill fixture\n---\n${body}\n`;
      fs.mkdirSync(nodePath.join(plugin, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(nodePath.join(plugin, ".claude-plugin", "plugin.json"), '{"name":"core","version":"0.1.4"}');
      for (const id of ["delegating-work", "openrig-skills", "queue-handoff"]) {
        fs.mkdirSync(nodePath.join(plugin, "skills", id), { recursive: true });
        fs.writeFileSync(nodePath.join(plugin, "skills", id, "SKILL.md"), skill(id, "Plugin"));
      }
      fs.mkdirSync(nodePath.join(project, ".claude/skills/delegating-work"), { recursive: true });
      fs.writeFileSync(nodePath.join(project, ".claude/skills/delegating-work/SKILL.md"), skill("delegating-work", "The project's own"));
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nresources:\n  plugins:\n    - id: core\n      source:\n        kind: local\n        path: plugins/core\nprofiles:\n  default:\n    uses:\n      plugins: [core]\n');
      const reconciler = vi.fn(reconcileSkillLoadout);
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
        skillsRootResolver: () => nodePath.join(root, "no-catalog"), skillReconciler: reconciler,
      });
      db = fixture.db;
      const rig = makeRigSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: project },
      ] }] });
      const result = await fixture.inst.instantiate(RigSpecCodec.serialize(rig), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(reconciler.mock.results[0]?.value.ok).toBe(true);
      const seat = seatSkillsRoot(result.ok ? result.result.rigId : "", "dev.impl");
      for (const id of ["delegating-work", "openrig-skills", "queue-handoff"]) {
        expect(fs.readFileSync(nodePath.join(seat, id, "SKILL.md"), "utf8")).toBe(skill(id, "Plugin"));
      }
      // The project's own skill is the project's: untouched, and nothing of the team's is added beside it.
      expect(fs.readFileSync(nodePath.join(project, ".claude/skills/delegating-work/SKILL.md"), "utf8")).toBe(skill("delegating-work", "The project's own"));
      expect(fs.readdirSync(nodePath.join(project, ".claude/skills"))).toEqual(["delegating-work"]);
      expect(JSON.stringify(result)).not.toContain("plugin_skill_kept");
      // The compatibility limit is named, never silent, and nothing falls back to the project.
      expect(JSON.stringify(result)).toContain("team_skills_need_claude_2.1.280");
      // Profile skills and startup skill files follow: the adapter is pointed at the same storage.
      expect(vi.mocked(fixture.adapter.project).mock.calls[0]![1].seatSkillsRoot).toBe(seat);
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["codex"] as const)("projects a selected plugin's skills for %s into the seat's own storage, leaving the project's same-name skill alone", async (runtime) => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-plugin-skills-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const installed = nodePath.join(root, "installed");
      const plugin = nodePath.join(installed, "agents/impl/plugins/core");
      const project = nodePath.join(root, "project");
      const skills = nodePath.join(project, runtime === "codex" ? ".agents" : ".claude", "skills");
      const skill = (id: string, body: string) => `---\nname: ${id}\ndescription: Skill fixture\n---\n${body}\n`;
      for (const manifest of [".claude-plugin", ".codex-plugin"]) {
        fs.mkdirSync(nodePath.join(plugin, manifest), { recursive: true });
        fs.writeFileSync(nodePath.join(plugin, manifest, "plugin.json"), '{"name":"core","version":"0.1.4"}');
      }
      for (const id of ["delegating-work", "openrig-skills", "queue-handoff"]) {
        fs.mkdirSync(nodePath.join(plugin, "skills", id), { recursive: true });
        fs.writeFileSync(nodePath.join(plugin, "skills", id, "SKILL.md"), skill(id, "Plugin"));
      }
      fs.mkdirSync(nodePath.join(skills, "delegating-work"), { recursive: true });
      fs.writeFileSync(nodePath.join(skills, "delegating-work/SKILL.md"), skill("delegating-work", "The project's own"));
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nresources:\n  plugins:\n    - id: core\n      source:\n        kind: local\n        path: plugins/core\nprofiles:\n  default:\n    uses:\n      plugins: [core]\n');
      const reconciler = vi.fn(reconcileSkillLoadout);
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
        skillsRootResolver: () => nodePath.join(root, "no-catalog"), skillReconciler: reconciler,
      });
      db = fixture.db;
      const rig = makeRigSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime, cwd: project },
      ] }] });
      const result = await fixture.inst.instantiate(RigSpecCodec.serialize(rig), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(reconciler.mock.results[0]?.value.ok).toBe(true);
      const seat = seatSkillsRoot(result.ok ? result.result.rigId : "", "dev.impl", runtime);
      for (const id of ["delegating-work", "openrig-skills", "queue-handoff"]) {
        expect(fs.readFileSync(nodePath.join(seat, id, "SKILL.md"), "utf8")).toBe(skill(id, "Plugin"));
      }
      // The project's own skill is the project's: untouched, with nothing of the team's beside it.
      expect(fs.readFileSync(nodePath.join(skills, "delegating-work/SKILL.md"), "utf8")).toBe(skill("delegating-work", "The project's own"));
      expect(fs.readdirSync(skills)).toEqual(["delegating-work"]);
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("projects a Codex seat's plugin skills to its own storage, leaving the project and its ignore file alone", async () => {
    // Before seat storage, a Codex seat's skills went into the project and its git exclusion could fail; now nothing of
    // the team's is written into the project at all.
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "instantiator-plugin-skills-codex-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const installed = nodePath.join(root, "installed");
      const plugin = nodePath.join(installed, "agents/impl/plugins/core");
      const project = nodePath.join(root, "project");
      fs.mkdirSync(nodePath.join(plugin, ".codex-plugin"), { recursive: true });
      fs.writeFileSync(nodePath.join(plugin, ".codex-plugin/plugin.json"), '{"name":"core","version":"0.1.4"}');
      fs.mkdirSync(nodePath.join(plugin, "skills/queue-handoff"), { recursive: true });
      fs.writeFileSync(nodePath.join(plugin, "skills/queue-handoff/SKILL.md"), "---\nname: queue-handoff\ndescription: Use when handing work to another seat.\n---\nPlugin\n");
      fs.writeFileSync(nodePath.join(installed, "agents/impl/agent.yaml"), 'name: impl\nversion: "1.0"\nresources:\n  plugins:\n    - id: core\n      source:\n        kind: local\n        path: plugins/core\nprofiles:\n  default:\n    uses:\n      plugins: [core]\n');
      fs.mkdirSync(nodePath.join(project, ".agents/skills"), { recursive: true });
      fs.writeFileSync(nodePath.join(project, ".agents/skills/.gitignore"), "*.tmp\n");
      execFileSync("git", ["init", "-q", project]);
      const reconciler = vi.fn(reconcileSkillLoadout);
      const fixture = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: fs.existsSync },
        skillsRootResolver: () => nodePath.join(root, "no-catalog"), skillReconciler: reconciler,
      });
      db = fixture.db;
      const rig = makeRigSpec({ pods: [{ id: "dev", label: "Dev", edges: [], members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: project },
      ] }] });
      const result = await fixture.inst.instantiate(RigSpecCodec.serialize(rig), installed);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(reconciler.mock.results.map((call) => call.value.ok)).toEqual([true]);
      const seat = seatSkillsRoot(result.ok ? result.result.rigId : "", "dev.impl", "codex");
      expect(fs.existsSync(nodePath.join(seat, "queue-handoff/SKILL.md"))).toBe(true);
      expect(fs.readdirSync(nodePath.join(project, ".agents/skills"))).toEqual([".gitignore"]);
      expect(fs.readFileSync(nodePath.join(project, ".agents/skills/.gitignore"), "utf8")).toBe("*.tmp\n");
      // C2: the seat's catalog, rebuilt after this launch's projection, lists the skill's trigger and exact path...
      const catalogPath = nodePath.join(nodePath.dirname(seat), "catalog.md");
      const catalog = fs.readFileSync(catalogPath, "utf8");
      expect(catalog).toContain("- **queue-handoff**: Use when handing work to another seat.");
      expect(catalog).toContain(nodePath.join(seat, "queue-handoff", "SKILL.md"));
      // ...and it is this seat's per-seat startup text: sent on a fresh start or a fresh-primed restore (native resume
      // replays nothing), saved with the seat's startup context, never merged into the project's AGENTS.md.
      const saved = db!.prepare("SELECT resolved_files_json FROM node_startup_context").get() as { resolved_files_json: string };
      expect(JSON.parse(saved.resolved_files_json)).toContainEqual(expect.objectContaining({
        absolutePath: catalogPath, deliveryHint: "send_text", appliesOn: ["fresh_start", "restore"],
      }));
      // R1.1: the one constant bootstrap line is saved with the seat's startup files; each start decides from the
      // person's saved answer whether to deliver it (startup-orchestrator), so nothing reached AGENTS.md here.
      expect(JSON.parse(saved.resolved_files_json)).toContainEqual(expect.objectContaining({
        path: "openrig-seat-skills.md", deliveryHint: "guidance_merge", appliesOn: ["fresh_start", "restore"] }));
      expect(fs.existsSync(nodePath.join(project, "AGENTS.md"))).toBe(false);
      // The seat's one generated router lists the skill's trigger and path, and is never in the catalog itself.
      const router = fs.readFileSync(nodePath.join(seat, "openrig-seat-router", "SKILL.md"), "utf8");
      expect(router).toContain("name: openrig-seat-router");
      expect(router).toContain("- **queue-handoff**: Use when handing work to another seat.");
      expect(catalog).not.toContain("openrig-seat-router");
    } finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("dedupes role guidance when the same file is referenced by resources.guidance and startup.files", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => {} });
    const adapter = mockAdapter();
    const fsOps = mockFs({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `
name: impl
version: "1.0.0"
resources:
  skills: []
  guidance:
    - id: role
      path: guidance/role.md
      target: claude_md
      merge: managed_block
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
profiles:
  default:
    uses:
      skills: []
      guidance: [role]
      subagents: []
      runtime_resources: []
`.trim(),
      [`${RIG_ROOT}/agents/impl/guidance/role.md`]: "# role",
    });

    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": adapter, codex: mockAdapter(), terminal: mockAdapter() },
      tmuxAdapter: tmux,
    });

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);
    const deliveredFiles = (adapter.deliverStartup as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as Array<{ path: string }>);
    expect(deliveredFiles.some((f) => f.path === "guidance/role.md")).toBe(false);
    const projectedPlan = (adapter.project as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(projectedPlan.entries.some((entry: { category: string; effectiveId: string }) => entry.category === "guidance" && entry.effectiveId === "role")).toBe(true);
    db.close();
  });

  it("injects rig identity context into launched agent startup actions", async () => {
    const { db, inst, tmux } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(true);

    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    const identityCall = sendText.mock.calls.find(([, text]) =>
      typeof text === "string" && text.includes("OpenRig session identity:"),
    );

    expect(identityCall).toBeDefined();
    expect(identityCall?.[0]).toBe("dev-impl@test-rig");
    expect(identityCall?.[1]).toMatch(/^OpenRig-generated identity context \(not a project task\):\ndev-impl@test-rig\nOpenRig session identity:/);
    // Identity fields preserved
    expect(identityCall?.[1]).toContain("- rig: test-rig");
    expect(identityCall?.[1]).toContain("- pod: dev");
    expect(identityCall?.[1]).toContain("- member: impl");
    expect(identityCall?.[1]).toContain("- logical_id: dev.impl");
    expect(identityCall?.[1]).toContain("- session: dev-impl@test-rig");
    // Whoami pointer
    expect(identityCall?.[1]).toContain("rig whoami --json");

    db.close();
  });

  it("includes openrig-start.md onboarding overlay in resolved startup files", async () => {
    const { db, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);

    // Check startup context for openrig-start.md
    const ctxRows = db.prepare("SELECT * FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    expect(ctxRows.length).toBeGreaterThan(0);
    const allFiles = ctxRows.flatMap((r) => JSON.parse(r.resolved_files_json) as Array<{ path: string }>);
    const onboarding = allFiles.find((f) => f.path === "openrig-start.md");
    expect(onboarding).toBeDefined();

    db.close();
  });

  it("delivers the two-part default onboarding pack on fresh starts", async () => {
    const { db, inst } = setup();
    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);

    const rows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const files = rows.flatMap((row) => JSON.parse(row.resolved_files_json) as Array<{
      path: string;
      required: boolean;
      appliesOn: string[];
    }>);
    expect(files.filter((file) => file.path.startsWith("openrig-onboarding-"))).toEqual([
      expect.objectContaining({
        path: "openrig-onboarding-01.md",
        required: true,
        appliesOn: ["fresh_start"],
      }),
      expect.objectContaining({
        path: "openrig-onboarding-02.md",
        required: true,
        appliesOn: ["fresh_start"],
      }),
    ]);

    db.close();
  });

  it("omits the default onboarding pack when the typed setting is off", async () => {
    const { db, inst } = setup(undefined, undefined, undefined, () => false);
    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);

    const rows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const paths = rows.flatMap((row) =>
      (JSON.parse(row.resolved_files_json) as Array<{ path: string }>).map((file) => file.path),
    );
    expect(paths).toContain("openrig-start.md");
    expect(paths.some((path) => path.startsWith("openrig-onboarding-"))).toBe(false);
    // The context-entry floor isn't part of the onboarding pack: every seat gets it, right after openrig-start.md,
    // on fresh starts and restores.
    const files = rows.flatMap((row) => JSON.parse(row.resolved_files_json) as Array<{ path: string; deliveryHint: string; appliesOn: string[] }>);
    const floors = files.filter((file) => file.path === "openrig-context-entry.md");
    expect(floors.length).toBe(rows.length);
    expect(floors[0]).toMatchObject({ deliveryHint: "guidance_merge", appliesOn: ["fresh_start", "restore"] });
    expect(paths[paths.indexOf("openrig-start.md") + 1]).toBe("openrig-context-entry.md");

    db.close();
  });

  it.each([true, false])("projects the rig override and the inherited default independently (daemon default %s)", async daemonDefault => {
    const { db, inst, adapter, rigRepo } = setup(undefined, undefined, undefined, () => daemonDefault);
    try {
      const rigs = [{ name: "overridden", override: !daemonDefault }, { name: "inherited" }];
      for (const { name, override } of rigs) {
        const spec = makeRigSpec({ name, defaultOnboardingPack: override });
        const materialized = await inst.materialize(RigSpecCodec.serialize(spec), RIG_ROOT);
        if (!materialized.ok) throw new Error(JSON.stringify(materialized));
        const { rigId } = materialized.result;
        const node = rigRepo.getRig(rigId)?.nodes[0];
        if (!node) throw new Error(`No seat materialized for ${name}`);

        vi.mocked(adapter.deliverStartup).mockClear();
        const launched = await inst.launchPersistedFresh(rigId, node.id);
        expect(launched, JSON.stringify(launched)).toMatchObject({ status: "launched" });
        const delivered = vi.mocked(adapter.deliverStartup).mock.calls.flatMap(([files]) => files.map(file => file.path));
        expect(delivered).toEqual(expect.arrayContaining(["openrig-start.md", "openrig-context-entry.md"]));
        expect(delivered.filter(file => file.startsWith("openrig-onboarding-"))).toEqual(
          (override ?? daemonDefault) ? ["openrig-onboarding-01.md", "openrig-onboarding-02.md"] : [],
        );
      }
    } finally {
      db.close();
    }
  });

  it("does not rewrite an existing rig when onboarding is enabled for future launches", async () => {
    let onboardingEnabled = false;
    const { db, inst } = setup(undefined, undefined, undefined, () => onboardingEnabled);
    const existing = await inst.instantiate(
      RigSpecCodec.serialize(makeRigSpec({ name: "existing-rig" })),
      RIG_ROOT,
    );
    expect(existing.ok).toBe(true);
    if (!existing.ok) throw new Error(existing.error);

    const existingNodeId = existing.result.nodes[0]!.id;
    const readStartup = (nodeId: string) => db.prepare(`
      SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime
        FROM node_startup_context
       WHERE node_id = ?
    `).get(nodeId) as Record<string, unknown>;
    const before = readStartup(existingNodeId);

    onboardingEnabled = true;
    const future = await inst.instantiate(
      RigSpecCodec.serialize(makeRigSpec({ name: "future-rig" })),
      RIG_ROOT,
    );
    expect(future.ok).toBe(true);
    if (!future.ok) throw new Error(future.error);

    expect(readStartup(existingNodeId)).toEqual(before);

    db.close();
  });

  it("always includes the default culture when the rig has no culture_file", async () => {
    const { db, inst } = setup();
    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);

    const ctxRows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const allFiles = ctxRows.flatMap((row) => JSON.parse(row.resolved_files_json) as Array<{
      path: string;
      deliveryHint: string;
      required: boolean;
    }>);
    expect(allFiles).toContainEqual(expect.objectContaining({
      path: "CULTURE-default.md",
      deliveryHint: "guidance_merge",
      required: true,
    }));

    db.close();
  });

  it("orders the default culture before the rig culture overlay", async () => {
    const { db, inst } = setup();
    const spec = makeRigSpec({ cultureFile: "CULTURE.md" });
    const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
    expect(result.ok).toBe(true);

    const ctxRows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const paths = ctxRows.flatMap((row) =>
      (JSON.parse(row.resolved_files_json) as Array<{ path: string }>).map((file) => file.path),
    );
    expect(paths).toContain("CULTURE-default.md");
    expect(paths).toContain("CULTURE.md");
    expect(paths.indexOf("CULTURE-default.md")).toBeLessThan(paths.indexOf("CULTURE.md"));

    db.close();
  });

  it("CULTURE-default.md ships the lightweight operating-model floor", () => {
    const { existsSync, readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const assetPath = resolve(import.meta.dirname, "../src/domain/../../assets/guidance/CULTURE-default.md");
    expect(existsSync(assetPath)).toBe(true);
    const content = readFileSync(assetPath, "utf8");
    expect(content).toContain("Pragmatic truth-seeking");
    expect(content).toContain("Principles over rules");
    expect(content).toContain("Ship good, working product");
    expect(content).toContain("Match rigor to stakes");
    expect(content).not.toContain("full stop on new production");
  });

  it("openrig-start.md asset exists on disk and guards the thin-overlay contract", () => {
    const { existsSync, readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const assetPath = resolve(import.meta.dirname, "../src/domain/../../assets/guidance/openrig-start.md");
    expect(existsSync(assetPath)).toBe(true);
    const content = readFileSync(assetPath, "utf8");
    // The thin overlay's positive guarantees: identity first, the two peer verbs,
    // the thin-transcript warning (guards a live per-runtime recording condition),
    // and an explicit ask-don't-infer close.
    expect(content).toContain("rig whoami --json");
    expect(content).toContain("rig send");
    expect(content).toContain("rig capture");
    // (wrap-safe fragments: the source is hard-wrapped markdown)
    expect(content).toContain("transcript capture is unreliable");
    expect(content).toContain("mean the session was quiet");
    expect(content).toContain("say so rather than inferring");
    // The product decision to keep the boot overlay thin, pinned as absences: no operating-model SDLC and
    // no skill-library routing may ride the default boot overlay (they are opt-in
    // layers, delivered by profile/startup config, never hardcoded here).
    expect(content).not.toContain("mission-slice-sop");
    expect(content).not.toContain("plan-lock");
    expect(content).not.toContain("openrig-user");
    expect(content).not.toContain("openrig-skills");
    expect(content).toContain("openrig-onboarding-01.md");
    expect(content).toContain("onboarding.default_pack.enabled");
    // Thin means thin: a hard ceiling so accretion back toward the 3.6KB pre-trim
    // overlay fails loudly instead of silently.
    expect(content.length).toBeLessThan(2500);
  });

  // T4: partial failure — one node startup fails, other succeeds
  it("partial node startup failure does not corrupt other nodes", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    };

    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

    // Startup orchestrator that fails for qa
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => {} });
    const origStartNode = startupOrch.startNode.bind(startupOrch);
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 2) {
        // Fail the second node's startup
        sessionRegistry.updateStartupStatus(input.sessionId, "failed");
        return { ok: false, startupStatus: "failed", errors: ["simulated failure"] };
      }
      return origStartNode(input);
    };

    const adapter = mockAdapter();
    const fsOps = mockFs(files);
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch, fsOps,
      adapters: { "claude-code": adapter },
    });

    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      const failed = result.result.nodes.filter((n) => n.status === "failed");
      expect(launched.length).toBe(1);
      expect(failed.length).toBe(1);
    }
    db.close();
  });

  // T5: same DB handle shared
  it("validates same DB handle", () => {
    const db = createFullTestDb();
    const db2 = createFullTestDb();
    const rigRepo = new RigRepository(db);
    expect(() => new PodRigInstantiator({
      db: db2, rigRepo, podRepo: new PodRepository(db2), sessionRegistry: new SessionRegistry(db2),
      eventBus: new EventBus(db2), nodeLauncher: new NodeLauncher({ db: db2, rigRepo: new RigRepository(db2), sessionRegistry: new SessionRegistry(db2), eventBus: new EventBus(db2), tmuxAdapter: mockTmux() }),
      startupOrchestrator: new StartupOrchestrator({ db: db2, sessionRegistry: new SessionRegistry(db2), eventBus: new EventBus(db2), tmuxAdapter: mockTmux() }),
      fsOps: mockFs({}), adapters: {},
    })).toThrow(/same db handle/);
    db.close();
    db2.close();
  });

  // T7: emits startup lifecycle events
  it("emits startup lifecycle events", async () => {
    const { db, eventBus, inst } = setup();
    const events: string[] = [];
    eventBus.subscribe((e) => events.push(e.type));
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    await inst.instantiate(yaml, RIG_ROOT);
    expect(events).toContain("node.startup_pending");
    expect(events).toContain("node.startup_ready");
    db.close();
  });

  // T8: pod membership persisted
  it("persists pod membership on nodes", async () => {
    const { db, rigRepo, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig!.nodes[0]!.podId).toBeTruthy();
    }
    db.close();
  });

  // CP2-R1: Two pods with same member name create distinct nodes (qualified logical_id)
  it("two pods with same member name create distinct nodes", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, rigRepo, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [
        { id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] },
        { id: "arch", label: "Arch", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] },
      ],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig!.nodes).toHaveLength(2);
      const logicalIds = rig!.nodes.map((n) => n.logicalId).sort();
      expect(logicalIds).toEqual(["arch.impl", "dev.impl"]);
    }
    db.close();
  });

  // CP2-R2: Narrowed restore-policy persisted to both node and session
  it("persists narrowed restore-policy to node and session", async () => {
    // Agent spec has checkpoint_only default, member requests resume_if_possible (broadening — should fail)
    // Instead: spec has resume_if_possible, member narrows to relaunch_fresh
    const narrowingAgent = `name: impl\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    compaction_strategy: harness_native\n    restore_policy: resume_if_possible\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
    const files = { [`${RIG_ROOT}/agents/impl/agent.yaml`]: narrowingAgent };
    const { db, rigRepo, sessionRegistry, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", restorePolicy: "relaunch_fresh" }], edges: [] }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig!.nodes[0]!.restorePolicy).toBe("relaunch_fresh");
      // Check session too
      const sessions = sessionRegistry.getSessionsForRig(result.result.rigId);
      expect(sessions[0]!.restorePolicy).toBe("relaunch_fresh");
    }
    db.close();
  });

  it("threads the three-level resolved mechanic through the real launch path into the cutover registration", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `
version: "0.2"
name: impl
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
    mechanic: default-mechanic@default-rig
resources:
  skills: []
profiles:
  default:
    lifecycle:
      mechanic: profile-mechanic@profile-rig
    uses:
      skills: []
`.trim(),
    };
    const register = vi.fn()
      .mockReturnValueOnce({ jobId: "prepare-job" })
      .mockReturnValueOnce({ jobId: "cutover-job" });
    const materializer = new ContinuityPolicyMaterializer({ register }, () => null);
    const { db, inst } = setup(files, undefined, undefined, undefined, materializer);
    const yaml = `
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        mechanic: member-mechanic@member-rig
    edges: []
edges: []
`;

    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
    const cutover = parseWatchdogSpec(register.mock.calls[1]![0].specYaml);
    expect(cutover.context).toMatchObject({
      continuity_action: { destination: "member-mechanic@member-rig" },
    });
    db.close();
  });

  it("refuses apprentice arming without a mechanic using field, layering, and SOP teaching", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `
version: "0.2"
name: impl
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`.trim(),
    };
    const register = vi.fn().mockReturnValue({ jobId: "must-not-arm" });
    const materializer = new ContinuityPolicyMaterializer({ register }, () => "/tmp/transcript.jsonl");
    const { db, inst } = setup(files, undefined, undefined, undefined, materializer);

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);

    expect(result.ok).toBe(true);
    expect(register).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toMatch(
      /mechanic.*spec-default.*profile.*member.*continuity\/apprentice-cutover\.md/i,
    );
    db.close();
  });

  it("#3579 seatContinuityPolicy reads the strategy and mechanic the spec says today, for a restore or a fresh launch of a seat that started earlier", async () => {
    const agentPath = `${RIG_ROOT}/agents/impl/agent.yaml`;
    const files: Record<string, string> = { [agentPath]: agentYaml("impl") };
    const { db, rigRepo, inst } = setup(files);
    const yaml = `
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const rigId = result.result.rigId;
    const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
    // As first started, the spec selected nothing: nothing to arm.
    expect(await inst.seatContinuityPolicy(rigId, nodeId)).toMatchObject({ ok: true, compactionStrategy: "default-compaction", runtime: "claude-code" });
    // The spec changes later (the role now selects managed-compaction): the seat's next start reads it as it is now.
    files[agentPath] = "version: \"0.2\"\nname: impl\ndefaults:\n  runtime: claude-code\n  lifecycle:\n    compaction_strategy: managed-compaction\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []";
    expect(await inst.seatContinuityPolicy(rigId, nodeId)).toMatchObject({ ok: true, compactionStrategy: "managed-compaction", runtime: "claude-code" });
    // The apprentice strategy carries its mechanic, resolved the same three-level way as a first start.
    files[agentPath] = "version: \"0.2\"\nname: impl\ndefaults:\n  runtime: claude-code\n  lifecycle:\n    compaction_strategy: apprentice-handover\n    mechanic: mech@rig\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []";
    expect(await inst.seatContinuityPolicy(rigId, nodeId)).toMatchObject({ ok: true, compactionStrategy: "apprentice-handover", mechanic: "mech@rig" });
    // A spec that can no longer be read says why (a warning for the caller); a seat with no launch recipe is silent.
    delete files[agentPath];
    expect(await inst.seatContinuityPolicy(rigId, nodeId)).toMatchObject({ ok: false });
    const bare = rigRepo.addNode(rigId, "dev.adopted", { runtime: "claude-code" });
    expect(await inst.seatContinuityPolicy(rigId, bare.id)).toEqual({ ok: false, reason: "no launch recipe or runtime", silent: true });
    db.close();
  });

  it("#3579 R2: a seat that is not Claude is not resolved against its spec: no warning for a notice it never had", async () => {
    const agentPath = `${RIG_ROOT}/agents/impl/agent.yaml`;
    const files: Record<string, string> = { [agentPath]: agentYaml("impl") };
    const { db, rigRepo, inst } = setup(files);
    const yaml = `
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: codex
        cwd: .
    edges: []
edges: []
`;
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const rigId = result.result.rigId;
    const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
    expect(await inst.seatContinuityPolicy(rigId, nodeId)).toEqual({ ok: true, compactionStrategy: "default-compaction", mechanic: undefined, runtime: "codex" });
    // Its spec can no longer be read: still no resolution and no warning (a Claude seat in the same state warns, as the test above shows).
    delete files[agentPath];
    expect(await inst.seatContinuityPolicy(rigId, nodeId)).toEqual({ ok: true, compactionStrategy: "default-compaction", mechanic: undefined, runtime: "codex" });
    db.close();
  });

  describe("a seat moved with rig seat set-runtime", () => {
    let root: string;
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    /** A seat materialized on Codex, with a model and effort its member authored for Codex, then moved to Claude as
     *  rig seat set-runtime records it: the node's runtime and the settings the move chose (none here: Claude's own
     *  defaults). Its launch recipe keeps the member as materialized. Its agent selects a plugin only Claude reads (no
     *  Codex manifest), one of whose skills holds a link: resolving the seat for Claude leaves that skill out with a
     *  warning, and resolving it for Codex never reads the plugin. */
    async function movedSeat() {
      root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "moved-seat-"));
      const put = (file: string, text: string) => { fs.mkdirSync(nodePath.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
      const plugin = nodePath.join(root, "plugins", "claude-only");
      put(nodePath.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "claude-only", version: "1.0.0" }));
      for (const id of ["review", "handoff"]) put(nodePath.join(plugin, "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: ${id}\n---\n${id}`);
      fs.symlinkSync(nodePath.join(plugin, "skills", "handoff", "SKILL.md"), nodePath.join(plugin, "skills", "review", "linked.md"));
      const rigRoot = nodePath.join(root, "rig");
      const agentPath = nodePath.join(rigRoot, "agents", "impl", "agent.yaml");
      const agentText = `name: impl\nversion: "1.0"\nresources:\n  plugins:\n    - id: claude-only\n      source: { kind: local, path: ${plugin} }\nprofiles:\n  default:\n    uses:\n      plugins: [claude-only]\n`;
      put(agentPath, agentText);
      const fixture = setup(undefined, undefined, undefined, undefined, undefined,
        { fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf8"), exists: (p: string) => fs.existsSync(p) } });
      const result = await fixture.inst.instantiate(`
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: codex
        model: gpt-6-astra
        effort: xhigh
        cwd: .
    edges: []
edges: []
`, rigRoot);
      if (!result.ok) throw new Error(JSON.stringify(result));
      const rigId = result.result.rigId;
      const nodeId = fixture.rigRepo.getRig(rigId)!.nodes[0]!.id;
      const before = await fixture.inst.seatSkillSelection(rigId, nodeId);
      fixture.db.prepare("UPDATE nodes SET runtime = 'claude-code', model = NULL, effort = NULL, advisor = NULL, codex_config_profile = NULL WHERE id = ?").run(nodeId);
      expect(fixture.rigRepo.getNodeLaunchRecipe(nodeId)!.rigSpec.pods[0]!.members[0]).toMatchObject({ runtime: "codex", model: "gpt-6-astra" });
      return { ...fixture, rigId, nodeId, before, agentPath, agentText };
    }
    /** Its session ends and a restore launches it fresh from the recipe: on Claude, never Codex. The Claude launch's binding. */
    async function launchFresh(f: Awaited<ReturnType<typeof movedSeat>>) {
      for (const session of f.sessionRegistry.getSessionsForRig(f.rigId)) f.sessionRegistry.markDetached(session.id);
      f.sessionRegistry.clearBinding(f.nodeId);
      vi.mocked(f.adapter.launchHarness).mockClear();
      vi.mocked(f.codexAdapter.launchHarness).mockClear();
      const fresh = await f.inst.launchPersistedFresh(f.rigId, f.nodeId);
      expect(fresh.status, JSON.stringify(fresh)).toBe("launched");
      expect(f.codexAdapter.launchHarness).not.toHaveBeenCalled();
      expect(f.adapter.launchHarness).toHaveBeenCalledTimes(1);
      return vi.mocked(f.adapter.launchHarness).mock.calls[0]![0];
    }
    const pluginSkipped = (out: Awaited<ReturnType<PodRigInstantiator["seatSkillSelection"]>>) =>
      out.ok && out.selection.warnings.some((w) => w.startsWith("plugin_skill_skipped: plugin claude-only"));

    it("resolves today's skill selection for its new runtime", async () => {
      const { db, inst, rigId, nodeId, before } = await movedSeat();
      expect(pluginSkipped(before), JSON.stringify(before)).toBe(false);
      const after = await inst.seatSkillSelection(rigId, nodeId);
      expect(pluginSkipped(after), JSON.stringify(after)).toBe(true);
      db.close();
    });

    it("launches fresh on its new runtime, without the old runtime's model or effort", async () => {
      const f = await movedSeat();
      const binding = await launchFresh(f);
      expect(binding.model).toBeUndefined();
      expect(binding.effort).toBeUndefined();
      expect(f.db.prepare("SELECT runtime, model, effort FROM nodes WHERE id = ?").get(f.nodeId)).toEqual({ runtime: "claude-code", model: null, effort: null });
      f.db.close();
    });

    it("launches fresh with the advisor its move stored, though the agent spec names another since", async () => {
      const f = await movedSeat();
      f.db.prepare("UPDATE nodes SET advisor = 'advisor-at-move' WHERE id = ?").run(f.nodeId);
      fs.writeFileSync(f.agentPath, `${f.agentText}defaults:\n  advisor: advisor-now\n`);
      expect((await launchFresh(f)).advisor).toBe("advisor-at-move");
      expect(f.db.prepare("SELECT advisor FROM nodes WHERE id = ?").get(f.nodeId)).toEqual({ advisor: "advisor-at-move" });
      f.db.close();
    });
  });

  it("a seat that was not moved keeps its recipe's model and effort when its node has none stored", async () => {
    const files: Record<string, string> = { [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") };
    const { db, rigRepo, sessionRegistry, inst, codexAdapter } = setup(files);
    const result = await inst.instantiate(`
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: codex
        model: gpt-6-astra
        effort: xhigh
        cwd: .
    edges: []
edges: []
`, RIG_ROOT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const rigId = result.result.rigId;
    const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
    db.prepare("UPDATE nodes SET model = NULL WHERE id = ?").run(nodeId);
    for (const session of sessionRegistry.getSessionsForRig(rigId)) sessionRegistry.markDetached(session.id);
    sessionRegistry.clearBinding(nodeId);
    vi.mocked(codexAdapter.launchHarness).mockClear();
    const fresh = await inst.launchPersistedFresh(rigId, nodeId);
    expect(fresh.status, JSON.stringify(fresh)).toBe("launched");
    expect(vi.mocked(codexAdapter.launchHarness).mock.calls[0]![0]).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
    db.close();
  });

  // CP2-R3: Topological ordering enforced (delegates_to edge)
  it("launches nodes in topological order based on edges", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/orch/agent.yaml`]: agentYaml("orch"),
    };
    const { db, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "worker", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "lead", agentRef: "local:agents/orch", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [{ kind: "delegates_to", from: "lead", to: "worker" }],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // lead should be launched before worker (delegates_to: lead -> worker means lead first)
      const leadIdx = result.result.nodes.findIndex((n) => n.logicalId === "dev.lead");
      const workerIdx = result.result.nodes.findIndex((n) => n.logicalId === "dev.worker");
      expect(leadIdx).toBeLessThan(workerIdx);
    }
    db.close();
  });

  // NS-T01: canonical session name {pod}-{member}@{rig}
  it("launches nodes with canonical session names", async () => {
    const { db, tmux, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    // tmux createSession was called with canonical name
    const createSession = tmux.createSession as ReturnType<typeof vi.fn>;
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0]![0]).toBe("dev-impl@test-rig");
    db.close();
  });

  // NS-T01: invalid session name characters caught at preflight within instantiation
  it("rejects invalid session name characters with per-component error at preflight", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, inst } = setup(files);
    const spec = makeRigSpec({
      name: "my rig",
      pods: [{
        id: "dev 1", label: "Dev",
        members: [{ id: "impl!", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "errors" in result) {
      expect(result.errors.some((e: string) => e.includes("pod name") && e.includes(" "))).toBe(true);
      expect(result.errors.some((e: string) => e.includes("member name") && e.includes("!"))).toBe(true);
      expect(result.errors.some((e: string) => e.includes("rig name") && e.includes(" "))).toBe(true);
    }
    db.close();
  });

  // NS-T03: terminal member instantiation — skips agent resolution, executes startup
  it("instantiates terminal member without agent resolution", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, tmux, rigRepo, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [
        {
          id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
          edges: [],
        },
        {
          id: "infra", label: "Infrastructure",
          members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: ".", startup: { files: [], actions: [{ type: "send_text", value: "npm run dev", phase: "after_ready", idempotent: true, appliesOn: ["fresh_start"] }] } }],
          edges: [],
        },
      ],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes).toHaveLength(2);
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      expect(launched).toHaveLength(2);
      // Terminal node was launched with canonical name
      const createSession = tmux.createSession as ReturnType<typeof vi.fn>;
      const sessionNames = createSession.mock.calls.map((c: string[]) => c[0]);
      expect(sessionNames).toContain("infra-server@test-rig");
    }
    db.close();
  });

  // NS-T03: terminal member restore_policy propagated to session
  it("terminal member propagates checkpoint_only restore_policy to session row", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{
        id: "infra", label: "Infra",
        members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Check session has checkpoint_only
      const sessions = db.prepare("SELECT restore_policy FROM sessions").all() as Array<{ restore_policy: string }>;
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]!.restore_policy).toBe("checkpoint_only");
    }
    db.close();
  });

  it("#3579 a terminal-only seat with a launch recipe reads no continuity policy, silently (builtin:terminal is not an agent spec)", async () => {
    const { db, rigRepo, inst } = setup({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") });
    const spec = makeRigSpec({ pods: [{ id: "infra", label: "Infra",
      members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." }], edges: [] }] });
    const result = await inst.materialize(RigSpecCodec.serialize(spec), RIG_ROOT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const node = rigRepo.getRig(result.result.rigId)!.nodes[0]!;
    // The control: the seat does keep a launch recipe, the shape materialize, expand and add-member all create.
    expect(rigRepo.getNodeLaunchRecipe(node.id)).not.toBeNull();
    expect(await inst.seatContinuityPolicy(result.result.rigId, node.id)).toEqual({ ok: false, reason: "a terminal seat selects no continuity strategy", silent: true });
    db.close();
  });

  // NS-T03: terminal node visible in node-inventory as infrastructure
  it("terminal-instantiated node appears in inventory with nodeKind infrastructure", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, rigRepo, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{
        id: "infra", label: "Infra",
        members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Verify via node-inventory projection
      const { getNodeInventory } = await import("../src/domain/node-inventory.js");
      const inventory = getNodeInventory(db, result.result.rigId);
      expect(inventory).toHaveLength(1);
      expect(inventory[0]!.nodeKind).toBe("infrastructure");
      expect(inventory[0]!.runtime).toBe("terminal");
    }
    db.close();
  });

  // CP2-R5: Two-node cycle must fail instantiation
  it("rejects dependency cycle between two nodes", async () => {
    const files = {
      [`${RIG_ROOT}/agents/a/agent.yaml`]: agentYaml("a"),
      [`${RIG_ROOT}/agents/b/agent.yaml`]: agentYaml("b"),
    };
    const { db, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "a", agentRef: "local:agents/a", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "b", agentRef: "local:agents/b", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [
          { kind: "delegates_to", from: "a", to: "b" },
          { kind: "delegates_to", from: "b", to: "a" },
        ],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe("cycle_error");
      expect(result.message).toMatch(/cycle/i);
    }
    db.close();
  });

  // OPR.0.3.2.22 Bug 2 — no orphan rig record on cycle_error.
  // Reorder fix: computePodLaunchOrder must run BEFORE createRig so a
  // detected cycle returns before any DB write happens. Before the fix,
  // every failed `rig up <builtin>` attempt left an orphan stopped-state
  // rig record that made retries report "ambiguous library-spec vs
  // restore-target" — the second-order UX trap behind the openrig-comms
  // hero-flow paper-cut.
  it("cycle_error: no orphan rig record persists (Bug 2 reorder)", async () => {
    const files = {
      [`${RIG_ROOT}/agents/a/agent.yaml`]: agentYaml("a"),
      [`${RIG_ROOT}/agents/b/agent.yaml`]: agentYaml("b"),
    };
    const { db, rigRepo, inst } = setup(files);
    const specName = "orphan-cycle-test-rig";
    const spec = makeRigSpec({
      name: specName,
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "a", agentRef: "local:agents/a", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "b", agentRef: "local:agents/b", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [
          { kind: "delegates_to", from: "a", to: "b" },
          { kind: "delegates_to", from: "b", to: "a" },
        ],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe("cycle_error");
    }
    // Load-bearing: no rig record persisted under the spec name.
    const orphans = rigRepo.findRigsByName(specName);
    expect(orphans, `expected no orphan rig records after cycle_error, found ${JSON.stringify(orphans)}`).toHaveLength(0);
    db.close();
  });

  // OPR.0.3.2.22 Bug 2 — rollback on service_boot_failed (prelaunch-hook
  // failure). Unlike cycle_error, the rig record + pods have been created
  // by the time the hook runs (the hook needs rigId), so the fix wraps
  // the failure return with rigRepo.deleteRig(rigId).
  it.each(["service_boot_failed", "compose_project_conflict"])("%s: propagates hook refusal and rolls back the created rig record", async (code) => {
    const { db, rigRepo, inst } = setup();
    const specName = "orphan-prelaunch-test-rig";
    const yaml = RigSpecCodec.serialize(makeRigSpec({ name: specName }));
    const result = await inst.instantiate(yaml, RIG_ROOT, {
      prelaunchHook: async () => ({ ok: false, code, message: "test: service boot refused" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe(code);
    }
    const orphans = rigRepo.findRigsByName(specName);
    expect(orphans, `expected no orphan rig records after service_boot_failed, found ${JSON.stringify(orphans)}`).toHaveLength(0);
    db.close();
  });

  it.each(["boot-failure", "node-failure", "boot-cleanup-failure", "node-cleanup-failure", "inherited", "inherited-boot-failure"].flatMap(scenario =>
    (["leave_running", "down_and_volumes"] as const).map(policy => ({ scenario, policy })),
  ))("retains or cleans up the actual service project on failed instantiation ($scenario, $policy)", async ({ scenario, policy }) => {
    const { db, rigRepo, inst, adapter, tmux } = setup();
    try {
      tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
      adapter.project = vi.fn(async () => ({ projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }] }));
      const commands: string[] = [];
      let currentId: string | undefined;
      const composeAdapter = new ComposeServicesAdapter(async cmd => {
        commands.push(cmd);
        if (cmd.includes("down")) {
          expect(rigRepo.getServicesRecord(currentId!)).not.toBeNull();
          if (scenario.includes("cleanup-failure")) throw new Error("Docker unavailable during cleanup");
        }
        if (cmd.includes("ps --format json") && (scenario.startsWith("boot-") || scenario === "inherited-boot-failure")) throw new Error("status failed after Compose up succeeded");
        return "";
      });
      const serviceOrchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter });
      const dbHandle = { db };
      const bootstrap = new BootstrapOrchestrator({ db, rigRepo, serviceOrchestrator, bootstrapRepo: dbHandle,
        runtimeVerifier: dbHandle, installExecutor: dbHandle, packageInstallService: dbHandle,
      } as ConstructorParameters<typeof BootstrapOrchestrator>[0]);
      const predecessor = scenario.startsWith("inherited") ? rigRepo.createRig("test-rig") : undefined;
      if (predecessor) rigRepo.setServicesRecord(predecessor.id, {
        kind: "compose", specJson: "{}", rigRoot: RIG_ROOT, composeFile: "compose.yaml", projectName: "legacy-project",
      });
      const yaml = RigSpecCodec.serialize(makeRigSpec({ services: {
        kind: "compose", composeFile: "compose.yaml", downPolicy: policy,
      } }));
      type HookResult = { ok: true; rollback?: () => Promise<void> } | { ok: false; code: string; message: string; retainRig?: boolean };
      const hook = await (bootstrap as unknown as { buildServicePrelaunchHook(yaml: string, root: string, stages: unknown[], errors: string[]): Promise<((id: string, replaced: readonly string[]) => Promise<HookResult>) | undefined> })
        .buildServicePrelaunchHook(yaml, RIG_ROOT, [], []);
      expect(hook).toBeDefined();
      const result = await inst.instantiate(yaml, RIG_ROOT, { force: true, prelaunchHook: async (id, replaced) => {
        currentId = id;
        return hook!(id, replaced);
      } });
      expect(result.ok).toBe(false);
      const down = commands.filter(cmd => cmd.includes("down"));
      expect(down).toHaveLength(predecessor ? 0 : 1);
      expect(down.every(cmd => !cmd.includes("--volumes"))).toBe(true);
      if (scenario.includes("cleanup-failure")) {
        expect(rigRepo.getServicesRecord(currentId!)).not.toBeNull();
        if (!result.ok) expect(result.message).toContain("retained for recovery");
      } else {
        expect(rigRepo.getRig(currentId!)).toBeNull();
      }
      if (predecessor) {
        expect(rigRepo.findUnarchivedRigsByName("test-rig").map(rig => rig.id)).toContain(predecessor.id);
        expect(commands.some(cmd => cmd.includes("-p 'legacy-project'") && cmd.includes("up -d"))).toBe(true);
        if (scenario === "inherited-boot-failure" && !result.ok) expect(result.message).toContain("Compose up may have changed its runtime");
      }
    } finally { db.close(); }
  });

  // NS-T05: orphan tmux sessions killed on total failure
  it("kills orphan tmux sessions on total failure", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    // Create a setup where startup always fails after launch
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    // Adapter that fails at project (after launch)
    const failAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true })),
    };
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const fsOps = mockFs(files);
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": failAdapter, "codex": failAdapter, "terminal": failAdapter },
      tmuxAdapter: tmux,
    });

    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(false);

    // tmux.killSession should have been called for the orphan session
    const killSession = tmux.killSession as ReturnType<typeof vi.fn>;
    expect(killSession).toHaveBeenCalled();

    db.close();
  });

  it("removes a failed rig when its launched tmux session is already absent", async () => {
    const { db, rigRepo, inst, adapter, tmux } = setup({
      [nodePath.resolve(RIG_ROOT, "agents/impl/agent.yaml")]: agentYaml("impl"),
    });
    (adapter.project as ReturnType<typeof vi.fn>).mockResolvedValue({
      projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }],
    });
    tmux.probeSession = vi.fn(async () => ({ state: "absent" }));
    tmux.killSession = vi.fn(async () => ({ ok: false, code: "guard_target_unknown", message: "ambiguous target" }));
    const prior = rigRepo.createRig("test-rig");

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);

    expect(result.ok).toBe(false);
    expect(adapter.project).toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(rigRepo.findRigsByName("test-rig").map((rig) => rig.id)).toEqual([prior.id]);
    expect(rigRepo.findUnarchivedRigsByName("test-rig").map((rig) => rig.id)).toEqual([prior.id]);
    db.close();
  });

  it("retains a failed rig when the tmux server cannot be reached", async () => {
    const { db, rigRepo, inst, adapter, tmux } = setup({
      [nodePath.resolve(RIG_ROOT, "agents/impl/agent.yaml")]: agentYaml("impl"),
    });
    (adapter.project as ReturnType<typeof vi.fn>).mockResolvedValue({
      projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }],
    });
    tmux.probeSession = vi.fn(async () => ({
      state: "transport_unavailable", cause: "no server running on /tmp/tmux-501/default",
    }));
    tmux.killSession = vi.fn(async () => ({ ok: true }));
    const prior = rigRepo.createRig("test-rig");

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);

    expect(result.ok).toBe(false);
    expect(adapter.project).toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(rigRepo.findRigsByName("test-rig")).toHaveLength(2);
    expect(rigRepo.findUnarchivedRigsByName("test-rig")).toHaveLength(1);
    expect(rigRepo.findUnarchivedRigsByName("test-rig")[0]?.id).not.toBe(prior.id);
    db.close();
  });

  it("retains a failed rig if the tmux server vanishes between probe and kill", async () => {
    const { db, rigRepo, inst, adapter, tmux } = setup({
      [nodePath.resolve(RIG_ROOT, "agents/impl/agent.yaml")]: agentYaml("impl"),
    });
    (adapter.project as ReturnType<typeof vi.fn>).mockResolvedValue({
      projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }],
    });
    tmux.probeSession = vi.fn(async () => ({ state: "present" }));
    tmux.killSession = vi.fn(async () => ({
      ok: false, code: "session_not_found", message: "no server running on /tmp/tmux-501/default",
    }));
    const prior = rigRepo.createRig("test-rig");

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);

    expect(result.ok).toBe(false);
    expect(tmux.killSession).toHaveBeenCalled();
    expect(rigRepo.findRigsByName("test-rig")).toHaveLength(2);
    expect(rigRepo.findUnarchivedRigsByName("test-rig")[0]?.id).not.toBe(prior.id);
    db.close();
  });

  // Agent Starter v1 vertical M1 — forward-compat smoke. A member spec
  // carrying the new `starter_ref` field (normalized as `starterRef`)
  // must pass through pod-aware instantiation without breaking the
  // existing pipeline. M1 only lands schema + resolver scaffolding; M2
  // wires `starterRef` into the launch path. This test verifies M1 does
  // not regress existing instantiation when the new field is present.
  //
  // R2 repair: assert the serialized YAML actually contains
  // `starter_ref:` before instantiation. The R1 codec dropped the field
  // (false-proof), so this assertion was added in R2 alongside the codec
  // emission fix. Without this assertion the smoke would be a hollow
  // pass — the existing pipeline always handled YAML without
  // `starter_ref:` already.
  it("forward-compat: pod with starter_ref on a member instantiates without error AND the codec emits it (R2 repair)", async () => {
    // M2 update: the resolver now actively reads the registry when
    // starterRef is set (M2.1/M2.2 wiring). Provide a fixture registry
    // entry so the resolver succeeds; the smoke proves the field flows
    // through to launch without breaking the existing pipeline. The
    // dedicated end-to-end + abort behaviors live in
    // agent-starter-instantiator.test.ts; this test stays as a
    // forward-compat regression catch.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpRegistry = fs.mkdtempSync(path.join(os.tmpdir(), "starter-fwd-compat-"));
    fs.writeFileSync(path.join(tmpRegistry, "fixture-starter.yaml"), `draft: false
starter_id: fixture-starter
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fwd-compat-fixture"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`);
    process.env.OPENRIG_AGENT_STARTER_ROOT = tmpRegistry;
    try {
      const { db, inst, rigRepo } = setup();
      const yaml = RigSpecCodec.serialize(makeRigSpec({
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            starterRef: { name: "fixture-starter" },
          }],
          edges: [],
        }],
      }));
      // R2: prove the serialized YAML actually carries the new field, then
      // verify instantiation still succeeds with it present.
      expect(yaml).toContain("starter_ref:");
      expect(yaml).toContain("fixture-starter");
      const result = await inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const rig = rigRepo.getRig(result.result.rigId);
        expect(rig).not.toBeNull();
        expect(rig!.nodes).toHaveLength(1);
      }
      db.close();
    } finally {
      delete process.env.OPENRIG_AGENT_STARTER_ROOT;
      fs.rmSync(tmpRegistry, { recursive: true, force: true });
    }
  });

  // --- Conveyor-Trust Minimal Fix (OPR.0.3.2.CT) ---
  //
  // QA baseline-deep-dogfood found `rig up conveyor --yes` dead-ends on
  // workspace-trust gate: instantiate_error AND failure tears down to
  // zero (rigs=0, nodes=0, sessions=0). The operator has nothing to
  // approve. PRD: missions/release-0.3.2/slices/conveyor-trust-minimal-fix/
  // IMPLEMENTATION-PRD.md.
  //
  // ROOT CAUSE: launchExistingAgentMember collapses
  // startupResult={ok:false, startupStatus:"attention_required"} to
  // status:"failed", then allFailed → tear down.
  //
  // MINIMAL FIX (HG-2, HG-5 gate-zero):
  //   - propagate attention_required through launchExistingAgentMember
  //   - allFailed tear-down ONLY when ALL nodes are TERMINALLY failed
  //     (attention_required nodes are recoverable; preserve rig + sessions)
  //   - the session's startup_status="attention_required" already exists
  //     (startupOrchestrator sets it); the rig is now visible via rig ps
  //     in attention_required state
  //   - HG-5: no trust-model / new-user UX / auto-trust changes — only
  //     the failure-handling path is touched

  it("HG-1 repro (PRE-FIX): all nodes hit trust-gate → instantiate_error + zero-collapse", async () => {
    // BEFORE the fix this test SHOULD have shown the broken zero-collapse.
    // Post-fix it documents the OLD behavior so the discriminator is clear.
    // This test passes post-fix because we now preserve the recoverable
    // state — it asserts the NEW expected shape (no tear-down).
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    // Startup orchestrator that returns attention_required for ALL nodes
    // (simulates trust-gate on a disposable workspace).
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["Harness launch requires attention: trust_gate"],
        evidence: "Claude is waiting for workspace trust approval before the session can become interactive.",
      };
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });

    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);

    // HG-2: NO zero-collapse. The result returns ok:false with the new
    // attention_required code (not the old instantiate_error), AND the
    // rig + sessions are preserved on disk so operator can act.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("attention_required");
      expect(result.message).toMatch(/trust|attention/i);
    }
    // Rig + sessions PRESERVED — the operator can list them via rig ps.
    expect(rigRepo.listRigs()).toHaveLength(1);
    if (!result.ok && result.code === "attention_required") {
      const fullRig = rigRepo.getRig(result.rigId);
      expect(fullRig).not.toBeNull();
      expect(fullRig!.nodes.length).toBe(2);
    }
    // Tmux sessions NOT killed (no cleanup pass on attention_required).
    expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // Session rows carry startup_status='attention_required' (already
    // persisted by startupOrchestrator — pin it here to anchor the
    // approve-and-resume path).
    const sessions = db.prepare("SELECT startup_status FROM sessions").all() as Array<{ startup_status: string }>;
    expect(sessions.length).toBe(2);
    for (const s of sessions) {
      expect(s.startup_status).toBe("attention_required");
    }
    db.close();
  });

  // A first start held at a trust dialog or another attention state leaves a live session the person clears later. It gets
  // the seat's continuity notice as a ready start does, and arming it again keeps that job. A failed start gets none.
  it.each([["ready", 1], ["attention_required", 1], ["failed", 0]] as const)(
    "a first start that ends %s arms the seat's managed-compaction notice %i time(s)", async (outcome, armed) => {
      const managedAgent = `
version: "0.2"
name: impl
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: managed-compaction
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`.trim();
      // The watchdog store on its own fully migrated database, as the daemon has it: the instantiator's fixture lacks 074's columns.
      const jobsDb = new Database(":memory:");
      migrate(jobsDb, ALL_MIGRATIONS);
      const jobs = new WatchdogJobsRepository(jobsDb);
      const materializer = new ContinuityPolicyMaterializer(jobs, () => null);
      const arm = vi.spyOn(materializer, "arm");
      const startNode = async () => ({ ok: false as const, startupStatus: outcome, errors: [`startup ended ${outcome}`] });
      const { db, inst } = setup({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: managedAgent }, undefined, undefined, undefined, materializer,
        outcome === "ready" ? undefined : { startupOrchestrator: { startNode } });

      const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);

      expect(result.ok).toBe(outcome === "ready");
      const notices = () => jobs.listActive().filter((job) => job.specYaml.includes("continuity_mode: managed-compaction"));
      expect(notices()).toHaveLength(armed);
      if (armed) {
        // The notice watches the session this start left running.
        const seat = db.prepare("SELECT session_name FROM sessions").all() as Array<{ session_name: string }>;
        expect(seat).toHaveLength(1);
        expect(notices()[0]!.targetSession).toBe(seat[0]!.session_name);
        const first = notices().map((job) => job.jobId);
        expect(materializer.arm(arm.mock.calls[0]![0]).map((job) => job.jobId)).toEqual(first);
        expect(notices().map((job) => job.jobId)).toEqual(first);
      }
      db.close();
      jobsDb.close();
    });

  it("HG-3 attention_required result carries the attentionNodes list (operator approve→resume path)", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["Harness launch requires attention: trust_gate"],
        evidence: "Claude is waiting for workspace trust approval before the session can become interactive.",
      };
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "attention_required") {
      expect(result.message).toMatch(/inspect/i);
      expect(result.message).not.toMatch(/approve and resume|NOT failed/);
      expect(result.rigId).toBeDefined();
      expect(result.attentionNodes).toBeInstanceOf(Array);
      expect(result.attentionNodes!.length).toBe(1);
      expect(result.attentionNodes![0]!.logicalId).toBe("dev.impl");
      expect(result.attentionNodes![0]!.sessionName).toContain("@test-rig");
    }
    db.close();
  });

  it("HG-2 mixed: one attention_required + one launched → rig preserved (ok:true) with attention warnings", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => {} });
    const origStartNode = startupOrch.startNode.bind(startupOrch);
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 2) {
        sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
        return {
          ok: false,
          startupStatus: "attention_required",
          errors: ["trust_gate on qa"],
          evidence: "trust prompt",
        };
      }
      return origStartNode(input);
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });

    const yaml = RigSpecCodec.serialize(makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    }));
    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const attention = result.result.nodes.filter((n) => n.status === "attention_required");
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      expect(launched.length).toBe(1);
      expect(attention.length).toBe(1);
      expect(attention[0]!.logicalId).toBe("dev.qa");
    }
    // Rig preserved; sessions intact.
    expect(rigRepo.listRigs()).toHaveLength(1);
    expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    db.close();
  });

  it("HG-2 negative: all-TERMINALLY-failed still tears down (no regression to terminal-failure cleanup)", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "failed");
      return {
        ok: false,
        startupStatus: "failed",
        errors: ["terminal failure (NOT trust-gate)"],
      };
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);

    // Terminal-failure tear-down preserved (no regression to existing
    // cleanup path).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("instantiate_error");
    }
    expect(rigRepo.listRigs()).toHaveLength(0);
    db.close();
  });

  it("HG-2 negative: at least one terminal failure + at least one attention_required → rig PRESERVED (recoverable wins over tear-down)", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 1) {
        sessionRegistry.updateStartupStatus(input.sessionId, "failed");
        return { ok: false, startupStatus: "failed", errors: ["terminal failure"] };
      }
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["trust_gate"],
        evidence: "trust prompt",
      };
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = RigSpecCodec.serialize(makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    }));
    const result = await inst.instantiate(yaml, RIG_ROOT);

    // ANY attention_required means recoverable — preserve rig even if
    // other nodes terminally failed.
    expect(rigRepo.listRigs()).toHaveLength(1);
    // The operator can still see + approve the attention_required node.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("attention_required");
    }
    db.close();
  });

  // r2-B1 (slice-06 BLOCKING 1): the REAL rig-up door is instantiate(), not
  // materializeValidatedSpec — the bootstrap apply path calls instantiate()
  // (bootstrap-orchestrator.ts), so an installer wired only into materialize
  // ships defaults on import/expand and NOT on `rig up`. This pin drives
  // instantiate() with a REAL temp spec dir carrying topology/ defaults and
  // asserts the files land under the resolved topology root on the REAL fs.
  it("r2-B1: instantiate() — the rig-up door — installs the spec's topology defaults under topology.root", async () => {
    const realFs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const specDir = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-spec-"));
    const topoRoot = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-topo-"));
    try {
      realFs.mkdirSync(nodePath.join(specDir, "topology", "rig"), { recursive: true });
      realFs.mkdirSync(nodePath.join(specDir, "topology", "instance"), { recursive: true });
      realFs.writeFileSync(nodePath.join(specDir, "topology", "rig", "CRAFT.md"), "rig default", "utf-8");
      realFs.writeFileSync(nodePath.join(specDir, "topology", "instance", "CRAFT.md"), "instance default", "utf-8");

      const files = { [`${specDir}/agents/impl/agent.yaml`]: agentYaml("impl") };
      const { db, inst } = setup(files, undefined, () => topoRoot);
      const yaml = RigSpecCodec.serialize(makeRigSpec());
      const result = await inst.instantiate(yaml, specDir);
      expect(result.ok).toBe(true);
      // The door proof: defaults exist on the REAL filesystem after rig-up.
      expect(realFs.readFileSync(nodePath.join(topoRoot, "rigs", "test-rig", "CRAFT.md"), "utf-8")).toBe("rig default");
      expect(realFs.readFileSync(nodePath.join(topoRoot, "CRAFT.md"), "utf-8")).toBe("instance default");
      db.close();
    } finally {
      realFs.rmSync(specDir, { recursive: true, force: true });
      realFs.rmSync(topoRoot, { recursive: true, force: true });
    }
  });

  it("r2-B1 control: without a topologyRootResolver, instantiate() installs nothing and still succeeds", async () => {
    const realFs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const specDir = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-spec-"));
    try {
      realFs.mkdirSync(nodePath.join(specDir, "topology", "rig"), { recursive: true });
      realFs.writeFileSync(nodePath.join(specDir, "topology", "rig", "CRAFT.md"), "x", "utf-8");
      const files = { [`${specDir}/agents/impl/agent.yaml`]: agentYaml("impl") };
      const { db, inst } = setup(files);
      const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), specDir);
      expect(result.ok).toBe(true);
      db.close();
    } finally {
      realFs.rmSync(specDir, { recursive: true, force: true });
    }
  });

  describe("process_limits lifecycle and retention (#3253)", () => {
    it("stores the limit on creation and, on re-apply, writes it before the pane is created; absent keeps, {} clears", async () => {
      const { db, rigRepo, sessionRegistry, inst, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      });
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const memberBase = { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex" as const, cwd: "." };
        const spec = (processLimits?: { tasksMax?: number }) => RigSpecCodec.serialize(makeRigSpec({
          pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, ...(processLimits ? { processLimits } : {}) }], edges: [] }],
        }));
        const clearOccupancy = (rigId: string) => {
          for (const s of sessionRegistry.getSessionsForRig(rigId)) {
            sessionRegistry.markDetached(s.id);
            sessionRegistry.clearBinding(s.nodeId);
          }
        };
        // What the terminal would read for the seat at the moment its pane is created.
        const seen: Array<{ tasksMax: number } | undefined> = [];
        let nodeId = "";
        tmux.createSession = vi.fn(async () => {
          seen.push(nodeId ? rigRepo.getNodeProcessLimits(nodeId) : undefined);
          return { ok: true as const };
        });

        const mat = await inst.materialize(spec({ tasksMax: 512 }), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
        expect(rigRepo.getNodeProcessLimits(nodeId)).toEqual({ tasksMax: 512 });
        expect(RigSpecCodec.serialize(makeRigSpec({ pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, processLimits: { tasksMax: 512 } }], edges: [] }] })))
          .toContain("tasks_max: 512");

        const kept = await inst.launchMaterialized(spec(), RIG_ROOT, rigId);
        expect(kept.ok, JSON.stringify(kept)).toBe(true);
        expect(seen.at(-1)).toEqual({ tasksMax: 512 });

        clearOccupancy(rigId);
        const replaced = await inst.launchMaterialized(spec({ tasksMax: 1024 }), RIG_ROOT, rigId);
        expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
        expect(seen.at(-1)).toEqual({ tasksMax: 1024 });

        clearOccupancy(rigId);
        const cleared = await inst.launchMaterialized(spec({}), RIG_ROOT, rigId);
        expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
        expect(seen.at(-1)).toBeUndefined();
        expect((db.prepare("SELECT process_limits FROM nodes WHERE id = ?").get(nodeId) as { process_limits: string | null })
          .process_limits).toBeNull();
      } finally {
        db.close();
      }
    });

    it("with memory_max, a re-apply writes the new value before the pane; absent keeps, a mapping replaces whole, {} clears both", async () => {
      const { db, rigRepo, sessionRegistry, inst, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      });
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const memberBase = { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex" as const, cwd: "." };
        const spec = (processLimits?: { tasksMax?: number; memoryMax?: number }) => RigSpecCodec.serialize(makeRigSpec({
          pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, ...(processLimits ? { processLimits } : {}) }], edges: [] }],
        }));
        const clearOccupancy = (rigId: string) => {
          for (const s of sessionRegistry.getSessionsForRig(rigId)) {
            sessionRegistry.markDetached(s.id);
            sessionRegistry.clearBinding(s.nodeId);
          }
        };
        const G = 1073741824;
        const seen: Array<{ tasksMax?: number; memoryMax?: number } | undefined> = [];
        let nodeId = "";
        tmux.createSession = vi.fn(async () => {
          seen.push(nodeId ? rigRepo.getNodeProcessLimits(nodeId) : undefined);
          return { ok: true as const };
        });

        const mat = await inst.materialize(spec({ tasksMax: 512, memoryMax: G }), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
        expect(rigRepo.getNodeProcessLimits(nodeId)).toEqual({ tasksMax: 512, memoryMax: G });

        const kept = await inst.launchMaterialized(spec(), RIG_ROOT, rigId);
        expect(kept.ok, JSON.stringify(kept)).toBe(true);
        expect(seen.at(-1)).toEqual({ tasksMax: 512, memoryMax: G });

        for (const next of [{ tasksMax: 512, memoryMax: 2 * G }, { memoryMax: 2 * G }, { tasksMax: 64 }, { tasksMax: 64, memoryMax: G }]) {
          clearOccupancy(rigId);
          const replaced = await inst.launchMaterialized(spec(next), RIG_ROOT, rigId);
          expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
          expect(seen.at(-1)).toEqual(next);
        }

        clearOccupancy(rigId);
        const cleared = await inst.launchMaterialized(spec({}), RIG_ROOT, rigId);
        expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
        expect(seen.at(-1)).toBeUndefined();
        expect((db.prepare("SELECT process_limits FROM nodes WHERE id = ?").get(nodeId) as { process_limits: string | null })
          .process_limits).toBeNull();
      } finally {
        db.close();
      }
    });

    it("the first materialized launch and a persisted fresh launch keep a stored memory_max beside tasks_max", async () => {
      const { db, rigRepo, sessionRegistry, inst, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      });
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const BOTH = '{"tasks_max":512,"memory_max":4294967296}';
        const stored = (nodeId: string) =>
          (db.prepare("SELECT process_limits FROM nodes WHERE id = ?").get(nodeId) as { process_limits: string | null }).process_limits;
        const spec = (name: string) => RigSpecCodec.serialize(makeRigSpec({ name, pods: [{ id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex" as const, cwd: ".",
            processLimits: { tasksMax: 512, memoryMax: 4294967296 } }], edges: [] }] }));

        const mat = await inst.materialize(spec("memory-first"), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const matNodeId = rigRepo.getRig(mat.result.rigId)!.nodes[0]!.id;
        expect(stored(matNodeId)).toBe(BOTH);
        await inst.launchFirstMaterializedNode(mat.result.rigId, matNodeId);
        expect(stored(matNodeId)).toBe(BOTH);

        const made = await inst.instantiate(spec("memory-persisted"), RIG_ROOT);
        expect(made.ok, JSON.stringify(made)).toBe(true);
        if (!made.ok) return;
        const nodeId = rigRepo.getRig(made.result.rigId)!.nodes[0]!.id;
        for (const s of sessionRegistry.getSessionsForRig(made.result.rigId)) {
          sessionRegistry.markDetached(s.id);
          sessionRegistry.clearBinding(s.nodeId);
        }
        await inst.launchPersistedFresh(made.result.rigId, nodeId);
        expect(stored(nodeId)).toBe(BOTH);
      } finally {
        db.close();
      }
    });

    it("a first-start retry with a changed memory_max is refused, and the same value (as a size) is not", async () => {
      const { db, rigRepo, sessionRegistry, inst, codexAdapter, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/worker/agent.yaml`]: agentYaml("worker"),
      });
      try {
        const start = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
        expect(start.ok, JSON.stringify(start)).toBe(true);
        if (!start.ok) return;
        const rigId = start.result.rigId;
        vi.spyOn(codexAdapter, "project").mockResolvedValueOnce({ projected: [], skipped: [],
          failed: [{ effectiveId: "fixture", error: "EACCES: projection ancestor" }] });
        const memberRaw = { id: "worker", agent_ref: "local:agents/worker", profile: "default", runtime: "codex", cwd: ".",
          process_limits: { tasks_max: 512, memory_max: 1073741824 } };
        expect(await inst.addMemberToPod(rigId, "dev", memberRaw, RIG_ROOT)).toMatchObject({ ok: true, result: { node: { status: "failed" } } });
        const worker = rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.worker")!;
        expect(worker.processLimits).toEqual({ tasksMax: 512, memoryMax: 1073741824 });
        const session = sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === worker.id)!;
        sessionRegistry.updateStatus(session.id, "exited");
        sessionRegistry.clearBinding(worker.id);
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));

        for (const processLimits of [{ tasks_max: 512, memory_max: "2G" }, { tasks_max: 512 }, { memory_max: "1G" }]) {
          expect(await inst.retryFirstStart(rigId, worker.id, { ...memberRaw, process_limits: processLimits }, RIG_ROOT)).toMatchObject({
            ok: false, code: "first_start_retry_refused", message: "Member source disagrees with the retained seat identity or policy." });
        }
        const retried = await inst.retryFirstStart(rigId, worker.id, { ...memberRaw, process_limits: { tasks_max: 512, memory_max: "1G" } }, RIG_ROOT);
        expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, status: "launched" });
        expect((db.prepare("SELECT process_limits FROM nodes WHERE id = ?").get(worker.id) as { process_limits: string | null })
          .process_limits).toBe('{"tasks_max":512,"memory_max":1073741824}');
      } finally {
        db.close();
      }
    });

    it("a stored value that can't be read is kept as stored by the first materialized launch and a persisted fresh launch", async () => {
      const { db, rigRepo, sessionRegistry, inst, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      });
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const BAD = "{not json";
        const stored = (nodeId: string) =>
          (db.prepare("SELECT process_limits FROM nodes WHERE id = ?").get(nodeId) as { process_limits: string | null }).process_limits;
        const corrupt = (nodeId: string) => db.prepare("UPDATE nodes SET process_limits = ? WHERE id = ?").run(BAD, nodeId);
        const spec = (name: string) => RigSpecCodec.serialize(makeRigSpec({ name, pods: [{ id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex" as const, cwd: ".",
            processLimits: { tasksMax: 512 } }], edges: [] }] }));

        const mat = await inst.materialize(spec("limits-first"), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const matNodeId = rigRepo.getRig(mat.result.rigId)!.nodes[0]!.id;
        corrupt(matNodeId);
        expect(rigRepo.getRig(mat.result.rigId)!.nodes[0]!.processLimitsError).toMatch(/process_limits/);
        await inst.launchFirstMaterializedNode(mat.result.rigId, matNodeId);
        expect(stored(matNodeId)).toBe(BAD);

        const made = await inst.instantiate(spec("limits-persisted"), RIG_ROOT);
        expect(made.ok, JSON.stringify(made)).toBe(true);
        if (!made.ok) return;
        const nodeId = rigRepo.getRig(made.result.rigId)!.nodes[0]!.id;
        corrupt(nodeId);
        for (const s of sessionRegistry.getSessionsForRig(made.result.rigId)) {
          sessionRegistry.markDetached(s.id);
          sessionRegistry.clearBinding(s.nodeId);
        }
        await inst.launchPersistedFresh(made.result.rigId, nodeId);
        expect(stored(nodeId)).toBe(BAD);
      } finally {
        db.close();
      }
    });

    it.each([["{}", {}], ["a value", { tasks_max: 1024 }]] as const)(
      "a first-start retry with %s keeps an unreadable stored value as stored, without a new refusal", async (_name, processLimits) => {
        const { db, rigRepo, sessionRegistry, inst, codexAdapter, tmux } = setup({
          [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
          [`${RIG_ROOT}/agents/worker/agent.yaml`]: agentYaml("worker"),
        });
        try {
          const start = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
          expect(start.ok, JSON.stringify(start)).toBe(true);
          if (!start.ok) return;
          const rigId = start.result.rigId;
          vi.spyOn(codexAdapter, "project").mockResolvedValueOnce({ projected: [], skipped: [],
            failed: [{ effectiveId: "fixture", error: "EACCES: projection ancestor" }] });
          const memberRaw = { id: "worker", agent_ref: "local:agents/worker", profile: "default", runtime: "codex", cwd: ".",
            process_limits: { tasks_max: 512 } };
          expect(await inst.addMemberToPod(rigId, "dev", memberRaw, RIG_ROOT)).toMatchObject({ ok: true, result: { node: { status: "failed" } } });
          const worker = rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.worker")!;
          const BAD = "{not json";
          db.prepare("UPDATE nodes SET process_limits = ? WHERE id = ?").run(BAD, worker.id);
          const session = sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === worker.id)!;
          sessionRegistry.updateStatus(session.id, "exited");
          sessionRegistry.clearBinding(worker.id);
          tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));

          const retried = await inst.retryFirstStart(rigId, worker.id, { ...memberRaw, process_limits: processLimits }, RIG_ROOT);
          // the launch goes on (here a terminal stub that reads no limits; a real one reports process_limits_invalid)
          expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, status: "launched" });
          expect((db.prepare("SELECT process_limits FROM nodes WHERE id = ?").get(worker.id) as { process_limits: string | null })
            .process_limits).toBe(BAD);
        } finally {
          db.close();
        }
      });

    it("a terminal member's limit is stored with its node, before any launch", async () => {
      const { db, rigRepo, inst, tmux } = setup({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") });
      try {
        const addNode = vi.spyOn(rigRepo, "addNode");
        tmux.createSession = vi.fn(async () => ({ ok: false as const, code: "tmux_failed", message: "refused in this test" }));
        const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec({ pods: [{ id: "infra", label: "Infra",
          members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: ".", processLimits: { tasksMax: 64 } }],
          edges: [] }] })), RIG_ROOT);
        expect(addNode).toHaveBeenCalledWith(expect.any(String), "infra.server", expect.objectContaining({ processLimits: { tasksMax: 64 } }));
        const rigId = result.ok ? result.result.rigId : (db.prepare("SELECT id FROM rigs").get() as { id: string } | undefined)?.id;
        const node = rigId ? rigRepo.getRig(rigId)?.nodes.find((n) => n.logicalId === "infra.server") : undefined;
        if (node) expect(rigRepo.getNodeProcessLimits(node.id)).toEqual({ tasksMax: 64 });
      } finally {
        db.close();
      }
    });
  });

  describe("keep_alive resolution and retention (#2940)", () => {
    const keptAgentYaml = (name: string) =>
      `name: ${name}\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    keep_alive: true\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
    const keepOf = (db: ReturnType<typeof createFullTestDb>, nodeId: string) =>
      (db.prepare("SELECT keep_alive FROM nodes WHERE id = ?").get(nodeId) as { keep_alive: number }).keep_alive;

    it("stores the resolved value at every creation site: agent defaults, a member override and a terminal's own", async () => {
      const { db, rigRepo, inst, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: keptAgentYaml("impl"),
        [`${RIG_ROOT}/agents/qa/agent.yaml`]: keptAgentYaml("qa"),
        [`${RIG_ROOT}/agents/plain/agent.yaml`]: agentYaml("plain"),
      });
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const members = [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex" as const, cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "codex" as const, cwd: ".", keepAlive: false },
          { id: "plain", agentRef: "local:agents/plain", profile: "default", runtime: "codex" as const, cwd: "." },
          { id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: ".", keepAlive: true },
        ];
        const yaml = RigSpecCodec.serialize(makeRigSpec({ pods: [{ id: "dev", label: "Dev", members, edges: [] }] }));
        const expected = { "dev.impl": 1, "dev.qa": 0, "dev.plain": 0, "dev.server": 1 };

        const made = await inst.instantiate(yaml, RIG_ROOT);
        expect(made.ok, JSON.stringify(made)).toBe(true);
        if (!made.ok) return;
        const upNodes = rigRepo.getRig(made.result.rigId)!.nodes;
        expect(Object.fromEntries(upNodes.map((n) => [n.logicalId, keepOf(db, n.id)]))).toEqual(expected);

        // materialize creates the nodes through createMemberNode, before any launch
        const mat = await inst.materialize(RigSpecCodec.serialize(makeRigSpec({ name: "kept-mat", pods: [{ id: "dev", label: "Dev", members, edges: [] }] })), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const matNodes = rigRepo.getRig(mat.result.rigId)!.nodes;
        expect(Object.fromEntries(matNodes.map((n) => [n.logicalId, keepOf(db, n.id)]))).toEqual(expected);
      } finally {
        db.close();
      }
    });

    it("a re-applied spec writes the newly resolved value; a fresh launch from the recipe keeps the stored one", async () => {
      const { db, rigRepo, sessionRegistry, inst, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      });
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const memberBase = { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex" as const, cwd: "." };
        const spec = (keepAlive?: boolean) => RigSpecCodec.serialize(makeRigSpec({
          pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, ...(keepAlive === undefined ? {} : { keepAlive }) }], edges: [] }],
        }));
        const clearOccupancy = (rigId: string) => {
          for (const s of sessionRegistry.getSessionsForRig(rigId)) {
            sessionRegistry.markDetached(s.id);
            sessionRegistry.clearBinding(s.nodeId);
          }
        };

        const mat = await inst.materialize(spec(true), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
        expect(keepOf(db, nodeId)).toBe(1);

        const launched = await inst.launchMaterialized(spec(true), RIG_ROOT, rigId);
        expect(launched.ok, JSON.stringify(launched)).toBe(true);
        expect(keepOf(db, nodeId)).toBe(1);

        clearOccupancy(rigId);
        const turnedOff = await inst.launchMaterialized(spec(), RIG_ROOT, rigId);
        expect(turnedOff.ok, JSON.stringify(turnedOff)).toBe(true);
        expect(keepOf(db, nodeId)).toBe(0);

        rigRepo.setNodeKeepAlive(nodeId, true);
        clearOccupancy(rigId);
        await inst.launchPersistedFresh(rigId, nodeId);
        expect(keepOf(db, nodeId)).toBe(1);
      } finally {
        db.close();
      }
    });

    it("a first-start retry whose member resolves keep_alive differently isn't refused: it carries the seat's saved value", async () => {
      const { db, rigRepo, sessionRegistry, inst, codexAdapter, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/worker/agent.yaml`]: agentYaml("worker"),
      });
      try {
        const start = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
        expect(start.ok, JSON.stringify(start)).toBe(true);
        if (!start.ok) return;
        const rigId = start.result.rigId;
        vi.spyOn(codexAdapter, "project").mockResolvedValueOnce({ projected: [], skipped: [],
          failed: [{ effectiveId: "fixture", error: "EACCES: projection ancestor" }] });
        const memberRaw = { id: "worker", agent_ref: "local:agents/worker", profile: "default", runtime: "codex", cwd: ".", keep_alive: true };
        expect(await inst.addMemberToPod(rigId, "dev", memberRaw, RIG_ROOT)).toMatchObject({ ok: true, result: { node: { status: "failed" } } });
        const worker = rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.worker")!;
        expect(keepOf(db, worker.id)).toBe(1);
        const session = sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === worker.id)!;
        sessionRegistry.updateStatus(session.id, "exited");
        sessionRegistry.clearBinding(worker.id);
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));

        // Without the member's keep_alive, its agent spec resolves it off; the recovery keeps the saved value instead.
        const { keep_alive: _dropped, ...withoutKeepAlive } = memberRaw;
        const retried = await inst.retryFirstStart(rigId, worker.id, withoutKeepAlive, RIG_ROOT);
        expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, status: "launched" });
        expect(keepOf(db, worker.id)).toBe(1);
      } finally {
        db.close();
      }
    });

    it("a re-applied keep_alive: false stays off across export and import; a member that never declares it exports no key", async () => {
      const { db, rigRepo, sessionRegistry, inst, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: keptAgentYaml("impl"),
        [`${RIG_ROOT}/agents/plain/agent.yaml`]: agentYaml("plain"),
      });
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const spec = (name: string, keepAlive?: boolean) => RigSpecCodec.serialize(makeRigSpec({ name, pods: [{ id: "dev", label: "Dev", members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex" as const, cwd: ".", ...(keepAlive === undefined ? {} : { keepAlive }) },
          { id: "plain", agentRef: "local:agents/plain", profile: "default", runtime: "codex" as const, cwd: "." },
        ], edges: [] }] }));
        const mat = await inst.materialize(spec("kept-rt"), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        const impl = rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.impl")!;
        expect(keepOf(db, impl.id)).toBe(1);
        // The member turns off what its agent spec turns on, in a spec re-applied after the seat was created.
        const reapplied = await inst.launchMaterialized(spec("kept-rt", false), RIG_ROOT, rigId);
        expect(reapplied.ok, JSON.stringify(reapplied)).toBe(true);
        expect(keepOf(db, impl.id)).toBe(0);

        const { RigSpecExporter } = await import("../src/domain/rigspec-exporter.js");
        const exported = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo: new PodRepository(db) }).exportRig(rigId) as RigSpec;
        const members = exported.pods.find((p) => p.id === "dev")!.members;
        expect(members.find((m) => m.id === "impl")?.keepAlive).toBe(false);
        expect("keepAlive" in members.find((m) => m.id === "plain")!).toBe(false);

        const imported = await inst.materialize(RigSpecCodec.serialize({ ...exported, name: "kept-rt-imported" }), RIG_ROOT);
        expect(imported.ok, JSON.stringify(imported)).toBe(true);
        if (!imported.ok) return;
        const back = rigRepo.getRig(imported.result.rigId)!.nodes;
        expect(Object.fromEntries(back.map((n) => [n.logicalId, keepOf(db, n.id)]))).toEqual({ "dev.impl": 0, "dev.plain": 0 });

        // The first start of a materialized seat launches its saved, resolved settings, not a declaration of the member's:
        // the member that never declared keep_alive still exports without it.
        const first = await inst.launchFirstMaterializedNode(imported.result.rigId, back.find((n) => n.logicalId === "dev.plain")!.id);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        const reexported = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo: new PodRepository(db) }).exportRig(imported.result.rigId) as RigSpec;
        expect("keepAlive" in reexported.pods.find((p) => p.id === "dev")!.members.find((m) => m.id === "plain")!).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  describe("pool block stored on the model node (#3395 Piece 1)", () => {
    const memberBase = { id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." };
    const yamlSpec = (pool?: unknown, name = "test-rig") => stringifyYaml({
      version: "0.2", name,
      pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, ...(pool === undefined ? {} : { pool }) }], edges: [] }],
      edges: [],
    });
    const fullBlock = (fields: Record<string, unknown>) => ({ spec: {
      max: 3, min: 0, dispatchAfterSeconds: 60, idleGraceSeconds: 300, cooldownSeconds: 60, dispatchTag: null, cwdTemplate: null, drain: false,
      ...fields,
    } });

    function poolSetup() {
      const ctx = setup({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") });
      ctx.tmux.startServer = vi.fn(async () => {});
      ctx.tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
      const clearOccupancy = (rigId: string) => {
        for (const s of ctx.sessionRegistry.getSessionsForRig(rigId)) {
          ctx.sessionRegistry.markDetached(s.id);
          ctx.sessionRegistry.clearBinding(s.nodeId);
        }
      };
      return { ...ctx, clearOccupancy };
    }

    it("A spec with a valid `pool` block on the model member loads, stays `valid`, and the block is stored on the model node.", async () => {
      const { db, rigRepo, inst } = poolSetup();
      try {
        const yaml = yamlSpec({ max: 3, dispatch_tag: "role:impl" });
        expect(RigSpecSchema.validate(RigSpecCodec.parse(yaml))).toEqual({ valid: true, errors: [] });
        const mat = await inst.materialize(yaml, RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const nodeId = rigRepo.getRig(mat.result.rigId)!.nodes[0]!.id;
        expect(rigRepo.getNodePool(nodeId)).toEqual(fullBlock({ dispatchTag: "role:impl" }));

        // `rig up` (import) goes through instantiate: the block lands on the node there too, every field as written
        const every = { max: 5, min: 2, dispatch_after_s: 45, idle_grace_s: 120, cooldown_s: 90, dispatch_tag: "role:qa", cwd_template: "/work/{slot}", drain: true };
        const up = await inst.instantiate(yamlSpec(every, "up-rig"), RIG_ROOT);
        expect(up.ok, JSON.stringify(up)).toBe(true);
        if (!up.ok) return;
        const upNode = rigRepo.getRig(up.result.rigId)!.nodes[0]!.id;
        expect(rigRepo.getNodePool(upNode)).toEqual(fullBlock({ max: 5, min: 2, dispatchAfterSeconds: 45, idleGraceSeconds: 120,
          cooldownSeconds: 90, dispatchTag: "role:qa", cwdTemplate: "/work/{slot}", drain: true }));
      } finally {
        db.close();
      }
    });

    it("A spec whose pool has `max: 0` loads, and the block is stored with `max: 0`.", async () => {
      const { db, rigRepo, inst } = poolSetup();
      try {
        const mat = await inst.materialize(yamlSpec({ max: 0 }), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const nodeId = rigRepo.getRig(mat.result.rigId)!.nodes[0]!.id;
        expect(rigRepo.getNodePool(nodeId)).toEqual(fullBlock({ max: 0 }));
      } finally {
        db.close();
      }
    });

    it("`pool: {}` validates with no advisory, and re-applied over a stored block it clears that block.", async () => {
      const { db, rigRepo, inst, clearOccupancy } = poolSetup();
      try {
        expect(RigSpecSchema.validate(RigSpecCodec.parse(yamlSpec({})))).toEqual({ valid: true, errors: [] });
        const mat = await inst.materialize(yamlSpec({ max: 3 }), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
        expect(rigRepo.getNodePool(nodeId)).toEqual(fullBlock({}));

        clearOccupancy(rigId);
        const cleared = await inst.launchMaterialized(yamlSpec({}), RIG_ROOT, rigId);
        expect(cleared, JSON.stringify(cleared)).toMatchObject({ ok: true, result: { nodes: [{ status: "launched" }] } });
        expect(rigRepo.getNodePool(nodeId)).toBeUndefined();
        expect((db.prepare("SELECT pool FROM nodes WHERE id = ?").get(nodeId) as { pool: string | null }).pool).toBeNull();
      } finally {
        db.close();
      }
    });

    it("A re-apply without the key leaves the stored block unchanged, and a new block replaces it whole.", async () => {
      const { db, rigRepo, inst, clearOccupancy } = poolSetup();
      try {
        const mat = await inst.materialize(yamlSpec({ max: 3, min: 1 }), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;

        const kept = await inst.launchMaterialized(yamlSpec(), RIG_ROOT, rigId);
        expect(kept, JSON.stringify(kept)).toMatchObject({ ok: true, result: { nodes: [{ status: "launched" }] } });
        expect(rigRepo.getNodePool(nodeId)).toEqual(fullBlock({ min: 1 }));

        clearOccupancy(rigId);
        const replaced = await inst.launchMaterialized(yamlSpec({ max: 5 }), RIG_ROOT, rigId);
        expect(replaced, JSON.stringify(replaced)).toMatchObject({ ok: true, result: { nodes: [{ status: "launched" }] } });
        expect(rigRepo.getNodePool(nodeId)).toEqual(fullBlock({ max: 5 }));
      } finally {
        db.close();
      }
    });

    it("A block that can't be used loads the rig, and re-applied over a stored block it is kept as authored with its error: the stored block is not removed.", async () => {
      const { db, rigRepo, inst, clearOccupancy } = poolSetup();
      try {
        const mat = await inst.materialize(yamlSpec({ max: 3 }), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;

        clearOccupancy(rigId);
        const bad = { max: 2, min: 4 };
        const reapplied = await inst.launchMaterialized(yamlSpec(bad), RIG_ROOT, rigId);
        expect(reapplied, JSON.stringify(reapplied)).toMatchObject({ ok: true, result: { nodes: [{ status: "launched" }] } });
        expect(rigRepo.getNodePool(nodeId)).toEqual({ raw: bad, error: "pool.max: must be at least min (4)" });

        const unknownKey = { max: 1, colour: "blue" };
        const fresh = await inst.materialize(yamlSpec(unknownKey, "second-rig"), RIG_ROOT);
        expect(fresh.ok, JSON.stringify(fresh)).toBe(true);
        if (!fresh.ok) return;
        const freshNode = rigRepo.getRig(fresh.result.rigId)!.nodes[0]!.id;
        expect(rigRepo.getNodePool(freshNode)).toMatchObject({ raw: unknownKey, error: expect.stringMatching(/^pool\.colour: unknown field/) });
      } finally {
        db.close();
      }
    });

    it("A stored block that can't be read comes back as stored, with why, and reading it never throws.", () => {
      const { db, rigRepo } = setup();
      try {
        const rig = rigRepo.createRig("stored-rig");
        const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
        db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run("{not json", node.id);
        expect(rigRepo.getNodePool(node.id)).toEqual({ raw: "{not json", error: "pool: the stored value is not valid JSON" });
        db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run(JSON.stringify({ max: "many" }), node.id);
        expect(rigRepo.getNodePool(node.id)).toEqual({ raw: { max: "many" }, error: "pool.max: must be a whole number of 0 or more" });
        db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run("{}", node.id);
        expect(rigRepo.getNodePool(node.id)).toEqual({ raw: {}, error: "pool: the stored block is empty" });
      } finally {
        db.close();
      }
    });

    // #3395 C6/C7: the advisory text, counted in the whole outcome, so a second copy anywhere fails
    const advisory = "dev.impl pool.max: must be at least min (4); pool not used";
    const occurrences = (outcome: unknown) => JSON.stringify(outcome).split(advisory).length - 1;

    it("Launch paths (`materializeStructured`, `launchMaterialized`, `addMemberToPod`) return the pool advisory in their warnings exactly once.", async () => {
      const { db, inst, clearOccupancy } = poolSetup();
      try {
        const bad = { max: 2, min: 4 };
        const structured = await inst.materializeStructured(RigSpecCodec.parse(yamlSpec(bad)), RIG_ROOT);
        expect(structured.ok, JSON.stringify(structured)).toBe(true);
        if (!structured.ok) return;
        expect(structured.result.warnings.filter((w) => w.includes(" pool."))).toEqual([advisory]);
        expect(occurrences(structured)).toBe(1);

        clearOccupancy(structured.result.rigId);
        const launched = await inst.launchMaterialized(yamlSpec(bad), RIG_ROOT, structured.result.rigId);
        expect(launched.ok, JSON.stringify(launched)).toBe(true);
        if (!launched.ok) return;
        expect(launched.result.warnings?.filter((w) => w.includes(" pool."))).toEqual([advisory]);
        expect(occurrences(launched)).toBe(1);

        clearOccupancy(structured.result.rigId);
        const clean = await inst.launchMaterialized(yamlSpec({ max: 3 }), RIG_ROOT, structured.result.rigId);
        expect(JSON.stringify(clean)).not.toContain(" pool.");
      } finally {
        db.close();
      }
    });

    it("Import returns the pool advisory in `warnings` exactly once (C6, through the load front).", async () => {
      const { db, inst } = poolSetup();
      try {
        const imported = await inst.instantiate(yamlSpec({ max: 2, min: 4 }, "import-rig"), RIG_ROOT);
        expect(imported.ok, JSON.stringify(imported)).toBe(true);
        expect(occurrences(imported)).toBe(1);
      } finally {
        db.close();
      }
    });

    it("A fresh launch of the model seat from its launch recipe leaves the stored block as it is.", async () => {
      const { db, rigRepo, inst, clearOccupancy } = poolSetup();
      try {
        const mat = await inst.materialize(yamlSpec({ max: 3 }), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
        rigRepo.setNodePool(nodeId, fullBlock({ max: 7 }));

        clearOccupancy(rigId);
        const relaunched = await inst.launchPersistedFresh(rigId, nodeId);
        expect(relaunched.status, JSON.stringify(relaunched)).toBe("launched");
        expect(rigRepo.getNodePool(nodeId)).toEqual(fullBlock({ max: 7 }));
      } finally {
        db.close();
      }
    });

    it("A rig launched and then re-applied with a valid `pool` block registers no seat-pool job while the job is unarmed.", async () => {
      const { db, rigRepo, inst, clearOccupancy } = poolSetup();
      try {
        const seatPoolJobs = () => (db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs WHERE policy = 'seat-pool'").get() as { n: number }).n;
        const mat = await inst.materialize(yamlSpec({ max: 3, min: 1 }), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
        expect(rigRepo.getNodePool(nodeId)).toEqual(fullBlock({ min: 1 }));
        expect(seatPoolJobs()).toBe(0);

        clearOccupancy(rigId);
        const again = await inst.launchMaterialized(yamlSpec({ max: 5, min: 2 }), RIG_ROOT, rigId);
        expect(again, JSON.stringify(again)).toMatchObject({ ok: true, result: { nodes: [{ status: "launched" }] } });
        expect(rigRepo.getNodePool(nodeId)).toEqual(fullBlock({ max: 5, min: 2 }));
        expect(seatPoolJobs()).toBe(0);

        // `rig up` (import) goes through instantiate: no job there either
        const up = await inst.instantiate(yamlSpec({ max: 2 }, "up-rig"), RIG_ROOT);
        expect(up.ok, JSON.stringify(up)).toBe(true);
        expect(seatPoolJobs()).toBe(0);

        // the node is one the registration would arm: the 0 above comes from the unarmed job, not from the node
        const jobsRepo = new WatchdogJobsRepository(db);
        expect(reconcileSeatPoolNode({ db, rigRepo, jobsRepo }, nodeId)).toMatchObject({ outcome: "registered", job: { targetSession: "dev-impl@test-rig" } });
        expect(seatPoolJobs()).toBe(1);
      } finally {
        db.close();
      }
    });

    // #3395, spec section 5, "Stored": the retry launches from the seat's stored settings (its fragment can't carry
    // `pool`), so it reads the stored pool block from the node, as the first start does.
    it("A first-start retry of a seat reports its stored pool block that can't be used once in its warnings, and the retry still launches.", async () => {
      const { db, rigRepo, sessionRegistry, inst, codexAdapter, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/worker/agent.yaml`]: agentYaml("worker"),
      });
      try {
        const start = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
        expect(start.ok, JSON.stringify(start)).toBe(true);
        if (!start.ok) return;
        const rigId = start.result.rigId;
        vi.spyOn(codexAdapter, "project").mockResolvedValueOnce({ projected: [], skipped: [],
          failed: [{ effectiveId: "fixture", error: "EACCES: projection ancestor" }] });
        const memberRaw = { id: "worker", agent_ref: "local:agents/worker", profile: "default", runtime: "codex", cwd: "." };
        expect(await inst.addMemberToPod(rigId, "dev", memberRaw, RIG_ROOT)).toMatchObject({ ok: true, result: { node: { status: "failed" } } });
        const worker = rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.worker")!;
        // Stored as a re-apply writes a block that can't be used: as authored.
        expect(rigRepo.setNodePool(worker.id, { raw: { max: -1 } })).toBe(true);
        const session = sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === worker.id)!;
        sessionRegistry.updateStatus(session.id, "exited");
        sessionRegistry.clearBinding(worker.id);
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));

        const retried = await inst.retryFirstStart(rigId, worker.id, memberRaw, RIG_ROOT);
        expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, status: "launched" });
        const stored = "dev.worker pool.max: must be a whole number of 0 or more; pool not used";
        expect(JSON.stringify(retried).split(stored).length - 1, JSON.stringify(retried)).toBe(1);
        expect(rigRepo.getNodePool(worker.id)).toEqual({ raw: { max: -1 }, error: expect.any(String) });
      } finally {
        db.close();
      }
    });
  });

  describe("launch_wrapper lifecycle and retention", () => {
    it("persists launch_wrapper on new creation (instantiate and materialize) and passes it to launchHarness", async () => {
      const piAdapter = mockAdapter("pi");
      const { db, rigRepo, inst, codexAdapter } = setup(
        {
          [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
          [`${RIG_ROOT}/agents/pi-worker/agent.yaml`]: agentYaml("pi-worker"),
        },
        { pi: piAdapter },
      );
      try {
        const spec = makeRigSpec({
          pods: [{
            id: "dev",
            label: "Dev",
            members: [
              {
                id: "impl",
                agentRef: "local:agents/impl",
                profile: "default",
                runtime: "codex",
                cwd: ".",
                launchWrapper: ["/bin/sh", "-c"],
              },
              {
                id: "pi-worker",
                agentRef: "local:agents/pi-worker",
                profile: "default",
                runtime: "pi",
                cwd: ".",
                launchWrapper: ["/bin/sh", "-e"],
              },
            ],
            edges: [],
          }],
        });
        const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) return;

        const rig = rigRepo.getRig(result.result.rigId)!;
        const codexNode = rig.nodes.find((n) => n.logicalId === "dev.impl")!;
        const piNode = rig.nodes.find((n) => n.logicalId === "dev.pi-worker")!;
        expect(codexNode.launchWrapper).toEqual(["/bin/sh", "-c"]);
        expect(piNode.launchWrapper).toEqual(["/bin/sh", "-e"]);

        const recipe = rigRepo.getNodeLaunchRecipe(codexNode.id);
        expect(recipe?.rigSpec.pods[0]?.members.find((m) => m.id === "impl")?.launchWrapper).toEqual(["/bin/sh", "-c"]);

        expect(vi.mocked(codexAdapter.launchHarness).mock.calls[0]?.[0].launchWrapper).toEqual(["/bin/sh", "-c"]);
        expect(vi.mocked(piAdapter.launchHarness).mock.calls[0]?.[0].launchWrapper).toEqual(["/bin/sh", "-e"]);
      } finally {
        db.close();
      }
    });

    it("existing authored member apply: absent preserves current, [] explicitly clears, non-empty array replaces (via operator-reachable launchMaterialized and stopped-rig re-import)", async () => {
      const { db, rigRepo, sessionRegistry, inst, codexAdapter, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      });
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const memberBase = {
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "codex" as const,
          cwd: ".",
        };
        const getNode = (rigId: string, nodeId: string) => rigRepo.getRig(rigId)?.nodes.find((n) => n.id === nodeId);
        const clearOccupancy = (rigId: string) => {
          for (const s of sessionRegistry.getSessionsForRig(rigId)) {
            sessionRegistry.markDetached(s.id);
            sessionRegistry.clearBinding(s.nodeId);
          }
        };

        // 1. Materialize with initial wrapper
        const mat = await inst.materialize(
          RigSpecCodec.serialize(makeRigSpec({
            pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, launchWrapper: ["/bin/sh", "-x"] }], edges: [] }],
          })),
          RIG_ROOT,
        );
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const rigId = mat.result.rigId;
        const nodeId = rigRepo.getRig(rigId)!.nodes[0]!.id;
        expect(getNode(rigId, nodeId)?.launchWrapper).toEqual(["/bin/sh", "-x"]);

        // 2. Apply spec with launch_wrapper absent -> preserves existing ["/bin/sh", "-x"]
        const launchedPreserved = await inst.launchMaterialized(
          RigSpecCodec.serialize(makeRigSpec({
            pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase }], edges: [] }],
          })),
          RIG_ROOT,
          rigId,
        );
        expect(launchedPreserved.ok, JSON.stringify(launchedPreserved)).toBe(true);
        expect(getNode(rigId, nodeId)?.launchWrapper).toEqual(["/bin/sh", "-x"]);
        expect(vi.mocked(codexAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toEqual(["/bin/sh", "-x"]);

        // 3. Apply edited spec with replacement array -> replaces stored wrapper and launch binding
        clearOccupancy(rigId);
        const launchedReplaced = await inst.launchMaterialized(
          RigSpecCodec.serialize(makeRigSpec({
            pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, launchWrapper: ["/bin/sh", "-v"] }], edges: [] }],
          })),
          RIG_ROOT,
          rigId,
        );
        expect(launchedReplaced.ok, JSON.stringify(launchedReplaced)).toBe(true);
        expect(getNode(rigId, nodeId)?.launchWrapper).toEqual(["/bin/sh", "-v"]);
        expect(vi.mocked(codexAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toEqual(["/bin/sh", "-v"]);

        // 4. Apply edited spec with explicit empty array [] -> clears stored wrapper to NULL and launches unwrapped
        clearOccupancy(rigId);
        const launchedCleared = await inst.launchMaterialized(
          RigSpecCodec.serialize(makeRigSpec({
            pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, launchWrapper: [] }], edges: [] }],
          })),
          RIG_ROOT,
          rigId,
        );
        expect(launchedCleared.ok, JSON.stringify(launchedCleared)).toBe(true);
        expect(getNode(rigId, nodeId)?.launchWrapper).toBeUndefined();
        const rawAfterClear = db.prepare("SELECT launch_wrapper FROM nodes WHERE id = ?").get(nodeId) as { launch_wrapper: string | null };
        expect(rawAfterClear.launch_wrapper).toBeNull();
        expect(vi.mocked(codexAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toBeUndefined();

        // 5. Operator-reachable recreate/import over a stopped rig replaces/removes wrapper on the recreated rig
        for (const s of sessionRegistry.getSessionsForRig(rigId)) sessionRegistry.updateStatus(s.id, "stopped");
        sessionRegistry.clearBinding(nodeId);
        const reimported = await inst.instantiate(
          RigSpecCodec.serialize(makeRigSpec({
            pods: [{ id: "dev", label: "Dev", members: [{ ...memberBase, launchWrapper: ["/bin/sh", "-e"] }], edges: [] }],
          })),
          RIG_ROOT,
          { force: true },
        );
        expect(reimported.ok, JSON.stringify(reimported)).toBe(true);
        if (!reimported.ok) return;
        const reimportedNode = rigRepo.getRig(reimported.result.rigId)!.nodes[0]!;
        expect(reimportedNode.launchWrapper).toEqual(["/bin/sh", "-e"]);
        expect(vi.mocked(codexAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toEqual(["/bin/sh", "-e"]);
      } finally {
        db.close();
      }
    });

    it.each(["codex", "claude-code"])("current row overrides stale launchRecipe on launchPersistedFresh and stale materializedSources on launchFirstMaterializedNode so cleared wrapper never resurrects (%s)", async runtime => {
      const { db, rigRepo, sessionRegistry, inst, adapter, codexAdapter, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      });
      const targetAdapter = runtime === "claude-code" ? adapter : codexAdapter;
      try {
        tmux.startServer = vi.fn(async () => {});
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
        const getNode = (rigId: string, nodeId: string) => rigRepo.getRig(rigId)?.nodes.find((n) => n.id === nodeId);
        const specWithWrapper = makeRigSpec({
          pods: [{
            id: "dev",
            label: "Dev",
            members: [{
              id: "impl",
              agentRef: "local:agents/impl",
              profile: "default",
              runtime,
              cwd: ".",
              launchWrapper: ["/bin/sh", "-x"],
            }],
            edges: [],
          }],
        });

        // Part A: launchFirstMaterializedNode after clearing row wrapper
        const mat = await inst.materialize(RigSpecCodec.serialize(specWithWrapper), RIG_ROOT);
        expect(mat.ok, JSON.stringify(mat)).toBe(true);
        if (!mat.ok) return;
        const matRigId = mat.result.rigId;
        const matNodeId = rigRepo.getRig(matRigId)!.nodes[0]!.id;
        expect(getNode(matRigId, matNodeId)?.launchWrapper).toEqual(["/bin/sh", "-x"]);

        // Clear the row's wrapper before first materialized launch (materializedSources still holds ["/bin/sh", "-x"])
        rigRepo.setNodeLaunchWrapper(matNodeId, null);
        expect(getNode(matRigId, matNodeId)?.launchWrapper).toBeUndefined();

        const firstLaunch = await inst.launchFirstMaterializedNode(matRigId, matNodeId);
        expect(firstLaunch?.ok, JSON.stringify(firstLaunch)).toBe(true);
        // Cleared wrapper on row must NOT resurrect from materializedSources
        expect(getNode(matRigId, matNodeId)?.launchWrapper).toBeUndefined();
        expect(vi.mocked(targetAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toBeUndefined();

        // Part B: launchPersistedFresh after clearing row wrapper while launch_recipe_json still has ["/bin/sh", "-x"]
        const instRig = await inst.instantiate(
          RigSpecCodec.serialize({ ...specWithWrapper, name: "fresh-rebuild-rig" }),
          RIG_ROOT,
        );
        expect(instRig.ok, JSON.stringify(instRig)).toBe(true);
        if (!instRig.ok) return;
        const rebuildRigId = instRig.result.rigId;
        const rebuildNodeId = rigRepo.getRig(rebuildRigId)!.nodes[0]!.id;
        expect(rigRepo.getNodeLaunchRecipe(rebuildNodeId)?.rigSpec.pods[0]?.members[0]?.launchWrapper).toEqual(["/bin/sh", "-x"]);

        // Clear current row's wrapper while recipe still has ["/bin/sh", "-x"]
        rigRepo.setNodeLaunchWrapper(rebuildNodeId, null);
        for (const s of sessionRegistry.getSessionsForRig(rebuildRigId)) {
          sessionRegistry.markDetached(s.id);
          sessionRegistry.clearBinding(s.nodeId);
        }

        const freshRebuild = await inst.launchPersistedFresh(rebuildRigId, rebuildNodeId);
        expect(freshRebuild.status, JSON.stringify(freshRebuild)).toBe("launched");
        // Cleared wrapper on row must NOT resurrect from stale launch_recipe_json
        expect(getNode(rebuildRigId, rebuildNodeId)?.launchWrapper).toBeUndefined();
        expect(vi.mocked(targetAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toBeUndefined();
      } finally {
        db.close();
      }
    });

    it.each(["codex", "claude-code"])("retryFirstStart retains launch_wrapper key and enforces sameLaunchWrapper equality against the failed node (%s)", async runtime => {
      const { db, rigRepo, sessionRegistry, inst, adapter, codexAdapter, tmux } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/worker/agent.yaml`]: agentYaml("worker"),
      });
      const targetAdapter = runtime === "claude-code" ? adapter : codexAdapter;
      try {
        const start = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
        expect(start.ok, JSON.stringify(start)).toBe(true);
        if (!start.ok) return;
        const rigId = start.result.rigId;

        vi.spyOn(targetAdapter, "project").mockResolvedValueOnce({
          projected: [],
          skipped: [],
          failed: [{ effectiveId: "fixture", error: "EACCES: projection ancestor" }],
        });
        const memberRaw = {
          id: "worker",
          agent_ref: "local:agents/worker",
          profile: "default",
          runtime,
          cwd: ".",
          launch_wrapper: ["/bin/sh", "-x"],
        };
        const added = await inst.addMemberToPod(rigId, "dev", memberRaw, RIG_ROOT);
        expect(added).toMatchObject({ ok: true, result: { node: { status: "failed" } } });
        const worker = rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.worker")!;
        expect(worker.launchWrapper).toEqual(["/bin/sh", "-x"]);

        const session = sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === worker.id)!;
        sessionRegistry.updateStatus(session.id, "exited");
        sessionRegistry.clearBinding(worker.id);
        tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));

        // 1. Changing launch_wrapper on retryFirstStart is refused
        expect(await inst.retryFirstStart(rigId, worker.id, { ...memberRaw, launch_wrapper: ["/bin/sh", "-v"] }, RIG_ROOT)).toMatchObject({
          ok: false,
          code: "first_start_retry_refused",
          message: "Member source disagrees with the retained seat identity or policy.",
        });

        // 2. Clearing/removing launch_wrapper on retryFirstStart is refused
        expect(await inst.retryFirstStart(rigId, worker.id, { ...memberRaw, launch_wrapper: [] }, RIG_ROOT)).toMatchObject({
          ok: false,
          code: "first_start_retry_refused",
          message: "Member source disagrees with the retained seat identity or policy.",
        });
        const { launch_wrapper: _omitted, ...withoutWrapper } = memberRaw;
        expect(await inst.retryFirstStart(rigId, worker.id, withoutWrapper, RIG_ROOT)).toMatchObject({
          ok: false,
          code: "first_start_retry_refused",
          message: "Member source disagrees with the retained seat identity or policy.",
        });

        // 3. Matching launch_wrapper succeeds and launches with the retained wrapper
        const retried = await inst.retryFirstStart(rigId, worker.id, memberRaw, RIG_ROOT);
        expect(retried, JSON.stringify(retried)).toMatchObject({ ok: true, status: "launched" });
        expect(vi.mocked(targetAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toEqual(["/bin/sh", "-x"]);
      } finally {
        db.close();
      }
    });

    it("fork uses TARGET node launch_wrapper and NEVER inherits source parent launch_wrapper", async () => {
      const { db, rigRepo, sessionRegistry, inst, codexAdapter } = setup({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      });
      try {
        const spec = makeRigSpec({
          pods: [{
            id: "dev",
            label: "Dev",
            members: [{
              id: "impl",
              agentRef: "local:agents/impl",
              profile: "default",
              runtime: "codex",
              cwd: ".",
              launchWrapper: ["/bin/sh", "-x"],
            }],
            edges: [],
          }],
        });
        const created = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
        expect(created.ok, JSON.stringify(created)).toBe(true);
        if (!created.ok) return;
        const rigId = created.result.rigId;
        const parentSession = sessionRegistry.getSessionsForRig(rigId)[0]!;
        sessionRegistry.updateResumeToken(parentSession.id, "codex_id", "11111111-2222-4333-8444-555555555555");

        // Fork child 1: no launch_wrapper declared -> must NOT inherit parent's ["/bin/sh", "-x"]
        const forkPlain = await inst.addMemberToPod(
          rigId,
          "dev",
          {
            id: "fork-plain",
            agent_ref: "local:agents/impl",
            profile: "default",
            runtime: "codex",
            cwd: ".",
            session_source: { mode: "fork", ref: { kind: "native_id", value: "11111111-2222-4333-8444-555555555555" } },
          },
          RIG_ROOT,
        );
        expect(forkPlain.ok, JSON.stringify(forkPlain)).toBe(true);
        if (!forkPlain.ok) return;
        const plainNode = rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.fork-plain")!;
        expect(plainNode.launchWrapper).toBeUndefined();
        expect(vi.mocked(codexAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toBeUndefined();

        // Fork child 2: declares its own launch_wrapper -> uses target's own wrapper
        const forkWrapped = await inst.addMemberToPod(
          rigId,
          "dev",
          {
            id: "fork-wrapped",
            agent_ref: "local:agents/impl",
            profile: "default",
            runtime: "codex",
            cwd: ".",
            launch_wrapper: ["/bin/sh", "-e"],
            session_source: { mode: "fork", ref: { kind: "native_id", value: "11111111-2222-4333-8444-555555555555" } },
          },
          RIG_ROOT,
        );
        expect(forkWrapped.ok, JSON.stringify(forkWrapped)).toBe(true);
        if (!forkWrapped.ok) return;
        const wrappedNode = rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.fork-wrapped")!;
        expect(wrappedNode.launchWrapper).toEqual(["/bin/sh", "-e"]);
        expect(vi.mocked(codexAdapter.launchHarness).mock.calls.at(-1)?.[0].launchWrapper).toEqual(["/bin/sh", "-e"]);
      } finally {
        db.close();
      }
    });
  });
});
