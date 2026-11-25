import nodePath from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

import { SettingsStore } from "./user-settings/settings-store.js";
import { ProjectReadError, selectCatalogProject } from "./workspace/project-catalog.js";

const ENV_REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Expands a leading `~` and `$VAR` / `${VAR}` references. A reference to an unset variable is
 *  left as written so preflight reports the path instead of launching in a silently shortened one. */
export function expandCwd(
  authored: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const tilded = authored === "~" || authored.startsWith("~/") ? home + authored.slice(1) : authored;
  return tilded.replace(ENV_REF, (ref, braced?: string, bare?: string) => env[braced ?? bare!] ?? ref);
}

/** Install preflight may preview a carried project's destination before routing creates it.
 * Actual launch never receives these roots: it reads the registered catalog. */
export type PlannedProjectRoots = Readonly<Record<string, string>>;

export function projectCwdReference(authored: string): { id: string; suffix: string } | undefined {
  if (!authored.includes("${project:")) return undefined;
  const match = /^\$\{project:([^{}\/\\:\s]+)\}(\/.*)?$/.exec(authored);
  if (!match || match[2]?.includes("${project:")) throw new Error('Project cwd must be "${project:project-id}" or "${project:project-id}/relative/path"; correct the cwd or supply --cwd.');
  return { id: match[1]!, suffix: match[2] ?? "" };
}

export function resolveProjectCwd(authored: string, plannedRoots?: PlannedProjectRoots): string | undefined {
  const ref = projectCwdReference(authored);
  if (!ref) return undefined;
  const catalog = new SettingsStore().resolveOne("workspace.catalog_path").value as string;
  const planned = plannedRoots && Object.hasOwn(plannedRoots, ref.id) ? plannedRoots[ref.id] : undefined;
  let root: string | undefined;
  try { root = selectCatalogProject(catalog, ref.id)?.root; }
  catch (err) {
    if (!(err instanceof ProjectReadError) || !["project_not_found", "project_root_missing"].includes(err.code) || !planned) {
      throw new Error(`Cannot resolve project cwd '${ref.id}': ${(err as Error).message}. Register that project or supply --cwd.`);
    }
  }
  root ??= planned;
  if (!root) throw new Error(`Cannot resolve project cwd '${ref.id}': no registered project in ${catalog}. Install its carried project, register it, or supply --cwd.`);
  // The catalog root is already resolved; a literal '$' in its name is not an environment reference.
  return nodePath.resolve(root, "." + ref.suffix);
}

/** Picks the directory an authored cwd means. The literal path wins when it exists, so a directory
 *  named with `~` or `$NAME` keeps its destination; otherwise the expanded path is used. A relative
 *  path resolves under `specRoot`; with no `specRoot` it stays relative, as the caller selected before. */
export function resolveAuthoredCwd(
  authored: string,
  specRoot: string | null,
  exists: (path: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const project = resolveProjectCwd(authored);
  if (project) return project;
  const place = (p: string) => (specRoot === null || nodePath.isAbsolute(p) ? p : nodePath.resolve(specRoot, p));
  const literal = place(authored);
  return exists(literal) ? literal : place(expandCwd(authored, env, home));
}

/** A run-only `--cwd` as every launch reads it: a non-blank value, resolved on the daemon; a blank one is no override. */
export function normalizeCwdOverride(cwdOverride: string | null | undefined): string | undefined {
  return cwdOverride && cwdOverride.trim().length > 0 ? nodePath.resolve(cwdOverride) : undefined;
}

export function resolveLaunchCwd(
  authoredCwd: string | null | undefined,
  specRoot: string,
  cwdOverride?: string | null,
  plannedProjectRoots?: PlannedProjectRoots,
): string {
  const override = normalizeCwdOverride(cwdOverride);
  if (override) {
    return override;
  }
  if (!authoredCwd || authoredCwd.trim().length === 0) {
    return nodePath.resolve(specRoot);
  }
  return resolveProjectCwd(authoredCwd, plannedProjectRoots) ?? resolveAuthoredCwd(authoredCwd, specRoot);
}

export function getOpenRigInstallRoot(): string {
  return nodePath.resolve(import.meta.dirname, "../..");
}

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(rootPath), nodePath.resolve(candidatePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}

/** `path` is the seat folder `folder` or lies inside it, and that folder isn't on this machine (a home that moved).
 *  OpenRig's writers into a seat's folder don't create such a folder to write inside it: the seat's terminal started in
 *  tmux's fallback folder instead, so nothing reads a file there, and a recreated folder would make the next restore start
 *  the seat in that stub. One write is left as it is: the Claude state file of an account home the person placed inside
 *  the seat's folder, which the launch itself reads. */
export function insideMissingFolder(path: string, folder: string | null | undefined, exists: (path: string) => boolean): boolean {
  return !!folder && !exists(folder) && isPathInsideRoot(path, folder);
}

/** Whether a folder is there, for insideMissingFolder. Only a confirmed absence reads as missing: nothing at the path, a
 *  file on the way to it (ENOENT, ENOTDIR), or something there that isn't a folder. Any other failure to look, such as a
 *  permission or I/O error, reads as present, so the write is still attempted and reports its own outcome. */
export function folderPresent(path: string, stat: (path: string) => { isDirectory(): boolean } = statSync): boolean {
  try {
    return stat(path).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

export function isFilesystemRoot(cwd: string): boolean {
  const resolved = nodePath.resolve(cwd);
  return resolved === nodePath.parse(resolved).root;
}

export function getOpenRigInstallCwdError(
  resolvedCwd: string,
  cwdOverride?: string | null,
  installRoot: string = getOpenRigInstallRoot(),
): string | null {
  // The filesystem root is not refused (#226): an explicit --cwd / or `cwd: /` is the person's
  // choice, and `rig up` warns when it defaulted to '/' itself.
  if (cwdOverride && cwdOverride.trim().length > 0) {
    return null;
  }
  if (!isPathInsideRoot(resolvedCwd, installRoot)) {
    return null;
  }
  return `Resolved cwd '${resolvedCwd}' is inside the OpenRig installation '${installRoot}', which is not a valid project workspace. Pass --cwd <path> to launch into your project directory.`;
}
