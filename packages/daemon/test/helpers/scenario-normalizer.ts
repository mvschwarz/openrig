/**
 * Slice 51-03 — the DECLARATIVE cross-surface normalizer (the `equals` mapping).
 *
 * A-N1 fixed the shape of this: the declarative mapping is the ONLY scenario-facing
 * form, and it LOWERS to the runner-internal seam
 * (`normalizer?: (surface, value) => unknown`) rather than replacing it. So this
 * module is purely additive — it builds that callback from YAML. The seam
 * signature is untouched and the runner's equals branch is unchanged.
 *
 * The problem it solves: the shipped surfaces answer in structurally different
 * shapes, so raw comparison always differs. `rig ps --json` is an array of rig
 * records; `rig queue list --json` is an array of qitems whose destinationSession
 * is `<pod>-<member>@<rig>`. Comparing them requires DECLARING which field of each
 * carries the shared truth — that declaration is what a normalizer is.
 *
 *   equals:
 *     ps:    { pluck: name }                          # -> ["scn-baton"]
 *     queue: { pluck: destinationSession, rig: true } # -> ["scn-baton"]
 *
 * Projections are deliberately tiny and total: pluck a field from each element of
 * an array surface, optionally reduce a session name to its rig, then dedupe and
 * sort so the comparison is order-insensitive (two surfaces agreeing on a SET
 * should not fail because they enumerate it differently).
 */

import type { ExpectSurface } from "./scenario-schema.js";

/** One surface's declared projection onto the shared comparison form. */
export interface SurfaceProjection {
  /** Field to take from each element of an array surface (e.g. `name`). */
  pluck?: string;
  /** Reduce a canonical session name (`<pod>-<member>@<rig>`) to its rig part. */
  rig?: boolean;
  /** Read a nested field from an OBJECT surface before projecting (dot path). */
  path?: string;
}

/** The declarative `equals` mapping: surface -> projection. */
export type EqualsMapping = Partial<Record<ExpectSurface, SurfaceProjection>>;

/** True when an `equals` payload is the declarative MAPPING form (not the legacy list). */
export function isEqualsMapping(payload: unknown): payload is EqualsMapping {
  return !!payload && typeof payload === "object" && !Array.isArray(payload);
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/** `dev-worker@scn-baton` -> `scn-baton`. Left unchanged when there is no `@`. */
export function rigOf(session: string): string {
  const at = session.lastIndexOf("@");
  return at < 0 ? session : session.slice(at + 1);
}

/** Apply one surface's declared projection. Total: never throws on a shape it did not expect. */
export function projectSurface(value: unknown, spec: SurfaceProjection): unknown {
  const base = spec.path ? readPath(value, spec.path) : value;
  if (!spec.pluck) return base;
  const items = Array.isArray(base) ? base : [base];
  const plucked = items
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[spec.pluck!] : undefined))
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => (spec.rig ? rigOf(v) : v));
  // Set semantics: dedupe + sort, so agreement on the SET is not defeated by order
  // or by one surface listing the same rig twice (N qitems, one rig).
  return [...new Set(plucked)].sort();
}

/**
 * Lower a declarative mapping onto the runner-internal seam (A-N1). Surfaces the
 * mapping does not mention pass through unchanged, so a partially-declared
 * comparison still behaves predictably rather than silently emptying.
 */
export function buildDeclarativeNormalizer(
  mapping: EqualsMapping,
): (surface: ExpectSurface, value: unknown) => unknown {
  return (surface, value) => {
    const spec = mapping[surface];
    return spec ? projectSurface(value, spec) : value;
  };
}
