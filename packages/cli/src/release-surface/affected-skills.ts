// OPR.0.3.3.13.2 - Skill <-> CLI-surface binding-index lookup (Component 2 of slice 13).
//
// Given a release surface-diff (13.1's deterministic output, surface-diff.ts) and
// a set of skills carrying `metadata.cli_surfaces_referenced`, returns which
// skills are affected by the release. Fully deterministic + offline (AC-4): the
// match is pure set/string ops over the diff + the provided skill index; the
// corpus loader is a plain filesystem read. No network, no agent/LLM - composes
// with 13.1's deterministic half. 13.3 (the dispatcher that WRITES skill
// updates) decides invocation; this stays invocation-agnostic.
//
// Join grammar - ADVISOR-RATIFIED (qitem-20260608235706-64ba9ef2; see the slice
// governance-watch.md SHARP WATCH #1):
//  - Skill tokens are stored WITHOUT the `rig ` prefix, in 13.1's command-path
//    grammar (`scope slice create`, `queue create`). We strip a leading `rig `
//    defensively so a skill written either way still matches.
//  - Changed-surface set: per `added_commands`, `{name}` plus `{name + " " +
//    each subcommand}`; per `added_flags`, `{command}` plus `{command + " " +
//    each subcommand}`. (13.1 emits `added_commands[].name` as a BARE top-level
//    name with deep paths in a separate `subcommands` list, so the set MUST be
//    expanded - a naive name-only intersect false-negatives `scope slice create`.)
//  - Match = COMPONENT-WISE (path-segment) prefix, in EITHER direction (NOT
//    raw-string prefix - so `up` does NOT match `update`). The bias is
//    deliberately conservative: prefix-both-directions OVER-includes, never
//    UNDER-includes, which is exactly right for AC-3's hard no-false-negative
//    floor. Over-inclusions are the "explained extras" AC-3 permits.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { SurfaceDiff } from "./surface-diff.js";

/**
 * Split a command token into path segments, stripping a leading `rig ` and
 * collapsing internal whitespace. `"rig scope slice create"` -> `["scope",
 * "slice", "create"]`; `"queue create"` -> `["queue", "create"]`.
 */
export function toSegments(token: string): string[] {
  const stripped = token.trim().replace(/^rig\s+/, "");
  return stripped.split(/\s+/).filter((segment) => segment.length > 0);
}

/**
 * The section-3 changed-surface set: every command-path string a release touched,
 * expanded from the diff's bare-top-level + subcommand-list grammar. This is
 * the AC-3a target (validated against 13.1's shipped sample diff + fixture).
 */
export function expandChangedSurface(diff: SurfaceDiff): Set<string> {
  const set = new Set<string>();
  for (const cmd of diff.added_commands ?? []) {
    if (cmd.name) set.add(cmd.name);
    for (const sub of cmd.subcommands ?? []) {
      if (sub) set.add(`${cmd.name} ${sub}`);
    }
  }
  for (const entry of diff.added_flags ?? []) {
    if (entry.command) set.add(entry.command);
    for (const sub of entry.subcommands ?? []) {
      if (sub) set.add(`${entry.command} ${sub}`);
    }
  }
  return set;
}

/**
 * Component-wise prefix match in EITHER direction: true iff one segment-list
 * equals OR is a path-segment prefix of the other. Compares segment-by-segment
 * up to the shorter length - so `["scope"]` matches `["scope","slice","create"]`
 * (and vice-versa), but `["up"]` does NOT match `["update"]` (distinct first
 * segment). This is the advisor sharpening over raw-string prefix.
 */
export function pathsMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const shorter = Math.min(a.length, b.length);
  for (let i = 0; i < shorter; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Does a skill token match any path in the changed-surface set? */
export function skillTokenMatches(skillToken: string, changedSurface: Set<string>): boolean {
  const tokenSegments = toSegments(skillToken);
  if (tokenSegments.length === 0) return false;
  for (const changed of changedSurface) {
    if (pathsMatch(tokenSegments, toSegments(changed))) return true;
  }
  return false;
}

export interface SkillIndexEntry {
  /** Skill directory name (the canonical skill id). */
  name: string;
  /** The skill's `metadata.cli_surfaces_referenced` tokens (13.1 grammar). */
  cliSurfacesReferenced: string[];
}

/**
 * AC-3b: the affected-skill output. A skill is affected iff ANY of its
 * `cli_surfaces_referenced` tokens matches the changed-surface set. Returns a
 * sorted, de-duplicated list of skill names - deterministic for a given
 * (diff, skills) pair (AC-4).
 */
export function computeAffectedSkills(diff: SurfaceDiff, skills: SkillIndexEntry[]): string[] {
  const changed = expandChangedSurface(diff);
  const affected = new Set<string>();
  for (const skill of skills) {
    const hit = (skill.cliSurfacesReferenced ?? []).some((token) =>
      skillTokenMatches(token, changed),
    );
    if (hit) affected.add(skill.name);
  }
  return [...affected].sort();
}

/**
 * Parse `metadata.cli_surfaces_referenced` from a SKILL.md frontmatter block.
 * Returns [] when there is no frontmatter, no metadata block, or the field is
 * absent/malformed (a skill with no CLI surfaces simply isn't in the index).
 */
export function parseCliSurfaces(skillMarkdown: string): string[] {
  const match = skillMarkdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  let meta: unknown;
  try {
    meta = parse(match[1]!);
  } catch {
    return [];
  }
  const field = (meta as { metadata?: { cli_surfaces_referenced?: unknown } })
    ?.metadata?.cli_surfaces_referenced;
  if (!Array.isArray(field)) return [];
  return field.filter((value): value is string => typeof value === "string");
}

/**
 * Load the skill index from a skills-root directory (offline fs read). Each
 * immediate subdirectory holding a SKILL.md with a non-empty
 * `cli_surfaces_referenced` becomes one index entry. Sorted by name.
 */
export function loadSkillIndex(skillsRoot: string): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];
  for (const dirent of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    let text: string;
    try {
      text = readFileSync(join(skillsRoot, dirent.name, "SKILL.md"), "utf8");
    } catch {
      continue; // no SKILL.md in this dir
    }
    const tokens = parseCliSurfaces(text);
    if (tokens.length > 0) {
      entries.push({ name: dirent.name, cliSurfacesReferenced: tokens });
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
