import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { getNodeInventory, getNodeDetail } from "../src/domain/node-inventory.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

function seedPodAwareRig(db: Database.Database, opts?: { rigName?: string }) {
  const rigName = opts?.rigName ?? "test-rig";
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", rigName);
  // Pod
  db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", "rig-1", "dev", "Dev");
  // Agent node
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile, resolved_spec_name, resolved_spec_version, resolved_spec_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("node-1", "rig-1", "dev.impl", "claude-code", "/project", "pod-1", "local:agents/impl", "default", "impl", "1.0.0", "abc123");
  // Terminal/infrastructure node
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("node-2", "rig-1", "infra.server", "terminal", "/project", "pod-1", "builtin:terminal", "none");
}

function seedSession(db: Database.Database, nodeId: string, sessionName: string, opts?: {
  status?: string;
  startupStatus?: string;
  resumeType?: string;
  resumeToken?: string;
  startupCompletedAt?: string;
}) {
  const id = `sess-${nodeId}-${Date.now()}`;
  db.prepare(
    "INSERT INTO sessions (id, node_id, session_name, status, startup_status, resume_type, resume_token, startup_completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id, nodeId, sessionName,
    opts?.status ?? "running",
    opts?.startupStatus ?? "ready",
    opts?.resumeType ?? null,
    opts?.resumeToken ?? null,
    opts?.startupCompletedAt ?? null,
  );
  // Binding with real PK
  const bindingId = `bind-${nodeId}`;
  db.prepare("INSERT OR REPLACE INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run(bindingId, nodeId, sessionName);
  return id;
}

function seedEvent(db: Database.Database, rigId: string, nodeId: string, type: string, payload: Record<string, unknown>) {
  db.prepare(
    "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
  ).run(rigId, nodeId, type, JSON.stringify({ ...payload, type }));
}

function seedStartupContext(db: Database.Database, nodeId: string, opts?: {
  files?: Array<{ path: string; deliveryHint: string; required: boolean }>;
  actions?: Array<{ type: string; value: string }>;
  projectionEntries?: Array<Record<string, string>>;
  runtime?: string;
}) {
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run(
    nodeId,
    JSON.stringify(opts?.projectionEntries ?? []),
    JSON.stringify(opts?.files ?? []),
    JSON.stringify(opts?.actions ?? []),
    opts?.runtime ?? "claude-code",
  );
}

function mockAdapter(overrides?: Partial<RuntimeAdapter>): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("Node Inventory Projection", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: Inventory includes all nodes for a pod-aware rig
  it("includes all nodes for a pod-aware rig", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");
    seedSession(db, "node-2", "infra.server@test-rig");

    const entries = getNodeInventory(db, "rig-1");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.logicalId).sort()).toEqual(["dev.impl", "infra.server"]);
    expect(entries.every((e) => e.podNamespace === "dev")).toBe(true);
  });

  // Test 2: Inventory includes correct canonical session names
  it("includes correct canonical session names", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");

    const entries = getNodeInventory(db, "rig-1");
    const agentEntry = entries.find((e) => e.logicalId === "dev.impl");
    expect(agentEntry?.canonicalSessionName).toBe("dev.impl@test-rig");
  });

  // Test 3: nodeKind is 'agent' for claude-code/codex, 'infrastructure' for terminal
  it("nodeKind distinguishes agent from infrastructure", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");
    seedSession(db, "node-2", "infra.server@test-rig");

    const entries = getNodeInventory(db, "rig-1");
    const agent = entries.find((e) => e.logicalId === "dev.impl");
    const infra = entries.find((e) => e.logicalId === "infra.server");
    expect(agent?.nodeKind).toBe("agent");
    expect(infra?.nodeKind).toBe("infrastructure");
  });

  // Test 4: tmuxAttachCommand computed correctly
  it("tmuxAttachCommand computed from session name", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");

    const entries = getNodeInventory(db, "rig-1");
    const entry = entries.find((e) => e.logicalId === "dev.impl");
    expect(entry?.tmuxAttachCommand).toBe("tmux attach -t dev.impl@test-rig");
  });

  // Test 5: resumeCommand uses correct runtime syntax
  it("resumeCommand uses correct runtime syntax", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig", {
      resumeType: "claude",
      resumeToken: "abc-123-def",
    });

    const entries = getNodeInventory(db, "rig-1");
    const entry = entries.find((e) => e.logicalId === "dev.impl");
    expect(entry?.resumeCommand).toBe("claude --resume abc-123-def");
  });

  // Test 6: resumeCommand is null when no resume token
  it("resumeCommand is null when no resume token", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");

    const entries = getNodeInventory(db, "rig-1");
    const entry = entries.find((e) => e.logicalId === "dev.impl");
    expect(entry?.resumeCommand).toBeNull();
  });

  // Test 7: startupStatus reflects session startup_status column
  it("startupStatus reflects session startup_status", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig", { startupStatus: "failed" });

    const entries = getNodeInventory(db, "rig-1");
    const entry = entries.find((e) => e.logicalId === "dev.impl");
    expect(entry?.startupStatus).toBe("failed");
  });

  // Test 8: restoreOutcome populated from restore.completed event
  it("restoreOutcome = 'resumed' from restore.completed event", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");
    seedEvent(db, "rig-1", "node-1", "restore.completed", {
      rigId: "rig-1",
      snapshotId: "snap-1",
      result: {
        snapshotId: "snap-1",
        preRestoreSnapshotId: "snap-0",
        nodes: [
          { nodeId: "node-1", logicalId: "dev.impl", status: "resumed" },
          { nodeId: "node-2", logicalId: "infra.server", status: "failed" },
        ],
        warnings: [],
      },
    });

    const entries = getNodeInventory(db, "rig-1");
    const agent = entries.find((e) => e.logicalId === "dev.impl");
    const infra = entries.find((e) => e.logicalId === "infra.server");
    expect(agent?.restoreOutcome).toBe("resumed");
    expect(infra?.restoreOutcome).toBe("failed");
  });

  // Resume state naming: rebuilt and fresh outcomes from inventory
  it("restoreOutcome maps checkpoint_written to 'rebuilt' and fresh_no_checkpoint to 'fresh'", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");
    seedSession(db, "node-2", "infra.server@test-rig");
    seedEvent(db, "rig-1", "node-1", "restore.completed", {
      rigId: "rig-1",
      snapshotId: "snap-1",
      result: {
        snapshotId: "snap-1",
        preRestoreSnapshotId: "snap-0",
        nodes: [
          { nodeId: "node-1", logicalId: "dev.impl", status: "rebuilt" },
          { nodeId: "node-2", logicalId: "infra.server", status: "fresh" },
        ],
        warnings: [],
      },
    });

    const entries = getNodeInventory(db, "rig-1");
    const agent = entries.find((e) => e.logicalId === "dev.impl");
    const infra = entries.find((e) => e.logicalId === "infra.server");
    expect(agent?.restoreOutcome).toBe("rebuilt");
    expect(infra?.restoreOutcome).toBe("fresh");
  });

  // Test 9: latestError populated from startup_failed events
  it("latestError from startup_failed event", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig", { startupStatus: "failed" });
    seedEvent(db, "rig-1", "node-1", "node.startup_failed", {
      rigId: "rig-1",
      nodeId: "node-1",
      error: "harness launch timeout after 30s",
    });

    const entries = getNodeInventory(db, "rig-1");
    const entry = entries.find((e) => e.logicalId === "dev.impl");
    expect(entry?.latestError).toBe("harness launch timeout after 30s");
  });

  // Test 10: Legacy rigs produce inventory with legacy session names
  it("legacy rigs produce inventory with legacy session names", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-leg", "r01");
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, ?, ?, ?)"
    ).run("node-leg", "rig-leg", "worker", "claude-code");
    seedSession(db, "node-leg", "r01-worker");

    const entries = getNodeInventory(db, "rig-leg");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.canonicalSessionName).toBe("r01-worker");
    expect(entries[0]!.nodeKind).toBe("agent");
    expect(entries[0]!.podId).toBeNull();
  });

  // Test 11: getNodeDetail returns startupFiles from node_startup_context
  it("getNodeDetail returns startupFiles from node_startup_context", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");
    seedStartupContext(db, "node-1", {
      files: [
        { path: "role.md", deliveryHint: "send_text", required: true },
        { path: "culture.md", deliveryHint: "guidance_merge", required: false },
      ],
    });

    const detail = getNodeDetail(db, "rig-1", "dev.impl");
    expect(detail).not.toBeNull();
    expect(detail!.startupFiles).toHaveLength(2);
    expect(detail!.startupFiles[0]!.path).toBe("role.md");
    // Binding.id regression: must match the real PK from bindings table
    expect(detail!.binding).not.toBeNull();
    expect(detail!.binding!.id).toBe("bind-node-1");
  });

  // Test 12: getNodeDetail returns recentEvents using events.node_id
  it("getNodeDetail returns recentEvents for the node", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");
    seedEvent(db, "rig-1", "node-1", "node.startup_pending", { rigId: "rig-1", nodeId: "node-1" });
    seedEvent(db, "rig-1", "node-1", "node.startup_ready", { rigId: "rig-1", nodeId: "node-1" });
    // Event for a different node — should not appear
    seedEvent(db, "rig-1", "node-2", "node.startup_pending", { rigId: "rig-1", nodeId: "node-2" });

    const detail = getNodeDetail(db, "rig-1", "dev.impl");
    expect(detail).not.toBeNull();
    expect(detail!.recentEvents).toHaveLength(2);
    expect(detail!.recentEvents.map((e) => e.type)).toEqual(["node.startup_ready", "node.startup_pending"]);
  });

  // Test 13: getNodeDetail installedResources fallback from startup context projection
  it("getNodeDetail installedResources from startup context projection fallback", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");
    seedStartupContext(db, "node-1", {
      // Use real persisted shape from startup-orchestrator.ts line 139
      projectionEntries: [
        { effectiveId: "skill-1", category: "skills", target: ".claude/skills/skill-1", sourceSpec: "impl", sourcePath: "skills/s1", resourcePath: "s1", absolutePath: "/project/agents/impl/skills/s1", mergeStrategy: "overwrite" },
        { effectiveId: "guidance-1", category: "guidance", target: "CLAUDE.md", sourceSpec: "impl", sourcePath: "guidance.md", resourcePath: "guidance.md", absolutePath: "/project/agents/impl/guidance.md", mergeStrategy: "append" },
      ],
    });

    const detail = getNodeDetail(db, "rig-1", "dev.impl");
    expect(detail).not.toBeNull();
    expect(detail!.installedResources).toHaveLength(2);
    expect(detail!.installedResources[0]!.id).toBe("skill-1");
    expect(detail!.installedResources[0]!.targetPath).toBe(".claude/skills/skill-1");
  });

  // Test 14: getNodeDetail infrastructureStartupCommand from terminal send_text
  it("getNodeDetail infrastructureStartupCommand for terminal node", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-2", "infra.server@test-rig");
    seedStartupContext(db, "node-2", {
      actions: [
        { type: "send_text", value: "npm run dev" },
        { type: "send_text", value: "echo ready" },
      ],
      runtime: "terminal",
    });

    const detail = getNodeDetail(db, "rig-1", "infra.server");
    expect(detail).not.toBeNull();
    expect(detail!.infrastructureStartupCommand).toBe("npm run dev");
    expect(detail!.nodeKind).toBe("infrastructure");
  });

  // Test 15: getNodeDetail installedResources adapter-backed path
  it("getNodeDetail installedResources via adapter listInstalled", () => {
    seedPodAwareRig(db);
    seedSession(db, "node-1", "dev.impl@test-rig");
    const adapter = mockAdapter({
      listInstalled: vi.fn(() => [
        { effectiveId: "live-skill", category: "skills", installedPath: ".claude/skills/live" },
      ]),
    });

    const detail = getNodeDetail(db, "rig-1", "dev.impl", {
      adapters: { "claude-code": adapter },
    });
    expect(detail).not.toBeNull();
    expect(detail!.installedResources).toHaveLength(1);
    expect(detail!.installedResources[0]!.id).toBe("live-skill");
  });
});
