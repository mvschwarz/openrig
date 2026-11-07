import * as fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { parseFrontmatter, type SliceIndexer } from "../slices/slice-indexer.js";
import { parseScopeTags } from "../slices/qitem-membership.js";
import { belongsToProject } from "../workspace/project-catalog.js";
import { NODE_FILE_PRECEDENCE } from "../scope/node-file.js";
import { projectTaskOwners, type TaskSeat, type TaskTerminalView } from "./task-terminal-view.js";

export interface ScopeViewError { code: "scope_unsupported" | "scope_not_found" | "scope_ambiguous" | "scope_unavailable"; error: string }
type IndexContext = Pick<SliceIndexer, "slicesRoot" | "additionalSliceRoots" | "projectId">;
interface Scope { name: string; id?: string; title: string; source: string; mission?: string; missionSource?: string }
interface Mission { name: string; source: string; manifest?: string }
interface ScopeIndex { slices: Scope[]; missions: Mission[]; claims: Map<string, Set<string>>; missionIssues: string[] }
const MAX_ENTRIES = 4096, MAX_HEADER_BYTES = 16384, MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 50000, MAX_TAG_BYTES = 16384, MAX_TOTAL_TAG_BYTES = 8 * 1024 * 1024;
class ScopeLimit extends Error {}
const unavailable = (error: string): ScopeViewError => ({ code: "scope_unavailable", error });

/** Strict bounded identity read over the configured index roots. The review
 * listing's first-match and unreadable-as-empty fallbacks are not authority
 * for retiring viewers. No inferred project, substring match or remote I/O. */
