import nodePath, { dirname, isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveProfileRuntimeResources } from "./profile-resolver.js";
import { reanchorBuiltinStartupFile } from "./builtin-startup-files.js";
import { RigRepository } from "./rig-repository.js";

/** What the seat's CURRENT authored specification selects for Claude activity
 * hooks: `known` when the agent file and profile resolve, `unknown` when they
 * cannot be read — never a guess. Shared by restore-check (diagnostics) and
 * restore (recovery): one resolution, no duplicated copies. */
export type DesiredClaudeActivityHooks =
  | { status: "known"; selected: boolean }
  | { status: "unknown"; evidence: string };

type ResolvedAgent = Extract<ReturnType<typeof resolveAgentRef>, { ok: true }>;

/** #1530: a `local:` agent ref resolved as at launch. When the node has a validated launch recipe with an absolute
 * `rigRoot`, resolve the current `local:` ref directly against that authoritative root (re-anchored for shipped specs,
 * #261). For legacy nodes without a usable recipe, every rig, pod and member startup file records the launch root as its
 * `ownerRoot`, and launch also records the folder it read the agent from as the owner root of the agent's own startup
 * files, so a folder counts only when the ref lands on a distinct recorded root, holds an `agent.yaml` with the seat's
 * resolved spec name, and is the only one that does (a root resolving the ref back to itself supplies no independent
 * evidence of the agent's source). Where the records can't prove which folder is the seat's spec (an import or author
 * folder can share its name), the answer is an error, never a guess. */
function agentResolvedAgainstRecordedRoots(
  agentRef: string,
  resolvedSpecName: string | null,
  resolvedStartupFiles: readonly unknown[],
  fsOps: AgentResolverFsOps,
  rigRoot?: string | null,
): { ok: true; agent: ResolvedAgent } | { ok: false; error: string } {
  const rel = agentRef.startsWith("local:") ? agentRef.slice("local:".length) : "";
  if (!rel) return { ok: false, error: "Current agent reference/profile has no established absolute source location" };
  if (rigRoot && isAbsolute(rigRoot)) {
    const root = reanchorBuiltinStartupFile({ path: "", absolutePath: nodePath.join(nodePath.resolve(rigRoot, rel), "agent.yaml"), ownerRoot: rigRoot }).ownerRoot;
    const folder = nodePath.resolve(root, rel);
    const result = fsOps.exists(nodePath.join(folder, "agent.yaml"))
      ? resolveAgentRef(`path:${folder}`, folder, fsOps)
      : null;
    if (result?.ok && result.resolved.spec.name === resolvedSpecName) {
      return { ok: true, agent: result };
    }
    return {
      ok: false,
      error: `The seat's agent spec (${resolvedSpecName ?? agentRef}) wasn't found by resolving ${agentRef} against a rig root its last launch recorded`,
    };
  }
  const roots = new Set<string>();
  for (const raw of resolvedStartupFiles) {
    if (!raw || typeof raw !== "object") continue;
    const { path, absolutePath, ownerRoot } = raw as Record<string, unknown>;
    if (typeof path !== "string" || typeof absolutePath !== "string" || typeof ownerRoot !== "string") continue;
    const root = reanchorBuiltinStartupFile({ path, absolutePath, ownerRoot }).ownerRoot;
    if (isAbsolute(root)) roots.add(nodePath.resolve(root));
  }
  let selfResolved = false;
  const folders = new Set([...roots].flatMap((root) => {
    const folder = nodePath.resolve(root, rel);
    if (folder === root) selfResolved = true;
    return folder !== root && roots.has(folder) ? [folder] : [];
  }));
  const agents = [...folders]
    .filter((folder) => fsOps.exists(nodePath.join(folder, "agent.yaml")))
    .map((folder) => resolveAgentRef(`path:${folder}`, folder, fsOps))
    .flatMap((result) => result.ok && result.resolved.spec.name === resolvedSpecName ? [result] : []);
  if (agents.length !== 1) {
    return { ok: false, error: agents.length === 0
      ? folders.size === 0 && selfResolved
        ? `Saved launch records no independent source location for the seat's agent spec (${resolvedSpecName ?? agentRef}) when resolving ${agentRef} against a rig root its last launch recorded`
        : `The seat's agent spec (${resolvedSpecName ?? agentRef}) wasn't found by resolving ${agentRef} against a rig root its last launch recorded`
      : `The seat's agent spec (${resolvedSpecName}) resolved to more than one folder: ${agents.map((agent) => agent.resolved.sourcePath).join(", ")}` };
  }
  return { ok: true, agent: agents[0]! };
}

