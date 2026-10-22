import type { WorkflowSpec } from "./workflow-types.js";

/**
 * A role's `preferred_targets` entry may end in `@{rig}`, as `member@{rig}`.
 * `{rig}` stands for the instance's bound rig (`--rig`), so one reusable spec
 * addresses the same member on whichever rig it is run against.
 *
 * Only a trailing `@{rig}` is the form. Braces in the member part or inside a
 * longer rig name (`ops-{rig}@rig-a`, `ops-watcher@prefix-{rig}`) stay literal.
 *
 * The cached spec keeps the literal `{rig}`; the expansion is computed from
 * the instance's stored `bound_rig` wherever that instance's spec is read,
 * so projection, resume, recovery and exception routing all see one target.
 * With no bound rig the target stays literal and is handled like any other
 * unknown destination, at the hop that selects it.
 */
export const RIG_PLACEHOLDER = "{rig}";
const RIG_SUFFIX = `@${RIG_PLACEHOLDER}`;

/** True when `target` is written `member@{rig}`. */
export function isRigRelativeTarget(target: string): boolean {
  return target.endsWith(RIG_SUFFIX);
}

/** `member@{rig}` as `member@<boundRig>`; any other target, or no bound rig, is returned as is. */
export function expandRigRelativeTarget(target: string, boundRig: string | null): string {
  if (boundRig === null || !isRigRelativeTarget(target)) return target;
  return target.slice(0, target.length - RIG_PLACEHOLDER.length) + boundRig;
}

/** The spec with each `member@{rig}` target resolved against `boundRig`. Returns
 *  `spec` itself when `boundRig` is null or no target uses the form. */
export function bindSpecToRig(spec: WorkflowSpec, boundRig: string | null): WorkflowSpec {
  if (boundRig === null) return spec;
  const uses = Object.values(spec.roles ?? {}).some((role) => (role?.preferred_targets ?? []).some(isRigRelativeTarget));
  if (!uses) return spec;
  const roles: NonNullable<WorkflowSpec["roles"]> = {};
  for (const [name, role] of Object.entries(spec.roles ?? {})) {
    roles[name] = role?.preferred_targets
      ? { ...role, preferred_targets: role.preferred_targets.map((t) => expandRigRelativeTarget(t, boundRig)) }
      : role;
  }
  return { ...spec, roles };
}
