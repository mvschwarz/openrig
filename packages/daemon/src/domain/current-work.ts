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
import type Database from "better-sqlite3";
import { parseFrontmatter } from "./slices/slice-indexer.js";
import { reanchorBuiltinStartupFile } from "./builtin-startup-files.js";

export interface RoleOrientation {
  state: "unknown" | "no-record" | "not-declared" | "missing" | "present";
  reason?: string;
  recordedAt?: string;
  note?: string;
  files: Array<{
    path: string;
    absolutePath: string;
    ownerRoot: string;
    resolvedPath: string;
    resolvedOwnerRoot: string;
    state: "present" | "missing" | "unknown";
  }>;
}

/** Read the caller's explicit role bindings, not startup content or a guessed basename. */
export function deriveRole(db: Database.Database | undefined, nodeId: string | null): RoleOrientation {
  const unknown = (reason: string): RoleOrientation => ({ state: "unknown", reason, files: [] });
  if (!db || !nodeId) return unknown("calling node unavailable");
  try {
    const row = db.prepare("SELECT resolved_files_json, created_at FROM node_startup_context WHERE node_id = ?")
      .get(nodeId) as { resolved_files_json: string; created_at: string } | undefined;
    if (!row) return { state: "no-record", files: [] };
    const entries: unknown = JSON.parse(row.resolved_files_json);
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== "object"
      || Array.isArray(entry) || (entry.orientation !== undefined && entry.orientation !== "role"))) {
      return unknown("malformed startup record");
    }
    const marked = entries.filter(entry => entry.orientation === "role");
    if (marked.some(entry => [entry.path, entry.absolutePath, entry.ownerRoot]
      .some(value => typeof value !== "string" || !value.trim())
      || !path.isAbsolute(entry.absolutePath) || !path.isAbsolute(entry.ownerRoot))) {
      return unknown("malformed role binding");
    }
    const files: RoleOrientation["files"] = marked.map(entry => {
      const resolved = reanchorBuiltinStartupFile(entry);
      let state: "present" | "missing" | "unknown";
      try { state = fs.statSync(resolved.absolutePath).isFile() ? "present" : "missing"; }
      catch (error) {
        state = ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ? "missing" : "unknown";
      }
      return { path: entry.path, absolutePath: entry.absolutePath, ownerRoot: entry.ownerRoot,
        resolvedPath: resolved.absolutePath, resolvedOwnerRoot: resolved.ownerRoot, state };
    });
    return {
      state: files.some(file => file.state === "unknown") ? "unknown"
        : files.some(file => file.state === "missing") ? "missing" : files.length ? "present" : "not-declared",
      recordedAt: row.created_at,
      note: "Timestamp is the startup-context record write/attempt, not verified successful launch or current-byte equivalence to the spec.",
      files,
    };
  } catch { return unknown("startup record unavailable or malformed"); }
}

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
export function resolveWorkNodeDirs(root: string, wanted: string): Match[] {
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
  const missionMatches = resolveWorkNodeDirs(missionsRoot, mission);
  if (missionMatches.length !== 1) {
    return {
      ok: false,
      reason: `mission ${mission} resolves to ${missionMatches.length} directories`,
    };
  }
  const missionMatch = missionMatches[0]!;

  const slicesRoot = path.join(missionsRoot, missionMatch.dir, "slices");
  const sliceMatches = resolveWorkNodeDirs(slicesRoot, slice);
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

/**
 * OPR.0.7.0.12 — labelled work candidates, BESIDE the strict derivation above, never
 * loosening it. deriveCurrentWork answers "which one node is this seat's work" and refuses
 * anything short of certainty; this answers "what evidence does the queue hold", so the
 * refocus packet can show it and let the AGENT decide. Nothing here picks a winner:
 * candidates are evidence the agent may correct, and the absence of evidence is reported as
 * such rather than filled with the project root.
 *
 * - An in-progress row's own `mission:` tag (with or without `slice:`) is a direct candidate,
 *   labelled with that tag as its source. A tag that does not resolve on this host is named,
 *   never swapped for a same-named directory found some other way.
 * - An in-progress row with no mission tag offers its handoff ancestry: the nearest local
 *   ancestor's mission tag, as a labelled candidate. A retargeted handoff (new body, no tags)
 *   or an ancestor that is not on this host gives no assumed mission.
 * - Pending rows are possible next work; blocked rows are held work with their blocker and
 *   continuation. No order is implied between them.
 * - A mission named only in body text is never evidence.
 */
export interface WorkCandidate {
  kind: "tag" | "ancestry";
  qitemId: string | null;
  mission: string;
  slice: string | null;
  /** The slice node when the slice resolves, else the mission node; null when the mission does not. */
  workNodePath: string | null;
  intent: string | null;
  source: string;
  /** Why the tag did not fully resolve on this host, when it did not. */
  unresolved: string | null;
}

export interface WorkCandidates {
  missionsRoot: string | null;
  candidates: WorkCandidate[];
  /** In-progress rows whose work the queue cannot name. */
  unknown: Array<{ qitemId: string | null; summary: string | null; reason: string }>;
  next: Array<{ qitemId: string | null; summary: string | null; missions: string[] }>;
  held: Array<{ qitemId: string | null; summary: string | null; blockedOn: string | null; continuation: string | null }>;
  /** Mission directories on this host, bounded, so an agent can name one without guessing. */
  missionsOnHost: string[];
  missionsOnHostTruncated: boolean;
}

interface CandidateRow extends TaggedRow {
  summary?: string | null;
  body?: string | null;
  blockedOn?: string | null;
  handedOffFrom?: string | null;
  chainOfRecord?: string[] | null;
}

export interface WorkCandidateLookups {
  /** A row by id on this host, or null when it is not here (remote or removed). */
  getRow: (qitemId: string) => CandidateRow | null;
  /** The recorded park continuation of a blocked row, or null. */
  continuationOf: (qitemId: string) => string | null;
}

const MISSIONS_ON_HOST_LIMIT = 30;

const BLOCK_SCALAR = new Set(["|", ">", "|-", ">-", "|+", ">+"]);

/**
 * The one-line `intent:` from SPEC.md frontmatter, read the way trace-to-root.py's `intent()`
 * reads it: a block scalar (`>-`, `|`, …) joins its indented lines with spaces, and wrapping
 * quotes are removed. parseFrontmatter is line-by-line and would return the indicator itself.
 */
export function frontmatterIntent(raw: string): string | null {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(raw);
  if (!match) return null;
  const lines = match[1]!.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const found = /^intent:\s*(.*)$/.exec(lines[index]!);
    if (!found) continue;
    const value = found[1]!.trim();
    if (BLOCK_SCALAR.has(value)) {
      const block: string[] = [];
      for (const later of lines.slice(index + 1)) {
        if (later && !/^\s/.test(later)) break;
        if (later.trim()) block.push(later.trim());
      }
      return block.join(" ") || null;
    }
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      if (value[0] === '"') {
        try { return JSON.parse(value) as string; } catch { /* fall through to a plain strip */ }
      }
      return value.slice(1, -1) || null;
    }
    return value || null;
  }
  return null;
}

