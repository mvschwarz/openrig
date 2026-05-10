import nodePath from "node:path";
import type { StartupBlock } from "./types.js";
import { classifyResourceProjection } from "./conflict-detector.js";
import type { ResolvedNodeConfig, QualifiedResource, ResolvedResources } from "./profile-resolver.js";
import type { ResourceCollision } from "./agent-resolver.js";

// -- Types --

export type ProjectionClassification = "safe_projection" | "managed_merge" | "hash_conflict" | "no_op";

export interface ProjectionEntry {
  category: "skill" | "guidance" | "subagent" | "plugin" | "runtime_resource";
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resourcePath: string;
  absolutePath: string;
  resourceType?: string;
  classification: ProjectionClassification;
  conflictDetail?: { reason: string; existingHash?: string; sourceHash?: string };
  mergeStrategy?: "managed_block" | "append";
  target?: string;
}

export interface ProjectionPlan {
  runtime: string;
  cwd: string;
  entries: ProjectionEntry[];
  startup: StartupBlock;
  conflicts: ProjectionEntry[];
  noOps: ProjectionEntry[];
  diagnostics: string[];
}

export interface ProjectionFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
}

export interface ProjectionInput {
  config: ResolvedNodeConfig;
  collisions: ResourceCollision[];
  fsOps: ProjectionFsOps;
  /** Optional: resolve target path for conflict detection. If absent, all entries are safe_projection. */
  resolveTargetPath?: (category: string, effectiveId: string, cwd: string) => string | null;
}

export type PlanResult =
  | { ok: true; plan: ProjectionPlan }
  | { ok: false; errors: string[] };

// -- Category mapping --

const CATEGORY_MAP: Record<string, ProjectionEntry["category"]> = {
  skills: "skill",
  guidance: "guidance",
  subagents: "subagent",
  plugins: "plugin",
  runtimeResources: "runtime_resource",
};

// -- Public API --

/**
 * Plan the effective runtime projection for one resolved node.
 * @param input - resolved config, collision diagnostics, and filesystem ops
 * @returns projection plan or errors
 */
export function planProjection(input: ProjectionInput): PlanResult {
  const { config, collisions, fsOps } = input;
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const entries: ProjectionEntry[] = [];

  // Check for import/import ambiguity in selected resources
  const ambiguityErrors = checkAmbiguity(config.selectedResources, collisions);
  if (ambiguityErrors.length > 0) {
    return { ok: false, errors: ambiguityErrors };
  }

  // Record collision diagnostics
  for (const col of collisions) {
    if (col.sources.length >= 2) {
      diagnostics.push(`Collision in ${col.category}: "${col.resourceId}" declared by ${col.sources.map((s) => s.specName).join(", ")}`);
    }
  }

  // Plan each resource category
  for (const [catKey, catSingular] of Object.entries(CATEGORY_MAP)) {
    const resources = config.selectedResources[catKey as keyof ResolvedResources] as QualifiedResource[];
    for (const qr of resources) {
      // Runtime resource filtering
      if (catKey === "runtimeResources") {
        const rr = qr.resource as { runtime: string; type?: string };
        if (rr.runtime !== config.runtime) continue;
      }

      // Plugins use a different shape: { id, source: { kind, path } } — extract path from source
      let resourcePath: string;
      let absolutePath: string;
      if (catKey === "plugins") {
        const pluginSource = (qr.resource as { source: { kind: string; path: string } }).source;
        resourcePath = pluginSource.path;
        // Plugin paths may be absolute (vendored at ~/.openrig/plugins/) or relative to spec root
        absolutePath = nodePath.isAbsolute(resourcePath) ? resourcePath : nodePath.resolve(qr.sourcePath, resourcePath);
      } else {
        resourcePath = (qr.resource as { path: string }).path;
        absolutePath = nodePath.resolve(qr.sourcePath, resourcePath);
      }

      const entry: ProjectionEntry = {
        category: catSingular,
        effectiveId: qr.effectiveId,
        sourceSpec: qr.sourceSpec,
        sourcePath: qr.sourcePath,
        resourcePath,
        absolutePath,
        classification: "safe_projection",
      };

      if (catKey === "runtimeResources") {
        entry.resourceType = (qr.resource as { type?: string }).type;
      }

      // Guidance-specific
      if (catKey === "guidance") {
        const g = qr.resource as { target?: string; merge?: string };
        entry.target = g.target;
        entry.mergeStrategy = g.merge as "managed_block" | "append" | undefined;
      }

      // Classify using hash-based conflict detection
      if (input.resolveTargetPath) {
        const targetPath = input.resolveTargetPath(catSingular, qr.effectiveId, config.cwd);
        if (targetPath) {
          entry.classification = classifyResourceProjection(
            entry.absolutePath,
            targetPath,
            catSingular,
            entry.mergeStrategy,
            fsOps,
          );
          if (entry.classification === "hash_conflict") {
            entry.conflictDetail = {
              reason: `${catSingular} "${qr.effectiveId}" exists at target with different content`,
            };
          }
        }
      }
      // Without resolveTargetPath, classification stays safe_projection (deferred to adapter)

      entries.push(entry);
    }
  }

  // Sort deterministically: by category then effectiveId
  entries.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    return catCmp !== 0 ? catCmp : a.effectiveId.localeCompare(b.effectiveId);
  });

  const conflicts = entries.filter((e) => e.classification === "hash_conflict");
  const noOps = entries.filter((e) => e.classification === "no_op");

  return {
    ok: true,
    plan: {
      runtime: config.runtime,
      cwd: config.cwd,
      entries,
      startup: config.startup,
      conflicts,
      noOps,
      diagnostics,
    },
  };
}

// -- Ambiguity guard --

function checkAmbiguity(selected: ResolvedResources, collisions: ResourceCollision[]): string[] {
  const errors: string[] = [];

  // Check each category separately — collisions are category-scoped
  const categoryEntries: Array<{ category: string; resources: QualifiedResource[] }> = [
    { category: "skills", resources: selected.skills },
    { category: "guidance", resources: selected.guidance },
    { category: "subagents", resources: selected.subagents },
    { category: "plugins", resources: selected.plugins },
    { category: "runtimeResources", resources: selected.runtimeResources },
  ];

  for (const { category, resources } of categoryEntries) {
    for (const qr of resources) {
      // Only check unqualified ids (no colon)
      if (qr.effectiveId.includes(":")) continue;

      // Find matching collision IN THE SAME CATEGORY
      const collision = collisions.find((c) => c.category === category && c.resourceId === qr.effectiveId);
      if (!collision || collision.sources.length < 2) continue;

      // Check if base owns the unqualified id
      const baseOwner = collision.sources.find((s) => s.qualifiedId === collision.resourceId);
      if (baseOwner) continue; // base owns it — not ambiguous

      // No base owner — import/import ambiguity
      errors.push(
        `Ambiguous resource "${qr.effectiveId}" in selected resources: declared by ${collision.sources.map((s) => s.specName).join(", ")}. Use a qualified id like "${collision.sources[0]!.qualifiedId}"`
      );
    }
  }

  return errors;
}

// Classification is now handled via classifyResourceProjection from conflict-detector.ts
// when resolveTargetPath is provided. Without it, entries default to safe_projection.
