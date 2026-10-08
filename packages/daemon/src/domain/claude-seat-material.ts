import nodePath from "node:path";

// #875 — where a Claude seat's projected material lives.
//
// `cwd` (default): skills, subagents, settings, MCP and managed blocks are written into the seat's
// working directory, as before. `seat`: they are written into a per-seat directory under the
// OpenRig home and handed to Claude Code at launch, so the working directory (often a repository
// that people without OpenRig also use) is left alone and an ordinary `claude` started there
// sees none of it.
//
// <openrig home>/state/claude-seats/<session>/
//   plugin/.claude-plugin/plugin.json   generated plugin "openrig"        --plugin-dir plugin
//   plugin/skills/<id>/                 the seat's skill loadout          (exposed as openrig:<id>)
//   plugin/agents/                      subagents
//   settings.json                       settings fragments, activity hooks, status line
//   launch-settings.json                settings.json + this launch's operational settings   --settings
//   mcp.json                            MCP fragments                     --mcp-config
//   guidance.md                         managed blocks                    --append-system-prompt-file
//   context-collector.cjs               status-line collector
//   skill-loadout.json                  loadout ownership manifest

export const CLAUDE_SEAT_MATERIAL_MODES = ["cwd", "seat"] as const;
export type ClaudeSeatMaterialMode = typeof CLAUDE_SEAT_MATERIAL_MODES[number];
export const DEFAULT_CLAUDE_SEAT_MATERIAL_MODE: ClaudeSeatMaterialMode = "cwd";

/** The generated plugin's name. Claude Code shows its skills as `openrig:<id>`. */
export const CLAUDE_SEAT_PLUGIN_NAME = "openrig";

export interface ClaudeSeatMaterialPaths {
  root: string;
  pluginDir: string;
  pluginManifestPath: string;
  skillsRoot: string;
  agentsDir: string;
  extensionsDir: string;
  settingsPath: string;
  launchSettingsPath: string;
  mcpPath: string;
  guidancePath: string;
  collectorPath: string;
  loadoutManifestPath: string;
}

export function isClaudeSeatMaterialMode(value: unknown): value is ClaudeSeatMaterialMode {
  return typeof value === "string" && (CLAUDE_SEAT_MATERIAL_MODES as readonly string[]).includes(value);
}

export function claudeSeatMaterialRoot(openrigHome: string, sessionName: string): string {
  return nodePath.join(nodePath.resolve(openrigHome), "state", "claude-seats", sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_"));
}

export function claudeSeatMaterialPaths(openrigHome: string, sessionName: string): ClaudeSeatMaterialPaths {
  const root = claudeSeatMaterialRoot(openrigHome, sessionName);
  const pluginDir = nodePath.join(root, "plugin");
  return {
    root,
    pluginDir,
    pluginManifestPath: nodePath.join(pluginDir, ".claude-plugin", "plugin.json"),
    skillsRoot: nodePath.join(pluginDir, "skills"),
    agentsDir: nodePath.join(pluginDir, "agents"),
    extensionsDir: nodePath.join(root, "extensions"),
    settingsPath: nodePath.join(root, "settings.json"),
    launchSettingsPath: nodePath.join(root, "launch-settings.json"),
    mcpPath: nodePath.join(root, "mcp.json"),
    guidancePath: nodePath.join(root, "guidance.md"),
    collectorPath: nodePath.join(root, "context-collector.cjs"),
    loadoutManifestPath: nodePath.join(root, "skill-loadout.json"),
  };
}

/** Skill folders of every seat directory under this OpenRig home. */
export function listClaudeSeatSkillRoots(openrigHome: string, listDir: (path: string) => string[]): string[] {
  const seatsRoot = nodePath.join(nodePath.resolve(openrigHome), "state", "claude-seats");
  let seats: string[];
  try { seats = listDir(seatsRoot); } catch { return []; }
  return seats.sort().map((seat) => nodePath.join(seatsRoot, seat, "plugin", "skills"));
}

/** The name Claude Code gives a skill delivered through the seat plugin. */
export function claudeSeatSkillName(skillId: string): string {
  return `${CLAUDE_SEAT_PLUGIN_NAME}:${skillId}`;
}

export interface SeatMaterialFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

export function ensureClaudeSeatPlugin(fs: SeatMaterialFs, paths: ClaudeSeatMaterialPaths): void {
  const manifest = `${JSON.stringify({
    name: CLAUDE_SEAT_PLUGIN_NAME,
    version: "0.0.0",
    description: "Seat material projected by OpenRig for this seat only.",
  }, null, 2)}\n`;
  if (fs.exists(paths.pluginManifestPath) && fs.readFile(paths.pluginManifestPath) === manifest) return;
  fs.mkdirp(nodePath.dirname(paths.pluginManifestPath));
  fs.writeFile(paths.pluginManifestPath, manifest);
}

/**
 * Claude Code keeps only the last `--settings` it is given (checked on 2.1.280: of two files with
 * a SessionStart hook each, only the second one's hook ran). The seat's settings and this launch's
 * operational settings (kernel-authority.ts) are therefore merged into one file. Objects merge by
 * key; arrays (hook groups, permission rules) are concatenated, operational entries last.
 */
export function mergeClaudeSettings(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      merged[key] = [...current, ...value.filter((item) => typeof item === "object" || !current.includes(item))];
    } else if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = mergeClaudeSettings(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * The launch arguments that hand a seat its material, replacing the operational
 * `--settings` (if any) with one merged settings file.
 *
 * Paths are passed as separate argv entries. Native identity proof reads the process
 * argv back from `ps`, which flattens it with spaces, so a path containing whitespace
 * would be split; such a home is refused here rather than launched unverifiable.
 */
export function claudeSeatLaunchArgs(fs: SeatMaterialFs, paths: ClaudeSeatMaterialPaths, operationalArgs: string[]): string[] {
  if (/\s/.test(paths.root)) {
    throw new Error(`seat_material: seat directory ${JSON.stringify(paths.root)} contains whitespace; Claude seat identity cannot be verified from such a launch. Use an OpenRig home without whitespace or seat_material: cwd.`);
  }
  let settings = readObject(fs, paths.settingsPath);
  const passthrough: string[] = [];
  for (let index = 0; index < operationalArgs.length; index += 1) {
    const arg = operationalArgs[index]!;
    if (arg === "--settings") {
      const value = operationalArgs[++index];
      if (value === undefined) throw new Error("operational --settings without a value");
      settings = mergeClaudeSettings(settings, JSON.parse(value) as Record<string, unknown>);
      continue;
    }
    passthrough.push(arg);
  }
  ensureClaudeSeatPlugin(fs, paths);
  fs.mkdirp(paths.root);
  fs.writeFile(paths.launchSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return [
    ...passthrough,
    "--settings", paths.launchSettingsPath,
    "--plugin-dir", paths.pluginDir,
    ...(fs.exists(paths.mcpPath) ? ["--mcp-config", paths.mcpPath] : []),
    ...(fs.exists(paths.guidancePath) ? ["--append-system-prompt-file", paths.guidancePath] : []),
  ];
}

function readObject(fs: SeatMaterialFs, path: string): Record<string, unknown> {
  if (!fs.exists(path)) return {};
  const parsed: unknown = JSON.parse(fs.readFile(path));
  if (!isPlainObject(parsed)) throw new Error(`${path} must be a JSON object`);
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
