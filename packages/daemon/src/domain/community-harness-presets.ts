// Community harnesses: another community harness runs in a seat from a small data preset the person installs, one YAML file
// per harness under $OPENRIG_HOME/community-harnesses/<name>.yaml. A preset names the harness, the command that starts it in the seat's
// pane, its maintainer and the limits it declares. With `launch_result: true`, its launcher reports the harness's own
// conversation id for each launch (see `community-harness-launch-result.ts`); OpenRig records it as reported, not observed.
// With `names_conversation: true`, OpenRig names the conversation itself and passes the name to the command; it records it
// as named by OpenRig, not observed. OpenRig hasn't tested these harnesses: it shows them as community harnesses,
// labels launcher identity separately from observation. A declared managed runner can report activity through hooks, and
// so can a plain preset whose own hook script posts the events it declares (`activity_hooks`); other presets use the
// screen. Built-in runtime names are
// reserved, so a preset can't replace one.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { BUILT_IN_RUNTIMES, isCommunityHarnessRuntime } from "./built-in-runtimes.js";

export { BUILT_IN_RUNTIMES, isCommunityHarnessRuntime };

export const COMMUNITY_HARNESS_PRESET_FORMAT = 1;
const FIELDS = ["format", "name", "command", "maintainer", "limits", "launch_result", "names_conversation", "resume", "startup_assisted", "first_input", "runner", "passes_model", "launch_wrapper", "protocol", "activity_hooks", "model_catalog"] as const;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type CommunityHarnessProtocol = "pi-rpc";

interface PresetModelCatalog {
  runtimeVersion?: string;
  models: Array<{ id: string; effortLevels?: string[] }>;
}

export interface CommunityHarnessPreset {
  name: string;
  command: string;
  maintainer: string;
  limits: string[];
  /** How the harness runs: omitted for the preset's own launcher; "pi-rpc" runs through OpenRig's Pi RPC runner. */
  protocol?: CommunityHarnessProtocol;
  /** The launcher writes one launch-result record per launch (the harness's own conversation id). */
  launchResult: boolean;
  /** The harness takes a conversation name from OpenRig (OPENRIG_CONVERSATION) and creates or reopens that conversation. */
  namesConversation: boolean;
  /** The harness can reopen a conversation OpenRig knows (OPENRIG_RESUME_REF): one its launcher reported, or one OpenRig named. */
  resume: boolean;
  /** Startup text is attempted, but the person must check its submission before the seat is marked ready. */
  startupAssisted: boolean;
  /** The launcher takes OPENRIG_FIRST_INPUT, a private file containing the composed first turn. */
  firstInput: boolean;
  /** The launcher takes the seat's declared model from OPENRIG_MODEL and maps it into its harness's own setting. */
  passesModel: boolean;
  /** The runner applies OPENRIG_LAUNCH_WRAPPER to its native child, keeping itself outside the wrapper. */
  launchWrapper: boolean;
  /** The command is an OpenRig-aware runner: it submits each pasted block as one prompt and posts the seat's turn
   *  boundaries as activity hooks, so its seat's activity reads from those hooks. Requires `launch_result`. */
  runner: boolean;
  /** The OpenRig hook events the harness's own hook script posts on the install-token path (`activity_hooks`), sorted and
   *  without repeats; absent when none are declared. On a plain preset these hooks decide its activity; a runner (or a
   *  pi-rpc preset) keeps its own reports and the declaration is ignored. */
  activityHooks?: string[];
  /** Optional settings-editor metadata. It has no effect on launching the harness. */
  modelCatalog?: PresetModelCatalog;
  path: string;
}

/** Safe to return through the catalog API. Keep preset paths and authored text in the local message only. */
interface PresetDiagnostic {
  field?: string;
  reason: string;
}

export type CommunityHarnessPresetLookup =
  | { ok: true; preset: CommunityHarnessPreset; modelCatalogDiagnostic?: PresetDiagnostic }
  | { ok: false; kind: "missing" | "incompatible"; path: string; message: string; diagnostic: PresetDiagnostic };

export function communityHarnessesDir(): string {
  return getDefaultOpenRigPath("community-harnesses");
}

function describePresetValue(value: unknown): string {
  try { return JSON.stringify(value ?? null); } catch { return "an invalid value"; }
}

