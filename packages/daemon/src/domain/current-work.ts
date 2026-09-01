/**
 * OPR.0.5.8.14 — derive the seat's current work node from the queue rows it holds.
 *
 * The only consumer today is `queue whoami`, which refocus reads so a returning agent
 * gets the intent of the mission and slice it actually owns. The derivation is
 * deliberately refusal-first: it answers ONLY when the seat's typed rows point at exactly
 * one work node. Anything else returns null with a named basis, because a guessed work
 * node is worse than an honest gap — it silently re-points a whole refocus at the wrong
 * outcome.
 *
 * Two properties are load-bearing and neither is obvious from the tag alone:
 *
 * 1. The canonical queue tags are `mission:<directory>` + `slice:<dot-id>`, e.g.
 *    `mission:release-0.5.8` + `slice:OPR.0.5.8.14`. All new handoffs use that pair.
 *    Some historical rows tag the mission by its SPEC frontmatter id instead, so the
 *    mission join also accepts that legacy form purely for compatibility — refusing an
 *    existing row would be the guess-refusal firing on good data. The legacy form is
 *    never the convention to reach for and is labelled as compat wherever it surfaces.
 *    (orch-lead ruling relayed 2026-09-01 09:43Z.)
 *
 * 2. There are two ambiguity checks and they run in a deliberate order.
 *
 *    WITHIN a row, a malformed baton is rejected up front, before any resolution: a row
 *    carrying two different mission values (or two different slice values) is not a
 *    well-formed baton at all, and rejecting malformed input is this module's job. Those
 *    rows never reach resolution.
 *
 *    ACROSS rows, resolution runs BEFORE counting and is failure-first. If every typed
 *    row resolves, ambiguity is judged on the resolved NODES rather than the raw tag
 *    strings, so two rows naming one slice through different forms collapse to one piece
 *    of work instead of reading as a conflict. But if any typed row fails to resolve, the
 *    answer is a refusal — an unresolved baton is unknown, not irrelevant, and letting the
 *    rows that happened to resolve carry the answer is precisely the guess this module
 *    exists to prevent. A basis-string disclosure does not discharge it: consumers read
 *    workNodePath, not the prose beside it.
 *
 *    Note the resolve-then-compare machinery below COULD tell you that two spellings name
 *    one directory. The within-row check does not use it, and that is a choice about what
 *    a valid baton is, not a limitation.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./slices/slice-indexer.js";

const MISSION_TAG = "mission:";
const SLICE_TAG = "slice:";

type MatchForm = "directory name" | "frontmatter id";

/**
 * How a match is described to a reader. The canonical tag pair is
 * `mission:<directory>` + `slice:<dot-id>`; anything else resolved here is compatibility
 * for rows already on the board, and says so, so nobody reads a basis string as a
 * convention to copy.
 */
function describeMatch(level: "mission" | "slice", form: MatchForm): string {
  if (level === "mission") {
    return form === "directory name"
      ? "canonical directory-name tag"
      : "legacy id-form tag (compat)";
  }
  return form === "frontmatter id"
    ? "canonical id tag"
    : "directory-name tag (compat)";
}

export interface CurrentWork {
  mission: string;
  slice: string;
  workNodePath: string;
  basis: string;
}

export interface CurrentWorkDerivation {
  currentWork: CurrentWork | null;
  /** Always present. Names why the answer is what it is, including every refusal. */
  currentWorkBasis: string;
}

interface TaggedRow {
  state?: string | null;
  tags?: string[] | null;
  /** Optional, but the production call site passes full queue items so it is populated
   *  there. A refusal that names the offending ROW is one command from actionable; one
   *  that names only the values leaves the reader to go find which row meant it. */
  qitemId?: string | null;
}

/** How a row is referred to in a refusal. Falls back cleanly when no id was supplied. */
function rowLabel(qitemId?: string | null): string {
  return qitemId ? `row ${qitemId}` : "a row";
}

/**
 * Only in-progress rows are considered — a ruled decision, not an oversight. But the
 * refusal has to say so: a seat whose one typed baton is BLOCKED holds real work, and
 * "you have no typed work" would be true about the query while false about the world.
 * "You hold nothing" and "your work is parked" call for different next actions, so the
 * string names the scope rather than implying an empty desk.
 */
const NO_TYPED_IN_PROGRESS =
  "no typed in-progress work (only in-progress rows are considered; a typed row that is " +
  "pending or blocked is not current work)";

interface Match {
  dir: string;
  form: MatchForm;
}

/**
 * Every DISTINCT non-empty value carried under `prefix` on one row.
 *
 * The tags column is persisted verbatim and nothing upstream enforces one value per
 * prefix, so array position carries no meaning. Taking the first match would make the
 * answer depend on insertion order — reversing the array would select a different slice.
 * Returning the set instead lets the caller refuse a genuinely conflicting row. Exact
 * duplicate strings collapse, because they are one value written twice.
 */
function tagValues(tags: string[], prefix: string): string[] {
  const values = tags
    .filter((t) => t.startsWith(prefix))
    .map((t) => t.slice(prefix.length).trim())
    .filter((v) => v.length > 0);
  return [...new Set(values)];
}

/**
 * Directories directly under `root` addressed by `wanted` — either because the directory
 * is named that, or because its SPEC.md frontmatter `id` is that. A directory can only
 * match once, so a name hit short-circuits its own frontmatter read.
 */
