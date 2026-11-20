import * as fs from "node:fs";
import * as path from "node:path";
import { parse, YAMLParseError } from "yaml";
import type { SettingsStore } from "../user-settings/settings-store.js";
import { NODE_FILE_PRECEDENCE } from "../scope/node-file.js";
import { readProjectCatalog, readCatalogAliasReport, selectCatalogProject, workspaceAliases, yamlObject, ProjectReadError, type IgnoredAlias } from "./project-catalog.js";

/** `aliases` are the former ids the project declares in its project.yaml; rows tagged with one are still this project's.
 *  `aliasWarnings` name the ones it declares that can't apply, and why (#3261). */
export interface ProjectRead { id: string; root: string; name: string; sourcePath: string | null; missionsRoot: string; aliases?: string[]; aliasWarnings?: string[]; error?: string }
/** Every id a project's rows can carry: its current id, then its declared former ids. */
export function projectIds(p: Pick<ProjectRead, "id" | "aliases">): string[] { return [p.id, ...(p.aliases ?? [])]; }
/** Whether an id is a project's current id or one of its declared former ids. */
export function namesProject(p: Pick<ProjectRead, "id" | "aliases">, id: string | null | undefined): boolean { return !!id && projectIds(p).includes(id); }
type ReadContext = { get: (key: never) => unknown; req: { query: (key: string) => string | undefined } };
export function projectCatalogPaths(c: Pick<ReadContext, "get">) {
  const store = c.get("settingsStore" as never) as SettingsStore | undefined;
  const workspace = store?.resolveOne("workspace.root").value;
  if (typeof workspace !== "string" || !workspace) throw new ProjectReadError("workspace_root_missing", "Workspace root is not configured");
  const configured = store?.resolveOne("workspace.catalog_path").value;
  return { workspace, catalog: typeof configured === "string" && configured ? configured : path.join(workspace, "workspace.yaml") };
}
export function insideProject(root: string, target: string): string {
  const actual = fs.realpathSync(target);
  const rel = path.relative(root, actual);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) throw new ProjectReadError("project_path_escape", `Source is outside selected project: ${target}`);
  return actual;
}
export function workSource(root: string, dir: string, validate = true): string {
  insideProject(root, dir);
  const source = NODE_FILE_PRECEDENCE.map(name => path.join(dir, name)).find(file => fs.existsSync(file));
  if (!source) throw new ProjectReadError("source_unavailable", `No work source at ${dir}`);
  insideProject(root, source);
  if (!validate) return source;
  const text = fs.readFileSync(source, "utf8");
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end < 0) throw new ProjectReadError("source_invalid", `Unterminated frontmatter: ${source}`);
    let value: unknown;
    try { value = parse(text.slice(3, end)); }
    catch (err) {
      if (!(err instanceof YAMLParseError)) throw err;
      const at = err.linePos?.[0];
      throw new ProjectReadError("source_invalid", `Invalid frontmatter: ${source} (${err.code}${at ? `, line ${at.line}, column ${at.col}` : ""}). Read the source to correct it.`);
    }
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new ProjectReadError("source_invalid", `Invalid frontmatter: ${source}`);
  }
  return source;
}
function projectEntry(id: string, root: string, aliases: string[] = [], aliasWarnings: string[] = []): ProjectRead {
  let p: ProjectRead = { id, root, name: id, sourcePath: null, missionsRoot: path.join(root, "missions"), aliases, ...(aliasWarnings.length ? { aliasWarnings } : {}) };
  try {
    p.root = fs.realpathSync(root);
    const manifest = path.join(p.root, "project.yaml");
    const value = fs.existsSync(manifest) ? yamlObject(insideProject(p.root, manifest)) : {};
    const declared = value.id ?? value.metadata?.id;
    if (declared && declared !== id) throw new ProjectReadError("project_identity_conflict", `Catalog ${id} conflicts with project identity ${declared}`);
    p.name = typeof value.metadata?.name === "string" ? value.metadata.name : id;
    const missions = value.missions?.root ?? "missions";
    if (typeof missions !== "string" || path.isAbsolute(missions) || missions.split(/[\\/]/).includes("..")) throw new ProjectReadError("missions_root_escape", "Invalid project missions.root");
    p.missionsRoot = path.resolve(p.root, missions);
    p.sourcePath = workSource(p.root, p.root);
    if (fs.existsSync(p.missionsRoot)) insideProject(p.root, p.missionsRoot);
  } catch (err) { p.error = (err as Error).message; }
  return p;
}
function aliasesOf(aliases: Map<string, string>, id: string): string[] {
  return [...aliases].filter(([, owner]) => owner === id).map(([alias]) => alias);
}
/** One plain advisory for each former id this project declares that can't apply. A collision is reported, never refused. */
function aliasWarningsOf(ignored: IgnoredAlias[], id: string): string[] {
  return ignored.filter(i => i.declaredBy.includes(id)).map(i => {
    if (i.currentOwner) return `aliases: '${i.alias}' is ignored: it's project ${i.currentOwner}'s current id, so rows tagged project:${i.alias} stay ${i.currentOwner}'s`;
    const others = i.declaredBy.filter(d => d !== id);
    return `aliases: '${i.alias}' is ignored: ${others.join(", ")} also declare${others.length === 1 ? "s" : ""} it, so rows tagged project:${i.alias} belong to no project`;
  });
}
/** Healthy catalogued projects' missions roots, for readers that resolve scopes through the project catalog (terminal mission/slice views, #3553). A project whose identity or missions root cannot be read is skipped, like a missing optional index root; a missing or unreadable catalog yields no roots. */
export function catalogMissionsRoots(catalogPath: string): string[] {
  let entries: Array<{ id: string; root: string }> | null;
  try {
    entries = readProjectCatalog(catalogPath);
  } catch {
    return [];
  }
  if (!entries) return [];
  const report = readCatalogAliasReport(catalogPath);
  const roots: string[] = [];
  for (const entry of entries) {
    const project = projectEntry(entry.id, path.resolve(path.dirname(catalogPath), entry.root),
      aliasesOf(report.aliases, entry.id), aliasWarningsOf(report.ignored, entry.id));
    if (!project.error) roots.push(project.missionsRoot);
  }
  return roots;
}
export function listProjects(c: Pick<ReadContext, "get">): { catalogPath: string; projects: ProjectRead[] } {
  const { workspace, catalog } = projectCatalogPaths(c);
  const entries = readProjectCatalog(catalog);
  if (entries) {
    const report = readCatalogAliasReport(catalog);
    return { catalogPath: catalog, projects: entries.map(e => projectEntry(e.id, path.resolve(path.dirname(catalog), e.root), aliasesOf(report.aliases, e.id), aliasWarningsOf(report.ignored, e.id))) };
  }
  // Uncatalogued workspaces keep their existing single-project authority.
  const manifest = path.join(workspace, "project.yaml");
  const value = fs.existsSync(manifest) ? yamlObject(manifest) : {};
  const id = value.id ?? value.metadata?.id ?? "workspace";
  return { catalogPath: catalog, projects: [projectEntry(id, workspace, workspaceAliases(workspace, id))] };
}
function lookupProject(c: Pick<ReadContext, "get">, id: string): ProjectRead {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new ProjectReadError("invalid_project", "Invalid project ID");
  const { catalog } = projectCatalogPaths(c);
  const selected = selectCatalogProject(catalog, id);
  const report = selected ? readCatalogAliasReport(catalog) : null;
  const p = selected && report ? projectEntry(selected.id, selected.root, aliasesOf(report.aliases, selected.id), aliasWarningsOf(report.ignored, selected.id))
    : listProjects(c).projects.find(p => p.id === id);
  if (!p) throw new ProjectReadError("project_not_found", `Project ${id} is unavailable`);
  return p;
}
function usableProject(p: ProjectRead): ProjectRead {
  if (p.error) throw new ProjectReadError("project_unavailable", `${p.id}: ${p.error}`);
  if (!fs.existsSync(p.missionsRoot)) throw new ProjectReadError("missions_unavailable", `${p.id}: missions root is unavailable: ${p.missionsRoot}`);
  return p;
}
/** One catalog project by id, resolved as `?project=` selection resolves it, without requiring its sources to be readable. */
export function declaredProject(c: Pick<ReadContext, "get">, id: string): ProjectRead {
  return lookupProject(c, id);
}
/** One catalog project by id, with the same resolution and checks as `?project=` selection. */
export function projectById(c: Pick<ReadContext, "get">, id: string): ProjectRead {
  return usableProject(lookupProject(c, id));
}
/** Prepared roots may spell the same directory through a symlink or dot segments. */
export function sameProjectRoot(expected: string, actual: string): boolean {
  try { return expected === actual || fs.realpathSync(expected) === fs.realpathSync(actual); }
  catch { return false; } // Distinct unavailable paths cannot confirm project identity.
}
export function selectedProject(c: ReadContext): ProjectRead | null {
  const id = c.req.query("project");
  if (id === undefined) return null;
  const p = lookupProject(c, id);
  if (c.req.query("projectRoot") && !sameProjectRoot(c.req.query("projectRoot")!, p.root)) throw new ProjectReadError("project_changed", `Project ${id} root changed; choose it again`);
  return usableProject(p);
}
export function projectReadResponse(err: unknown): Response {
  return Response.json({ error: err instanceof ProjectReadError ? err.code : "project_source_unavailable", message: (err as Error).message }, { status: 409 });
}
export function projectMission(p: ProjectRead, mission: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mission)) throw new ProjectReadError("invalid_mission", "Invalid mission directory");
  const dir = path.join(p.missionsRoot, mission);
  workSource(p.root, dir);
  const slices = path.join(dir, "slices");
  if (fs.existsSync(slices)) {
    insideProject(p.root, slices);
    for (const child of fs.readdirSync(slices, { withFileTypes: true })) {
      // Keep containment checks for every source consumed by mission readers.
      // A child's syntax belongs to that child's read, not its healthy siblings.
      if (child.isDirectory() || child.isSymbolicLink()) {
        const childDir = insideProject(p.root, path.join(slices, child.name));
        const source = NODE_FILE_PRECEDENCE.map(name => path.join(childDir, name)).find(file => fs.existsSync(file));
        if (source) insideProject(p.root, source);
      }
    }
  }
  return dir;
}
