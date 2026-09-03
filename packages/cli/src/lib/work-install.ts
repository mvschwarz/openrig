import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { readFrontmatter, resolveNodeFile } from "./scope/scope-fs.js";
import { readProjectSkillSelection } from "@openrig/daemon/skill-loadout";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type WorkInstallSource = "explicit" | "manifest" | "default";
export type WorkInstallAltitude = "project" | "mission" | "slice";

export interface WorkInstallPiece {
  altitude: WorkInstallAltitude;
  address: string;
  path: string;
  exists: boolean;
  source: WorkInstallSource;
}

export interface WorkInstallPlan {
  position: {
    workspaceRoot: string;
    projectId: string | null;
    projectRoot: string;
    missionRoot: string | null;
    sliceRoot: string | null;
    mission: string | null;
    slice: string | null;
    frontier: WorkInstallAltitude;
  };
  pieces: WorkInstallPiece[];
  /** Project-world skill identities from project.yaml install.skills. */
  skills: string[];
  derive: [];
  warnings: string[];
}

export interface WorkInstallFailure {
  error: {
    code: string;
    message: string;
    candidates?: string[];
  };
}

export type WorkInstallResult = WorkInstallPlan | WorkInstallFailure;

function failure(code: string, message: string, candidates?: string[]): WorkInstallFailure {
  return { error: { code, message, ...(candidates ? { candidates } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readYaml(path: string): { value: Record<string, unknown> | null; error?: string } {
  try {
    const value = parseYaml(readFileSync(path, "utf-8")) as unknown;
    return isRecord(value) ? { value } : { value: null, error: `${path} must contain a YAML object` };
  } catch (err) {
    return { value: null, error: `${path} is not valid YAML: ${(err as Error).message}` };
  }
}

function canonicalExisting(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function markdownPath(address: string): string | null {
  const path = address.split("#", 1)[0]!;
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    ![".md", ".markdown"].includes(extname(path).toLowerCase())
  ) {
    return null;
  }
  return path;
}

function piece(
  altitude: WorkInstallAltitude,
  address: string,
  root: string,
  source: WorkInstallSource,
): WorkInstallPiece | WorkInstallFailure {
  const rel = markdownPath(address.slice(address.indexOf(":") + 1));
  if (!rel) return failure("invalid_markdown_address", `${address} must be a relative Markdown address inside its selected root`);
  const nominalPath = resolve(root, rel);
  if (!inside(root, nominalPath)) {
    return failure("address_escape", `${address} resolves outside its selected ${altitude} root`);
  }
  if (existsSync(nominalPath)) {
    const canonicalPath = canonicalExisting(nominalPath);
    if (canonicalPath && !inside(root, canonicalPath)) {
      return failure("address_escape", `${address} resolves through a symlink outside its selected ${altitude} root`);
    }
  }
  return { altitude, address, path: nominalPath, exists: existsSync(nominalPath), source };
}

function manifestProjectId(manifest: Record<string, unknown> | null): string | null {
  if (!manifest) return null;
  if (typeof manifest["id"] === "string") return manifest["id"];
  const metadata = manifest["metadata"];
  return isRecord(metadata) && typeof metadata["id"] === "string" ? metadata["id"] : null;
}

function resolveExplicitSlice(
  missionRoot: string,
  selection: string,
): { root: string; name: string } | WorkInstallFailure {
  const slicesRoot = join(missionRoot, "slices");
  const available: string[] = [];
  const matches: Array<{ root: string; name: string }> = [];
  if (existsSync(slicesRoot)) {
    for (const entry of readdirSync(slicesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      available.push(entry.name);
      const nominalRoot = join(slicesRoot, entry.name);
      const root = canonicalExisting(nominalRoot);
      if (!root || !inside(missionRoot, root)) {
        if (entry.name === selection) {
          return failure("slice_root_escape", `slice '${selection}' resolves outside the selected mission root`);
        }
        continue;
      }
      const nodeFile = resolveNodeFile(root);
      const frontmatter = nodeFile ? readFrontmatter(nodeFile) : {};
      const declaredId = frontmatter["id"] ?? frontmatter["dotId"];
      if (entry.name === selection || declaredId === selection) {
        matches.push({ root, name: entry.name });
      }
    }
  }
  available.sort();
  matches.sort((a, b) => a.name.localeCompare(b.name));
  if (matches.length === 0) {
    return failure("slice_not_found", `slice '${selection}' is not a child of the selected mission`, available);
  }
  if (matches.length > 1) {
    return failure(
      "slice_identity_ambiguous",
      `slice '${selection}' names multiple children of the selected mission`,
      matches.map((match) => match.name),
    );
  }
  return matches[0]!;
}

export function resolveWorkPosition(opts: {
  workspaceRoot: string;
  project?: string;
  mission?: string;
  slice?: string;
}): WorkInstallResult {
  if (opts.project !== undefined && !SEGMENT.test(opts.project)) {
    return failure("invalid_project", "project must be a single bounded segment");
  }
  if (opts.mission !== undefined && !SEGMENT.test(opts.mission)) {
    return failure("invalid_mission", "mission must be a single bounded segment");
  }
  if (opts.slice !== undefined && !SEGMENT.test(opts.slice)) {
    return failure("invalid_slice", "slice must be a single bounded segment");
  }
  if (opts.slice !== undefined && opts.mission === undefined) {
    return failure("mission_required", "slice requires an exact mission selection");
  }

  const workspaceRoot = canonicalExisting(opts.workspaceRoot);
  if (!workspaceRoot) {
    return failure("workspace_root_missing", `workspace root does not exist: ${resolve(opts.workspaceRoot)}`);
  }

  const warnings: string[] = [];
  const catalogPath = join(workspaceRoot, "workspace.yaml");
  let projectId: string | null = null;
  let projectRoot = workspaceRoot;
  if (existsSync(catalogPath)) {
    const parsed = readYaml(catalogPath);
    if (!parsed.value) return failure("workspace_catalog_invalid", parsed.error!);
    const rawProjects = parsed.value["projects"];
    if (!Array.isArray(rawProjects)) {
      return failure("workspace_catalog_invalid", `${catalogPath} must declare projects: [...]`);
    }
    const projects = rawProjects.map((entry) => {
      if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["root"] !== "string") return null;
      return { id: entry["id"], root: entry["root"] };
    });
    if (projects.some((entry) => entry === null)) {
      return failure("workspace_catalog_invalid", `${catalogPath} projects must each declare string id and root values`);
    }
    const declared = projects as Array<{ id: string; root: string }>;
    const candidates = declared.map((entry) => entry.id);
    const duplicateId = candidates.find((id, index) => candidates.indexOf(id) !== index);
    if (duplicateId) {
      return failure("project_identity_ambiguous", `project id '${duplicateId}' names multiple roots in ${catalogPath}`);
    }
    const selectedId = opts.project ?? (declared.length === 1 ? declared[0]!.id : undefined);
    if (!selectedId) {
      return failure("project_required", "multiple projects are declared; select one with --project", candidates);
    }
    const selected = declared.find((entry) => entry.id === selectedId);
    if (!selected) {
      return failure("project_not_found", `project '${selectedId}' is not declared in ${catalogPath}`, candidates);
    }
    const nominalRoot = isAbsolute(selected.root) ? resolve(selected.root) : resolve(workspaceRoot, selected.root);
    const canonicalRoot = canonicalExisting(nominalRoot);
    if (!canonicalRoot) {
      return failure("project_root_missing", `project '${selectedId}' root does not exist: ${nominalRoot}`);
    }
    projectId = selectedId;
    projectRoot = canonicalRoot;
  }

  const projectManifestPath = join(projectRoot, "project.yaml");
  let projectManifest: Record<string, unknown> | null = null;
  if (existsSync(projectManifestPath)) {
    const parsed = readYaml(projectManifestPath);
    if (parsed.value) projectManifest = parsed.value;
    else warnings.push(`${parsed.error}; ignored optional enrichment and kept conventional addresses`);
  }
  const declaredProjectId = manifestProjectId(projectManifest);
  if (projectId && declaredProjectId && projectId !== declaredProjectId) {
    return failure(
      "project_identity_conflict",
      `selected project '${projectId}' conflicts with project.yaml identity '${declaredProjectId}' at ${projectRoot}`,
    );
  }
  if (!projectId) {
    if (opts.project && declaredProjectId !== opts.project) {
      return failure("project_not_found", `project '${opts.project}' cannot be resolved from the uncatalogued workspace`);
    }
    projectId = opts.project ?? declaredProjectId;
  }

  let missionsRel = "missions";
  const missions = projectManifest?.["missions"];
  if (isRecord(missions) && missions["root"] !== undefined) {
    if (typeof missions["root"] === "string" && !isAbsolute(missions["root"]) && !missions["root"].split(/[\\/]/).includes("..")) {
      missionsRel = missions["root"];
    } else {
      warnings.push("project.yaml: optional missions.root must be a relative path inside the project; kept the conventional missions root");
    }
  }
  const missionsRoot = resolve(projectRoot, missionsRel);
  if (!inside(projectRoot, missionsRoot)) {
    return failure("missions_root_escape", "project.yaml missions.root resolves outside the selected project root");
  }

  let projectIntent = "SPEC.md";
  let projectIntentSource: WorkInstallSource = "default";
  let projectContext: string[] = [];
  const install = projectManifest?.["install"];
  let projectSkills: string[] = [];
  if (isRecord(install)) {
    if (install["intent"] !== undefined) {
      if (typeof install["intent"] === "string" && markdownPath(install["intent"])) {
        projectIntent = install["intent"];
        projectIntentSource = "manifest";
      } else {
        warnings.push("project.yaml: optional install.intent must be a relative Markdown address; kept the conventional project SPEC");
      }
    }
    if (install["context"] !== undefined) {
      if (Array.isArray(install["context"]) && install["context"].every((value) => typeof value === "string" && markdownPath(value))) {
        projectContext = install["context"] as string[];
      } else {
        warnings.push("project.yaml: optional install.context must be a list of relative Markdown addresses; ignored it");
      }
    }
  }
  try {
    projectSkills = readProjectSkillSelection(projectRoot);
  } catch (err) {
    return failure("project_skills_invalid", (err as Error).message);
  }

  const pieces: WorkInstallPiece[] = [];
  for (const [address, source] of [
    [projectIntent, projectIntentSource],
    ...projectContext.map((address): [string, WorkInstallSource] => [address, "manifest"]),
  ] as Array<[string, WorkInstallSource]>) {
    const planned = piece("project", `project:${address}`, projectRoot, source);
    if ("error" in planned) return planned;
    pieces.push(planned);
  }

  let missionRoot: string | null = null;
  let sliceRoot: string | null = null;
  let sliceName: string | null = null;
  let frontier: WorkInstallAltitude = "project";
  if (opts.mission !== undefined) {
    missionRoot = join(missionsRoot, opts.mission);
    if (existsSync(missionRoot)) {
      const canonicalMissionRoot = canonicalExisting(missionRoot);
      if (!canonicalMissionRoot || !inside(projectRoot, canonicalMissionRoot)) {
        return failure("mission_root_escape", `mission '${opts.mission}' resolves outside the selected project root`);
      }
      missionRoot = canonicalMissionRoot;
      frontier = "mission";
      let missionSpec = "SPEC.md";
      let missionSource: WorkInstallSource = "default";
      const missionManifestPath = join(missionRoot, "mission.yaml");
      if (existsSync(missionManifestPath)) {
        const parsed = readYaml(missionManifestPath);
        const composition = parsed.value?.["composition"];
        const markdown = isRecord(composition) ? composition["mission_markdown"] : null;
        if (isRecord(markdown) && typeof markdown["spec"] === "string" && markdownPath(markdown["spec"])) {
          missionSpec = markdown["spec"];
          missionSource = "manifest";
        } else if (!parsed.value) {
          warnings.push(`${parsed.error}; kept the conventional mission SPEC`);
        }
      }
      const plannedMission = piece("mission", `mission:${missionSpec}`, missionRoot, missionSource);
      if ("error" in plannedMission) return plannedMission;
      pieces.push(plannedMission);
      const plannedMissionProgress = piece("mission", "mission:PROGRESS.md", missionRoot, "default");
      if ("error" in plannedMissionProgress) return plannedMissionProgress;
      pieces.push(plannedMissionProgress);

      if (opts.slice !== undefined) {
        const selectedSlice = resolveExplicitSlice(missionRoot, opts.slice);
        if ("error" in selectedSlice) return selectedSlice;
        sliceRoot = selectedSlice.root;
        sliceName = selectedSlice.name;
        frontier = "slice";
        let sliceSpec = "SPEC.md";
        let sliceSource: WorkInstallSource = "explicit";
        const sliceManifestPath = join(sliceRoot, "slice.yaml");
        if (existsSync(sliceManifestPath)) {
          const parsed = readYaml(sliceManifestPath);
          const composition = parsed.value?.["composition"];
          const markdown = isRecord(composition) ? composition["slice_markdown"] : null;
          if (isRecord(markdown) && typeof markdown["spec"] === "string" && markdownPath(markdown["spec"])) {
            sliceSpec = markdown["spec"];
            sliceSource = "manifest";
          } else if (!parsed.value) {
            warnings.push(`${parsed.error}; kept the conventional slice SPEC`);
          }
        }
        const plannedSlice = piece(
          "slice",
          `mission:slices/${sliceName}/${sliceSpec}`,
          missionRoot,
          sliceSource,
        );
        if ("error" in plannedSlice) return plannedSlice;
        pieces.push(plannedSlice);
        const plannedSliceProgress = piece("slice", `mission:slices/${sliceName}/PROGRESS.md`, missionRoot, "default");
        if ("error" in plannedSliceProgress) return plannedSliceProgress;
        pieces.push(plannedSliceProgress);
      }
    }
  }

  return {
    position: {
      workspaceRoot,
      projectId,
      projectRoot,
      missionRoot,
      sliceRoot,
      mission: opts.mission ?? null,
      slice: sliceName ?? opts.slice ?? null,
      frontier,
    },
    pieces,
    skills: projectSkills,
    derive: [],
    warnings,
  };
}
