import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp, mockTmuxAdapter, mockNativeRuntime } from "./helpers/test-app.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import type { RigSpec } from "../src/domain/types.js";

describe("persisted pod-aware launch recipes", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("survives a node reload and selects the member for a fresh launch", async () => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("recipe-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-recipe", rig.id, "dev", "Development");

    const rigRoot = "/workspace/recipe-rig";
    const rigSpec: RigSpec = {
      version: "0.2",
      name: "recipe-rig",
      pods: [{
        id: "dev",
        label: "Development",
        members: [{
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
        }],
        edges: [],
      }],
      edges: [],
    };
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      podId: "pod-recipe",
      launchRecipe: { version: 1, rigRoot, rigSpec },
    });

    expect(setup.rigRepo.getNodeLaunchRecipe(node.id)).toEqual({ version: 1, rigRoot, rigSpec });

    const launchBinding = vi.spyOn(setup.podInstantiator, "launchBinding")
      .mockResolvedValue({ status: "launched" });
    const result = await setup.podInstantiator.launchPersistedFresh(rig.id, node.id);

    expect(result).toEqual({ status: "launched" });
    expect(launchBinding).toHaveBeenCalledWith(expect.objectContaining({
      rigId: rig.id,
      rigRoot,
      qualifiedId: "dev.impl",
      nodeId: node.id,
      member: expect.objectContaining({ id: "impl", agentRef: "local:agents/impl" }),
      pod: expect.objectContaining({ id: "dev", label: "Development" }),
    }));
  });

  it("keeps saved seat choices authoritative over the recipe defaults", async () => {
    db = createFullTestDb();
    const launchHarness = vi.fn(async () => ({ ok: true as const }));
    const agentYaml = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default: {}\n`;
    const setup = createTestApp(db, {
      ...mockNativeRuntime(() => "codex"),
      adapters: {
        codex: {
          runtime: "codex",
          listInstalled: async () => [],
          project: async () => ({ projected: [], skipped: [], failed: [] }),
          deliverStartup: async () => ({ delivered: 0, failed: [] }),
          checkReady: async () => ({ ready: true }),
          launchHarness,
        },
      },
      podInstantiatorFsOps: {
        exists: (file) => file.replaceAll("\\", "/").endsWith("/agents/impl/agent.yaml"),
        readFile: () => agentYaml,
      },
    });
    const rig = setup.rigRepo.createRig("saved-choice-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-saved-choice", rig.id, "dev", "Development");

    const rigRoot = process.cwd();
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "codex",
      model: "saved-model",
      effort: "saved-effort",
      codexConfigProfile: "saved-profile",
      permissionPolicy: "builtin:yolo",
      env: { SAVED_CHOICE: "yes" },
      cwd: rigRoot,
      podId: "pod-saved-choice",
      launchRecipe: {
        version: 1,
        rigRoot,
        rigSpec: {
          version: "0.2",
          name: "saved-choice-rig",
          pods: [{
            id: "dev",
            label: "Development",
            members: [{
              id: "impl",
              agentRef: "local:agents/impl",
              profile: "default",
              runtime: "codex",
              model: "recipe-model",
              effort: "recipe-effort",
              codexConfigProfile: "recipe-profile",
              cwd: ".",
            }],
            edges: [],
          }],
          edges: [],
        },
      },
    });

    const result = await setup.podInstantiator.launchPersistedFresh(rig.id, node.id);

    expect(result).toMatchObject({ status: "launched" });
    expect(launchHarness).toHaveBeenCalledWith(expect.objectContaining({
      model: "saved-model",
      effort: "saved-effort",
      codexConfigProfile: "saved-profile",
      cwd: rigRoot,
      launchPosture: "full_bypass",
    }), expect.anything());
  });

  it("rejects malformed stored specs without throwing", async () => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("malformed-recipe-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?")
      .run(JSON.stringify({ version: 1, rigRoot: "/workspace", rigSpec: { version: "0.2", name: "broken", pods: {} } }), node.id);

    expect(setup.rigRepo.getNodeLaunchRecipe(node.id)).toBeNull();
  });

  it.each([
    { label: "invalid JSON", value: "{" },
    {
      label: "missing member",
      value: {
        version: 1,
        rigRoot: "/workspace",
        rigSpec: {
          version: "0.2",
          name: "broken",
          pods: [{ id: "dev", label: "Dev", members: [], edges: [] }],
          edges: [],
        },
      },
    },
    {
      label: "malformed startup action",
      value: {
        version: 1,
        rigRoot: "/workspace",
        rigSpec: {
          version: "0.2",
          name: "broken",
          startup: {
            files: [],
            actions: [{ type: "send_text", value: "hello", phase: "after_ready", idempotent: true, appliesOn: "fresh_start" }],
          },
          pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
          edges: [],
        },
      },
    },
    {
      label: "malformed pod continuity policy",
      value: {
        version: 1,
        rigRoot: "/workspace",
        rigSpec: {
          version: "0.2",
          name: "broken",
          pods: [{ id: "dev", label: "Dev", continuityPolicy: { enabled: "yes" }, members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
          edges: [],
        },
      },
    },
    {
      label: "malformed nested appliesOn phase",
      value: {
        version: 1,
        rigRoot: "/workspace",
        rigSpec: {
          version: "0.2",
          name: "broken",
          startup: { files: [], actions: [{ type: "send_text", value: "hello", phase: "after_ready", idempotent: true, appliesOn: [["fresh_start"]] }] },
          pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
          edges: [],
        },
      },
    },
    {
      label: "malformed rig metadata",
      value: {
        version: 1,
        rigRoot: "/workspace",
        rigSpec: {
          version: "0.2",
          name: "broken",
          cultureFile: 42,
          managedBlocks: { "claude-code": {} },
          services: { kind: "compose", composeFile: 42 },
          workspace: { workspaceRoot: "/workspace", repos: "not-an-array" },
          pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
          edges: [],
        },
      },
    },
  ])("rejects $label without throwing", ({ value }) => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("malformed-shape-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?")
      .run(typeof value === "string" ? value : JSON.stringify(value), node.id);

    expect(setup.rigRepo.getNodeLaunchRecipe(node.id)).toBeNull();
  });

  it("returns no recipe for a node that has never been materialized", () => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("unmaterialized-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });

    expect(setup.rigRepo.getNodeLaunchRecipe(node.id)).toBeNull();
    expect(setup.podInstantiator.canLaunchPersistedFresh(rig.id, node.id)).toBe(false);
  });

  it("restores through the real restore-to-instantiator callback with a fresh instantiator", async () => {
    db = createFullTestDb();
    let setup!: ReturnType<typeof createTestApp>;
    const freshLaunch = vi.fn(async (rigId: string, nodeId: string, launchOpts?: { processLimitsMode?: "fresh" | "recovery" }) => setup.podInstantiator.launchPersistedFresh(rigId, nodeId, launchOpts));
    const freshLaunchAvailable = vi.fn((rigId: string, nodeId: string) => setup.podInstantiator.canLaunchPersistedFresh(rigId, nodeId));
    const agentYaml = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default: {}\n`;
    setup = createTestApp(db, {
      ...mockNativeRuntime(() => "codex"),
      freshLaunch,
      freshLaunchAvailable,
      podInstantiatorFsOps: {
        exists: (file) => file.replaceAll("\\", "/").endsWith("/agents/impl/agent.yaml"),
        readFile: () => agentYaml,
      },
    });
    const runtimeAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };
    const rig = setup.rigRepo.createRig("reopened-recipe-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-reopened", rig.id, "dev", "Development");
    const rigRoot = process.cwd();
    const rigSpec: RigSpec = {
      version: "0.2",
      name: "reopened-recipe-rig",
      pods: [{
        id: "dev",
        label: "Development",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }],
        edges: [],
      }],
      edges: [],
    };
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "codex",
      agentRef: "local:agents/impl",
      profile: "default",
      cwd: rigRoot,
      podId: "pod-reopened",
      launchRecipe: { version: 1, rigRoot, rigSpec },
    });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@reopened-recipe-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxPane: "%7" });
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "recipe-reopen");
    setup.sessionRegistry.updateStatus(session.id, "exited");

    const result = await setup.restoreOrchestrator.restore(snapshot.id, {
      adapters: { codex: runtimeAdapter },
      freshLogicalIds: [node.logicalId],
    });

    expect(result.ok).toBe(true);
    expect(freshLaunch).toHaveBeenCalledWith(rig.id, node.id, { processLimitsMode: "recovery" });
    if (result.ok) {
      expect(result.result.nodes.find((entry) => entry.nodeId === node.id)?.status).toBe("fresh-primed");
    }
  });

  // A never-occupied seat restored through the recipe's fresh launch keeps a saved folder missing on this machine missing,
  // as the restore's own launch does: only a spec entry point, or a --cwd the person gives this run, creates a folder.
  it.each([false, true])("a restore's fresh launch of a never-occupied seat creates its folder only for a --cwd the person gave (%s)", async (withCwd) => {
    db = createFullTestDb();
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-missing-folder-"));
    const saved = path.join(tmp, "old-home", "project");
    const given = path.join(tmp, "new-home", "project");
    try {
      let setup!: ReturnType<typeof createTestApp>;
      const freshLaunch = vi.fn(async (rigId: string, nodeId: string, launchOpts?: { processLimitsMode?: "fresh" | "recovery"; cwdOverride?: string }) =>
        setup.podInstantiator.launchPersistedFresh(rigId, nodeId, launchOpts));
      const freshLaunchAvailable = vi.fn((rigId: string, nodeId: string) => setup.podInstantiator.canLaunchPersistedFresh(rigId, nodeId));
      const createFolder = vi.fn((dir: string) => { fs.mkdirSync(dir, { recursive: true }); });
      const agentYaml = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default: {}\n`;
      const tmux = mockTmuxAdapter();
      setup = createTestApp(db, { tmux, freshLaunch, freshLaunchAvailable, createFolder,
        podInstantiatorFsOps: { exists: (file) => file.replaceAll("\\", "/").endsWith("/agents/impl/agent.yaml"), readFile: () => agentYaml } });
      const runtimeAdapter = {
        runtime: "codex",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        checkReady: vi.fn(async () => ({ ready: true })),
        launchHarness: vi.fn(async () => ({ ok: true as const })),
      };
      const rig = setup.rigRepo.createRig("moved-recipe-rig");
      db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-moved", rig.id, "dev", "Development");
      const rigRoot = process.cwd();
      const rigSpec: RigSpec = { version: "0.2", name: "moved-recipe-rig", edges: [], pods: [{ id: "dev", label: "Development",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }] };
      const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", agentRef: "local:agents/impl", profile: "default",
        cwd: saved, podId: "pod-moved", launchRecipe: { version: 1, rigRoot, rigSpec } });
      const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@moved-recipe-rig");
      setup.sessionRegistry.updateStatus(session.id, "running");
      setup.sessionRegistry.updateBinding(node.id, { tmuxPane: "%7" });
      const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "recipe-moved");
      setup.sessionRegistry.updateStatus(session.id, "exited");

      const result = await setup.restoreOrchestrator.restore(snapshot.id, {
        adapters: { codex: runtimeAdapter }, freshLogicalIds: [node.logicalId], fsOps: { exists: (file: string) => fs.existsSync(file) },
        ...(withCwd ? { cwdOverride: given } : {}) });

      expect(result.ok).toBe(true);
      expect(freshLaunch).toHaveBeenCalledWith(rig.id, node.id, { processLimitsMode: "recovery", ...(withCwd ? { cwdOverride: given } : {}) });
      expect(fs.existsSync(saved), "the saved folder stays missing").toBe(false);
      // The fresh launch's terminal starts in the person's --cwd, or else the saved folder (tmux then falls back).
      expect(vi.mocked(tmux.createSession).mock.calls.at(-1)?.[1]).toBe(withCwd ? given : saved);
      if (withCwd) {
        expect(createFolder).toHaveBeenCalledWith(given);
        expect(fs.existsSync(given)).toBe(true);
        // The fresh launch created it, so the restore doesn't name it missing.
        expect(result.ok ? result.result.warnings.join("\n") : "").not.toContain("given with --cwd");
      } else {
        expect(createFolder).not.toHaveBeenCalled();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("#3253: a restore's fresh fallback is a recovery: a limit it can't apply leaves a notice, not a failed seat", async () => {
    db = createFullTestDb();
    let setup!: ReturnType<typeof createTestApp>;
    const freshLaunch = vi.fn(async (rigId: string, nodeId: string, launchOpts?: { processLimitsMode?: "fresh" | "recovery" }) =>
      setup.podInstantiator.launchPersistedFresh(rigId, nodeId, launchOpts));
    const freshLaunchAvailable = vi.fn((rigId: string, nodeId: string) => setup.podInstantiator.canLaunchPersistedFresh(rigId, nodeId));
    const agentYaml = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default: {}\n`;
    // The host can't apply the limit (the user manager doesn't answer): a fresh launch refuses, a recovery goes on.
    const problem = { kind: "unverified" as const, reason: "the user manager timed out", requested: { tasksMax: 8 } };
    const notice = { state: "not_applied" as const, ...problem, retryable: true };
    // The provisional shell's start couldn't be told; the replacement's is known not applied: the node reports the
    // replacement's.
    const provisional = { state: "unknown" as const, kind: "unverified" as const, reason: "the start was not seen", retryable: true };
    const { tmux, listProcesses } = mockNativeRuntime(() => "codex");
    let recoveries = 0;
    const createSession = vi.fn(async (_name: string, _cwd?: string, _env?: Record<string, string>,
      launchOpts?: { processLimitsMode?: "fresh" | "recovery" }) => launchOpts?.processLimitsMode === "recovery"
      ? { ok: true as const, processLimits: ++recoveries === 1 ? provisional : notice }
      : { ok: false as const, code: "process_limits_unverified", message: "refused", retryable: true, processLimits: problem });
    (tmux as unknown as Record<string, unknown>).createSession = createSession;
    setup = createTestApp(db, {
      tmux,
      listProcesses,
      freshLaunch,
      freshLaunchAvailable,
      podInstantiatorFsOps: {
        exists: (file) => file.replaceAll("\\", "/").endsWith("/agents/impl/agent.yaml"),
        readFile: () => agentYaml,
      },
    });
    const runtimeAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };
    const rig = setup.rigRepo.createRig("capped-recipe-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-capped", rig.id, "dev", "Development");
    const rigRoot = process.cwd();
    const rigSpec: RigSpec = {
      version: "0.2",
      name: "capped-recipe-rig",
      pods: [{
        id: "dev",
        label: "Development",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: ".", processLimits: { tasksMax: 8 } }],
        edges: [],
      }],
      edges: [],
    };
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "codex",
      agentRef: "local:agents/impl",
      profile: "default",
      cwd: rigRoot,
      podId: "pod-capped",
      launchRecipe: { version: 1, rigRoot, rigSpec },
      processLimits: { tasksMax: 8 },
    });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@capped-recipe-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxPane: "%7" });
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "capped-recipe");
    setup.sessionRegistry.updateStatus(session.id, "exited");

    const result = await setup.restoreOrchestrator.restore(snapshot.id, {
      adapters: { codex: runtimeAdapter },
      freshLogicalIds: [node.logicalId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(createSession).toHaveBeenCalledTimes(2);
    for (const call of createSession.mock.calls) expect(call[3]).toEqual({ processLimitsMode: "recovery" });
    expect(result.result.nodes.find((entry) => entry.nodeId === node.id)).toMatchObject({ status: "fresh-primed", processLimits: notice });
    expect(setup.rigRepo.getRig(rig.id)?.nodes.find((entry) => entry.id === node.id)?.processLimits).toEqual({ tasksMax: 8 });
  });

  it("a fresh restore from the recipe reports the agent spec's advisories, its own and its import's, once each", async () => {
    db = createFullTestDb();
    let setup!: ReturnType<typeof createTestApp>;
    const freshLaunch = vi.fn(async (rigId: string, nodeId: string, launchOpts?: { processLimitsMode?: "fresh" | "recovery" }) => setup.podInstantiator.launchPersistedFresh(rigId, nodeId, launchOpts));
    const freshLaunchAvailable = vi.fn((rigId: string, nodeId: string) => setup.podInstantiator.canLaunchPersistedFresh(rigId, nodeId));
    const rigRoot = process.cwd();
    const files: Record<string, string> = {
      [`${rigRoot}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nimports:\n  - ref: local:../shared\ndefaults:\n  effort: 3\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default: {}\n`,
      [`${rigRoot}/agents/shared/agent.yaml`]: `name: shared\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    compaction_strategy: harness_native\nresources:\n  skills: []\nprofiles: {}\n`,
    };
    setup = createTestApp(db, {
      ...mockNativeRuntime(() => "codex"),
      freshLaunch,
      freshLaunchAvailable,
      podInstantiatorFsOps: {
        exists: (file) => file.replaceAll("\\", "/") in files,
        readFile: (file) => files[file.replaceAll("\\", "/")]!,
      },
    });
    const runtimeAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };
    const rig = setup.rigRepo.createRig("advised-recipe-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-advised", rig.id, "dev", "Development");
    const rigSpec: RigSpec = {
      version: "0.2",
      name: "advised-recipe-rig",
      pods: [{
        id: "dev",
        label: "Development",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }],
        edges: [],
      }],
      edges: [],
    };
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "codex",
      agentRef: "local:agents/impl",
      profile: "default",
      cwd: rigRoot,
      podId: "pod-advised",
      launchRecipe: { version: 1, rigRoot, rigSpec },
    });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@advised-recipe-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxPane: "%7" });
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "recipe-advised");
    setup.sessionRegistry.updateStatus(session.id, "exited");

    const result = await setup.restoreOrchestrator.restore(snapshot.id, {
      adapters: { codex: runtimeAdapter },
      freshLogicalIds: [node.logicalId],
    });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes.find((entry) => entry.nodeId === node.id)?.status).toBe("fresh-primed");
    const warnings = result.result.warnings ?? [];
    expect(warnings.filter((w) => w === `dev.impl: agent spec advisory (impl, ${rigRoot}/agents/impl): defaults.effort: non-string value "3" ignored; effort must be a text value`)).toHaveLength(1);
    expect(warnings.filter((w) => w.startsWith(`dev.impl: agent spec advisory (shared, ${rigRoot}/agents/shared): defaults.lifecycle.compaction_strategy: "harness_native" is deprecated`))).toHaveLength(1);
  });

  it.each([
    { label: "no recipe", mutate: (db: Database.Database, nodeId: string) => db.prepare("UPDATE nodes SET launch_recipe_json = NULL WHERE id = ?").run(nodeId) },
    { label: "invalid JSON", mutate: (db: Database.Database, nodeId: string) => db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?").run("{", nodeId) },
    {
      label: "malformed member addition",
      mutate: (db: Database.Database, nodeId: string) => db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?").run(JSON.stringify({
        version: 1,
        rigRoot: "/workspace",
        rigSpec: {
          version: "0.2",
          name: "restore-fallback-rig",
          pods: [{ id: "dev", label: "Development", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: ".", pluginDirs: "not-an-array" }], edges: [] }],
          edges: [],
        },
      }), nodeId),
    },
    {
      label: "recipe missing this node's member",
      mutate: (db: Database.Database, nodeId: string) => db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?").run(JSON.stringify({
        version: 1,
        rigRoot: "/workspace",
        rigSpec: {
          version: "0.2",
          name: "restore-fallback-rig",
          pods: [{ id: "dev", label: "Development", members: [{ id: "other", agentRef: "local:agents/other", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
          edges: [],
        },
      }), nodeId),
    },
  ])("keeps the provisional shell and binding for $label", async ({ mutate }) => {
    db = createFullTestDb();
    let setup!: ReturnType<typeof createTestApp>;
    const freshLaunch = vi.fn(async (rigId: string, nodeId: string, launchOpts?: { processLimitsMode?: "fresh" | "recovery" }) => setup.podInstantiator.launchPersistedFresh(rigId, nodeId, launchOpts));
    const freshLaunchAvailable = vi.fn((rigId: string, nodeId: string) => setup.podInstantiator.canLaunchPersistedFresh(rigId, nodeId));
    setup = createTestApp(db, { freshLaunch, freshLaunchAvailable });
    const rig = setup.rigRepo.createRig("restore-fallback-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-restore-fallback", rig.id, "dev", "Development");
    const recipe = {
      version: 1,
      rigRoot: "/workspace",
      rigSpec: {
        version: "0.2",
        name: "restore-fallback-rig",
        pods: [{ id: "dev", label: "Development", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
        edges: [],
      },
    };
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "codex",
      agentRef: "local:agents/impl",
      profile: "default",
      cwd: process.cwd(),
      podId: "pod-restore-fallback",
      launchRecipe: recipe,
    });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@restore-fallback-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "recipe-fallback");
    mutate(db, node.id);
    setup.sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const result = await setup.restoreOrchestrator.restore(snapshot.id, { freshLogicalIds: [node.logicalId] });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.result.nodes.find((entry) => entry.nodeId === node.id)).toMatchObject({ status: "attention_required" });
    expect(freshLaunchAvailable).toHaveBeenCalledWith(rig.id, node.id);
    expect(freshLaunch).not.toHaveBeenCalled();
    expect(setup.sessionRegistry.getSessionsForRig(rig.id).some((entry) => entry.nodeId === node.id && entry.status === "running")).toBe(true);
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toEqual(expect.objectContaining({ tmuxSession: expect.any(String) }));
    // The kept shell carries restore's harness-not-started marker, so rig ps doesn't count it as a running seat.
    expect(getNodeInventory(db, rig.id).find((entry) => entry.logicalId === node.logicalId)).toMatchObject({
      sessionStatus: "running", startupStatus: "attention_required", latestErrorStage: "harness_not_started",
      latestError: "Harness not started: no usable persisted launch recipe for dev.impl.",
    });
    expect(new PsProjectionService({ db }).getEntries().find((entry) => entry.rigId === rig.id)).toMatchObject({ nodeCount: 1, runningCount: 0 });
  });

  it.each([
    { label: "permission policy", field: "permissionPolicy", value: {} },
    { label: "environment", field: "env", value: [] },
    { label: "advisor", field: "advisor", value: [] },
    { label: "agent file", field: "agentFile", value: 42 },
    { label: "append system prompt file", field: "appendSystemPromptFile", value: 42 },
    { label: "plugin directories", field: "pluginDirs", value: "not-an-array" },
    { label: "session source", field: "sessionSource", value: { mode: "rebuild", ref: { kind: "artifact_set", value: "not-an-array" } } },
    { label: "starter reference", field: "starterRef", value: { name: 42 } },
  ])("rejects malformed optional $label inputs without throwing", async ({ field, value }) => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig(`malformed-${field}-rig`);
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?")
      .run(JSON.stringify({
        version: 1,
        rigRoot: "/workspace",
        rigSpec: {
          version: "0.2",
          name: "broken",
          pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: ".", [field]: value }], edges: [] }],
          edges: [],
        },
      }), node.id);

    expect(setup.rigRepo.getNodeLaunchRecipe(node.id)).toBeNull();
  });
});

