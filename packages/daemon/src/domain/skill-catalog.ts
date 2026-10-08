import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import nodePath from "node:path";
import { parse as parseYaml } from "yaml";
import { parseSkillFrontmatter } from "./skill-discovery.js";

const CATALOG_SCHEMA = "openrig.skill-catalog/v1";
const MANIFEST_SCHEMA = "openrig.skill-loadout/v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TOPOLOGY_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type SkillSelectionSource = "system" | "topology" | "project";
export type SkillRuntime = "claude-code" | "codex";

export interface CatalogSkill {
  id: string;
  sourceDir: string;
  sourceRoot: string;
  revision: string;
  digest: string;
  files: Record<string, string>;
  selectedBy: SkillSelectionSource[];
  /** Set when the skill comes from a selected plugin. Such a skill never displaces
   *  a same-name skill OpenRig does not own (see reconcileSkillLoadout). */
  pluginId?: string;
}

export interface SkillLoadout {
  catalogRoot: string;
  catalogRevision: string | null;
  catalogDigest: string | null;
  /** Distinguishes an explicitly installed empty project loadout from a
   *  startup that has no project-world input and must retain the installed one. */
  projectSelectionDeclared: boolean;
  projectSelection: string[];
  entries: CatalogSkill[];
}

export interface SkillCatalogFailure {
  code: string;
  message: string;
  path?: string;
}

export type ResolveSkillLoadoutResult =
  | { ok: true; loadout: SkillLoadout }
  | { ok: false; errors: SkillCatalogFailure[] };

export type SkillProjectionStatus = "current" | "missing" | "shadowed" | "stale" | "conflicting";

export interface SkillProjectionReceipt {
  id: string;
  selectedBy: SkillSelectionSource[];
  sourceRoot: string;
  revision: string;
  digest: string;
  target: string;
  status: SkillProjectionStatus;
  detail: string;
}

interface OwnedSkill {
  id: string;
  target: string;
  sourceDir: string;
  sourceRoot: string;
  revision: string;
  digest: string;
  files: Record<string, string>;
  selectedBy: SkillSelectionSource[];
  /** #875 — the name the runtime shows when the skill arrives through a plugin (`openrig:<id>`). */
  qualifiedName?: string;
}

/** #875 — a loadout kept outside the cwd (a seat directory). Its skills reach the runtime through
 *  a plugin, so each is recorded with the plugin-qualified name the runtime shows. */
export interface SkillLoadoutLocation {
  targetRoot: string;
  manifestPath: string;
  qualifiedName: (skillId: string) => string;
}

interface OwnershipManifest {
  schema: typeof MANIFEST_SCHEMA;
  runtime: SkillRuntime;
  targetRoot: string;
  updatedAt: string;
  topologySelections: Record<string, string[]>;
  projectSelection: string[];
  skills: OwnedSkill[];
}

interface GitIgnorePlan {
  path: string;
  originalExists: boolean;
  originalContent: string;
  nextContent: string;
  changed: boolean;
}

export interface ReconcileSkillLoadoutResult {
  ok: boolean;
  applied: boolean;
  freshLaunchRequired: boolean;
  runtime: SkillRuntime;
  targetRoot: string;
  manifestPath: string;
  receipts: SkillProjectionReceipt[];
  removed: string[];
  errors: SkillCatalogFailure[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0
    && !nodePath.posix.isAbsolute(path)
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isWithin(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative);
}

function readYamlObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid YAML: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must contain a YAML object`);
  return parsed;
}

function readStringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && SAFE_ID.test(entry))) {
    throw new Error(`${label} must be a list of bounded skill identities`);
  }
  return value as string[];
}

export function readSystemSkillSelection(catalogRoot: string): string[] {
  const manifestPath = nodePath.join(catalogRoot, "catalog.yaml");
  if (!existsSync(manifestPath)) return [];
  const manifest = readYamlObject(manifestPath);
  if (manifest["schema"] !== CATALOG_SCHEMA) {
    throw new Error(`${manifestPath} must declare schema: ${CATALOG_SCHEMA}`);
  }
  return readStringList(manifest["system"], `${manifestPath} system`);
}

export function readProjectSkillSelection(projectRoot: string): string[] {
  const manifestPath = nodePath.join(projectRoot, "project.yaml");
  if (!existsSync(manifestPath)) return [];
  const manifest = readYamlObject(manifestPath);
  const install = manifest["install"];
  if (install === undefined || install === null) return [];
  if (!isRecord(install)) throw new Error(`${manifestPath} install must be a YAML object`);
  return readStringList(install["skills"], `${manifestPath} install.skills`);
}

export function inspectSkillDirectory(root: string): { digest: string; files: Record<string, string> } {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`managed skill target must be a real directory, not a symlink or file: ${root}`);
  }
  const files: Record<string, string> = {};
  const fileModes: Record<string, number> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name))) {
      const absolute = nodePath.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in a managed skill: ${absolute}`);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) {
        files[relative] = sha256(readFileSync(absolute));
        fileModes[relative] = stat.mode & 0o777;
      }
      else throw new Error(`unsupported filesystem entry in a managed skill: ${absolute}`);
    }
  };
  walk(root, "");
  const digest = sha256(Object.keys(files).sort(compareBytes)
    .map((path) => `${path}\0${fileModes[path]!.toString(8).padStart(3, "0")}\0${files[path]}`)
    .join("\n"));
  return { digest, files };
}

