import nodePath from "node:path";
import { createHash } from "node:crypto";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "./agent-manifest.js";
import type { AgentSpec, AgentResources } from "./types.js";

// -- Types --

export interface AgentResolverFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
}

export interface ResolvedAgentSpec {
  spec: AgentSpec;
  sourcePath: string;
  hash: string;
}

export interface ResourceCollision {
  category: string;
  resourceId: string;
  sources: Array<{ specName: string; qualifiedId: string }>;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedAgentSpec; imports: ResolvedAgentSpec[]; collisions: ResourceCollision[] }
  | { ok: false; code: "not_found"; error: string }
  | { ok: false; code: "parse_error"; error: string }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "version_mismatch"; error: string }
  | { ok: false; code: "import_error"; error: string; importRef: string }
  | { ok: false; code: "cycle_detected"; error: string };

// -- Resource category keys --

const RESOURCE_CATEGORIES: (keyof AgentResources)[] = [
  "skills", "guidance", "subagents", "hooks", "runtimeResources",
];

// -- Public API --

/**
 * Resolve an agent_ref to a concrete AgentSpec, including flat imports.
 * @param ref - agent_ref string (e.g. "local:agents/impl" or "path:/abs/agents/impl")
 * @param rigRoot - absolute path to rig root directory
 * @param fsOps - injectable filesystem operations
 * @returns structured resolve result
 */
export function resolveAgentRef(
  ref: string,
  rigRoot: string,
  fsOps: AgentResolverFsOps,
): ResolveResult {
  const dirPath = resolveRefToAbsPath(ref, rigRoot);
  if (!dirPath) {
    return { ok: false, code: "not_found", error: `Cannot resolve agent_ref "${ref}"` };
  }

  const baseResult = loadSpec(dirPath, fsOps);
  if (!baseResult.ok) return baseResult;

  // Resolve flat imports — import local: refs resolve relative to the base spec's directory
  return resolveWithImports(baseResult.resolved, baseResult.resolved.sourcePath, fsOps, new Set([baseResult.resolved.sourcePath]));
}

/**
 * Resolve imports for an already-loaded AgentSpec.
 * Import local: refs resolve relative to the spec's own directory.
 * @param resolved - already-resolved base spec
 * @param fsOps - injectable filesystem operations
 * @returns structured resolve result with imports and collisions
 */
export function resolveImports(
  resolved: ResolvedAgentSpec,
  fsOps: AgentResolverFsOps,
): ResolveResult {
  return resolveWithImports(resolved, resolved.sourcePath, fsOps, new Set([resolved.sourcePath]));
}

/**
 * Resolve a single agent_ref without following imports. Used for import targets.
 * @param ref - import ref string
 * @param basePath - directory to resolve local: refs relative to
 * @param fsOps - filesystem ops
 * @returns resolved spec or error
 */
function loadSpec(
  dirPath: string,
  fsOps: AgentResolverFsOps,
): { ok: true; resolved: ResolvedAgentSpec } | { ok: false; code: "not_found"; error: string } | { ok: false; code: "parse_error"; error: string } | { ok: false; code: "validation_failed"; errors: string[] } {
  const manifestPath = nodePath.join(dirPath, "agent.yaml");

  if (!fsOps.exists(manifestPath)) {
    return { ok: false, code: "not_found", error: `No agent.yaml found at ${manifestPath}` };
  }

  let rawYaml: string;
  try {
    rawYaml = fsOps.readFile(manifestPath);
  } catch (err) {
    return { ok: false, code: "parse_error", error: `Cannot read ${manifestPath}: ${(err as Error).message}` };
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseAgentSpec(rawYaml);
  } catch (err) {
    return { ok: false, code: "parse_error", error: `Cannot parse ${manifestPath}: ${(err as Error).message}` };
  }

  const validation = validateAgentSpec(raw);
  if (!validation.valid) {
    return { ok: false, code: "validation_failed", errors: validation.errors };
  }

  const spec = normalizeAgentSpec(raw);
  const hash = createHash("sha256").update(rawYaml).digest("hex");

  return {
    ok: true,
    resolved: { spec, sourcePath: dirPath, hash },
  };
}

/**
 * Resolve base spec + flat imports, detect collisions, enforce v1 constraints.
 */
/**
 * Resolve base spec + flat imports. Import local: refs resolve relative to specDir
 * (the importing spec's own directory), not the rig root.
 */
