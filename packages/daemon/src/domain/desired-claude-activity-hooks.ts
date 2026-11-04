import { dirname, isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveProfileRuntimeResources } from "./profile-resolver.js";
import { findSavedAgentSource, type SavedAgentSources } from "./saved-agent-source.js";

/** What the seat's CURRENT authored specification selects for Claude activity
 * hooks: `known` when the agent file and profile resolve, `unknown` when they
 * cannot be read — never a guess. Shared by restore-check (diagnostics) and
 * restore (recovery): one resolution, no duplicated copies. */
export type DesiredClaudeActivityHooks =
  | { status: "known"; selected: boolean }
  | { status: "unknown"; evidence: string };

/** Resolve the current selection from an agent reference and profile. An absolute `path:` ref is read where it points.
 * Any other ref (a `local:` ref resolved against a rig root that isn't retained) is read where the seat's last launch read
 * its agent spec, from its saved startup context (#1530). When that isn't one exact folder, or there's no saved context,
 * it resolves to `unknown` rather than guessing from cwd or rig name. */
export function resolveDesiredClaudeActivityHooks(
  agentRef: string | null,
  profile: string | null,
  fsOps: AgentResolverFsOps,
  saved?: SavedAgentSources & { resolvedSpecName: string | null },
): DesiredClaudeActivityHooks {
  if (!agentRef || !profile) {
    return { status: "unknown", evidence: "Current agent reference/profile has no established absolute source location" };
  }
  let resolved: Extract<ReturnType<typeof resolveAgentRef>, { ok: true }>;
  if (agentRef.startsWith("path:") && isAbsolute(agentRef.slice(5))) {
    const result = resolveAgentRef(agentRef, dirname(agentRef.slice(5)), fsOps);
    if (!result.ok) return { status: "unknown", evidence: "Current agent specification could not be resolved" };
    resolved = result;
  } else {
    if (!saved) return { status: "unknown", evidence: "Current agent reference/profile has no established absolute source location" };
    const found = findSavedAgentSource({ agentRef, resolvedSpecName: saved.resolvedSpecName }, saved, fsOps);
    if (!found.ok) return { status: "unknown", evidence: found.error };
    resolved = found.source;
  }
  const selected = resolveProfileRuntimeResources(resolved.resolved, resolved.imports, profile);
  if (!selected.ok) return { status: "unknown", evidence: selected.errors.join("; ") };
  return {
    status: "known",
    selected: selected.resources.some(({ resource }) =>
      "type" in resource && resource.type === "claude_activity_hooks" && "runtime" in resource && resource.runtime === "claude-code"),
  };
}

/** Read the live node record and its saved startup context, and resolve its current selection. A missing row resolves to
 * `unknown`: the caller reports the gap instead of projecting. A saved context that can't be read is left out, so a ref
 * that needs it stays `unknown`. */
export function createDesiredClaudeActivityHooksReader(
  db: Database.Database,
  fsOps: AgentResolverFsOps,
): (nodeId: string) => DesiredClaudeActivityHooks {
  return (nodeId) => {
    const node = db.prepare("SELECT agent_ref, profile, resolved_spec_name FROM nodes WHERE id = ?").get(nodeId) as
      { agent_ref: string | null; profile: string | null; resolved_spec_name: string | null } | undefined;
    let saved: (SavedAgentSources & { resolvedSpecName: string | null }) | undefined;
    try {
      const row = db.prepare("SELECT projection_entries_json, resolved_files_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as
        { projection_entries_json: string; resolved_files_json: string } | undefined;
      if (row) saved = { entries: JSON.parse(row.projection_entries_json), resolvedStartupFiles: JSON.parse(row.resolved_files_json),
        resolvedSpecName: node?.resolved_spec_name ?? null };
    } catch { /* unreadable: left out */ }
    return resolveDesiredClaudeActivityHooks(node?.agent_ref ?? null, node?.profile ?? null, fsOps, saved);
  };
}
