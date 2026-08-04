// Slice-03 (OPR.0.4.8.3) Seam B — permission_policy REF resolution + precedence + launch-posture.
// The `permission_policy` value attached to a rig or a seat is a REF (not a policy body). Semantics
// are grounded in Slice03 README v4 (sha256-8 d65afe67), rulings A1/A2/A3 + the Policy/YOLO framing:
//   - `builtin:<name>`, <name> ∈ {locked, standard, open, yolo} (A1): resolves into the packaged
//     read-only built-in set (origin=builtin). Unknown name = STRUCTURED error listing the known
//     set. The `builtin:` prefix is MANDATORY — bare canonical names never resolve (no shadowing).
//   - a RELATIVE custom path (A2), resolved relative to the DECLARING RigSpec dir (origin=custom);
//     absolute / `..` traversal / empty segments = STRUCTURED error (a spec defect, NOT a floor
//     fallback). Reuses the established safe-path discipline (path-safety.validateSafePath).
//   - `none` (A3) is RESERVED → structured error.
//   - ABSENT (no value) = the floor (honest absence) — the CALLER passes undefined; not an error.
// Built-in ASSET packaging is a LATER leg: builtin resolution here is REF-SEMANTICS (prefix→origin),
// it does NOT read or require the asset file to exist.

import * as path from "node:path";
import { validateSafePath } from "../path-safety.js";
import { parsePolicySpec, validatePolicySpec } from "./policy-spec.js";
import type { LaunchPosture, PolicySurface } from "./policy-spec.js";

/** The packaged read-only built-in policy set (README v4: 3 Policy-Mode specs + Operator/YOLO). */
export const BUILTIN_POLICY_NAMES = ["locked", "standard", "open", "yolo"] as const;
export type BuiltinPolicyName = (typeof BUILTIN_POLICY_NAMES)[number];
export type PolicyRefOrigin = "builtin" | "custom";

const BUILTIN_PREFIX = "builtin:";

export interface ResolvedPolicyRef {
  /** The ref string, preserved verbatim (travels with the spec through the state). */
  ref: string;
  origin: PolicyRefOrigin;
  /** Present when origin === "builtin": the validated built-in name. */
  builtinName?: BuiltinPolicyName;
}

function isBuiltinName(name: string): name is BuiltinPolicyName {
  return (BUILTIN_POLICY_NAMES as readonly string[]).includes(name);
}

/**
 * Validate + classify a permission_policy REF. Returns a STRUCTURED error string for an invalid ref
 * (an invalid ref is a spec DEFECT, never a silent floor fallback), or null when valid. ABSENT is the
 * caller's concern (only pass a present value here). `label` prefixes the error for the surfacing
 * layer (matches the RigSpec validate convention, e.g. "permission_policy" / "pods[0].members[1].
 * permission_policy").
 */
export function validatePermissionPolicyRef(value: unknown, label: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return `${label}: permission_policy must be a non-empty string ref`;
  }
  if (value === "none") {
    return `${label}: 'none' is reserved for the deliberate-none representation landing with the onboarding leg`;
  }
  if (value.startsWith(BUILTIN_PREFIX)) {
    const name = value.slice(BUILTIN_PREFIX.length);
    if (!isBuiltinName(name)) {
      return `${label}: unknown built-in policy '${name}' (known: ${BUILTIN_POLICY_NAMES.join(", ")})`;
    }
    return null;
  }
  // Anti-shadowing (A1: "no canonical-name shadowing, ever"): a BARE canonical name must NOT
  // masquerade as a custom ref — that would silently mis-resolve origin (and, for `yolo`, silently
  // downgrade full_bypass→floor). Require the explicit builtin: prefix.
  if (isBuiltinName(value)) {
    return `${label}: '${value}' is a built-in policy name — use 'builtin:${value}' (the builtin: prefix is mandatory; bare names never resolve, no shadowing)`;
  }
  // Custom relative ref — the established safe-path discipline (absolute / .. rejected)…
  const pathErr = validateSafePath(value, label);
  if (pathErr) return pathErr;
  // …plus the explicit empty-segment rejection (README v4 A2) that validateSafePath does not cover.
  const segments = value.replace(/\\/g, "/").split("/");
  if (segments.some((seg) => seg.length === 0)) {
    return `${label}: empty path segments are not allowed (got "${value}")`;
  }
  // README v4 A2 per-segment charset (the established ref discipline — same class as the
  // rig-context day-one contract): every segment is a single safe path component.
  for (const seg of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(seg)) {
      return `${label}: path segment "${seg}" violates the ref charset (each segment must match [A-Za-z0-9][A-Za-z0-9._-]*)`;
    }
  }
  return null;
}

/**
 * Classify a VALID ref (call validatePermissionPolicyRef first). Preserves + surfaces origin, never
 * silently reclassifies (origin honesty). Never throws on a validated ref.
 */
export function classifyPermissionPolicyRef(value: string): ResolvedPolicyRef {
  if (value.startsWith(BUILTIN_PREFIX)) {
    return { ref: value, origin: "builtin", builtinName: value.slice(BUILTIN_PREFIX.length) as BuiltinPolicyName };
  }
  return { ref: value, origin: "custom" };
}

/**
 * A restart-stable resolved attachment (dev-guard early ruling, 2026-08-04): persisting only the raw
 * relative ref is NOT restart-complete. We carry the raw `ref` (for export truth + later skill apply)
 * PLUS `resolvedTarget` (canonical package identifier for built-ins; the absolute resolved path for
 * custom) + `declaringDir` (custom) + `origin`, so a restore can reopen/validate the custom policy
 * and re-derive surface + launch_posture without the original in-memory RigSpec.
 */