function parsePreset(name: string, path: string, text: string): CommunityHarnessPresetLookup {
  const bad = (reason: string, field?: string, localReason = reason): CommunityHarnessPresetLookup => ({
    ok: false, kind: "incompatible", path,
    message: `community harness "${name}": the preset at ${path} can't be used: ${localReason}`,
    diagnostic: { reason, ...(field === undefined ? {} : { field }) },
  });
  let doc: unknown;
  try { doc = parseYaml(text); } catch { return bad("it isn't valid YAML"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return bad("it isn't a YAML mapping");
  const raw = doc as Record<string, unknown>;
  if (raw.format !== COMMUNITY_HARNESS_PRESET_FORMAT) {
    return bad(`format must be ${COMMUNITY_HARNESS_PRESET_FORMAT}`, "format",
      `it declares format ${describePresetValue(raw.format)}; this OpenRig reads format ${COMMUNITY_HARNESS_PRESET_FORMAT}`);
  }
  const unknown = Object.keys(raw).filter(key => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length) return bad(`The preset has unknown fields. Supported fields: ${FIELDS.join(", ")}.`, undefined,
    `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (format ${COMMUNITY_HARNESS_PRESET_FORMAT} has ${FIELDS.join(", ")})`);
  if (raw.name !== name) return bad("name must match the preset filename", "name", `its name is ${describePresetValue(raw.name)}, not "${name}" (the file name)`);
  for (const key of ["command", "maintainer"] as const) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) return bad(`${key} must be a non-empty string`, key);
  }
  const shell = shellSyntaxIn(raw.command as string);
  if (shell) {
    return bad(`command must be a single program and its arguments; shell syntax such as ${shell} isn't supported: put it in a script and name the script`, "command");
  }
  const limits = raw.limits ?? [];
  if (!Array.isArray(limits) || limits.some(limit => typeof limit !== "string" || !limit.trim())) {
    return bad("limits must be a list of non-empty strings", "limits");
  }
  if (raw.launch_result !== undefined && typeof raw.launch_result !== "boolean") return bad("launch_result must be true or false", "launch_result");
  if (raw.resume !== undefined && typeof raw.resume !== "boolean") return bad("resume must be true or false", "resume");
  if (raw.startup_assisted !== undefined && typeof raw.startup_assisted !== "boolean") return bad("startup_assisted must be true or false", "startup_assisted");
  if (raw.first_input !== undefined && typeof raw.first_input !== "boolean") return bad("first_input must be true or false", "first_input");
  if (raw.passes_model !== undefined && typeof raw.passes_model !== "boolean") return bad("passes_model must be true or false", "passes_model");
  if (raw.launch_wrapper !== undefined && typeof raw.launch_wrapper !== "boolean") return bad("launch_wrapper must be true or false", "launch_wrapper");
  if (raw.names_conversation !== undefined && typeof raw.names_conversation !== "boolean") return bad("names_conversation must be true or false", "names_conversation");
  if (raw.runner !== undefined && typeof raw.runner !== "boolean") return bad("runner must be true or false", "runner");
  const declaredHooks = raw.activity_hooks ?? [];
  if (!Array.isArray(declaredHooks) || declaredHooks.some(hook => typeof hook !== "string" || !hook.trim())) {
    return bad("activity_hooks must be a list of hook event names, such as [PreToolUse, PostToolUse, Stop]", "activity_hooks");
  }
  if (raw.protocol !== undefined) {
    if (typeof raw.protocol !== "string" || raw.protocol !== "pi-rpc") {
      return bad("protocol must be 'pi-rpc' when specified", "protocol");
    }
  }
  const protocol: CommunityHarnessProtocol | undefined = raw.protocol === "pi-rpc" ? "pi-rpc" : undefined;
  if (protocol === "pi-rpc") {
    if (raw.runner === true) {
      return bad("protocol: pi-rpc and runner: true can't both be set: pi-rpc harnesses use OpenRig's Pi runner", "protocol");
    }
    if (raw.launch_result === true || raw.names_conversation === true) {
      return bad("protocol: pi-rpc manages session identity through the Pi runner; launch_result and names_conversation are not supported", "protocol");
    }
    if (raw.startup_assisted === true) {
      return bad("protocol: pi-rpc and startup_assisted can't both be set", "protocol");
    }
    if (raw.first_input === true) {
      return bad("protocol: pi-rpc and first_input can't both be set", "protocol");
    }
  }
  if (raw.launch_wrapper === true && raw.runner !== true) return bad("launch_wrapper needs runner: true: only a runner consumes OPENRIG_LAUNCH_WRAPPER", "launch_wrapper");
  if (raw.runner === true && raw.launch_result !== true) {
    return bad("runner needs launch_result: true: a runner reports the conversation it opened in its launch record", "runner");
  }
  if (raw.launch_result === true && raw.names_conversation === true) {
    return bad("launch_result and names_conversation can't both be true: either the launcher reports the conversation, or OpenRig names it", "launch_result");
  }
  if (raw.resume === true && protocol !== "pi-rpc" && raw.launch_result !== true && raw.names_conversation !== true) {
    return bad("resume needs launch_result: true or names_conversation: true, so the conversation to reopen is one OpenRig knows", "resume");
  }
  const catalog = parseModelCatalog(raw.model_catalog);
  return { ok: true, ...(catalog?.diagnostic ? { modelCatalogDiagnostic: catalog.diagnostic } : {}),
    preset: { name, command: raw.command as string, maintainer: raw.maintainer as string, limits: limits as string[],
    ...(protocol ? { protocol } : {}),
    ...(catalog?.modelCatalog ? { modelCatalog: catalog.modelCatalog } : {}),
    launchResult: raw.launch_result === true, namesConversation: raw.names_conversation === true, resume: raw.resume === true,
    startupAssisted: raw.startup_assisted === true, firstInput: raw.first_input === true, runner: raw.runner === true, passesModel: raw.passes_model === true,
    launchWrapper: raw.launch_wrapper === true,
    ...(declaredHooks.length ? { activityHooks: [...new Set((declaredHooks as string[]).map(hook => hook.trim()))].sort() } : {}), path } };
}

