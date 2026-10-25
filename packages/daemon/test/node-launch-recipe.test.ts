import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
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
    const freshLaunch = vi.fn(async (rigId: string, nodeId: string) => setup.podInstantiator.launchPersistedFresh(rigId, nodeId));
    const freshLaunchAvailable = vi.fn((rigId: string, nodeId: string) => setup.podInstantiator.canLaunchPersistedFresh(rigId, nodeId));
    const agentYaml = `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []\nprofiles:\n  default: {}\n`;
    setup = createTestApp(db, {
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
    expect(freshLaunch).toHaveBeenCalledWith(rig.id, node.id);
    if (result.ok) {
      expect(result.result.nodes.find((entry) => entry.nodeId === node.id)?.status).toBe("fresh-primed");
    }
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
    const freshLaunch = vi.fn(async (rigId: string, nodeId: string) => setup.podInstantiator.launchPersistedFresh(rigId, nodeId));
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