function readIntent(nodePath: string): string | null {
  try {
    return frontmatterIntent(fs.readFileSync(path.join(nodePath, "SPEC.md"), "utf8"));
  } catch {
    return null;
  }
}

function resolveTagged(missionsRoot: string | null, mission: string, slice: string | null):
  Pick<WorkCandidate, "workNodePath" | "intent" | "unresolved"> {
  if (!missionsRoot) return { workNodePath: null, intent: null, unresolved: "no missions root configured" };
  const missions = resolveWorkNodeDirs(missionsRoot, mission);
  if (missions.length !== 1) {
    return { workNodePath: null, intent: null,
      unresolved: `mission ${mission} resolves to ${missions.length} directories on this host` };
  }
  const missionPath = path.join(missionsRoot, missions[0]!.dir);
  if (!slice) return { workNodePath: missionPath, intent: readIntent(missionPath), unresolved: null };
  const slicesRoot = path.join(missionPath, "slices");
  const slices = resolveWorkNodeDirs(slicesRoot, slice);
  if (slices.length !== 1) {
    // The mission is the slice's own parent, not a substitute: its intent is still the work's.
    return { workNodePath: missionPath, intent: readIntent(missionPath),
      unresolved: `slice ${slice} resolves to ${slices.length} directories under ${missions[0]!.dir}` };
  }
  const slicePath = path.join(slicesRoot, slices[0]!.dir);
  return { workNodePath: slicePath, intent: readIntent(slicePath), unresolved: null };
}