// #3395, spec section 5, "Stored": a launch from stored state reads a model seat's pool advisory from its node.
describe("a restore reports the stored pool block of a model seat", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  const agentYaml = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default: {}\n`;

  /**
   * Restores a stopped one-seat rig with its node storing `seed` (nothing when undefined): fresh, through its launch
   * recipe, or, with `resume`, by resuming the seat's recorded session.
   */
  async function restoreWithStoredPool(seed: ((db: Database.Database, nodeId: string, setup: ReturnType<typeof createTestApp>) => void) | undefined, resume = false) {
    db = createFullTestDb();
    let setup!: ReturnType<typeof createTestApp>;
    const freshLaunch = vi.fn(async (rigId: string, nodeId: string, launchOpts?: { processLimitsMode?: "fresh" | "recovery" }) => setup.podInstantiator.launchPersistedFresh(rigId, nodeId, launchOpts));
    const freshLaunchAvailable = vi.fn((rigId: string, nodeId: string) => setup.podInstantiator.canLaunchPersistedFresh(rigId, nodeId));
    setup = createTestApp(db, {
      ...mockNativeRuntime(() => "codex"),
      freshLaunch,
      freshLaunchAvailable,
      podInstantiatorFsOps: {
        exists: (file) => file.replaceAll("\\", "/").endsWith("/agents/impl/agent.yaml"),
        readFile: () => agentYaml,
      },
    });
    const runtimeAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };
    const rig = setup.rigRepo.createRig("pooled-recipe-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-pooled", rig.id, "dev", "Development");
    const rigRoot = process.cwd();
    const rigSpec: RigSpec = {
      version: "0.2",
      name: "pooled-recipe-rig",
      pods: [{ id: "dev", label: "Development", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: "." }], edges: [] }],
      edges: [],
    };
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "codex",
      agentRef: "local:agents/impl",
      profile: "default",
      cwd: rigRoot,
      podId: "pod-pooled",
      launchRecipe: { version: 1, rigRoot, rigSpec },
    });
    seed?.(db, node.id, setup);
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@pooled-recipe-rig");
    if (resume) setup.sessionRegistry.updateResumeToken(session.id, "codex_id", "pooled-thread", "operator");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxPane: "%7" });
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "pooled-recipe");
    setup.sessionRegistry.updateStatus(session.id, "exited");

    const result = await setup.restoreOrchestrator.restore(snapshot.id, {
      adapters: { codex: runtimeAdapter },
      ...(resume ? {} : { freshLogicalIds: [node.logicalId] }),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("restore failed");
    expect(freshLaunch).toHaveBeenCalledTimes(resume ? 0 : 1);
    return { result: result.result, nodeId: node.id };
  }

  /** What the restore says about the seat and the rig, the advisories left out. */
  const outcome = (result: Awaited<ReturnType<typeof restoreWithStoredPool>>["result"]) => ({
    rigResult: result.rigResult,
    nodes: result.nodes.map((entry) => ({ logicalId: entry.logicalId, status: entry.status })),
  });

  const occurrences = (whole: unknown, advisory: string) => JSON.stringify(whole).split(JSON.stringify(advisory).slice(1, -1)).length - 1;

  // Two restores: the seat resumes its recorded session, and the seat starts fresh, where the restore's own launch and
  // the launch recipe's fresh launch both run, so the count also proves the fresh branch doesn't report it a second time.
  it("A restore reports a model seat's stored pool block that can't be used once in its warnings, as <pod>.<member> pool.<field>: <reason>; pool not used, also when the seat starts fresh through its launch recipe, and the rig result is the same as without the block", async () => {
    const advisory = "dev.impl pool.max: must be a whole number of 0 or more; pool not used";
    const plain = await restoreWithStoredPool(undefined);
    db?.close();
    // Stored as a re-apply writes a block that can't be used: as authored.
    const pooled = await restoreWithStoredPool((_db, nodeId, setup) => {
      expect(setup.rigRepo.setNodePool(nodeId, { raw: { max: -1 } })).toBe(true);
    });
    expect(pooled.result.nodes.find((entry) => entry.nodeId === pooled.nodeId)?.status).toBe("fresh-primed");

    expect(pooled.result.warnings.filter((w) => w === advisory)).toHaveLength(1);
    expect(occurrences(pooled.result, advisory)).toBe(1);
    expect(plain.result.warnings.some((w) => w.includes("pool not used"))).toBe(false);
    expect(outcome(pooled.result)).toEqual(outcome(plain.result));

    // The seat resumes its recorded session instead: the restore's own launch reports the block, once, the same way.
    db?.close();
    const plainResume = await restoreWithStoredPool(undefined, true);
    db?.close();
    const pooledResume = await restoreWithStoredPool((_db, nodeId, setup) => {
      expect(setup.rigRepo.setNodePool(nodeId, { raw: { max: -1 } })).toBe(true);
    }, true);
    expect(pooledResume.result.nodes.find((entry) => entry.nodeId === pooledResume.nodeId)?.status).not.toBe("awaiting-decision");
    expect(pooledResume.result.warnings.filter((w) => w === advisory)).toHaveLength(1);
    expect(occurrences(pooledResume.result, advisory)).toBe(1);
    expect(plainResume.result.warnings.some((w) => w.includes("pool not used"))).toBe(false);
    expect(outcome(pooledResume.result)).toEqual(outcome(plainResume.result));
  });

  it("A stored pool value that is not valid JSON never stops a launch from stored state: the restore names it once in its warnings as <pod>.<member> pool: the stored value is not valid JSON; pool not used, and a usable stored block, or none, adds no warning", async () => {
    const advisory = "dev.impl pool: the stored value is not valid JSON; pool not used";
    const plain = await restoreWithStoredPool(undefined);
    db?.close();
    const broken = await restoreWithStoredPool((db, nodeId) => {
      db.prepare("UPDATE nodes SET pool = ? WHERE id = ?").run("not json", nodeId);
    });

    expect(broken.result.warnings.filter((w) => w === advisory)).toHaveLength(1);
    expect(occurrences(broken.result, advisory)).toBe(1);
    expect(JSON.stringify(broken.result)).not.toContain("must be a mapping");
    expect(outcome(broken.result)).toEqual(outcome(plain.result));
    db?.close();

    const usable = await restoreWithStoredPool((_db, nodeId, setup) => {
      expect(setup.rigRepo.setNodePool(nodeId, { raw: { max: 2 } })).toBe(true);
    });
    expect(usable.result.warnings.some((w) => w.includes("pool not used") || w.includes(" pool"))).toBe(false);
    expect(plain.result.warnings.some((w) => w.includes("pool not used") || w.includes(" pool"))).toBe(false);
    expect(outcome(usable.result)).toEqual(outcome(plain.result));
  });
});