function gitRevision(catalogRoot: string): string {
  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["-C", catalogRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(`managed skill catalog is not inside a readable Git repository: ${catalogRoot}`);
  }
  const rel = nodePath.relative(realpathSync(repoRoot), realpathSync(catalogRoot)) || ".";
  const dirty = execFileSync(
    "git",
    ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all", "--", rel],
    { encoding: "utf8" },
  ).trim();
  if (dirty) {
    throw new Error(`managed skill catalog has uncommitted content at ${catalogRoot}; commit or restore it before projection`);
  }
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function scanCatalog(catalogRoot: string): {
  revision: string;
  digest: string;
  skills: Map<string, Omit<CatalogSkill, "selectedBy">>;
} {
  if (!existsSync(catalogRoot)) throw new Error(`managed skill catalog root does not exist: ${catalogRoot}`);
  const rootStat = lstatSync(catalogRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`managed skill catalog root must be a real directory, not a symlink: ${catalogRoot}`);
  }
  const revision = gitRevision(catalogRoot);
  const skills = new Map<string, Omit<CatalogSkill, "selectedBy">>();
  for (const entry of readdirSync(catalogRoot, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const sourceDir = nodePath.join(catalogRoot, entry.name);
    if (lstatSync(sourceDir).isSymbolicLink()) {
      throw new Error(`symlinked skill directories are not allowed: ${sourceDir}`);
    }
    const skillFile = nodePath.join(sourceDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
    if (!parsed.ok) throw new Error(`${skillFile}: ${parsed.reason}`);
    const id = parsed.frontmatter.name;
    if (!SAFE_ID.test(id)) throw new Error(`${skillFile}: frontmatter name '${id}' is not a bounded skill identity`);
    const prior = skills.get(id);
    if (prior) {
      throw new Error(`duplicate managed skill identity '${id}' at ${prior.sourceDir} and ${sourceDir}`);
    }
    const tree = inspectSkillDirectory(sourceDir);
    skills.set(id, {
      id,
      sourceDir,
      sourceRoot: catalogRoot,
      revision,
      digest: tree.digest,
      files: tree.files,
    });
  }
  const digest = sha256([...skills.values()].map((skill) => `${skill.id}\0${skill.digest}`).join("\n"));
  return { revision, digest, skills };
}

export function resolveSkillLoadout(input: {
  catalogRoot: string;
  systemSkills?: string[];
  topologySkills?: string[];
  projectRoot?: string;
  projectSkills?: string[];
  allowMissingTopology?: boolean;
}): ResolveSkillLoadoutResult {
  const errors: SkillCatalogFailure[] = [];
  let system: string[] = [];
  let project: string[] = [];
  const projectSelectionDeclared = input.projectSkills !== undefined
    || (input.projectRoot !== undefined && existsSync(nodePath.join(input.projectRoot, "project.yaml")));
  try {
    system = input.systemSkills ?? readSystemSkillSelection(input.catalogRoot);
    project = input.projectSkills ?? (input.projectRoot ? readProjectSkillSelection(input.projectRoot) : []);
    readStringList(system, "system skill selection");
    readStringList(input.topologySkills ?? [], "topology skill selection");
  } catch (err) {
    return { ok: false, errors: [{ code: "selector_invalid", message: (err as Error).message }] };
  }

  const selected = new Map<string, SkillSelectionSource[]>();
  for (const [source, ids] of [
    ["system", system],
    ["topology", input.topologySkills ?? []],
    ["project", project],
  ] as Array<[SkillSelectionSource, string[]]>) {
    for (const id of ids) {
      const sources = selected.get(id) ?? [];
      if (!sources.includes(source)) sources.push(source);
      selected.set(id, sources);
    }
  }

  const catalogManifestExists = existsSync(nodePath.join(input.catalogRoot, "catalog.yaml"));
  const catalogRequired = system.length > 0 || project.length > 0 || (!input.allowMissingTopology && selected.size > 0);
  if (!catalogManifestExists && !catalogRequired) {
    return {
      ok: true,
      loadout: {
        catalogRoot: input.catalogRoot,
        catalogRevision: null,
        catalogDigest: null,
        projectSelectionDeclared,
        projectSelection: [...project].sort(compareBytes),
        entries: [],
      },
    };
  }

  let catalog: ReturnType<typeof scanCatalog>;
  try {
    catalog = scanCatalog(input.catalogRoot);
  } catch (err) {
    return { ok: false, errors: [{ code: "catalog_unavailable", message: (err as Error).message, path: input.catalogRoot }] };
  }

  const entries: CatalogSkill[] = [];
  for (const [id, selectedBy] of [...selected.entries()].sort(([a], [b]) => compareBytes(a, b))) {
    const skill = catalog.skills.get(id);
    if (!skill) {
      if (input.allowMissingTopology && selectedBy.every((source) => source === "topology")) continue;
      errors.push({
        code: "selected_skill_missing",
        message: `selected skill '${id}' is missing from managed catalog ${input.catalogRoot}`,
        path: input.catalogRoot,
      });
      continue;
    }
    entries.push({ ...skill, selectedBy });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    loadout: {
      catalogRoot: input.catalogRoot,
      catalogRevision: catalog.revision,
      catalogDigest: catalog.digest,
      projectSelectionDeclared,
      projectSelection: [...project].sort(compareBytes),
      entries,
    },
  };
}

/** A selected plugin's skills as loadout entries for one runtime. Neither Claude Code
 *  nor Codex reads skills from the plugin folder OpenRig projects into a seat's working
 *  directory, so they travel in the managed loadout instead. A plugin applies to a
 *  runtime as the adapters decide: an explicit pluginType, otherwise the runtime's own
 *  manifest (.claude-plugin/ or .codex-plugin/). */
export function resolvePluginSkills(input: {
  pluginId: string;
  pluginRoot: string;
  runtime: SkillRuntime;
  pluginType?: "claude" | "codex" | "auto";
}): { entries: CatalogSkill[]; warnings: string[] } {
  const entries: CatalogSkill[] = [];
  const warnings: string[] = [];
  const pluginRoot = nodePath.resolve(input.pluginRoot);
  const manifestDir = input.runtime === "claude-code" ? ".claude-plugin" : ".codex-plugin";
  const pluginType = input.pluginType ?? "auto";
  const applies = pluginType === "auto"
    ? existsSync(nodePath.join(pluginRoot, manifestDir, "plugin.json"))
    : pluginType === (input.runtime === "claude-code" ? "claude" : "codex");
  if (!applies) return { entries, warnings };

  let manifest: Record<string, unknown> = {};
  const manifestPath = [manifestDir, ".claude-plugin", ".codex-plugin"]
    .map((dir) => nodePath.join(pluginRoot, dir, "plugin.json"))
    .find((path) => existsSync(path));
  if (manifestPath) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (isRecord(parsed)) manifest = parsed;
    } catch { /* the plugin's own projection reports an unreadable manifest */ }
  }
  const skillsDir = nodePath.resolve(pluginRoot, typeof manifest["skills"] === "string" ? manifest["skills"] : "skills");
  if (!isWithin(pluginRoot, skillsDir) || !existsSync(skillsDir)) return { entries, warnings };
  const revision = `plugin:${input.pluginId}${typeof manifest["version"] === "string" ? `@${manifest["version"]}` : ""}`;

  let listing: Dirent[];
  try {
    listing = readdirSync(skillsDir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`plugin_skill_skipped: plugin ${input.pluginId} skills at ${skillsDir}: ${(err as Error).message}`);
    return { entries, warnings };
  }
  for (const entry of listing.sort((a, b) => compareBytes(a.name, b.name))) {
    if (!entry.isDirectory()) continue;
    const sourceDir = nodePath.join(skillsDir, entry.name);
    const skillFile = nodePath.join(sourceDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const parsed = parseSkillFrontmatter(readFileSync(skillFile, "utf8"));
      if (!parsed.ok) throw new Error(parsed.reason);
      const id = parsed.frontmatter.name;
      if (!SAFE_ID.test(id)) throw new Error(`frontmatter name '${id}' is not a bounded skill identity`);
      if (entries.some((skill) => skill.id === id)) throw new Error(`the plugin has another skill named '${id}'`);
      const tree = inspectSkillDirectory(sourceDir);
      entries.push({
        id,
        sourceDir,
        sourceRoot: pluginRoot,
        revision,
        digest: tree.digest,
        files: tree.files,
        selectedBy: ["topology"],
        pluginId: input.pluginId,
      });
    } catch (err) {
      warnings.push(`plugin_skill_skipped: plugin ${input.pluginId} skill at ${sourceDir}: ${(err as Error).message}`);
    }
  }
  entries.sort((a, b) => compareBytes(a.id, b.id));
  return { entries, warnings };
}