function resolveDirs(root: string, wanted: string): Match[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: Match[] = [];
  for (const dir of entries.sort()) {
    if (dir === wanted) {
      out.push({ dir, form: "directory name" });
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, dir, "SPEC.md"), "utf8");
    } catch {
      continue;
    }
    if (parseFrontmatter(raw)["id"] === wanted) out.push({ dir, form: "frontmatter id" });
  }
  return out;
}

interface Candidate {
  mission: string;
  slice: string;
  workNodePath: string;
  basis: string;
}

/** Resolve one typed row to a work node, or to the reason it could not be resolved. */
function resolveRow(
  missionsRoot: string,
  mission: string,
  slice: string,
): { ok: true; value: Candidate } | { ok: false; reason: string } {
  const missionMatches = resolveDirs(missionsRoot, mission);
  if (missionMatches.length !== 1) {
    return {
      ok: false,
      reason: `mission ${mission} resolves to ${missionMatches.length} directories`,
    };
  }
  const missionMatch = missionMatches[0]!;

  const slicesRoot = path.join(missionsRoot, missionMatch.dir, "slices");
  const sliceMatches = resolveDirs(slicesRoot, slice);
  if (sliceMatches.length !== 1) {
    return { ok: false, reason: `slice ${slice} resolves to ${sliceMatches.length} directories` };
  }
  const sliceMatch = sliceMatches[0]!;

  return {
    ok: true,
    value: {
      mission,
      slice,
      workNodePath: path.join(slicesRoot, sliceMatch.dir),
      basis:
        `one typed in-progress work node; mission via ${describeMatch("mission", missionMatch.form)}, ` +
        `slice via ${describeMatch("slice", sliceMatch.form)}`,
    },
  };
}

export function deriveCurrentWork(
  rows: TaggedRow[],
  missionsRoot: string | null,
): CurrentWorkDerivation {
  const refuse = (currentWorkBasis: string): CurrentWorkDerivation => ({
    currentWork: null,
    currentWorkBasis,
  });

  if (!missionsRoot) return refuse("no missions root configured");

  const typed: { mission: string; slice: string; qitemId?: string | null }[] = [];
  const conflicts: string[] = [];
  for (const r of rows) {
    if (r.state !== "in-progress") continue;
    const tags = r.tags ?? [];
    const missions = tagValues(tags, MISSION_TAG);
    const slices = tagValues(tags, SLICE_TAG);
    // A row missing either prefix is not a typed baton at all, so it is not this
    // derivation's business and never contributes a conflict.
    if (missions.length === 0 || slices.length === 0) continue;
    // Values are sorted for the message too, not just deduped: an order-dependent
    // explanation of an order-independence refusal would still be leaking array position.
    if (missions.length > 1) {
      conflicts.push(
        `${rowLabel(r.qitemId)} carries ${missions.length} distinct mission tags (${[...missions].sort().join(", ")})`,
      );
      continue;
    }
    if (slices.length > 1) {
      conflicts.push(
        `${rowLabel(r.qitemId)} carries ${slices.length} distinct slice tags (${[...slices].sort().join(", ")})`,
      );
      continue;
    }
    typed.push({ mission: missions[0]!, slice: slices[0]!, qitemId: r.qitemId });
  }

  // Conflicts outrank a usable sibling for the same reason an unresolved row does: the
  // seat's typed work is not unambiguous, and that is the whole precondition for answering.
  // This refuses even when the two values would resolve to one directory. Not because the
  // module could not check — resolveRow and the byPath dedupe below do exactly that across
  // rows — but because a single row naming its mission twice, differently, is MALFORMED,
  // and refusing malformed input is this module's job. Resolving it would be repairing a
  // caller's bad row on its behalf and calling the repair an answer.
  if (conflicts.length > 0) {
    return refuse(`conflicting typed tags: ${[...new Set(conflicts)].sort().join("; ")}`);
  }
  if (typed.length === 0) return refuse(NO_TYPED_IN_PROGRESS);

  // Resolve first, then count: different tag forms for one node must collapse to one node.
  const byPath = new Map<string, Candidate>();
  const failures: string[] = [];
  for (const { mission, slice, qitemId } of typed) {
    const resolved = resolveRow(missionsRoot, mission, slice);
    if (resolved.ok) {
      if (!byPath.has(resolved.value.workNodePath)) {
        byPath.set(resolved.value.workNodePath, resolved.value);
      }
    } else {
      const reason = `${rowLabel(qitemId)} — ${resolved.reason}`;
      if (!failures.includes(reason)) failures.push(reason);
    }
  }

  // A typed row that did not resolve is UNKNOWN, never irrelevant. Answering from the rows
  // that happened to resolve would treat "I could not tell what this is" as "this does not
  // count" — the exact guess this derivation exists to refuse. Disclosing it in the basis
  // is not sufficient, because the consumer reads workNodePath and not the prose beside it.
  // So any resolution failure refuses outright, and the cross-form dedupe below is reached
  // only when EVERY typed row resolved.
  if (failures.length > 0) {
    return refuse(`typed work did not resolve: ${failures.join("; ")}`);
  }
  if (byPath.size > 1) {
    return refuse(`${byPath.size} distinct typed work nodes — refusing to guess`);
  }

  const only = [...byPath.values()][0];
  if (!only) return refuse("no typed in-progress work resolved to a work node");
  return { currentWork: only, currentWorkBasis: only.basis };
}
