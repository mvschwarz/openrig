// release-0.3.2 slice 12 — scope CLI primitive types.
//
// Aligned with the substrate convention at
// `openrig-work/conventions/scope-and-versioning/README.md` (stage:
// provisional, authored 2026-05-15). The CLI mints stable dot-IDs
// into created mission/slice frontmatter per §1 of that convention.

/** Scope tiers. v0 ships `mission` + `slice`; `project` and `sub-slice`
 *  exist in the grammar but have no CLI verbs yet. */
export type ScopeTier = "project" | "mission" | "slice" | "sub-slice";

/** Stable reference ID parts. `OPR.0.3.2.12` → project="OPR",
 *  version="0.3.2", n=12. Escape-band non-release missions look like
 *  `OPR.99.0.1` → version="99.0.1", n=undefined. */
export interface DotId {
  project: string;       // 2-3 letter project prefix
  version: string;       // semver-shaped (release) or escape-band (99.x.y)
  n?: number;            // slice ordinal
  m?: number;            // sub-slice ordinal
}

export interface MissionInfo {
  /** Mission folder name (e.g., "release-0.3.2", "backlog"). */
  name: string;
  /** Absolute path to the mission folder. */
  absPath: string;
  /** Path to the mission's README.md, if present. */
  readmePath: string | null;
  /** Parsed frontmatter from the README. */
  frontmatter: Record<string, unknown>;
  /** Minted dot-ID for this mission (read from frontmatter if present,
   *  otherwise inferred from the folder name pattern). */
  id: string | null;
  activeSliceCount: number;
  closedSliceCount: number;
}

export interface SliceInfo {
  name: string;          // folder name like "12-rig-slice-cli-primitive"
  absPath: string;
  readmePath: string | null;
  frontmatter: Record<string, unknown>;
  /** "NN-slug" → NN. */
  nn: number | null;
  /** "NN-slug" → slug. */
  slug: string | null;
  missionName: string;
  /** Minted dot-ID, parent.NN form. */
  id: string | null;
  /** Frontmatter `status` field, lowercased. */
  status: string | null;
}

/** 3-part error shape per `building-agent-software` skill §3.6. */
export class ScopeCliError extends Error {
  readonly fact: string;
  readonly consequence: string;
  readonly action: string;
  constructor(opts: { fact: string; consequence: string; action: string }) {
    super(`${opts.fact}\n${opts.consequence}\n${opts.action}`);
    this.name = "ScopeCliError";
    this.fact = opts.fact;
    this.consequence = opts.consequence;
    this.action = opts.action;
  }
}

export type SliceState = "active" | "closed" | "shipped" | "all";
export type SliceTemplateKind =
  | "placeholder"
  | "bug-fix"
  | "backlog-deprecation"
  | "backlog-tech-debt"
  | "release-feature"
  | "research";
export const SLICE_TEMPLATE_KINDS: ReadonlyArray<SliceTemplateKind> = [
  "placeholder",
  "bug-fix",
  "backlog-deprecation",
  "backlog-tech-debt",
  "release-feature",
  "research",
];

export type MissionTemplateKind = "placeholder" | "release";
export const MISSION_TEMPLATE_KINDS: ReadonlyArray<MissionTemplateKind> = [
  "placeholder",
  "release",
];

export type CloseReason = "wontfix" | "deferred" | "superseded" | "stale";
export const CLOSE_REASONS: ReadonlyArray<CloseReason> = [
  "wontfix",
  "deferred",
  "superseded",
  "stale",
];
