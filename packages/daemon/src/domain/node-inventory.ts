import type Database from "better-sqlite3";
import type { NodeInventoryEntry, NodeDetailEntry, NodeDetailPeer, NodeDetailEdge, NodeDetailCompactSpec, NodeRestoreOutcome, Binding, RestoreResult, NodeRecoveryGuidance } from "./types.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { ContextUsageStore } from "./context-usage-store.js";

// -- Row types for SQL results --

interface InventoryRow {
  node_id: string;
  rig_id: string;
  rig_name: string;
  logical_id: string;
  pod_id: string | null;
  pod_namespace: string | null;
  runtime: string | null;
  model: string | null;
  agent_ref: string | null;
  profile: string | null;
  cwd: string | null;
  restore_policy: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
  resolved_spec_hash: string | null;
  // Newest session fields (may be null if no session)
  session_name: string | null;
  session_status: string | null;
  startup_status: string | null;
  resume_type: string | null;
  resume_token: string | null;
  startup_completed_at: string | null;
  binding_attachment_type: string | null;
}

interface EventRow {
  seq: number;
  rig_id: string;
  node_id: string;
  type: string;
  payload: string;
  created_at: string;
}

interface StartupContextRow {
  node_id: string;
  projection_entries_json: string;
  resolved_files_json: string;
  startup_actions_json: string;
  runtime: string;
}

interface BindingRow {
  id: string;
  node_id: string;
  attachment_type: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  external_session_name: string | null;
  cmux_workspace: string | null;
  cmux_surface: string | null;
  updated_at: string;
}

// -- Helpers --

function computeResumeCommand(runtime: string | null, resumeToken: string | null): string | null {
  if (!resumeToken) return null;
  if (runtime === "claude-code") return `claude --resume ${resumeToken}`;
  if (runtime === "codex") return `codex resume ${resumeToken}`;
  return null;
}

function computeRecoveryGuidance(input: {
  runtime: string | null;
  resumeToken: string | null;
  cwd: string | null;
  sessionName: string | null;
}): NodeRecoveryGuidance | null {
  const { runtime, resumeToken, cwd, sessionName } = input;

  if (runtime === "claude-code") {
    const commands: string[] = [];
    const notes: string[] = [];

    if (resumeToken) {
      commands.push(`claude --resume ${resumeToken}`);
    }
    if (cwd) {
      commands.push(`cd ${cwd}`);
    }
    commands.push("claude --resume");

    if (sessionName) {
      notes.push(`Look for session name: ${sessionName}`);
    }
    notes.push("Choose the full conversation option, not summary.");

    return {
      summary: resumeToken
        ? "Try native Claude resume first, then fall back to the workspace-local picker if needed."
        : "No stored Claude resume token. Use the workspace-local Claude picker fallback.",
      commands,
      notes,
    };
  }

  if (runtime === "codex") {
    const commands: string[] = [];
    const notes: string[] = [];

    if (resumeToken) {
      commands.push(`codex resume ${resumeToken}`);
    }
    if (cwd) {
      commands.push(`cd ${cwd}`);
    }
    commands.push("codex");
    commands.push("resume");

    notes.push("Use workspace and recent prompt text to identify the right conversation.");
    if (sessionName) {
      notes.push(`If the identity anchor was captured, the picker may include: ${sessionName}`);
    }

    return {
      summary: resumeToken
        ? "Try native Codex resume first, then fall back to the workspace-local Codex picker if needed."
        : "No stored Codex resume token. Use the workspace-local Codex picker fallback.",
      commands,
      notes,
    };
  }

  return null;
}

function deriveNodeKind(runtime: string | null): "agent" | "infrastructure" {
  return runtime === "terminal" ? "infrastructure" : "agent";
}

function deriveRestoreOutcome(db: Database.Database, rigId: string, nodeId: string): NodeRestoreOutcome {
  // Find the latest restore.completed event for this rig
  const row = db.prepare(
    "SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.completed' ORDER BY seq DESC LIMIT 1"
  ).get(rigId) as { payload: string } | undefined;

  if (!row) return "n-a";

  try {
    const event = JSON.parse(row.payload) as { result: RestoreResult };
    const nodeResult = event.result.nodes.find((n) => n.nodeId === nodeId);
    if (!nodeResult) return "n-a";

    if (nodeResult.status === "resumed") return "resumed";
    if (nodeResult.status === "failed") return "failed";
    if (nodeResult.status === "rebuilt") return "rebuilt";
    if (nodeResult.status === "fresh") return "fresh";
    // Compat: old persisted events may contain pre-rename values
    if ((nodeResult.status as string) === "checkpoint_written") return "rebuilt";
    if ((nodeResult.status as string) === "fresh_no_checkpoint") return "fresh";
    return "n-a";
  } catch {
    return "n-a";
  }
}

