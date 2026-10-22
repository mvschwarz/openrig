import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import type { SeatEnv } from "./seat-env.js";

// What a Claude seat needs so it loads the vendored openrig-core plugin (its refocus, compaction-restore and
// activity hooks). Claude reads CLAUDE_CODE_PLUGIN_DIRS, a colon-separated list, so this has to be the vendored copy
// under the OpenRig home: the copy projected into a seat's folder is named `shared:openrig-core`, and the colon splits
// it in two. It is an env var, not a launch argument, so the seat's process identity is unchanged. Claude Code reads it
// from v2.1.280; an older Claude ignores it and the hooks stay unloaded there.
//
// Only a seat whose resolved plugin selection includes the shipped plugin gets it. That is the plugin's resolved
// location, which is what the profile resolver gives for every way of selecting it (`openrig-core`, `shared:openrig-core`,
// a resource of another name that points at the vendored copy); a seat that selected nothing is launched as before.
//
// The value is added to the seat's declared environment (its spec's `env:` and a one-off `rig up --env`), so every path
// that already carries that environment carries this: fresh launch, restore, handover successor and the managed `env -i`
// launch, which forwards the declared names from the pane. A list the seat declares itself keeps working and the
// vendored plugin is added after it.
//
// The plugin also carries an activity relay, and a seat's settings.local.json may carry OpenRig's own copy of it. The
// plugin's relay run decides for itself, from that file, whether to stay quiet (see hooks/scripts/activity-relay.cjs).

export const CLAUDE_PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";
/** The seat's launch project, set for a seat that loads the plugin, so a Claude started elsewhere inside the seat can be told from the seat. */
export const SEAT_PROJECT_DIR_ENV = "OPENRIG_SEAT_PROJECT_DIR";

/** The vendored openrig-core plugin directory under `pluginsDir`, or undefined when it is not vendored. */
export function vendoredCorePluginDir(pluginsDir: string = getDefaultOpenRigPath("plugins")): string | undefined {
  const dir = join(pluginsDir, "openrig-core");
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) ? dir : undefined;
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** The resolved plugin locations in a node's persisted startup context (what the profile resolver selected for it). */
export function pluginPathsOf(entries: ReadonlyArray<{ category: string; absolutePath: string }>): string[] {
  return entries.filter((entry) => entry.category === "plugin").map((entry) => entry.absolutePath);
}

/** The plugin locations the node's last launch resolved, or undefined when none were saved (or they can't be read). */
export function persistedPluginPaths(db: Database.Database, nodeId: string): string[] | undefined {
  try {
    const row = db.prepare("SELECT projection_entries_json FROM node_startup_context WHERE node_id = ?")
      .get(nodeId) as { projection_entries_json: string } | undefined;
    if (!row) return undefined;
    const entries = JSON.parse(row.projection_entries_json) as unknown;
    return Array.isArray(entries) ? pluginPathsOf(entries.filter((e): e is { category: string; absolutePath: string } =>
      typeof e === "object" && e !== null && typeof (e as { category?: unknown }).category === "string"
      && typeof (e as { absolutePath?: unknown }).absolutePath === "string")) : undefined;
  } catch {
    return undefined;
  }
}

/** Saved selection, even when the vendored manifest is missing; inspection must not call that intentional hooklessness. */
export function selectedCorePluginDir(paths: readonly string[], pluginsDir: string = getDefaultOpenRigPath("plugins")): string | undefined {
  const dir = join(pluginsDir, "openrig-core");
  return paths.some((path) => canonical(path) === canonical(dir)) ? dir : undefined;
}

/**
 * The directory to load into this node's Claude process, or undefined: not a Claude seat, the plugin is not vendored,
 * or the seat's resolved plugin selection doesn't include it. `selectedPaths` is the selection a launch has just
 * resolved or a snapshot saved; without it the node's persisted startup context is read.
 */
export function seatCorePluginDir(
  node: { id: string; runtime: string | null },
  db: Database.Database,
  selectedPaths?: readonly string[],
  pluginsDir?: string,
): string | undefined {
  if (node.runtime !== "claude-code") return undefined;
  const dir = vendoredCorePluginDir(pluginsDir);
  if (!dir) return undefined;
  const paths = selectedPaths ?? persistedPluginPaths(db, node.id) ?? [];
  return selectedCorePluginDir(paths, pluginsDir);
}

/** The explicit interpreter a selected seat's plugin hooks run with, so they never depend on `node` resolving on PATH. */
export const SEAT_NODE_ENV = "OPENRIG_NODE";

/**
 * Codex: the vendored plugin directory when this node is a Codex seat whose resolved plugin selection includes it, else
 * undefined. Codex loads the plugin from its own installation, not from this directory, so this only decides the seat's
 * signal: OPENRIG_SEAT_PROJECT_DIR and OPENRIG_NODE, which the plugin's Codex hook commands check before running anything.
 */
export function seatCodexCorePluginDir(
  node: { id: string; runtime: string | null },
  db: Database.Database,
  selectedPaths?: readonly string[],
  pluginsDir?: string,
): string | undefined {
  if (node.runtime !== "codex") return undefined;
  const dir = vendoredCorePluginDir(pluginsDir);
  if (!dir) return undefined;
  return selectedCorePluginDir(selectedPaths ?? persistedPluginPaths(db, node.id) ?? [], pluginsDir);
}

/** The seat's declared env with the vendored plugin added after any list the seat declared itself. */
export function withCorePlugin(seatEnv: SeatEnv, dir: string | undefined): SeatEnv {
  return withPluginDirs(seatEnv, [dir]);
}

/** The seat's declared env with OpenRig's plugin directories (the vendored openrig-core, the seat's own skill plugin)
 *  added, in order, after any list the seat declared itself. */
export function withPluginDirs(seatEnv: SeatEnv, dirs: ReadonlyArray<string | undefined>): SeatEnv {
  let env = seatEnv;
  for (const dir of dirs) {
    if (!dir) continue;
    const own = env[CLAUDE_PLUGIN_DIRS_ENV];
    if (!own) {
      env = { ...env, [CLAUDE_PLUGIN_DIRS_ENV]: dir };
      continue;
    }
    // Claude skips a relative entry in the list, so only an absolute one can already be this plugin. The seat's
    // entries stay as written and the plugin's absolute path goes after them.
    const want = canonical(dir);
    if (own.split(":").some((entry) => isAbsolute(entry) && canonical(entry) === want)) continue;
    env = { ...env, [CLAUDE_PLUGIN_DIRS_ENV]: `${own}:${dir}` };
  }
  return env;
}