function listMissions(missionsRoot: string | null): { names: string[]; truncated: boolean } {
  if (!missionsRoot) return { names: [], truncated: false };
  try {
    const names = fs.readdirSync(missionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(missionsRoot, entry.name, "SPEC.md")))
      .map(entry => entry.name)
      .sort();
    return { names: names.slice(0, MISSIONS_ON_HOST_LIMIT), truncated: names.length > MISSIONS_ON_HOST_LIMIT };
  } catch {
    return { names: [], truncated: false };
  }
}

export function deriveWorkCandidates(
  rows: CandidateRow[],
  missionsRoot: string | null,
  lookups: WorkCandidateLookups,
): WorkCandidates {
  const candidates: WorkCandidate[] = [];
  const unknown: WorkCandidates["unknown"] = [];
  const next: WorkCandidates["next"] = [];
  const held: WorkCandidates["held"] = [];
  const seen = new Set<string>();
  const add = (candidate: WorkCandidate) => {
    const key = `${candidate.kind}|${candidate.mission}|${candidate.slice ?? ""}|${candidate.workNodePath ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const row of rows) {
    const tags = row.tags ?? [];
    const missions = tagValues(tags, MISSION_TAG);
    const qitemId = row.qitemId ?? null;
    const summary = row.summary ?? null;
    if (row.state === "pending") {
      next.push({ qitemId, summary, missions });
      continue;
    }
    if (row.state === "blocked") {
      held.push({ qitemId, summary, blockedOn: row.blockedOn ?? null,
        continuation: qitemId ? lookups.continuationOf(qitemId) : null });
      continue;
    }
    if (row.state !== "in-progress") continue;

    if (missions.length > 0) {
      const slices = tagValues(tags, SLICE_TAG);
      // One slice tag belongs to its mission; anything else is shown without a slice rather
      // than paired by array position.
      const slice = missions.length === 1 && slices.length === 1 ? slices[0]! : null;
      for (const mission of [...missions].sort()) {
        add({ kind: "tag", qitemId, mission, slice,
          ...resolveTagged(missionsRoot, mission, slice),
          source: `tag mission:${mission}${slice ? ` + slice:${slice}` : ""} on ${rowLabel(qitemId)}` });
      }
      continue;
    }

    // No mission tag: handoff ancestry is a lead, not truth.
    const ancestry = [...(row.chainOfRecord ?? [])].reverse();
    if (row.handedOffFrom && !ancestry.includes(row.handedOffFrom)) ancestry.unshift(row.handedOffFrom);
    if (ancestry.length === 0) {
      unknown.push({ qitemId, summary, reason: "no mission tag and no handoff ancestry" });
      continue;
    }
    let found = false;
    for (const ancestorId of ancestry) {
      const ancestor = lookups.getRow(ancestorId);
      if (!ancestor) {
        unknown.push({ qitemId, summary,
          reason: `handoff ancestor ${ancestorId} is not on this host (remote or removed); no mission assumed` });
        found = true;
        break;
      }
      const ancestorMissions = tagValues(ancestor.tags ?? [], MISSION_TAG);
      if (ancestorMissions.length === 0) continue;
      if ((row.tags ?? []).length === 0 && (row.body ?? "") !== (ancestor.body ?? "")) {
        unknown.push({ qitemId, summary,
          reason: `retargeted handoff from ${ancestorId} (new body, no tags); no mission assumed` });
        found = true;
        break;
      }
      for (const mission of [...ancestorMissions].sort()) {
        add({ kind: "ancestry", qitemId, mission, slice: null,
          ...resolveTagged(missionsRoot, mission, null),
          source: `handoff ancestor ${ancestorId} carries mission:${mission}; ${rowLabel(qitemId)} itself is untagged` });
      }
      found = true;
      break;
    }
    if (!found) unknown.push({ qitemId, summary, reason: "no handoff ancestor carries a mission tag" });
  }

  const listed = listMissions(missionsRoot);
  return { missionsRoot, candidates, unknown, next, held,
    missionsOnHost: listed.names, missionsOnHostTruncated: listed.truncated };
}