function getLatestError(db: Database.Database, rigId: string, nodeId: string): string | null {
  const row = db.prepare(
    "SELECT payload FROM events WHERE rig_id = ? AND node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1"
  ).get(rigId, nodeId) as { payload: string } | undefined;

  if (!row) return null;

  try {
    const event = JSON.parse(row.payload) as { error?: string };
    return event.error ?? null;
  } catch {
    return null;
  }
}

/**
 * Map persisted projection entries to the installedResources shape.
 * The startup-orchestrator persists: { category, effectiveId, sourceSpec, sourcePath, resourcePath, absolutePath, mergeStrategy, target }
 * We normalize to: { id, category, targetPath }
 */
function mapProjectionEntries(entries: unknown[]): Array<{ id: string; category: string; targetPath: string }> {
  return entries.map((e: unknown) => {
    const entry = e as Record<string, string>;
    return {
      id: entry.effectiveId ?? entry.id ?? "",
      category: entry.category ?? "",
      targetPath: entry.target ?? entry.targetPath ?? "",
    };
  });
}

// -- Public API --

/**
 * Get the canonical node inventory for a rig.
 * Single source of truth consumed by CLI, UI, and MCP.
 */
export function getNodeInventory(db: Database.Database, rigId: string): NodeInventoryEntry[] {
  // Join nodes with newest session (max ULID = max session.id string comparison)
  // and the rig name
  const rows = db.prepare(`
    SELECT
      n.id as node_id,
      n.rig_id,
      r.name as rig_name,
      n.logical_id,
      n.pod_id,
      p.namespace as pod_namespace,
      n.runtime,
      n.model,
      n.agent_ref,
      n.profile,
      n.cwd,
      n.restore_policy,
      n.resolved_spec_name,
      n.resolved_spec_version,
      n.resolved_spec_hash,
      s.session_name,
      s.status as session_status,
      s.startup_status,
      s.resume_type,
      s.resume_token,
      s.startup_completed_at,
      b.attachment_type as binding_attachment_type
    FROM nodes n
    JOIN rigs r ON r.id = n.rig_id
    LEFT JOIN pods p ON p.id = n.pod_id
    LEFT JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    LEFT JOIN bindings b ON b.node_id = n.id
    WHERE n.rig_id = ?
    ORDER BY n.created_at
  `).all(rigId) as InventoryRow[];

  return rows.map((row) => ({
    rigId: row.rig_id,
    rigName: row.rig_name,
    logicalId: row.logical_id,
    podId: row.pod_id,
    podNamespace: row.pod_namespace,
    canonicalSessionName: row.session_name,
    attachmentType: (row.binding_attachment_type as NodeInventoryEntry["attachmentType"]) ?? null,
    nodeKind: deriveNodeKind(row.runtime),
    runtime: row.runtime,
    sessionStatus: row.session_status,
    startupStatus: row.startup_status as NodeInventoryEntry["startupStatus"],
    restoreOutcome: deriveRestoreOutcome(db, rigId, row.node_id),
    tmuxAttachCommand: row.binding_attachment_type === "tmux" && row.session_name ? `tmux attach -t ${row.session_name}` : null,
    resumeCommand: computeResumeCommand(row.runtime, row.resume_token),
    recoveryGuidance: computeRecoveryGuidance({
      runtime: row.runtime,
      resumeToken: row.resume_token,
      cwd: row.cwd,
      sessionName: row.session_name,
    }),
    latestError: row.startup_status === "ready" ? null : getLatestError(db, rigId, row.node_id),
    // Extended fields
    model: row.model,
    agentRef: row.agent_ref,
    profile: row.profile,
    resolvedSpecName: row.resolved_spec_name,
    resolvedSpecVersion: row.resolved_spec_version,
    resolvedSpecHash: row.resolved_spec_hash,
    cwd: row.cwd,
    restorePolicy: row.restore_policy,
    resumeType: row.resume_type,
    resumeToken: row.resume_token,
    startupCompletedAt: row.startup_completed_at,
  }));
}

