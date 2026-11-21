import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import type { SeatEnv } from "./seat-env.js";
import { homePluginPath } from "./builtin-startup-files.js";
import { SettingsStore } from "./user-settings/settings-store.js";

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

/**
 * #3245: whether Claude seats load OpenRig's plugin folders through CLAUDE_CODE_PLUGIN_DIRS (`launch.claude_sideload`,
 * default on). A person turns it off for a Claude login whose managed settings set `disableSideloadFlags`, which makes
 * Claude Code refuse that variable at startup. Off, no launch path adds the variable: fresh launch, restore and relaunch
 * (node launcher), handover successor, provider switch, and the managed `env -i` launch that forwards it by name. Read at
 * each call, so a change applies to the next launch; a setting that can't be read leaves the usual launch.
 */
export function claudeSideloadEnabled(read: () => unknown = () => new SettingsStore().resolveOne("launch.claude_sideload").value): boolean {
  try { return read() !== false; } catch { return true; }
}

/** The vendored openrig-core plugin directory under `pluginsDir`, or undefined when it is not vendored. */
export function vendoredCorePluginDir(pluginsDir: string = getDefaultOpenRigPath("plugins")): string | undefined {
  const dir = join(pluginsDir, "openrig-core");
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) ? dir : undefined;
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** The resolved plugin locations in a node's persisted startup context (what the profile resolver selected for it). A
 *  plugin selected under the OpenRig home (`openrig-home:`) is read in `openrigHome`, the running home by default, so a
 *  home that moved still names its own plugins. */
export function pluginPathsOf(
  entries: ReadonlyArray<{ category: string; absolutePath: string; resourcePath?: string | null; sourcePath?: string | null }>,
  openrigHome?: string,
): string[] {
  return entries.filter((entry) => entry.category === "plugin").map((entry) => homePluginPath(entry, openrigHome));
}

/** The plugin locations the node's last launch resolved, or undefined when none were saved (or they can't be read). */
export function persistedPluginPaths(db: Database.Database, nodeId: string, openrigHome?: string): string[] | undefined {
  try {
    const row = db.prepare("SELECT projection_entries_json FROM node_startup_context WHERE node_id = ?")
      .get(nodeId) as { projection_entries_json: string } | undefined;
    if (!row) return undefined;
    const entries = JSON.parse(row.projection_entries_json) as unknown;
    return Array.isArray(entries) ? pluginPathsOf(entries.filter((e): e is { category: string; absolutePath: string } =>
      typeof e === "object" && e !== null && typeof (e as { category?: unknown }).category === "string"
      && typeof (e as { absolutePath?: unknown }).absolutePath === "string"), openrigHome) : undefined;
  } catch {
    return undefined;
  }
}

/** #3245: whether the node's saved startup context selects OpenRig's settings.local.json activity relay
 *  (`claude_activity_hooks`), or undefined when nothing was saved (or it can't be read). */
export function persistedActivityHooksSelected(db: Database.Database, nodeId: string): boolean | undefined {
  try {
    const row = db.prepare("SELECT projection_entries_json FROM node_startup_context WHERE node_id = ?")
      .get(nodeId) as { projection_entries_json: string } | undefined;
    if (!row) return undefined;
    const entries = JSON.parse(row.projection_entries_json) as unknown;
    return Array.isArray(entries) ? entries.some((e) => typeof e === "object" && e !== null
      && (e as { category?: unknown }).category === "runtime_resource" && (e as { resourceType?: unknown }).resourceType === "claude_activity_hooks") : undefined;
  } catch {
    return undefined;
  }
}

/** Saved selection, even when the vendored manifest is missing; inspection must not call that intentional hooklessness. */
export function selectedCorePluginDir(paths: readonly string[], pluginsDir: string = getDefaultOpenRigPath("plugins")): string | undefined {
  const dir = join(pluginsDir, "openrig-core");
  return paths.some((path) => canonical(path) === canonical(dir)) ? dir : undefined;
}

/** Claude Code's system-wide managed settings file on this platform (for every user of the machine), or undefined. */
export function claudeManagedSettingsPath(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "linux") return "/etc/claude-code/managed-settings.json";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  return undefined;
}

/**
 * #3245: that file, when it sets `disableSideloadFlags: true`, else undefined (absent, unreadable, not JSON, or the setting
 * isn't true). It's the only evidence of the policy OpenRig reads, to explain a refusal and suggest
 * `launch.claude_sideload`; it never changes a launch. Its absence proves nothing: managed settings can also come from
 * Claude's servers, which leave no file here.
 */
export function claudeSideloadPolicyFile(readFile: (path: string) => string, platform: NodeJS.Platform = process.platform): string | undefined {
  const path = claudeManagedSettingsPath(platform);
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFile(path)) as unknown;
    return typeof parsed === "object" && parsed !== null && (parsed as { disableSideloadFlags?: unknown }).disableSideloadFlags === true ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory to load into this node's Claude process, or undefined: not a Claude seat, the plugin is not vendored,
 * the seat's resolved plugin selection doesn't include it, or `launch.claude_sideload` is off. `selectedPaths` is the
 * selection a launch has just resolved or a snapshot saved; without it the node's persisted startup context is read.
 */