/** Resolve the current selection from an agent reference and profile. An absolute `path:` ref is read where it points; a
 * `local:` ref is resolved against the rig roots its saved launch recorded (#1530). Anything else, or a `local:` ref that
 * doesn't resolve to exactly one folder holding the seat's spec, resolves to `unknown` rather than guessing. */
export function resolveDesiredClaudeActivityHooks(
  agentRef: string | null,
  profile: string | null,
  fsOps: AgentResolverFsOps,
  saved?: { resolvedSpecName: string | null; resolvedStartupFiles: readonly unknown[]; rigRoot?: string | null },
): DesiredClaudeActivityHooks {
  if (!agentRef || !profile) {
    return { status: "unknown", evidence: "Current agent reference/profile has no established absolute source location" };
  }
  let resolved: ResolvedAgent;
  if (agentRef.startsWith("path:") && isAbsolute(agentRef.slice(5))) {
    const result = resolveAgentRef(agentRef, dirname(agentRef.slice(5)), fsOps);
    if (!result.ok) return { status: "unknown", evidence: "Current agent specification could not be resolved" };
    resolved = result;
  } else {
    if (!saved) return { status: "unknown", evidence: "Current agent reference/profile has no established absolute source location" };
    const found = agentResolvedAgainstRecordedRoots(agentRef, saved.resolvedSpecName, saved.resolvedStartupFiles, fsOps, saved.rigRoot);
    if (!found.ok) return { status: "unknown", evidence: found.error };
    resolved = found.agent;
  }
  const selected = resolveProfileRuntimeResources(resolved.resolved, resolved.imports, profile);
  if (!selected.ok) return { status: "unknown", evidence: selected.errors.join("; ") };
  return {
    status: "known",
    selected: selected.resources.some(({ resource }) =>
      "type" in resource && resource.type === "claude_activity_hooks" && "runtime" in resource && resource.runtime === "claude-code"),
  };
}

/** Read the live node record, its validated launch recipe, and its saved startup files, and resolve its current selection.
 * A missing row resolves to `unknown`: the caller reports the gap instead of projecting. Saved startup files that can't be
 * read are left out, so a legacy `local:` ref without a usable launch recipe stays `unknown`. */
export function createDesiredClaudeActivityHooksReader(
  db: Database.Database,
  fsOps: AgentResolverFsOps,
): (nodeId: string) => DesiredClaudeActivityHooks {
  const rigs = new RigRepository(db);
  return (nodeId) => {
    const node = db.prepare("SELECT agent_ref, profile, resolved_spec_name FROM nodes WHERE id = ?").get(nodeId) as
      { agent_ref: string | null; profile: string | null; resolved_spec_name: string | null } | undefined;
    let rigRoot: string | undefined;
    try {
      const recipe = rigs.getNodeLaunchRecipe(nodeId);
      if (recipe && isAbsolute(recipe.rigRoot)) rigRoot = recipe.rigRoot;
    } catch { /* unreadable: left out */ }
    let resolvedStartupFiles: unknown[] | undefined;
    try {
      const row = db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?").get(nodeId) as
        { resolved_files_json: string } | undefined;
      const parsed: unknown = row ? JSON.parse(row.resolved_files_json) : undefined;
      if (Array.isArray(parsed)) resolvedStartupFiles = parsed;
    } catch { /* unreadable: left out */ }
    return resolveDesiredClaudeActivityHooks(node?.agent_ref ?? null, node?.profile ?? null, fsOps,
      resolvedStartupFiles || rigRoot
        ? { resolvedSpecName: node?.resolved_spec_name ?? null, resolvedStartupFiles: resolvedStartupFiles ?? [], rigRoot }
        : undefined);
  };
}
