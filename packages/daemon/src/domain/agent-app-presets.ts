// Community agent apps: another agent app runs in a seat from a small data preset the person installs, one YAML file
// per app under $OPENRIG_HOME/agent-apps/<name>.yaml. A preset names the app, the command that starts it in the seat's
// pane, its maintainer and the limits it declares. OpenRig hasn't tested these apps: it shows them as community apps,
// never confirms their identity, and reads their activity only from what the screen shows. Built-in runtime names are
// reserved, so a preset can't replace one.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { BUILT_IN_RUNTIMES, isAgentAppRuntime } from "./built-in-runtimes.js";

export { BUILT_IN_RUNTIMES, isAgentAppRuntime };

/** The newest preset format this OpenRig reads. Format 1 is launch-only; format 2 adds the optional `session` block. */
export const AGENT_APP_PRESET_FORMAT = 2;
const READABLE_FORMATS: readonly number[] = [1, 2];
const FIELDS_BY_FORMAT: Record<number, readonly string[]> = {
  1: ["format", "name", "command", "maintainer", "limits"],
  2: ["format", "name", "command", "maintainer", "limits", "session"],
};
const SESSION_FIELDS = ["id_pattern", "resume", "exists", "list"] as const;
/** The one placeholder a session argv may hold, as a whole element. */
export const SESSION_ID_PLACEHOLDER = "{session_id}";
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** How OpenRig continues an app's conversation. Each command is an argv run or typed without shell syntax. */
export interface AgentAppSessionSpec {
  /** Anchored regular expression every session id must match before it reaches a command line. */
  idPattern: string;
  /** Typed into the seat's pane to resume; holds `{session_id}` as a whole element. */
  resume: string[];
  /** Run in the seat's cwd: exit 0 when the session exists, 1 when it doesn't. Holds `{session_id}`. */
  exists?: string[];
  /** Run in the seat's cwd: prints a JSON array of {id, created, directory?}. No placeholder. */
  list?: string[];
}

export interface AgentAppPreset {
  name: string;
  command: string;
  maintainer: string;
  limits: string[];
  path: string;
  /** Present only on a format-2 preset that declares session continuity; absent means launch-only. */
  session?: AgentAppSessionSpec;
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
  if (typeof raw.format !== "number" || !READABLE_FORMATS.includes(raw.format)) {
    return bad(`it declares format ${JSON.stringify(raw.format ?? null)}; this OpenRig reads formats ${READABLE_FORMATS.join(" and ")}`);
  }
  const format = raw.format;
  const fields = FIELDS_BY_FORMAT[format]!;
  const unknown = Object.keys(raw).filter(key => !fields.includes(key));
  if (unknown.length) return bad(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (format ${format} has ${fields.join(", ")})`);
  if (raw.name !== name) return bad(`its name is ${JSON.stringify(raw.name ?? null)}, not "${name}" (the file name)`);
  for (const key of ["command", "maintainer"] as const) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) return bad(`${key} must be a non-empty string`);
  }
  const shell = shellSyntaxIn(raw.command as string);
  if (shell) {
    return bad(`command must be a single program and its arguments; shell syntax such as ${shell} isn't supported: put it in a script and name the script`);
  }
  const limits = raw.limits ?? [];
  if (!Array.isArray(limits) || limits.some(limit => typeof limit !== "string" || !limit.trim())) {
    return bad("limits must be a list of non-empty strings");
  }
  let session: AgentAppSessionSpec | undefined;
  if (raw.session !== undefined) {
    const parsed = parseSession(raw.session);
    if (typeof parsed === "string") return bad(`session: ${parsed}`);
    session = parsed;
  }
  return { ok: true, preset: { name, command: raw.command as string, maintainer: raw.maintainer as string, limits: limits as string[], path,
    ...(session ? { session } : {}) } };
}

/** An argv from YAML, or why it can't be one. `placeholder` says whether `{session_id}` must, or must not, appear. */
function parseArgv(value: unknown, key: string, placeholder: "required" | "forbidden"): string[] | string {
  if (!Array.isArray(value) || value.length === 0) return `${key} must be a non-empty list of strings (an argv, not a shell line)`;
  for (const arg of value) {
    if (typeof arg !== "string" || arg.length === 0) return `${key} must be a non-empty list of non-empty strings`;
    if (/[\n\r\0]/.test(arg)) return `${key} can't hold a newline or NUL`;
    if (arg !== SESSION_ID_PLACEHOLDER && arg.includes("{session_id}")) return `${key}: {session_id} must be a whole element, not part of "${arg}"`;
  }
  const args = value as string[];
  if (args[0] === SESSION_ID_PLACEHOLDER) return `${key}: the first element is the program and can't be {session_id}`;
  const has = args.includes(SESSION_ID_PLACEHOLDER);
  if (placeholder === "required" && !has) return `${key} must hold {session_id} as one element`;
  if (placeholder === "forbidden" && has) return `${key} can't hold {session_id}`;
  return args;
}

