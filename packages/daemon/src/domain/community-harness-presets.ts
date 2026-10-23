// Community harnesses: another community harness runs in a seat from a small data preset the person installs, one YAML file
// per harness under $OPENRIG_HOME/community-harnesses/<name>.yaml. A preset names the harness, the command that starts it in the seat's
// pane, its maintainer and the limits it declares. With `launch_result: true`, its launcher reports the harness's own
// conversation id for each launch (see `community-harness-launch-result.ts`); OpenRig records it as reported, not observed. OpenRig hasn't tested these harnesses: it shows them as community harnesses,
// never confirms their identity, and reads their activity only from what the screen shows. Built-in runtime names are
// reserved, so a preset can't replace one.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { BUILT_IN_RUNTIMES, isCommunityHarnessRuntime } from "./built-in-runtimes.js";

export { BUILT_IN_RUNTIMES, isCommunityHarnessRuntime };

export const COMMUNITY_HARNESS_PRESET_FORMAT = 1;
const FIELDS = ["format", "name", "command", "maintainer", "limits", "launch_result"] as const;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface CommunityHarnessPreset {
  name: string;
  command: string;
  maintainer: string;
  limits: string[];
  /** The launcher writes one launch-result record per launch (the harness's own conversation id). */
  launchResult: boolean;
  path: string;
}

export type CommunityHarnessPresetLookup =
  | { ok: true; preset: CommunityHarnessPreset }
  | { ok: false; kind: "missing" | "incompatible"; path: string; message: string };

export function communityHarnessesDir(): string {
  return getDefaultOpenRigPath("community-harnesses");
}

function parsePreset(name: string, path: string, text: string): CommunityHarnessPresetLookup {
  const bad = (reason: string): CommunityHarnessPresetLookup => ({ ok: false, kind: "incompatible", path,
    message: `community harness "${name}": the preset at ${path} can't be used: ${reason}` });
  let doc: unknown;
  try { doc = parseYaml(text); } catch { return bad("it isn't valid YAML"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return bad("it isn't a YAML mapping");
  const raw = doc as Record<string, unknown>;
  if (raw.format !== COMMUNITY_HARNESS_PRESET_FORMAT) {
    return bad(`it declares format ${JSON.stringify(raw.format ?? null)}; this OpenRig reads format ${COMMUNITY_HARNESS_PRESET_FORMAT}`);
  }
  const unknown = Object.keys(raw).filter(key => !(FIELDS as readonly string[]).includes(key));
  if (unknown.length) return bad(`unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (format ${COMMUNITY_HARNESS_PRESET_FORMAT} has ${FIELDS.join(", ")})`);
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
  if (raw.launch_result !== undefined && typeof raw.launch_result !== "boolean") return bad("launch_result must be true or false");
  return { ok: true, preset: { name, command: raw.command as string, maintainer: raw.maintainer as string, limits: limits as string[],
    launchResult: raw.launch_result === true, path } };
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
    return { ok: false, kind: "incompatible", path, message: `"${name}" is a built-in runtime; a community harness preset can't use that name` };
  }
  // The name check comes first: it keeps a runtime name from reaching outside the directory.
  if (!NAME.test(name)) {
    if (name === basename(name) && !name.startsWith(".") && existsSync(path)) {
      return { ok: false, kind: "incompatible", path,
        message: `community harness "${name}": the preset at ${path} can't be used: its name must be lowercase letters, digits and hyphens, starting with a letter or digit` };
    }
    return { ok: false, kind: "missing", path, message: `no community harness preset named "${name}" is installed (looked for ${path})` };
  }
  if (!existsSync(path)) {
    return { ok: false, kind: "missing", path, message: `no community harness preset named "${name}" is installed (looked for ${path})` };
  }
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch {
    return { ok: false, kind: "incompatible", path, message: `community harness "${name}": the preset at ${path} couldn't be read` };
  }
  return parsePreset(name, path, text);
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
  identity: "not confirmed" | "reported by its launcher, not observed";
  /** The conversation id its launcher reported for this launch. */
  reportedConversation?: string;
  needsInput: "from the screen only: no harness prompt pattern";
  /** Set when the preset is missing or can't be used. */
  presetError?: string;
}

export function communityHarnessLabel(runtime: string, dir: string = communityHarnessesDir(),
  session?: { resumeType: string | null; resumeToken: string | null }): CommunityHarnessLabel {
  const reported = session?.resumeType === `community:${runtime}` && session.resumeToken ? session.resumeToken : undefined;
  const found = loadCommunityHarnessPreset(runtime, dir);
  return {
    harness: runtime, community: true, testedByOpenRig: false,
    maintainer: found.ok ? found.preset.maintainer : null,
    limits: found.ok ? found.preset.limits : [],
    identity: reported ? "reported by its launcher, not observed" : "not confirmed",
    ...(reported ? { reportedConversation: reported } : {}),
    needsInput: "from the screen only: no harness prompt pattern",
    ...(found.ok ? {} : { presetError: found.message }),
  };
}
