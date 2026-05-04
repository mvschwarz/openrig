// PL-007 Workspace Primitive v0 — runtime resolution of typed workspace
// context for whoami / node-inventory consumers.
//
// Given a persisted RigSpec.workspace block + a node's cwd + an optional
// per-session env override, derive:
//   - workspaceRoot          — verbatim from the spec
//   - activeRepo             — env override, else default_repo, else null
//   - repos                  — typed list (name, path, kind)
//   - knowledgeRoot, knowledgeKind — verbatim when declared
//
// Per-node kind resolution (used by node-inventory) walks the cwd up the
// directory tree looking for the longest containing repo path; falls back
// to "knowledge" when cwd is under knowledgeRoot, else null.

import * as path from "node:path";
import type { WorkspaceSpec, WorkspaceKind, NodeWorkspaceInfo } from "../types.js";

export interface WhoamiWorkspaceBlock {
  workspaceRoot: string;
  activeRepo: string | null;
  repos: Array<{ name: string; path: string; kind: WorkspaceKind }>;
  knowledgeRoot: string | null;
  knowledgeKind: WorkspaceKind | null;
}

export function resolveWorkspaceContext(opts: {
  spec: WorkspaceSpec | null;
  cwd: string | null;
  envOverride: string | null;
}): WhoamiWorkspaceBlock | null {
  const { spec, envOverride } = opts;
  if (!spec) return null;

  // env override wins when it names a declared repo; otherwise fall through
  // to default_repo. Unknown override is honored verbatim per PL-007 PRD §
  // Item 3 — operators set OPENRIG_TARGET_REPO consciously.
  const repoNames = new Set(spec.repos.map((r) => r.name));
  let activeRepo: string | null = null;
  if (envOverride && envOverride.trim() !== "") {
    activeRepo = envOverride;
  } else if (spec.defaultRepo && repoNames.has(spec.defaultRepo)) {
    activeRepo = spec.defaultRepo;
  }

  return {
    workspaceRoot: spec.workspaceRoot,
    activeRepo,
    repos: spec.repos.map((r) => ({ name: r.name, path: r.path, kind: r.kind })),
    knowledgeRoot: spec.knowledgeRoot ?? null,
    knowledgeKind: spec.knowledgeRoot ? "knowledge" : null,
  };
}

/** PL-007 — per-node workspace summary derived from a node's cwd against
 *  the rig's WorkspaceSpec. Used by NodeInventory. Returns null when the
 *  rig has no workspace declaration. */
export function resolveNodeWorkspace(opts: {
  spec: WorkspaceSpec | null;
  cwd: string | null;
}): NodeWorkspaceInfo | null {
  const { spec, cwd } = opts;
  if (!spec) return null;

  let activeRepo: string | null = null;
  let kind: WorkspaceKind | null = null;
  if (cwd) {
    // Find the longest-prefix repo whose path contains cwd.
    let best: { name: string; kind: WorkspaceKind; len: number } | null = null;
    for (const r of spec.repos) {
      if (isInside(cwd, r.path) && r.path.length > (best?.len ?? -1)) {
        best = { name: r.name, kind: r.kind, len: r.path.length };
      }
    }
    if (best) {
      activeRepo = best.name;
      kind = best.kind;
    } else if (spec.knowledgeRoot && isInside(cwd, spec.knowledgeRoot)) {
      kind = "knowledge";
    }
  }
  // Fall back to the rig's default_repo when cwd doesn't resolve.
  if (!activeRepo && spec.defaultRepo) {
    activeRepo = spec.defaultRepo;
    if (!kind) {
      const r = spec.repos.find((x) => x.name === spec.defaultRepo);
      if (r) kind = r.kind;
    }
  }

  return {
    workspaceRoot: spec.workspaceRoot,
    activeRepo,
    kind,
  };
}

function isInside(child: string, parent: string): boolean {
  const normChild = path.resolve(child);
  const normParent = path.resolve(parent);
  if (normChild === normParent) return true;
  const rel = path.relative(normParent, normChild);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