const KEPT_DETAIL = "kept: ";

/** The plugin an owned record came from, from the revision resolvePluginSkills wrote. */
function pluginIdOf(revision: string): string | undefined {
  return /^plugin:([^@]+)/.exec(revision)?.[1];
}

/** A plugin skill left out because a skill OpenRig does not own already has its name. */
export function isKeptPluginSkill(receipt: SkillProjectionReceipt): boolean {
  return receipt.status === "shadowed" && receipt.detail.startsWith(KEPT_DETAIL);
}

function targetRootFor(runtime: SkillRuntime, cwd: string): string {
  return nodePath.join(cwd, runtime === "claude-code" ? ".claude" : ".agents", "skills");
}

function ownershipManifestPath(cwd: string, runtime: SkillRuntime): string {
  return nodePath.join(cwd, ".openrig", "skill-loadouts", `${runtime}.json`);
}

function readOwnershipManifest(path: string, runtime: SkillRuntime, targetRoot: string): OwnershipManifest {
  if (!existsSync(path)) {
    return { schema: MANIFEST_SCHEMA, runtime, targetRoot, updatedAt: "", topologySelections: {}, projectSelection: [], skills: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`skill ownership manifest is unreadable at ${path}: ${(err as Error).message}`);
  }
  if (!isRecord(value) || value["schema"] !== MANIFEST_SCHEMA || value["runtime"] !== runtime || value["targetRoot"] !== targetRoot || !Array.isArray(value["skills"])) {
    throw new Error(`skill ownership manifest has an incompatible shape at ${path}; move it aside and re-run inspection`);
  }
  const skills = value["skills"] as unknown[];
  if (!skills.every((entry) => {
    if (
      !isRecord(entry)
      || typeof entry["id"] !== "string"
      || !SAFE_ID.test(entry["id"])
      || entry["target"] !== nodePath.join(targetRoot, entry["id"])
      || typeof entry["sourceRoot"] !== "string"
      || !nodePath.isAbsolute(entry["sourceRoot"])
      || (entry["sourceDir"] !== undefined && typeof entry["sourceDir"] !== "string")
      || typeof entry["revision"] !== "string"
      || entry["revision"].length === 0
      || typeof entry["digest"] !== "string"
      || !SHA256.test(entry["digest"])
      || !isRecord(entry["files"])
      || !Object.entries(entry["files"]).every(([file, digest]) => isSafeRelativePath(file) && typeof digest === "string" && SHA256.test(digest))
      || !Array.isArray(entry["selectedBy"])
      || !entry["selectedBy"].every((source) => source === "system" || source === "topology" || source === "project")
      || (entry["qualifiedName"] !== undefined && typeof entry["qualifiedName"] !== "string")
    ) return false;
    const sourceDir = entry["sourceDir"] ?? nodePath.join(entry["sourceRoot"], entry["id"]);
    return nodePath.isAbsolute(sourceDir) && isWithin(entry["sourceRoot"], sourceDir);
  })) {
    throw new Error(`skill ownership manifest contains an invalid skill record at ${path}; move it aside and re-run inspection`);
  }
  if (new Set(skills.map((entry) => (entry as Record<string, unknown>)["id"])).size !== skills.length) {
    throw new Error(`skill ownership manifest contains duplicate skill identities at ${path}; move it aside and re-run inspection`);
  }
  const rawTopology = value["topologySelections"];
  if (
    rawTopology !== undefined
    && (
      !isRecord(rawTopology)
      || !Object.entries(rawTopology).every(([owner, ids]) => (
        SAFE_TOPOLOGY_OWNER.test(owner)
        && Array.isArray(ids)
        && ids.every((id) => typeof id === "string" && SAFE_ID.test(id))
        && new Set(ids).size === ids.length
      ))
    )
  ) {
    throw new Error(`skill ownership manifest contains invalid topology selections at ${path}; move it aside and re-run inspection`);
  }
  const rawProject = value["projectSelection"];
  if (
    rawProject !== undefined
    && (!Array.isArray(rawProject) || !rawProject.every((id) => typeof id === "string" && SAFE_ID.test(id)) || new Set(rawProject).size !== rawProject.length)
  ) {
    throw new Error(`skill ownership manifest contains an invalid project selection at ${path}; move it aside and re-run inspection`);
  }
  const parsed = value as unknown as Omit<OwnershipManifest, "topologySelections" | "projectSelection"> & {
    topologySelections?: Record<string, string[]>;
    projectSelection?: string[];
  };
  const parsedSkills = parsed.skills.map((skill) => ({
    ...skill,
    sourceDir: skill.sourceDir ?? nodePath.join(skill.sourceRoot, skill.id),
  }));
  return {
    ...parsed,
    topologySelections: parsed.topologySelections ?? {},
    projectSelection: parsed.projectSelection
      ?? parsedSkills.filter((skill) => skill.selectedBy.includes("project")).map((skill) => skill.id).sort(compareBytes),
    skills: parsedSkills,
  };
}

