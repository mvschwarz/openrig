import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

const realpath = process.platform === "win32" ? fs.realpathSync.native : fs.realpathSync;

export class ProjectReadError extends Error {
  constructor(readonly code: string, message: string, readonly candidates?: string[]) { super(message); }
}
export function yamlObject(file: string): Record<string, any> {
  try {
    const value = parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a YAML object");
    return value;
  } catch (err) { throw new ProjectReadError("workspace_catalog_invalid", `${file}: ${(err as Error).message}`); }
}
/** The existing workspace.yaml catalog, shared by work-install and project reads. */
export function readProjectCatalog(catalogPath: string): Array<{ id: string; root: string }> | null {
  if (!fs.existsSync(catalogPath)) return null;
  const entries = yamlObject(catalogPath).projects;
  if (!Array.isArray(entries) || entries.some(e => !e || typeof e.id !== "string" || typeof e.root !== "string"))
    throw new ProjectReadError("workspace_catalog_invalid", `${catalogPath} projects must each declare string id and root values`);
  const ids = entries.map(e => e.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new ProjectReadError("project_identity_ambiguous", `project id '${duplicate}' names multiple roots in ${catalogPath}`);
  return entries.map(e => ({ id: e.id, root: e.root }));
}
export function selectCatalogProject(catalogPath: string, selectedId?: string): { id: string; root: string } | null {
  const projects = readProjectCatalog(catalogPath);
  if (!projects) return null;
  const candidates = projects.map(p => p.id);
  const id = selectedId ?? (projects.length === 1 ? projects[0]!.id : undefined);
  if (!id) throw new ProjectReadError("project_required", "multiple projects are declared; select one with --project", candidates);
  const selected = projects.find(p => p.id === id);
  if (!selected) throw new ProjectReadError("project_not_found", `project '${id}' is not declared in ${catalogPath}`, candidates);
  const nominal = path.resolve(path.dirname(catalogPath), selected.root);
  try { return { id, root: realpath(nominal) }; }
  catch { throw new ProjectReadError("project_root_missing", `project '${id}' root does not exist: ${nominal}`); }
}
/** The rig of a canonical seat session (`member@rig`). Pod and member ids can't
 *  contain `@`, so the rig is everything after the first one. */
export function rigFromSession(sessionName: string | null | undefined): string | null {
  const at = sessionName?.indexOf("@") ?? -1;
  return at > 0 && at < sessionName!.length - 1 ? sessionName!.slice(at + 1) : null;
}

/** Only an explicit, unique rigs association is a rig default; cwd and unclaimed projects are not bindings. */
export function selectRigProject(catalogPath: string, rigName: string | null): { id: string; root: string } | null {
  if (!rigName) return null;
  const projects = readProjectCatalog(catalogPath);
  if (!projects) return null;
  const entries = yamlObject(catalogPath).projects as Array<{ id: string; rigs?: unknown }>;
  const malformed = entries.filter((entry) => entry.rigs !== undefined
    && (!Array.isArray(entry.rigs) || !entry.rigs.every((rig: unknown) => typeof rig === "string")));
  if (malformed.length) throw new ProjectReadError("workspace_catalog_invalid", `${catalogPath}: project rigs must be lists of rig names`);
  const matches = entries.filter((entry) => Array.isArray(entry.rigs) && entry.rigs.includes(rigName));
  if (matches.length > 1) throw new ProjectReadError("project_required", `rig '${rigName}' is listed under several projects; choose a target explicitly`, matches.map((entry) => entry.id));
  return matches.length ? selectCatalogProject(catalogPath, matches[0]!.id) : null;
}

export type CatalogInferenceBasis = "rig" | "cwd" | "unclaimed";

function catalogEntries(catalogPath: string): unknown[] {
  try {
    const value = yamlObject(catalogPath).projects;
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function canonicalExisting(file: string): string | null {
  try { return realpath(file); } catch { return null; }
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}
function selectInferred(catalogPath: string, id: string, selectedBy: CatalogInferenceBasis): { id: string; root: string; selectedBy: CatalogInferenceBasis } {
  const selected = selectCatalogProject(catalogPath, id);
  if (!selected) throw new ProjectReadError("project_not_found", `project '${id}' is not declared in ${catalogPath}`);
  return { ...selected, selectedBy };
}

/** Steps 3-5 of project selection, used only where the catalog alone would stop
 *  with project_required: the calling rig's association (workspace.yaml
 *  `projects[].rigs`), then the unique deepest project root containing the
 *  working directory, then the only entry that no rig claims. The last keeps a
 *  user's own rigs on their project after a claimed project (a contributor
 *  bundle) is added beside it. None adds a refusal: an unusable signal is a
 *  warning, and no unique answer throws the original project_required.
 *  Shared by work-install and operating posture, so both pick the same project. */
export function inferCatalogProject(
  catalogPath: string,
  required: ProjectReadError,
  signals: { rigName?: string | null; cwd?: string | null },
  warnings: string[],
): { id: string; root: string; selectedBy: CatalogInferenceBasis } {
  const claims = new Map<string, string[]>();
  const malformed = new Set<string>();
  for (const entry of catalogEntries(catalogPath)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { id, rigs } = entry as { id?: unknown; rigs?: unknown };
    if (typeof id !== "string" || rigs === undefined) continue;
    if (!Array.isArray(rigs) || !rigs.every((name) => typeof name === "string")) {
      warnings.push(`${catalogPath}: project '${id}' rigs must be a list of rig names; ignored it`);
      malformed.add(id);
      continue;
    }
    claims.set(id, rigs as string[]);
  }

  const rig = signals.rigName ?? null;
  if (rig) {
    const claimants = [...claims].filter(([, rigs]) => rigs.includes(rig)).map(([id]) => id);
    if (claimants.length > 1) {
      throw new ProjectReadError("project_required", `rig '${rig}' is listed under several projects in ${catalogPath}; select one with --project`, claimants);
    }
    if (claimants.length === 1) return selectInferred(catalogPath, claimants[0]!, "rig");
  }

  const cwd = signals.cwd ? canonicalExisting(signals.cwd) : null;
  if (cwd) {
    const containing: Array<{ id: string; root: string; depth: number }> = [];
    for (const entry of readProjectCatalog(catalogPath) ?? []) {
      const root = canonicalExisting(path.resolve(path.dirname(catalogPath), entry.root));
      if (!root) {
        warnings.push(`project '${entry.id}' root does not exist; skipped it for working-directory selection`);
        continue;
      }
      if (inside(root, cwd)) containing.push({ id: entry.id, root, depth: root.split(path.sep).filter(Boolean).length });
    }
    const depth = Math.max(...containing.map((entry) => entry.depth));
    const deepest = containing.filter((entry) => entry.depth === depth);
    if (deepest.length === 1) return { id: deepest[0]!.id, root: deepest[0]!.root, selectedBy: "cwd" };
    if (deepest.length > 1) {
      throw new ProjectReadError(
        "project_required",
        `the working directory is inside several projects with the same root; select one with --project`,
        deepest.map((entry) => entry.id),
      );
    }
  }

  const unclaimed = (readProjectCatalog(catalogPath) ?? [])
    .filter((entry) => !malformed.has(entry.id) && (claims.get(entry.id) ?? []).length === 0);
  if (unclaimed.length === 1) return selectInferred(catalogPath, unclaimed[0]!.id, "unclaimed");
  throw required;
}

/** The former ids a project's own project.yaml lists under `aliases:`. Unreadable or malformed entries add none. */
function manifestAliases(root: string): string[] {
  try {
    const realRoot = fs.realpathSync(root);
    const manifest = fs.realpathSync(path.join(realRoot, "project.yaml"));
    if (!inside(realRoot, manifest)) return [];
    const aliases: unknown = parse(fs.readFileSync(manifest, "utf8"))?.aliases;
    return Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === "string" && a.trim() !== "").map(a => a.trim()) : [];
  } catch { return []; }
}

/** A declared former id the catalog doesn't use, and why: it's another project's current id (which keeps its rows), or
 *  several projects declare it (so its rows belong to none). Reported, never refused. */
export interface IgnoredAlias { alias: string; declaredBy: string[]; currentOwner: string | null }

/** Former project ids, each mapped to the catalogued project that declares it, so rows tagged before a rename stay that
 *  project's, plus the declarations that can't apply. A former id that is a current catalog id stays that project's, and
 *  one several projects declare stays unclaimed. History is never rewritten. */
export function readCatalogAliasReport(catalogPath: string): { aliases: Map<string, string>; ignored: IgnoredAlias[] } {
  let entries: Array<{ id: string; root: string }>;
  try { entries = readProjectCatalog(catalogPath) ?? []; } catch { return { aliases: new Map(), ignored: [] }; }
  const ids = new Set(entries.map(e => e.id));
  const owners = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const alias of manifestAliases(path.resolve(path.dirname(catalogPath), entry.root))) {
      if (alias === entry.id) continue;
      const claimed = owners.get(alias) ?? new Set<string>();
      owners.set(alias, claimed.add(entry.id));
    }
  }
  const aliases = new Map<string, string>();
  const ignored: IgnoredAlias[] = [];
  for (const [alias, claimed] of owners) {
    if (!ids.has(alias) && claimed.size === 1) aliases.set(alias, [...claimed][0]!);
    else ignored.push({ alias, declaredBy: [...claimed].sort(), currentOwner: ids.has(alias) ? alias : null });
  }
  return { aliases, ignored };
}
export function readCatalogAliases(catalogPath: string): Map<string, string> { return readCatalogAliasReport(catalogPath).aliases; }

/** The former ids one project declares, for a workspace with no catalog (its own project.yaml). */
export function workspaceAliases(root: string, id: string): string[] {
  return [...new Set(manifestAliases(root))].filter(alias => alias !== id);
}

/** Project membership by exact `project:<id>` tag, for the project's id or any former id it declares. Unscoped historical
 *  rows are not assigned to a selected project. */
export function belongsToProject(raw: string | null | undefined, ids: string | readonly string[]): boolean {
  const wanted = new Set((typeof ids === "string" ? [ids] : ids).map(id => `project:${id}`));
  try {
    const tags: unknown = JSON.parse(raw ?? "null");
    return Array.isArray(tags) && tags.flatMap(t => typeof t === "string" ? t.split(",").map(s => s.trim()) : []).some(t => wanted.has(t));
  } catch { return false; }
}

/** The project ids a row's tags name, comma-split as membership reads them. */
export function projectTagIds(raw: string | null | undefined): string[] {
  try {
    const tags: unknown = JSON.parse(raw ?? "null");
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags.flatMap(t => typeof t === "string" ? t.split(",").map(s => s.trim()) : [])
      .filter(t => t.startsWith("project:") && t.length > "project:".length).map(t => t.slice("project:".length)))];
  } catch { return []; }
}
