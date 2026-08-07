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

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MANAGED_BLOCK_START = (packageName: string) =>
  `<!-- BEGIN OpenRig MANAGED BLOCK: ${packageName} -->`;
const MANAGED_BLOCK_END = (packageName: string) =>
  `<!-- END OpenRig MANAGED BLOCK: ${packageName} -->`;

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
        const legacyBegin = `<!-- BEGIN RIGGED MANAGED BLOCK: ${plan.packageName} -->`;
        const legacyEnd = `<!-- END RIGGED MANAGED BLOCK: ${plan.packageName} -->`;
        const hasExistingBlock =
          (targetContent.includes(beginMarker) && targetContent.includes(endMarker)) ||
          (targetContent.includes(legacyBegin) && targetContent.includes(legacyEnd));

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
  /** P20 — the projector's LAST-written hash for targetPath (manifest), or null.
   *  Optional so legacy 5-arg callers keep P17 behavior (no manifest → hash_conflict).
   *  Consulted fail-closed, BROKEN≠ABSENT: a returned null (no entry) → hash_conflict
   *  (P17 fallback); a THROW (broken read) → operator_conflict (PROTECT — a read
   *  error must never overwrite what might be an operator edit). */
  lastHashLookup?: (targetPath: string) => string | null,
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

    // P20 — target ≠ source. Consult the manifest to discriminate:
    //  - target == what WE last wrote → STALE projection (source advanced) → safe overwrite
    //  - target ≠ our last write (and ≠ source) → OPERATOR-modified → protect
    //  - manifest read ERROR (throw) → BROKEN, not ABSENT → operator_conflict (PROTECT)
    //  - no manifest entry (null) → ABSENT → P17 fallback (hash_conflict, overwrite-with-warning)
    let lastHash: string | null = null;
    if (lastHashLookup) {
      try {
        lastHash = lastHashLookup(targetPath);
      } catch {
        // BROKEN vs ABSENT: a read that THREW is broken — we cannot rule out an
        // operator edit, and hash_conflict WOULD overwrite it. True fail-closed is
        // to PROTECT (operator_conflict), distinct from a returned null (no entry)
        // which is the benign P17 hash_conflict fallback below.
        return "operator_conflict";
      }
    }
    if (lastHash !== null) {
      return targetHash === lastHash ? "stale_overwrite" : "operator_conflict";
    }
    return "hash_conflict";
  } catch {
    return "hash_conflict";
  }
}