function copyDirectoryExact(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = nodePath.join(source, entry.name);
    const dest = nodePath.join(target, entry.name);
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in a managed skill: ${src}`);
    if (stat.isDirectory()) copyDirectoryExact(src, dest);
    else if (stat.isFile()) {
      writeFileSync(dest, readFileSync(src));
      chmodSync(dest, stat.mode & 0o777);
    } else throw new Error(`unsupported filesystem entry in a managed skill: ${src}`);
  }
}

function gitIgnorePattern(base: string, path: string, directory: boolean): string {
  const relative = nodePath.relative(base, path);
  if (!relative || relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
    throw new Error(`managed skill projection path is outside its Git working tree: ${path}`);
  }
  const escaped = relative
    .split(nodePath.sep)
    .join("/")
    .replace(/([\\*?\[\] !#])/g, "\\$1");
  return `/${escaped}${directory ? "/" : ""}`;
}

function replaceGitIgnoreBlock(original: string, begin: string, end: string, patterns: string[] | null): string {
  const beginAt = original.indexOf(begin);
  const endAt = original.indexOf(end);
  if ((beginAt === -1) !== (endAt === -1)) {
    throw new Error(`managed Git exclusion block is incomplete (${begin})`);
  }
  if (beginAt !== -1) {
    if (
      original.indexOf(begin, beginAt + begin.length) !== -1
      || original.indexOf(end, endAt + end.length) !== -1
      || (beginAt > 0 && original[beginAt - 1] !== "\n")
      || endAt < beginAt
      || (original[endAt + end.length] !== undefined && original[endAt + end.length] !== "\n")
    ) {
      throw new Error(`managed Git exclusion block is ambiguous (${begin})`);
    }
    const after = original[endAt + end.length] === "\n" ? endAt + end.length + 1 : endAt + end.length;
    const block = patterns === null ? "" : `${begin}\n${patterns.join("\n")}\n${end}\n`;
    return `${original.slice(0, beginAt)}${block}${original.slice(after)}`;
  }
  if (patterns === null) return original;
  const separator = original.length > 0 && !original.endsWith("\n") ? "\n" : "";
  return `${original}${separator}${begin}\n${patterns.join("\n")}\n${end}\n`;
}

function isGitIgnored(repoRoot: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--no-index", "--", path], { stdio: "ignore" });
    return true;
  } catch (err) {
    if ((err as { status?: number | null }).status === 1) return false;
    throw err;
  }
}

function isGitTracked(repoRoot: string, path: string): boolean {
  const relative = nodePath.relative(repoRoot, path);
  try {
    execFileSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relative], { stdio: "ignore" });
    return true;
  } catch (err) {
    if ((err as { status?: number | null }).status === 1) return false;
    throw err;
  }
}

function planGitIgnoreFile(input: {
  repoRoot: string;
  path: string;
  begin: string;
  end: string;
  targets: Array<{ path: string; directory: boolean }>;
  coveragePaths: string[];
}): GitIgnorePlan | null {
  const originalExists = existsSync(input.path);
  const originalContent = originalExists ? readFileSync(input.path, "utf8") : "";
  const hasManagedBlock = originalContent.includes(input.begin) || originalContent.includes(input.end);
  const hasOtherManagedBlock = (["claude-code", "codex"] as const).some((runtime) =>
    originalContent.includes(`# BEGIN OpenRig managed skill loadout ${runtime}`)
    && originalContent.includes(`# END OpenRig managed skill loadout ${runtime}`));
  if (!hasManagedBlock && !hasOtherManagedBlock) {
    if (input.coveragePaths.every((path) => isGitIgnored(input.repoRoot, path))) return null;
    if (originalExists) {
      throw new Error(`refusing to modify an existing unmanaged Git ignore file at ${input.path}`);
    }
  }
  const patterns = input.targets.length === 0
    ? null
    : ["/.gitignore", ...input.targets
      .map((target) => gitIgnorePattern(nodePath.dirname(input.path), target.path, target.directory))
      .sort(compareBytes)];
  const nextContent = replaceGitIgnoreBlock(originalContent, input.begin, input.end, patterns);
  if (nextContent !== originalContent && isGitTracked(input.repoRoot, input.path)) {
    throw new Error(`refusing to modify a tracked Git ignore file at ${input.path}`);
  }
  return { path: input.path, originalExists, originalContent, nextContent, changed: nextContent !== originalContent };
}

