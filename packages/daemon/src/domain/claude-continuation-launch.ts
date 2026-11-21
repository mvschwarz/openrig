import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { readNativeProcessLaunch } from "./native-process-arguments.js";
import type { ClaudeAutoMode } from "./claude-auto-mode.js";

/** Transient argv/config selector only; no general environment values or positional startup input. */
export interface ClaudeContinuationLaunch { args?: string[]; configDir?: string | null; warnings: string[] }
const exec = promisify(execFile);
const identity = new Set(["--resume", "-r", "--session-id", "--continue", "-c", "--fork-session", "--from-pr"]);

/** Parse arity from this executable's own help, rather than guessing future flags or replaying a positional prompt. */
export function continuationArguments(argv: string[], help: string): { args: string[]; warnings: string[] } {
  const options = new Map<string, { value: boolean; required: boolean; many: boolean }>();
  for (const line of help.split("\n")) {
    const syntax = /^  (-\S.*?)(?: {2,}|$)/.exec(line)?.[1];
    if (!syntax) continue;
    for (const [, flag] of syntax.matchAll(/(?:^|,\s+)(--?[A-Za-z][\w-]*)/g)) options.set(flag!, { value: /[<[]/.test(syntax), required: syntax.includes("<"), many: syntax.includes("...") });
  }
  const args: string[] = [], warnings: string[] = [];
  const start = /^node(?:\.exe)?$/.test(basename(argv[0] ?? "")) ? 2 : 1;
  for (let n = start; n < argv.length; n++) {
    const arg = argv[n]!, flag = arg.split("=", 1)[0]!;
    const option = options.get(flag);
    if (!option) { warnings.push(arg.startsWith("-") ? `Running option ${flag} could not be mapped; not carried.` : "A positional startup input was not replayed."); continue; }
    const values: string[] = [];
    if (!arg.includes("=") && option.value) {
      while (n + 1 < argv.length && (!argv[n + 1]!.startsWith("-") || (option.required && values.length === 0))) { values.push(argv[++n]!); if (!option.many) break; }
    }
    if (!identity.has(flag)) args.push(arg, ...values);
  }
  return { args, warnings: [...new Set(warnings)] };
}

export async function captureClaudeContinuation(pid: number, executable: string, comparePane?: (env: Readonly<Record<string, string>>) => Promise<string[] | null>, script?: string): Promise<ClaudeContinuationLaunch> {
  const warnings: string[] = [];
  const launch = await readNativeProcessLaunch(pid);
  if (!launch) return { warnings: ["The running Claude argv/environment could not be read; using the seat's ordinary launch settings."] };
  // Values are used only for this transient comparison; only the config selector leaves this function.
  let different: string[] | null = null;
  try { different = await comparePane?.(launch.env) ?? null; } catch { /* name the unknown comparison, never its values */ }
  warnings.push(different === null ? "Running environment could not be compared with the pane's tmux session; only CLAUDE_CONFIG_DIR is captured. Other values use ordinary pane forwarding."
    : different.length ? `Running values differing from the pane's tmux session are not copied: ${different.join(", ")}. Ordinary pane forwarding and current credential/identity channels apply.`
      : "Only CLAUDE_CONFIG_DIR is captured; other values use ordinary pane forwarding and current credential/identity channels.");
  const configDir = launch.env.CLAUDE_CONFIG_DIR ?? null;
  try {
    const { stdout } = await exec(executable, [...(script ? [script] : []), "--help"], { windowsHide: true, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}), ...(configDir === null ? {} : { CLAUDE_CONFIG_DIR: configDir }) }, encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024 });
    if (!stdout.includes("--settings") || !stdout.includes("--resume")) throw new Error("unmapped help");
    const mapped = continuationArguments(launch.argv, stdout);
    if (mapped.args.some(a => a === "--settings" || a.startsWith("--settings="))) warnings.push("Custom --settings is retained; its credential precedence is not verified by this switch. Check Claude /status for the active billing source.");
    return { ...mapped, configDir, warnings: [...warnings, "Kept mapped running Claude options (including settings/model); the startup prompt is not replayed.", ...mapped.warnings] };
  } catch { return { configDir, warnings: [...warnings, "The running Claude options could not be mapped from its help; using the seat's ordinary arguments."] }; }
}