/**
 * Get detailed node information including startup files, resources, and events.
 * The adapter dependency is optional — when provided, uses live listInstalled;
 * otherwise falls back to projection entries from startup context.
 */
export function getNodeDetail(
  db: Database.Database,
  rigId: string,
  logicalId: string,
  opts?: {
    adapters?: Record<string, RuntimeAdapter>;
    /** Pre-resolved installed resources from adapter.listInstalled() — route layer provides this. */
    installedResourcesOverride?: Array<{ id: string; category: string; targetPath: string }>;
  },
): NodeDetailEntry | null {
  // Get the inventory entry first
  const allEntries = getNodeInventory(db, rigId);
  const entry = allEntries.find((e) => e.logicalId === logicalId);
  if (!entry) return null;

  // Find the node ID
  const nodeRow = db.prepare(
    "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?"
  ).get(rigId, logicalId) as { id: string } | undefined;
  if (!nodeRow) return null;
  const nodeId = nodeRow.id;

  // Binding
  const bindingRow = db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeId) as BindingRow | undefined;
  const binding: Binding | null = bindingRow ? {
    id: bindingRow.id,
    nodeId,
    attachmentType: (bindingRow.attachment_type as Binding["attachmentType"]) ?? "tmux",
    tmuxSession: bindingRow.tmux_session,
    tmuxWindow: bindingRow.tmux_window,
    tmuxPane: bindingRow.tmux_pane,
    externalSessionName: bindingRow.external_session_name ?? null,
    cmuxWorkspace: bindingRow.cmux_workspace,
    cmuxSurface: bindingRow.cmux_surface,
    updatedAt: bindingRow.updated_at,
  } : null;

  // Startup context
  const ctxRow = db.prepare(
    "SELECT * FROM node_startup_context WHERE node_id = ?"
  ).get(nodeId) as StartupContextRow | undefined;

  const startupFiles = ctxRow ? JSON.parse(ctxRow.resolved_files_json) : [];
  const startupActions = ctxRow ? JSON.parse(ctxRow.startup_actions_json) : [];
  const projectionEntries = ctxRow ? JSON.parse(ctxRow.projection_entries_json) : [];

  // Installed resources: override (from async adapter call) > projection fallback
  let installedResources: NodeDetailEntry["installedResources"];
  if (opts?.installedResourcesOverride) {
    installedResources = opts.installedResourcesOverride;
  } else if (opts?.adapters?.[entry.runtime ?? ""] && binding) {
    // Adapter is available — caller should have pre-resolved via listInstalled (async).
    // If caller passed adapters but not override, try sync call for test compatibility.
    try {
      const adapter = opts.adapters[entry.runtime ?? ""]!;
      const nodeBinding = { ...binding, cwd: entry.cwd ?? "." };
      const resources = adapter.listInstalled(nodeBinding) as unknown;
      // Handle both sync (test mocks) and Promise (real adapters)
      if (Array.isArray(resources)) {
        installedResources = (resources as Array<{ effectiveId: string; category: string; installedPath: string }>).map((r) => ({
          id: r.effectiveId,
          category: r.category,
          targetPath: r.installedPath,
        }));
      } else {
        // Async — fall through to projection
        installedResources = mapProjectionEntries(projectionEntries);
      }
    } catch {
      installedResources = mapProjectionEntries(projectionEntries);
    }
  } else {
    // Projection fallback
    installedResources = mapProjectionEntries(projectionEntries);
  }

  // Recent events (last 20 for this node)
  const eventRows = db.prepare(
    "SELECT * FROM events WHERE node_id = ? ORDER BY seq DESC LIMIT 20"
  ).all(nodeId) as EventRow[];

  const recentEvents = eventRows.map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload); } catch { /* empty */ }
    return {
      type: r.type,
      createdAt: r.created_at,
      payload,
    };
  });

  // Infrastructure startup command
  let infrastructureStartupCommand: string | null = null;
  if (entry.nodeKind === "infrastructure" && startupActions.length > 0) {
    const sendTextAction = startupActions.find((a: { type: string }) => a.type === "send_text");
    if (sendTextAction) {
      infrastructureStartupCommand = sendTextAction.value;
    }
  }

  // Peers: other nodes in the same rig
  const peers: NodeDetailPeer[] = allEntries
    .filter((e) => e.logicalId !== logicalId)
    .map((e) => ({
      logicalId: e.logicalId,
      canonicalSessionName: e.canonicalSessionName,
      attachmentType: e.attachmentType,
      runtime: e.runtime,
    }));

  // Edges: outgoing and incoming for this node
  const edgeRows = db.prepare(
    "SELECT e.kind, e.source_id, e.target_id, src.logical_id as src_logical, tgt.logical_id as tgt_logical " +
    "FROM edges e " +
    "JOIN nodes src ON src.id = e.source_id " +
    "JOIN nodes tgt ON tgt.id = e.target_id " +
    "WHERE e.rig_id = ? AND (e.source_id = ? OR e.target_id = ?)"
  ).all(rigId, nodeId, nodeId) as Array<{ kind: string; source_id: string; target_id: string; src_logical: string; tgt_logical: string }>;

  const nodeSessionMap = new Map(allEntries.map((e) => [e.logicalId, e.canonicalSessionName]));
  const outgoing: NodeDetailEdge[] = [];
  const incoming: NodeDetailEdge[] = [];
  for (const row of edgeRows) {
    if (row.source_id === nodeId) {
      outgoing.push({ kind: row.kind, to: { logicalId: row.tgt_logical, sessionName: nodeSessionMap.get(row.tgt_logical) ?? null } });
    }
    if (row.target_id === nodeId) {
      incoming.push({ kind: row.kind, from: { logicalId: row.src_logical, sessionName: nodeSessionMap.get(row.src_logical) ?? null } });
    }
  }

  // Compact spec summary
  const compactSpec: NodeDetailCompactSpec = {
    name: entry.resolvedSpecName,
    version: entry.resolvedSpecVersion,
    profile: entry.profile,
    skillCount: installedResources.filter((r) => r.category === "skill" || r.category === "skills").length,
    guidanceCount: installedResources.filter((r) => r.category === "guidance" || r.category === "guidance_merge").length,
  };

  return {
    ...entry,
    binding,
    startupFiles,
    startupActions,
    installedResources,
    recentEvents,
    infrastructureStartupCommand,
    peers,
    edges: { outgoing, incoming },
    transcript: { enabled: false, path: null, tailCommand: null }, // populated by route handler
    compactSpec,
  };
}