function resolveWithImports(
  base: ResolvedAgentSpec,
  specDir: string,
  fsOps: AgentResolverFsOps,
  visitedPaths: Set<string>,
): ResolveResult {
  const resolvedImports: ResolvedAgentSpec[] = [];
  const importNames = new Set<string>();

  for (const imp of base.spec.imports) {
    // Remote sources already rejected by AS-T01 validation, but double-check at resolve time
    if (!imp.ref.startsWith("local:") && !imp.ref.startsWith("path:")) {
      return { ok: false, code: "import_error", error: `Remote import source not supported in v1: "${imp.ref}"`, importRef: imp.ref };
    }

    const importDir = resolveRefToAbsPath(imp.ref, specDir);
    if (!importDir) {
      return { ok: false, code: "import_error", error: `Cannot resolve import ref "${imp.ref}"`, importRef: imp.ref };
    }

    // Cycle detection
    if (visitedPaths.has(importDir)) {
      return { ok: false, code: "cycle_detected", error: `Import cycle detected: "${imp.ref}" resolves to already-visited path ${importDir}` };
    }

    const importResult = loadSpec(importDir, fsOps);
    if (!importResult.ok) {
      if (importResult.code === "not_found") {
        return { ok: false, code: "import_error", error: importResult.error, importRef: imp.ref };
      }
      if (importResult.code === "validation_failed") {
        return { ok: false, code: "import_error", error: `Imported spec at "${imp.ref}" has validation errors: ${importResult.errors.join("; ")}`, importRef: imp.ref };
      }
      return { ok: false, code: "import_error", error: importResult.error, importRef: imp.ref };
    }

    const importedSpec = importResult.resolved;

    // Version check
    if (imp.version && importedSpec.spec.version !== imp.version) {
      return {
        ok: false, code: "version_mismatch",
        error: `Import "${imp.ref}" requires version "${imp.version}" but spec declares "${importedSpec.spec.version}"`,
      };
    }

    // v1: imported specs must not declare their own imports (no transitive)
    if (importedSpec.spec.imports.length > 0) {
      return {
        ok: false, code: "import_error",
        error: `Imported spec "${importedSpec.spec.name}" declares nested imports, which are not supported in v1`,
        importRef: imp.ref,
      };
    }

    // Imported spec name must not contain colon (conflicts with qualified ref syntax)
    if (importedSpec.spec.name.includes(":")) {
      return {
        ok: false, code: "import_error",
        error: `Imported spec name "${importedSpec.spec.name}" contains colon, which conflicts with qualified ref syntax (namespace:id)`,
        importRef: imp.ref,
      };
    }

    // Duplicate import names
    if (importNames.has(importedSpec.spec.name)) {
      return {
        ok: false, code: "import_error",
        error: `Duplicate import name: two imports resolve to specs both named "${importedSpec.spec.name}"`,
        importRef: imp.ref,
      };
    }
    importNames.add(importedSpec.spec.name);

    resolvedImports.push(importedSpec);
  }

  // Detect resource collisions
  const collisions = detectCollisions(base, resolvedImports);

  return { ok: true, resolved: base, imports: resolvedImports, collisions };
}

// -- Collision detection --

function detectCollisions(base: ResolvedAgentSpec, imports: ResolvedAgentSpec[]): ResourceCollision[] {
  const collisions: ResourceCollision[] = [];

  for (const category of RESOURCE_CATEGORIES) {
    // Build a map of resourceId -> sources
    const idSources = new Map<string, Array<{ specName: string; qualifiedId: string }>>();

    // Base spec resources (unqualified id)
    const baseResources = base.spec.resources[category] as Array<{ id: string }>;
    for (const r of baseResources) {
      const sources = idSources.get(r.id) ?? [];
      sources.push({ specName: base.spec.name, qualifiedId: r.id });
      idSources.set(r.id, sources);
    }

    // Imported spec resources (qualified id)
    for (const imp of imports) {
      const importResources = imp.spec.resources[category] as Array<{ id: string }>;
      for (const r of importResources) {
        const sources = idSources.get(r.id) ?? [];
        sources.push({ specName: imp.spec.name, qualifiedId: `${imp.spec.name}:${r.id}` });
        idSources.set(r.id, sources);
      }
    }

    // Record collisions (any id with 2+ sources)
    for (const [resourceId, sources] of idSources) {
      if (sources.length >= 2) {
        collisions.push({ category, resourceId, sources });
      }
    }
  }

  return collisions;
}

// -- Path resolution --

function resolveRefToAbsPath(ref: string, baseDir: string): string | null {
  if (ref.startsWith("local:")) {
    const relPath = ref.slice("local:".length);
    if (!relPath) return null;
    return nodePath.resolve(baseDir, relPath);
  }
  if (ref.startsWith("path:")) {
    const absPath = ref.slice("path:".length);
    if (!absPath) return null;
    return absPath;
  }
  return null;
}