function parseSession(value: unknown): AgentAppSessionSpec | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "must be a mapping";
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(key => !(SESSION_FIELDS as readonly string[]).includes(key));
  if (unknown.length) return `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (session has ${SESSION_FIELDS.join(", ")})`;
  if (typeof raw.id_pattern !== "string" || !raw.id_pattern.startsWith("^") || !raw.id_pattern.endsWith("$")) {
    return "id_pattern must be a regular expression anchored with ^ and $";
  }
  try { new RegExp(raw.id_pattern); } catch { return "id_pattern isn't a valid regular expression"; }
  const resume = parseArgv(raw.resume, "resume", "required");
  if (typeof resume === "string") return resume;
  const spec: AgentAppSessionSpec = { idPattern: raw.id_pattern, resume };
  if (raw.exists !== undefined) {
    const exists = parseArgv(raw.exists, "exists", "required");
    if (typeof exists === "string") return exists;
    spec.exists = exists;
  }
  if (raw.list !== undefined) {
    const list = parseArgv(raw.list, "list", "forbidden");
    if (typeof list === "string") return list;
    spec.list = list;
  }
  return spec;
}

/** The first shell construct in a preset command, or null when it's one program with its arguments. The command is
 *  typed into the seat pane's shell as `/usr/bin/env K=V … <command>` (or staged into a script run by sh), so an
 *  operator, redirection, substitution, history expansion or newline would act on that line outside the program, and an
 *  alias isn't a program. Keeping to one program and its arguments keeps shell syntax out of the line; it doesn't
 *  isolate the program from a shell (`sh -c '…'` is still a program and its arguments). Single and double quotes may
 *  group an argument; a backslash or `!` is accepted only inside single quotes, where the shell reads it literally. */
function shellSyntaxIn(command: string): string | null {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    // The shell reads \" or \' as a literal quote, not a grouping one; a scan without escapes would misread what follows.
    if (c === "\\") return "a backslash escape";
    if (c === "!") return "! (history expansion)";
    if (c === "\n" || c === "\r") return "a newline";
    if (c === "`") return "`…` (command substitution)";
    if (c === "$" && next === "(") return "$(…) (command substitution)";
    if (quote === '"') { if (c === '"') quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "&" && next === "&") return "&&";
    if (c === "|" && next === "|") return "||";
    if (c === "|") return "|";
    if (c === "&") return "&";
    if (c === ";") return ";";
    if (c === "<" || c === ">") return "a redirection (< or >)";
    if (c === "(" || c === ")") return "a subshell ( … )";
  }
  return quote ? "an unclosed quote" : null;
}

/** The installed preset for a community agent app, or why there isn't a usable one. */
export function loadAgentAppPreset(name: string, dir: string = agentAppsDir()): AgentAppPresetLookup {
  const path = join(dir, `${name}.yaml`);
  if (BUILT_IN_RUNTIMES.has(name)) {
    return { ok: false, kind: "incompatible", path, message: `"${name}" is a built-in runtime; an agent app preset can't use that name` };
  }
  // The name check comes first: it keeps a runtime name from reaching outside the directory.
  if (!NAME.test(name)) {
    if (name === basename(name) && !name.startsWith(".") && existsSync(path)) {
      return { ok: false, kind: "incompatible", path,
        message: `agent app "${name}": the preset at ${path} can't be used: its name must be lowercase letters, digits and hyphens, starting with a letter or digit` };
    }
    return { ok: false, kind: "missing", path, message: `no agent app preset named "${name}" is installed (looked for ${path})` };
  }
  if (!existsSync(path)) {
    return { ok: false, kind: "missing", path, message: `no agent app preset named "${name}" is installed (looked for ${path})` };
  }
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch {
    return { ok: false, kind: "incompatible", path, message: `agent app "${name}": the preset at ${path} couldn't be read` };
  }
  return parsePreset(name, path, text);
}

/** Whether the installed preset for this app declares session continuity (format 2 with a `session` block). A
 *  missing or unusable preset, or one without the block, is launch-only. */
export function agentAppResumes(name: string, dir: string = agentAppsDir()): boolean {
  const found = loadAgentAppPreset(name, dir);
  return found.ok && found.preset.session !== undefined;
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
  needsInput: "from the screen only: no app prompt pattern";
  /** "declared" when the preset has a `session` block (format 2), so a restore can continue the conversation. */
  resume: "declared" | "not declared";
  /** Set when the preset is missing or can't be used. */
  presetError?: string;
}

export function agentAppLabel(runtime: string, dir: string = agentAppsDir()): AgentAppLabel {
  const found = loadAgentAppPreset(runtime, dir);
  return {
    app: runtime, community: true, testedByOpenRig: false,
    maintainer: found.ok ? found.preset.maintainer : null,
    limits: found.ok ? found.preset.limits : [],
    identity: "not confirmed", needsInput: "from the screen only: no app prompt pattern",
    resume: found.ok && found.preset.session ? "declared" : "not declared",
    ...(found.ok ? {} : { presetError: found.message }),
  };
}