function readScopeIndex(index: IndexContext): ScopeIndex | ScopeViewError {
  let entries = 0, bytes = 0;
  const scopes: Scope[] = [], missions: Mission[] = [], missionIssues: string[] = [];
  const seenRoots = new Set<string>(), scopeBySource = new Map<string, Scope>(), missionBySource = new Map<string, Mission>();
  const list = (dir: string, visit: (name: string) => void) => {
    const handle = fs.opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > MAX_ENTRIES) throw new ScopeLimit(`Scope index exceeds its ${MAX_ENTRIES}-entry work limit.`);
        if (entry.isDirectory() && !entry.name.startsWith(".")) visit(entry.name);
      }
    } finally { handle.closeSync(); }
  };
  const addMission = (dir: string, name: string, manifest?: string): Mission => {
    const source = fs.realpathSync(dir), existing = missionBySource.get(source);
    if (existing) return existing;
    const mission = { name, source, ...(manifest ? { manifest } : {}) };
    missionBySource.set(source, mission); missions.push(mission); return mission;
  };
  const add = (dir: string, name: string, mission?: string, missionSource?: string) => {
    const source = fs.realpathSync(dir), existing = scopeBySource.get(source);
    if (existing) { if (missionSource && !existing.missionSource) { existing.mission = mission; existing.missionSource = missionSource; } return; }
    let raw = "";
    for (const file of NODE_FILE_PRECEDENCE) {
      let fd: number;
      try { fd = fs.openSync(path.join(dir, file), "r"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      try {
        const buffer = Buffer.alloc(MAX_HEADER_BYTES);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        bytes += size;
        if (bytes > MAX_SOURCE_BYTES) throw new ScopeLimit("Scope index exceeds its 8-MiB source-byte work limit.");
        raw = buffer.subarray(0, size).toString("utf8");
        if (raw.startsWith("---") && !raw.slice(3).includes("\n---")) {
          if (size === MAX_HEADER_BYTES) throw new ScopeLimit("Scope frontmatter exceeds its 16-KiB header work limit.");
          throw new Error("Unterminated scope frontmatter.");
        }
      } finally { fs.closeSync(fd); }
      break; // SPEC.md wins; an unreadable selected node never falls back.
    }
    const fields = parseFrontmatter(raw);
    const id = typeof fields.id === "string" && fields.id ? fields.id : undefined;
    const title = typeof fields.title === "string" && fields.title ? fields.title
      : typeof fields.slice === "string" && fields.slice ? fields.slice : raw.match(/^# (.+)$/m)?.[1]?.trim() || name;
    const scope = { name, id, title, source, ...(missionSource ? { mission, missionSource } : {}) };
    scopeBySource.set(source, scope); scopes.push(scope);
  };
  try {
    for (const [position, root] of [index.slicesRoot, ...index.additionalSliceRoots].entries()) {
      let real: string;
      try { real = fs.realpathSync(root); }
      catch (error) {
        // Explicit legacy compatibility roots may not exist. The primary
        // configured index and every existing root must remain readable.
        if (position > 0 && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (seenRoots.has(real)) continue;
      seenRoots.add(real);
      list(root, name => {
        const dir = path.join(root, name), nested = path.join(dir, "slices");
        let isMission = false;
        try { isMission = fs.statSync(nested).isDirectory(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (isMission) {
          const mission = addMission(dir, name);
          list(nested, child => add(path.join(nested, child), child, name, mission.source));
        } else {
          add(dir, name); // Preserve existing flat-slice lookup and header accounting.
          const manifest = path.join(dir, "mission.yaml");
          try { if (fs.statSync(manifest).isFile()) addMission(dir, name, manifest); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") missionIssues.push("Mission declarations could not be enumerated completely."); }
        }
      });
    }
  } catch (error) {
    return unavailable(error instanceof ScopeLimit ? `${error.message} This index is too large for this bounded read; use a smaller configured index or a qitem view.`
      : "Scope index sources are unavailable or malformed; inspect the configured sources and refresh the view.");
  }
  const claims = new Map<string, Set<string>>();
  for (const scope of scopes) for (const key of new Set([scope.name, scope.id])) {
    if (!key) continue;
    const owners = claims.get(key) ?? new Set<string>(); owners.add(scope.source); claims.set(key, owners);
  }
  return { slices: scopes, missions, claims, missionIssues };
}
function selectSlice(scopes: Scope[], key: string): Scope | ScopeViewError {
  if (!key || key.trim() !== key || /[\\/\x00-\x1f\x7f]/.test(key)) return { code: "scope_not_found", error: "Invalid slice name or id." };
  const matches = scopes.filter(scope => scope.name === key || scope.id === key);
  if (!matches.length) return { code: "scope_not_found", error: `No indexed slice exactly matches '${key}'.` };
  if (matches.length !== 1) return { code: "scope_ambiguous", error: `Multiple indexed slices match '${key}'; choose an unambiguous scope.` };
  const selected = matches[0]!;
  // Flat legacy slices have no mission context to place a colliding alias.
  if (!selected.missionSource && scopes.some(other => other !== selected && (other.name === selected.name || other.id === selected.name
    || (selected.id && (other.id === selected.id || other.name === selected.id))))) {
    return { code: "scope_ambiguous", error: `Slice '${key}' has a colliding name or id association.` };
  }
  return selected;
}

function selectMission(index: ScopeIndex, key: string): { mission: Mission; sliceKeys: Set<string>; collidingKeys: Map<string, Set<string>> } | ScopeViewError {
  if (!key || key.trim() !== key || /[\\/\x00-\x1f\x7f]/.test(key)) return { code: "scope_not_found", error: "Invalid mission directory id." };
  if (index.missionIssues.length) return unavailable(index.missionIssues.join(" "));
  const matches = index.missions.filter(mission => mission.name === key);
  if (!matches.length) return { code: "scope_not_found", error: `No indexed mission exactly matches '${key}'.` };
  if (matches.length !== 1) return { code: "scope_ambiguous", error: `Multiple indexed missions match '${key}'.` };
  const mission = matches[0]!, sliceKeys = new Set<string>(), collidingKeys = new Map<string, Set<string>>();
  if (mission.manifest) {
    try { fs.accessSync(mission.manifest, fs.constants.R_OK); }
    catch { return unavailable("The selected mission declaration is unavailable; refresh after inspecting its configured source."); }
  }
  for (const slice of index.slices) {
    if (slice.missionSource !== mission.source) continue;
    for (const tag of [slice.name, slice.id]) {
      if (!tag) continue;
      if ((index.claims.get(tag)?.size ?? 0) > 1) { collidingKeys.set(tag, new Set()); continue; }
      sliceKeys.add(tag);
    }
  }
  // One bounded index pass establishes which missions can place shared keys.
  for (const slice of index.slices) for (const tag of new Set([slice.name, slice.id])) {
    if (tag && slice.mission) collidingKeys.get(tag)?.add(slice.mission);
  }
  return { mission, sliceKeys, collidingKeys };
}

/** Active typed-tag owners only, with one bounded local queue projection.
 * A cap or malformed record is incomplete, never authoritative empty. */
export function readScopedTaskTerminalView(db: Database.Database, view: string, index: IndexContext,
  resolveSeat: (address: string) => TaskSeat | null, readIndex = () => readScopeIndex(index)): TaskTerminalView | ScopeViewError {
  if (!/^(slice|mission):/.test(view)) return { code: "scope_unsupported", error: "Authoritative following for this scope kind is not implemented." };
  const identities = readIndex();
  if ("code" in identities) return identities;
  const kind = view.startsWith("mission:") ? "mission" : "slice";
  let id: string, name: string, sliceKeys: Set<string>, missionKey: string | undefined, scope: Scope | undefined;
  let collidingKeys = new Map<string, Set<string>>();
  if (kind === "slice") {
    const selected = selectSlice(identities.slices, view.slice(6));
    if ("code" in selected) return selected;
    scope = selected;
    id = scope.id ?? scope.name; name = scope.title; sliceKeys = new Set([scope.name, ...(scope.id ? [scope.id] : [])]);
  } else {
    const selected = selectMission(identities, view.slice(8));
    if ("code" in selected) return selected;
    id = name = missionKey = selected.mission.name; sliceKeys = selected.sliceKeys; collidingKeys = selected.collidingKeys;
  }
  // At most two linear index passes per resolve, never a scan per queue row.
  const claims = new Map(scope ? [...new Set([scope.name, scope.id].filter((key): key is string => !!key))].map(key => {
    const candidates = identities.slices.filter(candidate => candidate.name === key || candidate.id === key);
    const byMission = new Map<string, Scope[]>();
    for (const candidate of candidates) {
      if (!candidate.mission) continue;
      const sameMission = byMission.get(candidate.mission) ?? [];
      sameMission.push(candidate); byMission.set(candidate.mission, sameMission);
    }
    return [key, { count: candidates.length, byMission }] as const;
  }) : []);
  return db.transaction(() => {
    const issues = new Set<string>();
    const selected: Array<{ qitem_id: string; destination_session: string; state: string }> = [];
    const tagSize = "coalesce(length(CAST(tags AS BLOB)),0)";
    const rows = db.prepare(`SELECT qitem_id,destination_session,state,${tagSize} AS tag_bytes,
      CASE WHEN ${tagSize}<=${MAX_TAG_BYTES} THEN tags ELSE NULL END AS tags
      FROM queue_items INDEXED BY idx_queue_items_state WHERE state IN ('pending','in-progress','blocked') LIMIT ?`)
      .iterate(MAX_ROWS + 1) as Iterable<{ qitem_id: string; destination_session: string; state: string; tags: string | null; tag_bytes: number }>;
    let scanned = 0, bytes = 0;
    for (const row of rows) {
      if (++scanned > MAX_ROWS || (bytes += row.tag_bytes) > MAX_TOTAL_TAG_BYTES) {
        issues.add("Scoped queue enumeration reached its row/encoded-byte work limit; membership is incomplete."); break;
      }
      if (row.tag_bytes > MAX_TAG_BYTES) { issues.add("Some active scope tags exceed their per-record work limit; membership is incomplete."); continue; }
      let tags: unknown;
      try { tags = row.tags === null ? [] : JSON.parse(row.tags); } catch { tags = null; }
      if (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string")) {
        issues.add("Some active scope tags are malformed; membership is incomplete."); continue;
      }
      if (index.projectId && !belongsToProject(row.tags, index.projectId)) continue;
      const parsed = parseScopeTags(row.tags);
      if (kind === "mission") {
        if (missionKey && parsed.missions.has(missionKey)) { selected.push(row); continue; }
        const mission = parsed.missions.size === 1 ? parsed.missions.values().next().value : undefined;
        const unplaced = [...parsed.slices].some(key => collidingKeys.has(key)
          && (mission === undefined || !collidingKeys.get(key)!.has(mission)));
        if (unplaced) {
          issues.add(`Queue row '${row.qitem_id}' has unplaceable or contradictory colliding slice tags; membership is incomplete.`);
          continue;
        }
        if ([...parsed.slices].some(tag => sliceKeys.has(tag))) selected.push(row);
        continue;
      }
      let here = false, elsewhere = false, unplaced = false;
      const mission = parsed.missions.size === 1 ? parsed.missions.values().next().value : undefined;
      for (const [key, claim] of claims) {
        if (!parsed.slices.has(key)) continue;
        if (claim.count === 1) { here = true; continue; }
        // A reused name/id requires exactly one mission tag and one indexed
        // claimant in that mission. Never assign it by first-match or absence.
        const placed = mission === undefined ? [] : claim.byMission.get(mission) ?? [];
        if (placed.length !== 1) { unplaced = true; continue; }
        if (placed[0]!.source === scope!.source) here = true; else elsewhere = true;
      }
      if (unplaced || (here && elsewhere)) {
        issues.add(`Queue row '${row.qitem_id}' has unplaceable or contradictory colliding slice tags; membership is incomplete.`);
      } else if (here) selected.push(row);
    }
    selected.sort((a, b) => a.qitem_id.localeCompare(b.qitem_id));
    return projectTaskOwners({ kind, id, name,
      complete: issues.size === 0, issues: [...issues] }, selected, resolveSeat);
  })();
}


/** Cache identities only under live primary-root notification coverage.
 * Queue ownership is always read anew. Missing legacy roots are checked on
 * every call; an appearing/unwatched root disables generation reuse. */
export function createScopedTaskResolver(db: Database.Database, index: IndexContext,
  resolveSeat: (address: string) => TaskSeat | null, observed: () => boolean) {
  let cached: ScopeIndex | undefined;
  return {
    invalidate() { cached = undefined; },
    resolve(view: string): TaskTerminalView | ScopeViewError {
      let reusable = false;
      try {
        const primary = fs.realpathSync(index.slicesRoot);
        reusable = observed() && index.additionalSliceRoots.every(root => {
          try { const real = fs.realpathSync(root); return real === primary || real.startsWith(primary + path.sep); }
          catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
        });
      } catch { /* Unconfirmed coverage always takes a fresh bounded read. */ }
      if (!reusable) cached = undefined;
      try {
        const result = readScopedTaskTerminalView(db, view, index, resolveSeat, () => {
          if (cached) return cached;
          const next = readScopeIndex(index);
          if (reusable && !("code" in next)) cached = next;
          return next;
        });
        if ("code" in result) cached = undefined;
        return result;
      } catch (error) { cached = undefined; throw error; }
    },
  };
}
