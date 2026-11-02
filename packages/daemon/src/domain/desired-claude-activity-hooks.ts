import { dirname, isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveProfileRuntimeResources } from "./profile-resolver.js";

/** What the seat's CURRENT authored specification selects for Claude activity
 * hooks: `known` when the agent file and profile resolve, `unknown` when they
 * cannot be read — never a guess. Shared by restore-check (diagnostics) and
 * restore (recovery): one resolution, no duplicated copies. */
export type DesiredClaudeActivityHooks =
  | { status: "known"; selected: boolean }
  | { status: "unknown"; evidence: string };

/** Resolve the current selection from an agent reference and profile. A
 * relative agent reference has no retained authoritative launch root here, so
 * it resolves to `unknown` rather than guessing from cwd or rig name. */
export function resolveDesiredClaudeActivityHooks(
  agentRef: string | null,
  profile: string | null,
  fsOps: AgentResolverFsOps,
): DesiredClaudeActivityHooks {
  if (!agentRef?.startsWith("path:") || !isAbsolute(agentRef.slice(5)) || !profile) {
    return { status: "unknown", evidence: "Current agent reference/profile has no established absolute source location" };
  }
  const resolved = resolveAgentRef(agentRef, dirname(agentRef.slice(5)), fsOps);
  if (!resolved.ok) return { status: "unknown", evidence: "Current agent specification could not be resolved" };
  const selected = resolveProfileRuntimeResources(resolved.resolved, resolved.imports, profile);
  if (!selected.ok) return { status: "unknown", evidence: selected.errors.join("; ") };
  return {
    status: "known",
    selected: selected.resources.some(({ resource }) =>
      "type" in resource && resource.type === "claude_activity_hooks" && "runtime" in resource && resource.runtime === "claude-code"),
  };
}

/** Read the live node record and resolve its current selection. A missing row
 * resolves to `unknown`: the caller reports the gap instead of projecting. */
export function createDesiredClaudeActivityHooksReader(
  db: Database.Database,
  fsOps: AgentResolverFsOps,
): (nodeId: string) => DesiredClaudeActivityHooks {
  return (nodeId) => {
    const node = db.prepare("SELECT agent_ref, profile FROM nodes WHERE id = ?").get(nodeId) as
      { agent_ref: string | null; profile: string | null } | undefined;
    return resolveDesiredClaudeActivityHooks(node?.agent_ref ?? null, node?.profile ?? null, fsOps);
  };
}
