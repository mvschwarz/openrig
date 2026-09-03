import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";

type Mapping = Record<string, unknown>;

export interface LifecycleMissionMember {
  ref: string;
  normalizedRef: string;
  order: number;
  active: boolean;
  path: string;
}

export class LifecycleManifestValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LifecycleManifestValidationError";
  }
}

/**
 * The one strict reader for mission composition membership. Read surfaces and
 * scope mutation planning consume this exact parser, so a manifest cannot be
 * actionable in one path and malformed in another.
 */
export function validateMissionComposition(
  mission: unknown,
  missionPath: string,
): LifecycleMissionMember[] {
  if (!isMapping(mission) || mission.kind !== "mission") {
    throw issue("lifecycle_manifest_kind_mismatch", `${missionPath}: expected kind mission`, { missionPath, actual: isMapping(mission) ? mission.kind : null });
  }
  if (!isMapping(mission.composition) || !Array.isArray(mission.composition.slices)) {
    throw issue("lifecycle_membership_missing", `${missionPath}: composition.slices must be a list`, { missionPath });
  }
  const missionDir = resolve(missionPath, "..");
  const missionReal = realpathSync(missionDir);
  const refs = new Set<string>();
  const orders = new Set<number>();
  let priorOrder = Number.NEGATIVE_INFINITY;
  return mission.composition.slices.map((raw, index) => {
    if (!isMapping(raw)) {
      throw issue("lifecycle_membership_invalid", `${missionPath}: composition.slices[${index}] must be a mapping`, { missionPath, index });
    }
    if (typeof raw.ref !== "string" || raw.ref.length === 0) {
      throw issue("lifecycle_field_missing", `${missionPath}: composition.slices[${index}].ref must be a non-empty string`, { missionPath, index });
    }
    const normalizedRef = normalize(raw.ref);
    if (isAbsolute(raw.ref) || normalizedRef.split(sep).includes("..")) {
      throw issue("lifecycle_path_escape", `${missionPath}: composition.slices[${index}].ref must be a safe relative path without '..'`, { missionPath, index, ref: raw.ref });
    }
    if (refs.has(normalizedRef)) {
      throw issue("lifecycle_membership_duplicate", `${missionPath}: duplicate slice ref ${raw.ref}`, { missionPath, ref: raw.ref });
    }
    if (typeof raw.order !== "number" || !Number.isInteger(raw.order)) {
      throw issue("lifecycle_order_invalid", `${missionPath}: ${raw.ref} requires an integer order`, { missionPath, ref: raw.ref, value: raw.order });
    }
    if (orders.has(raw.order) || raw.order <= priorOrder) {
      throw issue("lifecycle_order_invalid", `${missionPath}: slice orders must be unique and strictly increasing; ${raw.ref} has ${raw.order} after ${priorOrder}`, { missionPath, ref: raw.ref, order: raw.order, priorOrder });
    }
    const target = resolve(missionDir, normalizedRef);
    if (!existsSync(target)) {
      throw issue("lifecycle_member_missing", `${missionPath}: ${raw.ref} does not exist at ${target}`, { missionPath, ref: raw.ref, target });
    }
    if (lstatSync(target).isSymbolicLink()) {
      throw issue("lifecycle_member_symlink", `${missionPath}: ${raw.ref} may not be a symlink`, { missionPath, ref: raw.ref, target });
    }
    const targetReal = realpathSync(target);
    if (targetReal !== missionReal && !targetReal.startsWith(`${missionReal}${sep}`)) {
      throw issue("lifecycle_path_escape", `${missionPath}: ${raw.ref} escapes the mission root`, { missionPath, ref: raw.ref, target: targetReal });
    }
    refs.add(normalizedRef);
    orders.add(raw.order);
    priorOrder = raw.order;
    return { ref: raw.ref, normalizedRef, order: raw.order, active: raw.active !== false, path: targetReal };
  });
}

function isMapping(value: unknown): value is Mapping {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function issue(code: string, message: string, details?: Record<string, unknown>): LifecycleManifestValidationError {
  return new LifecycleManifestValidationError(code, message, details);
}
