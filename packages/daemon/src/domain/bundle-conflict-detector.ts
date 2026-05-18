/**
 * Bundle conflict detector (Item 3 / slice-05 Checkpoint 4.1).
 *
 * Pure function. Compares a bundle's declared identifiers against the daemon's
 * current state and returns a structured conflict report. Callers (route
 * handlers in Checkpoint 4.2) provide the daemon state (listRigs() etc.); the
 * detector itself has no daemon dependencies — fully unit-testable.
 *
 * Fails CLOSED: the conflict list is the source of truth. Missing or ambiguous
 * input is treated as no-conflict-detectable, NOT as bypass — Items 4.2+ will
 * surface ambiguity as a conflict where appropriate. This commit ships the
 * rig-name collision check only; agent / port / managed-app / sibling-primitive
 * checks land in Checkpoint 4.3 + 4.4.
 *
 * Extends, does NOT replace, the existing 409 "install already in progress"
 * guard at /api/bundles/install (concurrency lock) per PRD Item 3 §
 * "extends, does NOT replace".
 */

/** A rig-name collision: bundle declares a rig name that a currently-running rig already uses. */
export interface RigNameCollision {
  kind: "rig_name_collision";
  /** Name declared by the bundle's rig spec. */
  bundleRigName: string;
  /** Identity of the running rig that holds the same name. */
  collisionWith: { rigId: string; rigName: string };
  /** Human-readable summary suitable for the 3-part error description line. */
  description: string;
  /** Operator-actionable resolutions (3-part error what-to-do line). */
  resolutions: string[];
}

/** Discriminated union over all conflict kinds. Extends in Checkpoint 4.3+. */
export type BundleConflict = RigNameCollision;

/** Result of a conflict check. */
export interface ConflictReport {
  conflicts: BundleConflict[];
  hasConflicts: boolean;
}

/** Input to detectBundleConflicts. Pure data; no daemon handles. */
export interface DetectConflictsInput {
  /** Rig name declared in the bundle's rig spec (rig.yaml `name:` field). */
  bundleRigName: string;
  /** Snapshot of currently-running rigs from rigRepo.listRigs(). */
  runningRigs: Array<{ rigId: string; name: string }>;
}

/**
 * Run the conflict checks for an install candidate. Returns the full conflict
 * list (Checkpoint 4.2 returns it via /install --plan; --apply blocks on
 * non-empty unless --force).
 */
export function detectBundleConflicts(input: DetectConflictsInput): ConflictReport {
  const conflicts: BundleConflict[] = [];

  // Rig-name collision: bundle declares a name a running rig already holds.
  // O(n) scan over runningRigs — acceptable for the seat-scale rig counts the
  // daemon manages (tens, not thousands).
  if (input.bundleRigName && input.bundleRigName.length > 0) {
    for (const rig of input.runningRigs) {
      if (rig.name === input.bundleRigName) {
        conflicts.push({
          kind: "rig_name_collision",
          bundleRigName: input.bundleRigName,
          collisionWith: { rigId: rig.rigId, rigName: rig.name },
          description: `bundle declares rig name '${input.bundleRigName}' but a running rig with this name already exists (rigId: ${rig.rigId})`,
          resolutions: [
            "use --target <newname> on install to rename the rig on install (lands at Checkpoint 4.2)",
            `stop the running rig first (e.g. rig down ${rig.name}) and re-attempt install`,
            "use --force on install for an operator-explicit override (lands at Checkpoint 4.2; NOT recommended for routine use)",
          ],
        });
        break;
      }
    }
  }

  return { conflicts, hasConflicts: conflicts.length > 0 };
}