function parseModelCatalog(value: unknown):
  | { modelCatalog: PresetModelCatalog; diagnostic?: never }
  | { diagnostic: PresetDiagnostic; modelCatalog?: never }
  | undefined {
  if (value === undefined) return;
  const bad = (field: string, reason: string) => ({ diagnostic: { field, reason } });
  const isRecord = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry);
  const isLabel = (label: unknown): label is string =>
    typeof label === "string" && label.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(label);
  if (!isRecord(value)) return bad("model_catalog", "model_catalog must be a mapping");
  if (!Array.isArray(value.models)) return bad("model_catalog.models", "models must be a list");
  const version = value.runtime_version;
  if (version !== undefined && !isLabel(version)) {
    return bad("model_catalog.runtime_version", "runtime_version must be a non-empty string without control characters");
  }

  const models: PresetModelCatalog["models"] = [];
  for (const [index, entry] of value.models.entries()) {
    const field = `model_catalog.models[${index}]`;
    if (!isRecord(entry)) return bad(field, "each model must be a mapping");
    if (!isLabel(entry.id)) return bad(`${field}.id`, "id must be a non-empty string without control characters");
    const levels = entry.effort_levels;
    if (levels !== undefined && (!Array.isArray(levels) || !levels.every(isLabel))) {
      return bad(`${field}.effort_levels`, "effort_levels must be a list of non-empty strings without control characters");
    }
    models.push({
      id: entry.id.trim(),
      ...(levels === undefined ? {} : { effortLevels: levels.map(level => level.trim()) }),
    });
  }
  return { modelCatalog: { ...(version === undefined ? {} : { runtimeVersion: version }), models } };
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

/** The installed preset for a community harness, or why there isn't a usable one. */
export function loadCommunityHarnessPreset(name: string, dir: string = communityHarnessesDir()): CommunityHarnessPresetLookup {
  const path = join(dir, `${name}.yaml`);
  if (BUILT_IN_RUNTIMES.has(name)) {
    return { ok: false, kind: "incompatible", path, message: `"${name}" is a built-in runtime; a community harness preset can't use that name`,
      diagnostic: { field: "name", reason: "A community harness preset cannot use a built-in runtime name." } };
  }
  // The name check comes first: it keeps a runtime name from reaching outside the directory.
  if (!NAME.test(name)) {
    if (name === basename(name) && !name.startsWith(".") && existsSync(path)) {
      return { ok: false, kind: "incompatible", path,
        message: `community harness "${name}": the preset at ${path} can't be used: its name must be lowercase letters, digits and hyphens, starting with a letter or digit`,
        diagnostic: { field: "name", reason: "The preset name must be lowercase letters, digits and hyphens, starting with a letter or digit." } };
    }
    return { ok: false, kind: "missing", path, message: `no community harness preset named "${name}" is installed (looked for ${path})`,
      diagnostic: { reason: "No community harness preset is installed for this runtime." } };
  }
  if (!existsSync(path)) {
    return { ok: false, kind: "missing", path, message: `no community harness preset named "${name}" is installed (looked for ${path})`,
      diagnostic: { reason: "No community harness preset is installed for this runtime." } };
  }
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch {
    return { ok: false, kind: "incompatible", path, message: `community harness "${name}": the preset at ${path} couldn't be read`,
      diagnostic: { reason: "The preset could not be read." } };
  }
  return parsePreset(name, path, text);
}

