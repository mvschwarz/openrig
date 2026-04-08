import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockAdapter(): RuntimeAdapter {
  return {
    runtime: "claude-code",
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
  function setup(fsFiles?: Record<string, string>) {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const adapter = mockAdapter();
    const files = fsFiles ?? { [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") };
    const fsOps = mockFs(files);

    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": adapter, "codex": mockAdapter(), "terminal": mockAdapter() },
      tmuxAdapter: tmux,
    });

    return { db, rigRepo, podRepo, sessionRegistry, eventBus, inst, adapter, tmux };
  }

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

  it("dedupes role guidance when the same file is referenced by resources.guidance and startup.files", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
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
      hooks: []
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

  it("includes using-openrig.md onboarding overlay in resolved startup files", async () => {
    const { db, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);

    // Check startup context for using-openrig.md
    const ctxRows = db.prepare("SELECT * FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    expect(ctxRows.length).toBeGreaterThan(0);
    const allFiles = ctxRows.flatMap((r) => JSON.parse(r.resolved_files_json) as Array<{ path: string }>);
    const onboarding = allFiles.find((f) => f.path === "using-openrig.md");
    expect(onboarding).toBeDefined();

    db.close();
  });

  it("using-openrig.md asset exists on disk", () => {
    const { existsSync } = require("node:fs");
    const { resolve } = require("node:path");
    const assetPath = resolve(import.meta.dirname, "../src/domain/../../assets/guidance/using-openrig.md");
    expect(existsSync(assetPath)).toBe(true);
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
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
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
});