export interface ResolvedPolicyAttachment {
  /** Raw ref, preserved verbatim for export + skill apply. */
  ref: string;
  origin: PolicyRefOrigin;
  /** origin=builtin: the validated built-in name. */
  builtinName?: BuiltinPolicyName;
  /** custom: the absolute resolved path. builtin: the canonical shipped package-copy path once the
   * packaging leg rules it (PM lane c76c7153) — ABSENT until then; NEVER a `builtin:<name>` echo of
   * the raw ref (dev-guard correction 2: the ref is persisted separately for export; duplicating it
   * here is not restart-stable provenance). */
  resolvedTarget?: string;
  /** origin=custom: the canonical (absolute) declaring RigSpec directory — restart-stable provenance. */
  declaringDir?: string;
  /** The resolved policy surface, when content was resolvable (custom) or known (built-in). */
  surface?: PolicySurface;
  /** Flag-surface launch posture for per-seat binding (floor | full_bypass). */
  launchPosture: LaunchPosture;
  /** Guard round-2 (8232199a): TRUE only when custom CONTENT resolution genuinely
   *  succeeded with USABLE semantics — parse OK + known surface + (flag ⇒ a valid
   *  launch_posture). Restore trusts a re-derivation ONLY when this is true; otherwise
   *  the PERSISTED posture carries. Builtins: always true (name-derived semantics). */
  contentResolved: boolean;
}

/** Injected reader so resolution is testable + does not hard-couple the module to fs. Throws when
 *  the target is missing/unreadable (resolver treats that as an advisory floor, provenance kept). */
export interface PolicyResolveDeps {
  readFile: (absolutePath: string) => string;
}

/**
 * The SINGLE mapping point for the built-in policies' canonical shipped package-copy path —
 * PM-RULED (inline ruling via dev-guard NOT-CLEAR at 9e94c274, lane c76c7153):
 *   repo source (future):   packages/daemon/policies/builtin/<name>.policy.md
 *   provenance target:      policies/builtin/<name>.policy.md  (package-relative;
 *                           module-relative at runtime)
 * The raw `builtin:<name>` ref stays separate (export truth); this target is the restart-
 * stable provenance. Built-in CONTENT stays a later leg — no asset read or copy here.
 */
export function builtinPackageTarget(name: BuiltinPolicyName): string {
  return `policies/builtin/${name}.policy.md`;
}

/**
 * Resolve a VALIDATED, present ref (call validatePermissionPolicyRef first) into a restart-stable
 * attachment. `declaringDir` is the canonical directory of the RigSpec that declared the ref (custom
 * refs resolve relative to it — README v4 A2). Flag-surface CONTENT resolution is CORE-owned (guard
 * ruling): a custom `surface: flag` policy's `launch_posture` (floor|full_bypass) is read here.
 *   - built-in: name-derived posture bounded to the locked set (yolo → full_bypass, else floor);
 *     origin + canonical `builtin:<name>` target preserved. Package ASSET existence is a later leg.
 *   - custom: resolve relative to declaringDir, read + parse (Seam A), derive surface; flag →
 *     its launch_posture; config → floor (config-surface CONTENT application is deferred to the
 *     skill; no config write here). Unreadable/invalid → advisory floor, provenance still preserved.
 */
export function resolvePermissionPolicyAttachment(
  ref: string,
  declaringDir: string,
  deps: PolicyResolveDeps,
): ResolvedPolicyAttachment {
  if (ref.startsWith(BUILTIN_PREFIX)) {
    const builtinName = ref.slice(BUILTIN_PREFIX.length) as BuiltinPolicyName;
    return {
      ref,
      origin: "builtin",
      builtinName,
      resolvedTarget: builtinPackageTarget(builtinName),
      surface: builtinName === "yolo" ? "flag" : undefined,
      launchPosture: builtinName === "yolo" ? "full_bypass" : "floor",
      contentResolved: true,
    };
  }
  // Custom ref: resolve relative to the declaring RigSpec directory (never cwd/workspace root).
  const resolvedTarget = path.resolve(declaringDir, ref);
  let surface: PolicySurface | undefined;
  let launchPosture: LaunchPosture = "floor";
  let contentResolved = false;
  try {
    const parsed = parsePolicySpec(deps.readFile(resolvedTarget));
    if (!("error" in parsed)) {
      const s = parsed.frontmatter["surface"];
      if (s === "flag" || s === "config") surface = s;
      // R2 HIGH-2: content is RESOLVED only when the COMPLETE sealed Seam-A frontmatter
      // contract validates (validatePolicySpec: surface-appropriate required fields,
      // action-list shapes, schema version, description, …) — parseable-but-invalid
      // content must NOT be trusted over persisted posture. Advisory read only.
      const contract = validatePolicySpec(parsed.frontmatter);
      if (contract.ok && surface === "flag") {
        const lp = parsed.frontmatter["launch_posture"];
        if (lp === "floor" || lp === "full_bypass") {
          launchPosture = lp;
          contentResolved = true;
        }
      } else if (contract.ok && surface === "config") {
        contentResolved = true; // valid config semantics; posture floor is genuine
      }
      // invalid contract or unknown surface → NOT resolved (advisory floor, provenance kept)
    }
  } catch {
    // Unreadable/unresolvable at resolve time → advisory floor; ref + provenance still preserved.
  }
  return { ref, origin: "custom", resolvedTarget, declaringDir, surface, launchPosture, contentResolved };
}

/**
 * Precedence: a per-member ref overrides the rig-level ref; absence at both is undefined (= floor).
 * member > rig > floor (README v4 + IMPL-PLAN). No pod level exists in the spec surface.
 */
export function resolvePermissionPolicyRefValue(
  memberRef: string | null | undefined,
  rigRef: string | null | undefined,
): string | undefined {
  return (memberRef ?? undefined) ?? (rigRef ?? undefined);
}
