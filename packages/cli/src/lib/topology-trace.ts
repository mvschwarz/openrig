// OPR.0.5.3.6 — the productized chain-file trace (CE-v2).
//
// The topology tree carries derived context at three shipped altitudes
// (founder P1: skip the pod level), instance at the TOP of the root (D2):
//
//   <topology.root>/<NAME>                          — instance
//   <topology.root>/rigs/<rig>/<NAME>               — rig
//   <topology.root>/rigs/<rig>/seats/<seat>/<NAME>  — seat
//
// The root comes from the typed `topology.root` config key — never a literal
// (D1). The pre-convention location (resolveLegacyTopologyRigsRoot) stays
// readable as a per-level fallback that MUST surface the named advisory: the
// read succeeds, and the caller is told the content came from the legacy tree
// and how to migrate. The legacy literal lives in ONE helper here (the CLI
// twin of the daemon settings-store's resolveLegacyTopologyRigsRoot), so the
// walk itself carries no path literal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLegacyTopologyRigsRoot } from "../config-store.js";

export type TraceAltitude = "instance" | "rig" | "seat";

export interface TraceLevel {
  altitude: TraceAltitude;
  /** The canonical path under topology.root for this level. */
  path: string;
  /** Where content was actually found: canonical, the legacy tree, or nowhere. */
  source: "topology.root" | "legacy" | "absent";
  /** The path the content was read from (canonical or legacy); null when absent. */
  resolvedPath: string | null;
  content: string | null;
  /** Present exactly when source === "legacy" — the named advisory. */
  advisory?: string;
}

export interface TraceResult {
  name: string;
  topologyRoot: string;
  /** Root-first: instance, rig, seat — general to specific, one file per level. */
  levels: TraceLevel[];
}

export interface TraceFs {
  exists(path: string): boolean;
  read(path: string): string;
}

/** r2-B3: rig, seat, and name must each be ONE safe path segment. Unvalidated
 *  values joined into filesystem paths let `--rig ../../outside` resolve every
 *  level OUTSIDE topology.root (proven by the reviewer's discriminator).
 *  Rejection happens BEFORE any filesystem contact. Dotted filenames
 *  (a.b.c.md) and dashed/underscored ids stay valid; separators, dot-segments,
 *  empties, and NULs do not. */
function assertSafeSegment(value: string, field: "rig" | "seat" | "name"): void {
  if (
    value.length === 0
    || value === "." || value === ".."
    || value.includes("/") || value.includes("\\")
    || value.includes("\0")
  ) {
    throw new Error(
      `invalid ${field} "${value}": must be a single path segment (no separators or dot-segments)`,
    );
  }
}

const realFs: TraceFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, "utf-8"),
};

/**
 * Walk the topology tree for one chain filename. `seat` is optional (a
 * rig-level trace stops at the rig altitude). Pure given `fs` — tests inject.
 */
export function traceTopologyChain(input: {
  topologyRoot: string;
  name: string;
  rig: string;
  seat?: string | null;
  legacyRigsRoot?: string;
  fs?: TraceFs;
}): TraceResult {
  assertSafeSegment(input.rig, "rig");
  if (input.seat) assertSafeSegment(input.seat, "seat");
  assertSafeSegment(input.name, "name");

  const fs = input.fs ?? realFs;
  const legacyRigsRoot = input.legacyRigsRoot ?? resolveLegacyTopologyRigsRoot();

  const levels: Array<{ altitude: TraceAltitude; canonical: string; legacy: string | null }> = [
    // The instance altitude IS the root of the tree — no legacy equivalent
    // existed (the legacy layout began at rigs/).
    { altitude: "instance", canonical: join(input.topologyRoot, input.name), legacy: null },
    {
      altitude: "rig",
      canonical: join(input.topologyRoot, "rigs", input.rig, input.name),
      legacy: join(legacyRigsRoot, input.rig, input.name),
    },
    ...(input.seat
      ? [{
          altitude: "seat" as const,
          canonical: join(input.topologyRoot, "rigs", input.rig, "seats", input.seat, input.name),
          legacy: join(legacyRigsRoot, input.rig, "seats", input.seat, input.name),
        }]
      : []),
  ];

  return {
    name: input.name,
    topologyRoot: input.topologyRoot,
    levels: levels.map(({ altitude, canonical, legacy }): TraceLevel => {
      if (fs.exists(canonical)) {
        return { altitude, path: canonical, source: "topology.root", resolvedPath: canonical, content: fs.read(canonical) };
      }
      if (legacy && fs.exists(legacy)) {
        return {
          altitude,
          path: canonical,
          source: "legacy",
          resolvedPath: legacy,
          content: fs.read(legacy),
          advisory:
            `legacy-topology-read: ${altitude}-level "${input.name}" was found at the pre-convention location ` +
            `${legacy} — not under topology.root (${input.topologyRoot}). The read succeeded; migrate this file ` +
            `to ${canonical} (see the chain-file convention doc; \`rig config get topology.root\` names the root).`,
        };
      }
      return { altitude, path: canonical, source: "absent", resolvedPath: null, content: null };
    }),
  };
}