/** Whether a community harness's installed preset declares `resume` (its launcher reopens a reported conversation). */
export function communityHarnessResumes(name: string | null | undefined, dir: string = communityHarnessesDir()): boolean {
  if (!name) return false;
  const found = loadCommunityHarnessPreset(name, dir);
  return found.ok && found.preset.resume;
}

/** Whether a saved conversation is one this community harness can be asked to reopen: its preset declares `resume` and
 *  the token is this harness's own (`community:<name>`), never a former runtime's. */
export function communityHarnessResumesToken(name: string | null | undefined, resumeType: string | null | undefined,
  dir: string = communityHarnessesDir()): boolean {
  return !!name && resumeType === `community:${name}` && communityHarnessResumes(name, dir);
}

/** Whether restore stops a community harness's seat at its own gate: the preset can't resume, or the seat holds a token
 *  that isn't this harness's own. A seat with no token passes on to the usual "no resume token" stop. */
export function communityHarnessStopsRestore(name: string | null | undefined, resumeType: string | null | undefined,
  resumeToken: string | null | undefined, dir: string = communityHarnessesDir()): boolean {
  return !name || !communityHarnessResumes(name, dir) || (!!resumeToken && resumeType !== `community:${name}`);
}

/** Every preset file in the directory, usable or not, sorted by name. */
export function listCommunityHarnessPresets(dir: string = communityHarnessesDir()): CommunityHarnessPresetLookup[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir).filter(file => file.endsWith(".yaml")).sort(); } catch { return []; }
  return files.map(file => loadCommunityHarnessPreset(file.slice(0, -".yaml".length), dir));
}

/** What a seat on a community harness shows about it. */
export interface CommunityHarnessLabel {
  harness: string;
  community: true;
  testedByOpenRig: false;
  maintainer: string | null;
  limits: string[];
  /** "reported" when its launcher reported the conversation it created (what it says, not proof the harness used it). */
  identity: "not confirmed" | "reported by its launcher, not observed" | "named by OpenRig, not observed";
  /** The conversation id its launcher reported for this launch. */
  reportedConversation?: string;
  /** The conversation name OpenRig passed to the harness for this launch. */
  namedConversation?: string;
  needsInput: "from the screen only: no harness prompt pattern" | "from structured activity and screen observations";
  /** The hooks this seat's launch recorded its preset's own script posting, when they decide its activity (never on a
   *  runner's seat, whose runner reports instead): its activity and attention words then come from OpenRig's decision. */
  activityHooks?: string[];
  /** Set when the preset is missing or can't be used. */
  presetError?: string;
}

export function communityHarnessLabel(runtime: string, dir: string = communityHarnessesDir(),
  session?: { resumeType: string | null; resumeToken: string | null; resumeProvenance: string | null; runner?: boolean;
    activityHooks?: readonly string[] | null }): CommunityHarnessLabel {
  // A conversation is labelled reported only when the launcher reported it, and named only when OpenRig named it and passed
  // it: a resume that needed attention keeps the conversation it attempted, with neither provenance.
  const own = session?.resumeType === `community:${runtime}` && session.resumeToken ? session.resumeToken : undefined;
  const reported = own && session?.resumeProvenance === "launcher" ? own : undefined;
  const named = own && session?.resumeProvenance === "passed" ? own : undefined;
  const found = loadCommunityHarnessPreset(runtime, dir);
  const isPiRpc = found.ok && found.preset.protocol === "pi-rpc";
  return {
    harness: runtime, community: true, testedByOpenRig: false,
    maintainer: found.ok ? found.preset.maintainer : null,
    limits: found.ok ? found.preset.limits : [],
    identity: reported ? "reported by its launcher, not observed" : named ? "named by OpenRig, not observed" : isPiRpc && own ? "reported by its launcher, not observed" : "not confirmed",
    ...(reported || (isPiRpc && own) ? { reportedConversation: reported ?? own } : {}),
    ...(named ? { namedConversation: named } : {}),
    needsInput: isPiRpc || session?.runner === true || session?.activityHooks?.length ? "from structured activity and screen observations" : "from the screen only: no harness prompt pattern",
    ...(session?.runner !== true && session?.activityHooks?.length ? { activityHooks: [...session.activityHooks] } : {}),
    ...(found.ok ? {} : { presetError: found.message }),
  };
}