function planGitIgnores(input: {
  cwd: string;
  runtime: SkillRuntime;
  targetRoot: string;
  manifestPath: string;
  owned: OwnedSkill[];
}): GitIgnorePlan[] {
  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["-C", input.cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return [];
  }
  const canonicalRepoRoot = realpathSync(repoRoot);
  const canonicalCwd = realpathSync(input.cwd);
  const fromCanonicalCwd = (path: string): string => {
    const relative = nodePath.relative(input.cwd, path);
    if (!relative || relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) {
      throw new Error(`managed skill projection path is outside its working directory: ${path}`);
    }
    return nodePath.join(canonicalCwd, relative);
  };
  const canonicalTargetRoot = fromCanonicalCwd(input.targetRoot);
  const canonicalManifestPath = fromCanonicalCwd(input.manifestPath);
  const key = input.runtime;
  const begin = `# BEGIN OpenRig managed skill loadout ${key}`;
  const end = `# END OpenRig managed skill loadout ${key}`;
  const plans = [
    planGitIgnoreFile({
      repoRoot: canonicalRepoRoot,
      path: nodePath.join(canonicalTargetRoot, ".gitignore"),
      begin,
      end,
      targets: input.owned.map((skill) => ({ path: fromCanonicalCwd(skill.target), directory: true })),
      coveragePaths: input.owned.flatMap((skill) => Object.keys(skill.files)
        .map((path) => nodePath.join(fromCanonicalCwd(skill.target), path))),
    }),
    planGitIgnoreFile({
      repoRoot: canonicalRepoRoot,
      path: nodePath.join(nodePath.dirname(canonicalManifestPath), ".gitignore"),
      begin,
      end,
      targets: [{ path: canonicalManifestPath, directory: false }],
      coveragePaths: [canonicalManifestPath],
    }),
  ];
  return plans.filter((plan): plan is GitIgnorePlan => plan !== null);
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(nodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    if (existsSync(path)) chmodSync(temporary, lstatSync(path).mode & 0o777);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function applyGitIgnore(plan: GitIgnorePlan): void {
  if (plan.nextContent.length === 0) rmSync(plan.path, { force: true });
  else writeFileAtomic(plan.path, plan.nextContent);
}

function restoreGitIgnore(plan: GitIgnorePlan): void {
  if (plan.nextContent.length === 0) {
    if (existsSync(plan.path)) return;
  } else if (!existsSync(plan.path) || readFileSync(plan.path, "utf8") !== plan.nextContent) return;
  if (plan.originalExists) writeFileAtomic(plan.path, plan.originalContent);
  else rmSync(plan.path, { force: true });
}

function classifySkillProjectionTarget(
  skill: Pick<CatalogSkill, "digest">,
  prior: Pick<OwnedSkill, "digest"> | undefined,
  target: string,
): Pick<SkillProjectionReceipt, "status" | "detail"> {
  if (!pathEntryExists(target)) {
    return { status: "missing", detail: "selected skill is not projected" };
  }
  try {
    const actual = inspectSkillDirectory(target);
    if (actual.digest === skill.digest) {
      return prior
        ? { status: "current", detail: "owned target matches selected source bytes" }
        : { status: "shadowed", detail: "equal unowned target already supplies these bytes" };
    }
    if (prior && actual.digest === prior.digest) {
      return { status: "stale", detail: "owned target still matches the prior projection and can be refreshed safely" };
    }
    return {
      status: "conflicting",
      detail: prior
        ? "target differs from both the selected source and OpenRig's last owned projection; refusing to overwrite an operator edit"
        : "unowned target differs from the selected skill source; move it aside or reconcile its bytes explicitly",
    };
  } catch (err) {
    return { status: "conflicting", detail: (err as Error).message };
  }
}

export function reconcileSkillLoadout(input: {
  loadout: SkillLoadout;
  runtime: SkillRuntime;
  cwd: string;
  apply?: boolean;
  /** Stable seat/session identity whose topology selector is being reconciled.
   *  Different seats may share one cwd; their role selections compose as a
   *  union instead of deleting one another. CLI-only reconciliation uses the
   *  workspace owner. */
  topologyOwner?: string;
  /** #875 — keep the loadout here instead of under the cwd. */
  location?: SkillLoadoutLocation;
}): ReconcileSkillLoadoutResult {
  const cwd = nodePath.resolve(input.cwd);
  const targetRoot = input.location ? nodePath.resolve(input.location.targetRoot) : targetRootFor(input.runtime, cwd);
  const manifestPath = input.location ? nodePath.resolve(input.location.manifestPath) : ownershipManifestPath(cwd, input.runtime);
  const qualify = (skill: OwnedSkill): OwnedSkill => input.location ? { ...skill, qualifiedName: input.location.qualifiedName(skill.id) } : skill;
  const receipts: SkillProjectionReceipt[] = [];
  const errors: SkillCatalogFailure[] = [];
  let manifest: OwnershipManifest;
  try {
    manifest = readOwnershipManifest(manifestPath, input.runtime, targetRoot);
  } catch (err) {
    return { ok: false, applied: false, freshLaunchRequired: false, runtime: input.runtime, targetRoot, manifestPath, receipts, removed: [], errors: [{ code: "ownership_manifest_invalid", message: (err as Error).message, path: manifestPath }] };
  }
  const owned = new Map(manifest.skills.map((skill) => [skill.id, skill]));

  // A plugin's skill never displaces one OpenRig does not own: that target keeps its
  // bytes, and the selection is not recorded, so no seat sharing this folder later
  // depends on an ownership record that was never written.
  // Names that differ only in ASCII letter case count as the same name, because Git may
  // compare them that way (core.ignorecase) and an ignore entry would then hide the
  // user's folder.
  const keptReceipts: SkillProjectionReceipt[] = [];
  const foldCase = (name: string) => name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let existingNames: string[] = [];
  try { existingNames = readdirSync(targetRoot); } catch { /* no skill folder yet */ }
  const loadoutEntries = input.loadout.entries.filter((entry) => {
    if (!entry.pluginId || owned.has(entry.id)) return true;
    const existing = existingNames.includes(entry.id)
      ? entry.id
      : existingNames.find((name) => foldCase(name) === foldCase(entry.id));
    if (existing === undefined) return true;
    const target = nodePath.join(targetRoot, existing);
    const observed = classifySkillProjectionTarget(entry, undefined, target);
    keptReceipts.push({
      id: entry.id,
      selectedBy: entry.selectedBy,
      sourceRoot: entry.sourceRoot,
      revision: entry.revision,
      digest: entry.digest,
      target,
      status: "shadowed",
      detail: observed.status === "shadowed"
        ? observed.detail
        : `${KEPT_DETAIL}a skill with this name that OpenRig does not own is already here; plugin ${entry.pluginId}'s copy was not projected`,
    });
    return false;
  });

  if (
    input.loadout.catalogRevision === null
    && input.loadout.entries.length === 0
    && manifest.skills.length === 0
    && manifest.projectSelection.length === 0
    && Object.keys(manifest.topologySelections).length === 0
  ) {
    return { ok: true, applied: false, freshLaunchRequired: false, runtime: input.runtime, targetRoot, manifestPath, receipts, removed: [], errors };
  }

  const topologyOwner = input.topologyOwner?.trim() || "workspace";
  if (!SAFE_TOPOLOGY_OWNER.test(topologyOwner)) {
    return {
      ok: false,
      applied: false,
      freshLaunchRequired: false,
      runtime: input.runtime,
      targetRoot,
      manifestPath,
      receipts,
      removed: [],
      errors: [{ code: "topology_owner_invalid", message: `topology owner '${topologyOwner}' is not a bounded seat identity` }],
    };
  }
  const topologySelections: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const owner of Object.keys(manifest.topologySelections).sort(compareBytes)) {
    topologySelections[owner] = [...manifest.topologySelections[owner]!].sort(compareBytes);
  }
  const currentTopology = loadoutEntries
    .filter((entry) => entry.selectedBy.includes("topology"))
    .map((entry) => entry.id)
    .sort(compareBytes);
  if (currentTopology.length > 0) topologySelections[topologyOwner] = currentTopology;
  else delete topologySelections[topologyOwner];
  const canonicalTopologySelections: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const owner of Object.keys(topologySelections).sort(compareBytes)) {
    canonicalTopologySelections[owner] = topologySelections[owner]!;
  }
  const retainedTopology = new Set(Object.values(topologySelections).flat());
  const effectiveEntries = [...loadoutEntries];
  for (const id of [...retainedTopology].sort(compareBytes)) {
    const current = effectiveEntries.find((entry) => entry.id === id);
    if (current) {
      current.selectedBy = (["system", "topology", "project"] as SkillSelectionSource[])
        .filter((source) => current.selectedBy.includes(source) || source === "topology");
      continue;
    }
    const prior = owned.get(id);
    if (!prior) {
      errors.push({
        code: "topology_selection_unavailable",
        message: `topology owner still selects '${id}', but its owned source record is absent; relaunch that owner or clear its selection explicitly`,
        path: manifestPath,
      });
      continue;
    }
    const pluginId = pluginIdOf(prior.revision);
    effectiveEntries.push({
      id: prior.id,
      sourceDir: prior.sourceDir,
      sourceRoot: prior.sourceRoot,
      revision: prior.revision,
      digest: prior.digest,
      files: prior.files,
      selectedBy: ["topology"],
      ...(pluginId ? { pluginId } : {}),
    });
  }
  const projectSelection = (input.loadout.projectSelectionDeclared
    ? input.loadout.projectSelection
    : manifest.projectSelection).slice().sort(compareBytes);
  for (const id of projectSelection) {
    const current = effectiveEntries.find((entry) => entry.id === id);
    if (current) {
      current.selectedBy = (["system", "topology", "project"] as SkillSelectionSource[])
        .filter((source) => current.selectedBy.includes(source) || source === "project");
      continue;
    }
    const prior = owned.get(id);
    if (!prior) {
      errors.push({
        code: "project_selection_unavailable",
        message: `installed project still selects '${id}', but its owned source record is absent; run an explicit project install to repair or clear it`,
        path: manifestPath,
      });
      continue;
    }
    effectiveEntries.push({
      id: prior.id,
      sourceDir: prior.sourceDir,
      sourceRoot: prior.sourceRoot,
      revision: prior.revision,
      digest: prior.digest,
      files: prior.files,
      selectedBy: ["project"],
    });
  }
  effectiveEntries.sort((a, b) => compareBytes(a.id, b.id));

  // An edit to OpenRig's own copy of a plugin skill is kept too, under the same record.
  const keptOwned = new Set<string>();
  for (const skill of effectiveEntries) {
    const target = nodePath.join(targetRoot, skill.id);
    const prior = owned.get(skill.id);
    let { status, detail } = classifySkillProjectionTarget(skill, prior, target);
    if (status === "conflicting" && skill.pluginId && prior) {
      keptOwned.add(skill.id);
      status = "shadowed";
      detail = `${KEPT_DETAIL}this copy was changed after OpenRig projected it; plugin ${skill.pluginId}'s copy was not projected`;
    }
    receipts.push({
      id: skill.id,
      selectedBy: skill.selectedBy,
      sourceRoot: skill.sourceRoot,
      revision: skill.revision,
      digest: skill.digest,
      target,
      status,
      detail,
    });
    if (status === "missing" || status === "stale") {
      try {
        const source = inspectSkillDirectory(skill.sourceDir);
        if (source.digest !== skill.digest) {
          status = "conflicting";
          detail = "selected source bytes no longer match the resolved loadout; resolve a fresh loadout before applying";
          receipts[receipts.length - 1]!.status = status;
          receipts[receipts.length - 1]!.detail = detail;
        }
      } catch (err) {
        status = "conflicting";
        detail = `selected source cannot be projected safely: ${(err as Error).message}`;
        receipts[receipts.length - 1]!.status = status;
        receipts[receipts.length - 1]!.detail = detail;
      }
      // A plugin copy OpenRig owns whose source moved on (an upgrade, or a moved plugin
      // folder) keeps its record and waits for a seat that selects the plugin to refresh it.
      if (status === "conflicting" && skill.pluginId && prior && pluginIdOf(prior.revision) === skill.pluginId) {
        keptOwned.add(skill.id);
        status = "shadowed";
        detail = `${KEPT_DETAIL}plugin ${skill.pluginId} changed or moved since OpenRig projected this copy; a seat that selects the plugin refreshes it at its next launch`;
        receipts[receipts.length - 1]!.status = status;
        receipts[receipts.length - 1]!.detail = detail;
      }
    }
    if (status === "conflicting") errors.push({ code: "target_conflict", message: `${skill.id}: ${detail}`, path: target });
  }
  receipts.push(...keptReceipts);

  const selectedIds = new Set(effectiveEntries.map((entry) => entry.id));
  const safeRemovals: OwnedSkill[] = [];
  for (const prior of manifest.skills) {
    if (selectedIds.has(prior.id)) continue;
    if (!pathEntryExists(prior.target)) continue;
    let failure: SkillCatalogFailure | null = null;
    try {
      if (inspectSkillDirectory(prior.target).digest !== prior.digest) failure = {
        code: "stale_target_modified",
        message: `${prior.id}: deselected owned target was modified after projection; refusing to remove it`,
        path: prior.target,
      };
    } catch (err) {
      failure = { code: "stale_target_unreadable", message: `${prior.id}: ${(err as Error).message}`, path: prior.target };
    }
    if (!failure) {
      safeRemovals.push(prior);
      continue;
    }
    // A deselected plugin copy that was changed stays where it is and stops being OpenRig's.
    const pluginId = pluginIdOf(prior.revision);
    if (!pluginId) {
      errors.push(failure);
      continue;
    }
    receipts.push({
      id: prior.id,
      selectedBy: prior.selectedBy,
      sourceRoot: prior.sourceRoot,
      revision: prior.revision,
      digest: prior.digest,
      target: prior.target,
      status: "shadowed",
      detail: `${KEPT_DETAIL}plugin ${pluginId} is no longer selected and this copy differs from what OpenRig projected; left in place and no longer managed by OpenRig`,
    });
  }

  if (errors.length > 0 || !input.apply) {
    return { ok: errors.length === 0, applied: false, freshLaunchRequired: false, runtime: input.runtime, targetRoot, manifestPath, receipts, removed: [], errors };
  }

  const changed = receipts.filter((receipt) => receipt.status === "missing" || receipt.status === "stale");
  const nextOwned = effectiveEntries
    .filter((skill) => keptOwned.has(skill.id) || receipts.find((receipt) => receipt.id === skill.id)?.status !== "shadowed")
    .map((skill): OwnedSkill => keptOwned.has(skill.id) ? owned.get(skill.id)! : ({
      id: skill.id,
      target: nodePath.join(targetRoot, skill.id),
      sourceDir: skill.sourceDir,
      sourceRoot: skill.sourceRoot,
      revision: skill.revision,
      digest: skill.digest,
      files: skill.files,
      selectedBy: skill.selectedBy,
    }))
    .map(qualify)
    .sort((a, b) => compareBytes(a.id, b.id));
  let gitIgnorePlans: GitIgnorePlan[];
  try {
    // A loadout outside the cwd adds nothing to the checkout, so it has nothing to hide from Git.
    gitIgnorePlans = input.location ? [] : planGitIgnores({ cwd, runtime: input.runtime, targetRoot, manifestPath, owned: nextOwned });
  } catch (err) {
    return {
      ok: false,
      applied: false,
      freshLaunchRequired: false,
      runtime: input.runtime,
      targetRoot,
      manifestPath,
      receipts,
      removed: [],
      errors: [{ code: "git_exclusion_failed", message: `skill projection could not preserve clean Git state: ${(err as Error).message}` }],
    };
  }
  if (
    changed.length === 0
    && safeRemovals.length === 0
    && JSON.stringify(manifest.skills) === JSON.stringify(nextOwned)
    && JSON.stringify(manifest.topologySelections) === JSON.stringify(canonicalTopologySelections)
    && JSON.stringify(manifest.projectSelection) === JSON.stringify(projectSelection)
    && !gitIgnorePlans.some((plan) => plan.changed)
  ) {
    return { ok: true, applied: false, freshLaunchRequired: false, runtime: input.runtime, targetRoot, manifestPath, receipts, removed: [], errors: [] };
  }
  const removed: string[] = [];
  const rollback: Array<{ target: string; backup: string | null }> = [];
  let stagingRoot: string | null = null;
  const appliedGitIgnores: GitIgnorePlan[] = [];
  try {
    mkdirSync(nodePath.dirname(targetRoot), { recursive: true });
    stagingRoot = nodePath.join(nodePath.dirname(targetRoot), `.openrig-skill-stage-${randomUUID()}`);
    mkdirSync(stagingRoot, { recursive: true });
    const staged = nodePath.join(stagingRoot, "new");
    const backups = nodePath.join(stagingRoot, "old");
    mkdirSync(staged, { recursive: true });
    mkdirSync(backups, { recursive: true });

    for (const receipt of changed) {
      const skill = effectiveEntries.find((entry) => entry.id === receipt.id)!;
      copyDirectoryExact(skill.sourceDir, nodePath.join(staged, skill.id));
    }
    for (const plan of gitIgnorePlans.filter((candidate) => candidate.changed)) {
      applyGitIgnore(plan);
      appliedGitIgnores.push(plan);
    }
    mkdirSync(targetRoot, { recursive: true });
    for (const receipt of changed) {
      const backup = pathEntryExists(receipt.target) ? nodePath.join(backups, receipt.id) : null;
      if (backup) renameSync(receipt.target, backup);
      renameSync(nodePath.join(staged, receipt.id), receipt.target);
      rollback.push({ target: receipt.target, backup });
      receipt.status = "current";
      receipt.detail = "projected exact selected source bytes";
    }
    for (const prior of safeRemovals) {
      const backup = nodePath.join(backups, `removed-${prior.id}`);
      renameSync(prior.target, backup);
      rollback.push({ target: prior.target, backup });
      removed.push(prior.id);
    }

    mkdirSync(nodePath.dirname(manifestPath), { recursive: true });
    const nextManifest: OwnershipManifest = {
      schema: MANIFEST_SCHEMA,
      runtime: input.runtime,
      targetRoot,
      updatedAt: new Date().toISOString(),
      topologySelections: canonicalTopologySelections,
      projectSelection,
      skills: nextOwned,
    };
    const tmpManifest = `${manifestPath}.${randomUUID()}.tmp`;
    writeFileSync(tmpManifest, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
    renameSync(tmpManifest, manifestPath);
    rmSync(stagingRoot, { recursive: true, force: true });
    return {
      ok: true,
      applied: true,
      freshLaunchRequired: changed.length > 0 || removed.length > 0,
      runtime: input.runtime,
      targetRoot,
      manifestPath,
      receipts,
      removed,
      errors: [],
    };
  } catch (err) {
    for (const action of rollback.reverse()) {
      try {
        if (pathEntryExists(action.target)) rmSync(action.target, { recursive: true, force: true });
        if (action.backup && pathEntryExists(action.backup)) renameSync(action.backup, action.target);
      } catch { /* retain the original failure; rollback is best-effort */ }
    }
    for (const plan of appliedGitIgnores.reverse()) {
      try { restoreGitIgnore(plan); } catch { /* retain the original failure; rollback is best-effort */ }
    }
    for (const receipt of changed) {
      const skill = effectiveEntries.find((entry) => entry.id === receipt.id)!;
      const restored = classifySkillProjectionTarget(skill, owned.get(receipt.id), receipt.target);
      receipt.status = restored.status;
      receipt.detail = restored.detail;
    }
    if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
    return {
      ok: false,
      applied: false,
      freshLaunchRequired: false,
      runtime: input.runtime,
      targetRoot,
      manifestPath,
      receipts,
      removed: [],
      errors: [{ code: "projection_failed", message: `skill projection failed and was rolled back: ${(err as Error).message}` }],
    };
  }
}