export function seatCorePluginDir(
  node: { id: string; runtime: string | null },
  db: Database.Database,
  selectedPaths?: readonly string[],
  pluginsDir?: string,
): string | undefined {
  return claudeSideloadEnabled() ? seatCorePluginSelection(node, db, selectedPaths, pluginsDir) : undefined;
}

/** The vendored plugin this Claude seat selected, whether or not its launch may load it: what it asked for. */
export function seatCorePluginSelection(
  node: { id: string; runtime: string | null },
  db: Database.Database,
  selectedPaths?: readonly string[],
  pluginsDir?: string,
): string | undefined {
  if (node.runtime !== "claude-code") return undefined;
  const dir = vendoredCorePluginDir(pluginsDir);
  if (!dir) return undefined;
  const paths = selectedPaths ?? persistedPluginPaths(db, node.id, pluginsDir ? dirname(pluginsDir) : undefined) ?? [];
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
  return selectedCorePluginDir(selectedPaths ?? persistedPluginPaths(db, node.id, pluginsDir ? dirname(pluginsDir) : undefined) ?? [], pluginsDir);
}

/**
 * #3245: the env a seat launches with, its declared env plus OpenRig's plugin directories (`withPluginDirs`). A Claude
 * seat with `launch.claude_sideload` off gets none of them, and a CLAUDE_CODE_PLUGIN_DIRS its own env declares is left
 * out too, since Claude Code would refuse it; `claudeSideloadOffNotes` names both.
 */
export function seatPluginEnv(seatEnv: SeatEnv, dirs: ReadonlyArray<string | undefined>, runtime: string | null): SeatEnv {
  if (runtime !== "claude-code" || claudeSideloadEnabled()) return withPluginDirs(seatEnv, dirs);
  if (!(CLAUDE_PLUGIN_DIRS_ENV in seatEnv)) return seatEnv;
  const { [CLAUDE_PLUGIN_DIRS_ENV]: _leftOut, ...rest } = seatEnv;
  return rest;
}

/**
 * #3245: what a Claude seat asked for that a launch with `launch.claude_sideload` off doesn't deliver, one line each:
 * none for another runtime or with the setting on. Launch additions it can't pass are named by
 * `seatLaunchAdditionsForLaunch` with the seat's other refused additions.
 */
export function claudeSideloadOffNotes(input: {
  runtime: string | null;
  /** The seat selected the vendored openrig-core (`seatCorePluginSelection`). */
  coreSelected: boolean;
  /** The seat's declared env, before `seatPluginEnv`. */
  seatEnv: SeatEnv;
  /** The seat's profile selects OpenRig's own activity relay copy in .claude/settings.local.json (`claude_activity_hooks`);
   *  undefined when the launch can't tell. */
  activityHooksSelected?: boolean;
}): string[] {
  if (input.runtime !== "claude-code" || claudeSideloadEnabled()) return [];
  const notes: string[] = [];
  if (input.coreSelected) {
    notes.push("claude_sideload_off: openrig-core isn't loaded (launch.claude_sideload is off), so its refocus and compaction-restore hooks don't run; its skills are in this seat's skill list instead");
    if (input.activityHooksSelected === false) {
      notes.push("claude_sideload_off: this seat's profile doesn't select claude_activity_hooks, and openrig-core's activity relay isn't loaded, so the seat reports no activity");
    }
  }
  if (CLAUDE_PLUGIN_DIRS_ENV in input.seatEnv) {
    notes.push(`claude_sideload_off: ${CLAUDE_PLUGIN_DIRS_ENV} from this seat's env is left out (launch.claude_sideload is off)`);
  }
  return notes;
}

/**
 * #3245: what a Claude seat with `launch.claude_sideload` off reads by path instead of loading through its plugin, for the
 * launch to allow reading (`withManagedRestoreReads`): its skill list, its own skills and, when it selected openrig-core,
 * the vendored plugin's skills. Nothing with the setting on, or for another runtime. Only this seat's storage is named.
 */
export function sideloadOffSkillReads(
  node: { id: string; runtime: string | null },
  db: Database.Database,
  seat: { root: string; skillsRoot: string; catalogPath: string } | undefined,
  pluginsDir?: string,
): { files: string[]; trees: string[] } {
  if (node.runtime !== "claude-code" || claudeSideloadEnabled() || !seat) return { files: [], trees: [] };
  const core = seatCorePluginSelection(node, db, undefined, pluginsDir);
  return { files: [seat.catalogPath], trees: [seat.skillsRoot, ...(core ? [join(core, "skills")] : [])] };
}

/**
 * #3245: the skills folders a Claude seat with `launch.claude_sideload` off lists beyond its own, in its catalog and its
 * router: the vendored openrig-core's, when the seat selected it. None with the setting on, or for another runtime.
 */
export function sideloadOffExtraSkillsRoots(
  node: { id: string; runtime: string | null },
  db: Database.Database,
  selectedPaths?: readonly string[],
  pluginsDir?: string,
): string[] {
  if (node.runtime !== "claude-code" || claudeSideloadEnabled()) return [];
  const core = seatCorePluginSelection(node, db, selectedPaths, pluginsDir);
  return core ? [join(core, "skills")] : [];
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
