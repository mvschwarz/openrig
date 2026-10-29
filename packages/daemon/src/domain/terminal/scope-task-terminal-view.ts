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
interface Scope { name: string; id?: string; title: string; source: string }
const MAX_ENTRIES = 4096, MAX_HEADER_BYTES = 16384, MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 50000, MAX_TAG_BYTES = 16384, MAX_TOTAL_TAG_BYTES = 8 * 1024 * 1024;
const unavailable = (error: string): ScopeViewError => ({ code: "scope_unavailable", error });

/** Strict bounded identity read over the configured index roots. The review
 * listing's first-match and unreadable-as-empty fallbacks are not authority
 * for retiring viewers. No inferred project, substring match or remote I/O. */
function resolveSlice(index: IndexContext, key: string): Scope | ScopeViewError {
  if (!key || key.trim() !== key || /[\\/\x00-\x1f\x7f]/.test(key)) return { code: "scope_not_found", error: "Invalid slice name or id." };
  let entries = 0, bytes = 0;
  const scopes: Scope[] = [], seenRoots = new Set<string>(), seenScopes = new Set<string>();
  const list = (dir: string, visit: (name: string) => void) => {
    const handle = fs.opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > MAX_ENTRIES) throw new Error(`Scope index exceeds its ${MAX_ENTRIES}-entry work limit.`);
        if (entry.isDirectory() && !entry.name.startsWith(".")) visit(entry.name);
      }
    } finally { handle.closeSync(); }
  };
  const add = (dir: string, name: string) => {
    const source = fs.realpathSync(dir);
    if (seenScopes.has(source)) return;
    seenScopes.add(source);
    let raw = "";
    for (const file of NODE_FILE_PRECEDENCE) {
      let fd: number;
      try { fd = fs.openSync(path.join(dir, file), "r"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      try {
        const buffer = Buffer.alloc(MAX_HEADER_BYTES);
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        bytes += size;
        if (bytes > MAX_SOURCE_BYTES) throw new Error("Scope index exceeds its source-byte work limit.");
        raw = buffer.subarray(0, size).toString("utf8");
        if (raw.startsWith("---") && !raw.slice(3).includes("\n---")) throw new Error("Scope frontmatter is unreadable or exceeds its header work limit.");
      } finally { fs.closeSync(fd); }
      break; // SPEC.md wins; an unreadable selected node never falls back.
    }
    const fields = parseFrontmatter(raw);
    const id = typeof fields.id === "string" && fields.id ? fields.id : undefined;
    const title = typeof fields.title === "string" && fields.title ? fields.title
      : typeof fields.slice === "string" && fields.slice ? fields.slice : raw.match(/^# (.+)$/m)?.[1]?.trim() || name;
    scopes.push({ name, id, title, source });
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
        if (isMission) list(nested, child => add(path.join(nested, child), child));
        else add(dir, name);
      });
    }
  } catch { return unavailable("Scope index could not be read completely within its entry/header/source limits; refresh after repairing its configured sources."); }
  const matches = scopes.filter(scope => scope.name === key || scope.id === key);
  if (!matches.length) return { code: "scope_not_found", error: `No indexed slice exactly matches '${key}'.` };
  if (matches.length !== 1) return { code: "scope_ambiguous", error: `Multiple indexed slices match '${key}'; choose an unambiguous scope.` };
  const selected = matches[0]!;
  // A unique name cannot certify which rows an ambiguous alias names.
  if (scopes.some(other => other !== selected && (other.name === selected.name
    || (selected.id && (other.id === selected.id || other.name === selected.id))))) {
    return { code: "scope_ambiguous", error: `Slice '${key}' has a colliding name or id association.` };
  }
  return selected;
}

/** Active typed-tag owners only, with one bounded local queue projection.
 * A cap or malformed record is incomplete, never authoritative empty. */
export function readScopedTaskTerminalView(db: Database.Database, view: string, index: IndexContext,
  resolveSeat: (address: string) => TaskSeat | null): TaskTerminalView | ScopeViewError {
  if (!view.startsWith("slice:")) return { code: "scope_unsupported", error: "Authoritative following for this scope kind is not implemented." };
  const scope = resolveSlice(index, view.slice(6));
  if ("code" in scope) return scope;
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
      if (parsed.slices.has(scope.name) || (scope.id && parsed.slices.has(scope.id))) selected.push(row);
    }
    selected.sort((a, b) => a.qitem_id.localeCompare(b.qitem_id));
    return projectTaskOwners({ kind: "slice", id: scope.id ?? scope.name, name: scope.title,
      complete: issues.size === 0, issues: [...issues] }, selected, resolveSeat);
  })();
}
