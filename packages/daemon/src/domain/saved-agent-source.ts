import nodePath from "node:path";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { reanchorShippedProjectionEntry } from "./builtin-startup-files.js";

/** Where a seat's last launch read its resources from, as its saved startup context records them. */
export interface SavedAgentSources {
  entries: ReadonlyArray<{ sourcePath: string; absolutePath: string }>;
  resolvedStartupFiles: ReadonlyArray<{ ownerRoot: string }>;
}

/** A seat's agent spec, found where its last launch read it. The rig root a `local:` ref resolved against isn't recorded,
 *  so the candidates are the folders the saved projection entries and startup files came from (and an absolute `path:`
 *  ref). Only a folder holding an `agent.yaml` whose spec name is the node's resolved spec name counts, and exactly one
 *  must: anything else is reported, never guessed from the cwd or the rig's name. */
export function findSavedAgentSource(
  node: { agentRef?: string | null; resolvedSpecName?: string | null },
  saved: SavedAgentSources,
  fsOps: AgentResolverFsOps,
): { ok: true; source: Extract<ReturnType<typeof resolveAgentRef>, { ok: true }> } | { ok: false; error: string } {
  const candidates = new Set<string>();
  if (node.agentRef?.startsWith("path:")) candidates.add(node.agentRef.slice("path:".length));
  for (const entry of saved.entries) candidates.add(reanchorShippedProjectionEntry(entry).sourcePath);
  for (const file of saved.resolvedStartupFiles) candidates.add(file.ownerRoot);
  const sources = [...candidates]
    .filter((root) => nodePath.isAbsolute(root) && fsOps.exists(nodePath.join(root, "agent.yaml")))
    .map((root) => resolveAgentRef(`path:${root}`, root, fsOps))
    .flatMap((result) => result.ok && result.resolved.spec.name === node.resolvedSpecName ? [result] : []);
  const unique = new Map(sources.map((source) => [source.resolved.sourcePath, source]));
  if (unique.size !== 1) {
    return { ok: false, error: unique.size === 0
      ? `The seat's agent spec (${node.resolvedSpecName ?? node.agentRef}) wasn't found where its last launch read it.`
      : `The seat's agent spec (${node.resolvedSpecName}) was found in more than one place: ${[...unique.keys()].join(", ")}.` };
  }
  return { ok: true, source: [...unique.values()][0]! };
}
