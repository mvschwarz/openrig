import { createHash } from "node:crypto";
import type { ProjectionClassification } from "./projection-planner.js";
import type { FsOps } from "./package-resolver.js";
import type { InstallPlan, InstallPlanEntry, ConflictInfo } from "./install-planner.js";

export interface RefinedInstallPlan extends InstallPlan {
  noOps: InstallPlanEntry[];
}

export interface GuidanceConflictMeta {
  hasExistingBlock: boolean;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MANAGED_BLOCK_START = (packageName: string) =>
  `<!-- BEGIN RIGGED MANAGED BLOCK: ${packageName} -->`;
const MANAGED_BLOCK_END = (packageName: string) =>
  `<!-- END RIGGED MANAGED BLOCK: ${packageName} -->`;

/**
 * Refines an InstallPlan with content-aware conflict detection.
 * - Skills/agents: same content = no-op, different content = conflict with hashes
 * - Guidance: detects existing managed blocks for this specific package
 * - Deferred entries (hooks/mcp/requirements) pass through unchanged
 */
export function detectConflicts(
  plan: InstallPlan,
  fs: FsOps,
): RefinedInstallPlan {
  const actionable: InstallPlanEntry[] = [];
  const conflicts: InstallPlanEntry[] = [];
  const deferred: InstallPlanEntry[] = [];
  const noOps: InstallPlanEntry[] = [];
  const allEntries: InstallPlanEntry[] = [];

  for (const entry of plan.entries) {
    // Deferred entries pass through
    if (entry.deferred) {
      deferred.push(entry);
      allEntries.push(entry);
      continue;
    }

    // No sourcePath (e.g., requirements already deferred, but just in case)
    if (!entry.sourcePath) {
      actionable.push(entry);
      allEntries.push(entry);
      continue;
    }

    if (entry.exportType === "skill" || entry.exportType === "agent") {
      if (!entry.conflict) {
        // Target doesn't exist — safe_projection
        actionable.push(entry);
        allEntries.push(entry);
        continue;
      }

      // Target exists — compare content
      try {
        const sourceContent = fs.readFile(entry.sourcePath);
        const targetContent = fs.readFile(entry.targetPath);
        const sourceHash = hashContent(sourceContent);
        const existingHash = hashContent(targetContent);

        if (sourceHash === existingHash) {
          // Same content — no-op
          noOps.push({ ...entry, conflict: undefined });
          allEntries.push({ ...entry, conflict: undefined });
        } else {
          // Different content — enriched conflict
          const enriched: InstallPlanEntry = {
            ...entry,
            conflict: {
              existingPath: entry.targetPath,
              existingHash,
              sourceHash,
              reason: `${entry.exportType} '${entry.exportName}' exists with different content`,
            } as ConflictInfo & { existingHash: string; sourceHash: string },
          };
          conflicts.push(enriched);
          allEntries.push(enriched);
        }
      } catch {
        // Can't read files — treat as conflict
        conflicts.push(entry);
        allEntries.push(entry);
      }
    } else if (entry.exportType === "guidance") {
      // Check for existing managed block
      if (entry.classification === "managed_merge" && fs.exists(entry.targetPath)) {
        const targetContent = fs.readFile(entry.targetPath);
        const beginMarker = MANAGED_BLOCK_START(plan.packageName);
        const endMarker = MANAGED_BLOCK_END(plan.packageName);
        const hasExistingBlock = targetContent.includes(beginMarker) && targetContent.includes(endMarker);

        const refined: InstallPlanEntry & { guidanceMeta?: GuidanceConflictMeta } = {
          ...entry,
          guidanceMeta: { hasExistingBlock },
        } as InstallPlanEntry & { guidanceMeta: GuidanceConflictMeta };

        actionable.push(refined);
        allEntries.push(refined);
      } else {
        actionable.push(entry);
        allEntries.push(entry);
      }
    } else {
      actionable.push(entry);
      allEntries.push(entry);
    }
  }

  return {
    ...plan,
    entries: allEntries,
    actionable,
    deferred,
    conflicts,
    noOps,
  };
}

// -- Projection-specific conflict classification (AgentSpec reboot) --

interface ProjectionFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
}

/**
 * Classify a resource projection using hash-based comparison.
 * Returns projection-specific classification states (not legacy ActionClassification).
 * @param sourcePath - absolute path to source resource
 * @param targetPath - absolute path to target location
 * @param category - resource category
 * @param mergeStrategy - guidance merge strategy if applicable
 * @param fsOps - filesystem operations
 * @returns ProjectionClassification
 */
export function classifyResourceProjection(
  sourcePath: string,
  targetPath: string,
  category: string,
  mergeStrategy: string | undefined,
  fsOps: ProjectionFsOps,
): ProjectionClassification {
  // Guidance with managed_block: always managed_merge
  if (category === "guidance" && mergeStrategy === "managed_block") {
    return "managed_merge";
  }

  // Target doesn't exist: safe projection
  if (!fsOps.exists(targetPath)) {
    return "safe_projection";
  }

  // Target exists: compare hashes
  try {
    const sourceContent = fsOps.readFile(sourcePath);
    const targetContent = fsOps.readFile(targetPath);
    const sourceHash = hashContent(sourceContent);
    const targetHash = hashContent(targetContent);

    if (sourceHash === targetHash) {
      return "no_op";
    }
    return "hash_conflict";
  } catch {
    return "hash_conflict";
  }
}
