// Community agent apps: another agent app runs in a seat from a small data preset the person installs, one YAML file
// per app under $OPENRIG_HOME/agent-apps/<name>.yaml. A preset names the app, the command that starts it in the seat's
// pane, its maintainer and the limits it declares. OpenRig hasn't tested these apps: it shows them as community apps,
// never confirms their identity, and reads their activity only from what the screen shows. Built-in runtime names are
// reserved, so a preset can't replace one.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { BUILT_IN_RUNTIMES, isAgentAppRuntime } from "./built-in-runtimes.js";

export { BUILT_IN_RUNTIMES, isAgentAppRuntime };

export const AGENT_APP_PRESET_FORMAT = 1;
const FIELDS = ["format", "name", "command", "maintainer", "limits"] as const;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface AgentAppPreset {
  name: string;
  command: string;
  maintainer: string;
  limits: string[];
  path: string;
}

export type AgentAppPresetLookup =
  | { ok: true; preset: AgentAppPreset }
  | { ok: false; kind: "missing" | "incompatible"; path: string; message: string };

export function agentAppsDir(): string {
  return getDefaultOpenRigPath("agent-apps");
}

function parsePreset(name: string, path: string, text: string): AgentAppPresetLookup {
  const bad = (reason: string): AgentAppPresetLookup => ({ ok: false, kind: "incompatible", path,
    message: `agent app "${name}": the preset at ${path} can't be used: ${reason}` });
  let doc: unknown;
  try { doc = parseYaml(text); } catch { return bad("it isn't valid YAML"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return bad("it isn't a YAML mapping");
  const raw = doc as Record<string, unknown>;
  if (raw.format !== AGENT_APP_PRESET_FORMAT) {
    return bad(`it declares format ${JSON.stringify(raw.format ?? null)}; this OpenRig reads format ${AGENT_APP_PRESET_FORMAT}`);
  }
  const unknown = Object.keys(raw).filter(key => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length) return bad(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (format ${AGENT_APP_PRESET_FORMAT} has ${FIELDS.join(", ")})`);
  if (raw.name !== name) return bad(`its name is ${JSON.stringify(raw.name ?? null)}, not "${name}" (the file name)`);
  for (const key of ["command", "maintainer"] as const) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) return bad(`${key} must be a non-empty string`);
  }
  const limits = raw.limits ?? [];
  if (!Array.isArray(limits) || limits.some(limit => typeof limit !== "string" || !limit.trim())) {
    return bad("limits must be a list of non-empty strings");
  }
  return { ok: true, preset: { name, command: raw.command as string, maintainer: raw.maintainer as string, limits: limits as string[], path } };
}

/** The installed preset for a community agent app, or why there isn't a usable one. */
export function loadAgentAppPreset(name: string, dir: string = agentAppsDir()): AgentAppPresetLookup {
  const path = join(dir, `${name}.yaml`);
  if (BUILT_IN_RUNTIMES.has(name)) {
    return { ok: false, kind: "incompatible", path, message: `"${name}" is a built-in runtime; an agent app preset can't use that name` };
  }
  if (!NAME.test(name) || !existsSync(path)) {
    return { ok: false, kind: "missing", path,
      message: `no agent app preset named "${name}" is installed (looked for ${path})` };
  }
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch {
    return { ok: false, kind: "incompatible", path, message: `agent app "${name}": the preset at ${path} couldn't be read` };
  }
  return parsePreset(name, path, text);
}

/** Every preset file in the directory, usable or not, sorted by name. */
export function listAgentAppPresets(dir: string = agentAppsDir()): AgentAppPresetLookup[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir).filter(file => file.endsWith(".yaml")).sort(); } catch { return []; }
  return files.map(file => loadAgentAppPreset(file.slice(0, -".yaml".length), dir));
}

/** What a seat on a community agent app shows about it. */
export interface AgentAppLabel {
  app: string;
  community: true;
  testedByOpenRig: false;
  maintainer: string | null;
  limits: string[];
  identity: "not confirmed";
  needsInput: "not detected: no prompt pattern";
  /** Set when the preset is missing or can't be used. */
  presetError?: string;
}

export function agentAppLabel(runtime: string, dir: string = agentAppsDir()): AgentAppLabel {
  const found = loadAgentAppPreset(runtime, dir);
  return {
    app: runtime, community: true, testedByOpenRig: false,
    maintainer: found.ok ? found.preset.maintainer : null,
    limits: found.ok ? found.preset.limits : [],
    identity: "not confirmed", needsInput: "not detected: no prompt pattern",
    ...(found.ok ? {} : { presetError: found.message }),
  };
}
