import { join } from "node:path";
import {
  ensureDefaultWorkspace,
  nodeInitializationFs,
  type InitializationConflict,
  type InitializationFsOps,
} from "./workspace/default-workspace-scaffold.js";

export interface OpenRigInstanceInitializationOptions {
  home: string;
  workspaceRoot?: string;
  contextRoot?: string;
  skillsRoot?: string;
  topologyRoot?: string;
  dryRun?: boolean;
  fs?: InitializationFsOps;
}

export interface OpenRigInstanceInitializationResult {
  ok: boolean;
  home: string;
  createdPaths: string[];
  conflicts: InitializationConflict[];
  dryRun: boolean;
}

export function openRigContextLibraryRoots(contextRoot: string): [string, string] {
  return [contextRoot, join(contextRoot, "system")];
}

/** Reconcile one canonical OpenRig instance layout. This is the shared owner
 * for CLI setup and daemon first-start. It owns empty roots and config.json;
 * S01 owns workspace contents, S04 owns skill contents, and topology owns its
 * contents. */
export function ensureOpenRigInstance(
  options: OpenRigInstanceInitializationOptions,
): OpenRigInstanceInitializationResult {
  const fs = options.fs ?? nodeInitializationFs();
  const dryRun = options.dryRun ?? false;
  const workspaceRoot = options.workspaceRoot ?? join(options.home, "workspace");
  const contextRoot = options.contextRoot ?? join(options.home, "context");
  const skillsRoot = options.skillsRoot ?? join(options.home, "skills");
  const topologyRoot = options.topologyRoot ?? join(options.home, "topology");
  const [contextLibraryRoot, systemContextRoot] = openRigContextLibraryRoots(contextRoot);
  const directories = [...new Set([
    options.home,
    join(options.home, "state"),
    contextLibraryRoot,
    systemContextRoot,
    skillsRoot,
    join(options.home, "specs"),
    topologyRoot,
    join(options.home, "plugins"),
    join(options.home, "run"),
    join(options.home, "logs"),
    join(options.home, "transcripts"),
    join(options.home, "backups"),
    join(options.home, "secrets"),
  ])];
  const configPath = join(options.home, "config.json");
  const conflicts: InitializationConflict[] = [];

  for (const path of directories) {
    const actual = fs.pathKind(path);
    if (actual !== "missing" && actual !== "directory") {
      conflicts.push({ path, expected: "directory", actual });
    }
  }
  const configKind = fs.pathKind(configPath);
  if (configKind !== "missing" && configKind !== "file") {
    conflicts.push({ path: configPath, expected: "file", actual: configKind });
  }

  const workspacePlan = ensureDefaultWorkspace({ root: workspaceRoot, dryRun: true, fs });
  conflicts.push(...workspacePlan.conflicts);
  if (conflicts.length > 0) {
    return { ok: false, home: options.home, createdPaths: [], conflicts, dryRun };
  }

  const missingDirectories = directories.filter((path) => fs.pathKind(path) === "missing");
  const createdPaths = [
    ...missingDirectories,
    ...(configKind === "missing" ? [configPath] : []),
    ...(workspacePlan.rootCreated ? [workspaceRoot] : []),
    ...workspacePlan.subdirs.filter((entry) => entry.created).map((entry) => entry.path),
    ...workspacePlan.files.filter((entry) => entry.created).map((entry) => entry.absPath),
  ];

  if (!dryRun) {
    for (const path of missingDirectories) fs.mkdirp(path);
    if (configKind === "missing") fs.writeFile(configPath, "{}\n");
    ensureDefaultWorkspace({ root: workspaceRoot, fs });
  }

  return { ok: true, home: options.home, createdPaths, conflicts: [], dryRun };
}

export function formatInstanceInitializationConflicts(
  result: Pick<OpenRigInstanceInitializationResult, "conflicts">,
): string {
  return result.conflicts
    .map((conflict) => `${conflict.path}: expected ${conflict.expected}, found ${conflict.actual}`)
    .join("; ");
}