/**
 * Context-aware wrapper: returns inventory with context usage attached.
 * Uses one daemon-owned ContextUsageStore for all reads.
 */
export function getNodeInventoryWithContext(
  db: Database.Database,
  rigId: string,
  contextUsageStore: ContextUsageStore,
): NodeInventoryEntry[] {
  const entries = getNodeInventory(db, rigId);

  // Find node IDs for batch read
  const nodeRows = db.prepare(
    "SELECT id, logical_id FROM nodes WHERE rig_id = ?"
  ).all(rigId) as Array<{ id: string; logical_id: string }>;
  const nodeIdByLogicalId = new Map(nodeRows.map((r) => [r.logical_id, r.id]));

  const contextEntries = entries.map((e) => ({
    nodeId: nodeIdByLogicalId.get(e.logicalId) ?? "",
    currentSessionName: e.canonicalSessionName,
  }));

  const contextMap = contextUsageStore.getForNodes(contextEntries);

  return entries.map((e) => {
    const nodeId = nodeIdByLogicalId.get(e.logicalId) ?? "";
    return { ...e, contextUsage: contextMap.get(nodeId) ?? contextUsageStore.unknownUsage("no_data") };
  });
}

/**
 * Context-aware wrapper: returns node detail with context usage attached.
 */
export function getNodeDetailWithContext(
  db: Database.Database,
  rigId: string,
  logicalId: string,
  contextUsageStore: ContextUsageStore,
  opts?: Parameters<typeof getNodeDetail>[3],
): NodeDetailEntry | null {
  const detail = getNodeDetail(db, rigId, logicalId, opts);
  if (!detail) return null;

  const nodeRow = db.prepare(
    "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?"
  ).get(rigId, logicalId) as { id: string } | undefined;

  if (nodeRow) {
    detail.contextUsage = contextUsageStore.getForNode(nodeRow.id, detail.canonicalSessionName);
  } else {
    detail.contextUsage = contextUsageStore.unknownUsage("no_data");
  }

  return detail;
}