/** Each `--settings` value in argv: its index, inline form, and parsed object (undefined when it's a file or not JSON). */
function settingsValues(args: string[]): { at: number; inline: boolean; value?: Record<string, unknown> }[] {
  const found: { at: number; inline: boolean; value?: Record<string, unknown> }[] = [];
  args.forEach((arg, at) => {
    const inline = arg.startsWith("--settings=");
    if (arg !== "--settings" && !inline) return;
    const raw = inline ? arg.slice("--settings=".length) : args[at + 1] ?? "";
    let value: Record<string, unknown> | undefined;
    try { const parsed = JSON.parse(raw) as unknown; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>; } catch { /* a settings file */ }
    found.push({ at, inline, ...(value ? { value } : {}) });
  });
  return found;
}

/** Sets the seat's block (null: none) in captured arguments, keeping every other settings key.
 *  Undefined when a captured --settings is a file, whose autoMode OpenRig can't see or change. */
function withAutoMode(args: string[], block: ClaudeAutoMode | null): string[] | undefined {
  const found = settingsValues(args);
  if (found.some(entry => !entry.value)) return undefined;
  if (!found.length) return block ? [...args, "--settings", JSON.stringify({ autoMode: block })] : args;
  const result = [...args];
  found.forEach((entry, index) => {
    const { autoMode: _dropped, ...rest } = entry.value!;
    const json = JSON.stringify(block && index === found.length - 1 ? { ...rest, autoMode: block } : rest);
    if (entry.inline) result[entry.at] = `--settings=${json}`; else result[entry.at + 1] = json;
  });
  return result;
}

/** The autoMode block these final arguments send: null for none, undefined when a settings file makes it unknown. */
export function sentClaudeAutoMode(args: string[]): ClaudeAutoMode | null | undefined {
  const found = settingsValues(args);
  if (found.some(entry => !entry.value)) return undefined;
  const blocks = found.filter(entry => entry.value!["autoMode"] !== undefined);
  if (blocks.length > 1) return undefined;
  return (blocks[0]?.value!["autoMode"] as ClaudeAutoMode | undefined) ?? null;
}

/** `autoMode` is the block this launch sends (null: none); undefined leaves captured settings as they are. */
export function resumedClaudeArguments(launch: ClaudeContinuationLaunch | undefined, fallback: string[], conversation: string, effort?: string | null, posture?: string,
  autoMode?: ClaudeAutoMode | null): string[] {
  if (!launch?.args) return fallback;
  const args = autoMode === undefined ? [...launch.args] : withAutoMode(launch.args, autoMode) ?? [...launch.args];
  // Keep restore's existing explicit seat-effort precedence.
  if (effort) {
    const at = args.findIndex(a => a === "--effort" || a.startsWith("--effort="));
    if (at >= 0) args.splice(at, args[at]!.includes("=") ? 1 : 2, "--effort", effort);
    else args.push("--effort", effort);
  }
  if (posture) {
    for (let n = args.length - 1; n >= 0; n--) {
      if (args[n] === "--permission-mode") args.splice(n, 2);
      else if (args[n]!.startsWith("--permission-mode=") || args[n] === "--dangerously-skip-permissions") args.splice(n, 1);
    }
    args.push(...posture.split(" "));
  }
  return [...args, "--resume", conversation];
}

export function continuationPermission(launch: ClaudeContinuationLaunch): string {
  const args = launch.args ?? [], at = args.lastIndexOf("--permission-mode");
  const inline = [...args].reverse().find(a => a.startsWith("--permission-mode="));
  const mode = inline?.slice("--permission-mode=".length) ?? (at >= 0 ? args[at + 1] : undefined);
  if (args.includes("--dangerously-skip-permissions")) return mode ? "" : "--dangerously-skip-permissions";
  return mode ? `--permission-mode ${mode}` : "";
}

export function continuationChoiceNotes(launch: ClaudeContinuationLaunch | undefined, posture: string, model?: string | null): string[] {
  if (!launch?.args) return [];
  const notes: string[] = [], running = continuationPermission(launch);
  if (running !== posture) notes.push(`The saved permission posture ${posture} replaces the running ${running || "(no explicit posture)"}.`);
  const at = launch.args.lastIndexOf("--model"), inline = [...launch.args].reverse().find(a => a.startsWith("--model="));
  const runningModel = inline?.slice("--model=".length) ?? (at >= 0 ? launch.args[at + 1] : undefined);
  if (model && model !== runningModel) notes.push(`The running model ${runningModel ?? "(no --model flag)"} is kept instead of the saved model ${model}.`);
  return notes;
}
