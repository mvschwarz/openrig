import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename } from "node:path";
import { OUTRANKING_TOKEN_ENV } from "./claude-credential-precedence.js";
import { readNativeProcessLaunch } from "./native-process-arguments.js";

/** In-memory only: no native environment or original prompt enters a snapshot/result. */
export interface ClaudeContinuationLaunch { args?: string[]; env?: Record<string, string>; warnings: string[] }
const exec = promisify(execFile);
const identity = new Set(["--resume", "-r", "--session-id", "--continue", "-c", "--fork-session", "--from-pr"]);
const credentials = new Set([...OUTRANKING_TOKEN_ENV, "CLAUDE_CODE_OAUTH_TOKEN"]);

/** Parse arity from this executable's own help, rather than guessing future flags or replaying a positional prompt. */
export function continuationArguments(argv: string[], help: string): { args: string[]; warnings: string[] } {
  const options = new Map<string, { value: boolean; many: boolean }>();
  for (const line of help.split("\n")) {
    const syntax = /^  (-\S.*?)(?: {2,}|$)/.exec(line)?.[1];
    if (!syntax) continue;
    for (const [, flag] of syntax.matchAll(/(?:^|,\s+)(--?[A-Za-z][\w-]*)/g)) options.set(flag!, { value: /[<[]/.test(syntax), many: syntax.includes("...") });
  }
  const args: string[] = [], warnings: string[] = [];
  const start = /^node(?:\.exe)?$/.test(basename(argv[0] ?? "")) ? 2 : 1;
  for (let n = start; n < argv.length; n++) {
    const arg = argv[n]!, flag = arg.split("=", 1)[0]!;
    const option = options.get(flag);
    if (!option) { warnings.push(arg.startsWith("-") ? `Running option ${flag} could not be mapped; not carried.` : "A positional startup input was not replayed."); continue; }
    const values: string[] = [];
    if (!arg.includes("=") && option.value) {
      while (n + 1 < argv.length && !argv[n + 1]!.startsWith("-")) { values.push(argv[++n]!); if (!option.many) break; }
    }
    if (!identity.has(flag)) args.push(arg, ...values);
  }
  return { args, warnings: [...new Set(warnings)] };
}

export async function captureClaudeContinuation(pid: number, executable: string): Promise<ClaudeContinuationLaunch> {
  const warnings: string[] = [];
  const launch = await readNativeProcessLaunch(pid);
  if (!launch) return { warnings: ["The running Claude argv/environment could not be read; using the seat's ordinary launch settings."] };
  const env = Object.fromEntries(Object.entries(launch.env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    && !key.startsWith("OPENRIG_") && !key.startsWith("RIGGED_") && !credentials.has(key) && !["_", "SHLVL", "SHELLOPTS", "BASHOPTS", "UID", "EUID", "PPID"].includes(key)));
  if (!env.HOME?.startsWith("/") || !env.PATH) return { warnings: ["Running Claude HOME/PATH unavailable; using ordinary launch settings."] };
  warnings.push("Kept the captured running Claude environment; credentials and OpenRig identity use the current launch channel, and shell bookkeeping is regenerated.");
  try {
    const { stdout } = await exec(executable, ["--help"], { env: { PATH: env.PATH, HOME: env.HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR }, encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024 });
    if (!stdout.includes("--settings") || !stdout.includes("--resume")) throw new Error("unmapped help");
    const mapped = continuationArguments(launch.argv, stdout);
    if (mapped.args.some(a => a === "--settings" || a.startsWith("--settings="))) warnings.push("Custom --settings is retained; its credential precedence is not verified by this switch. Check Claude /status for the active billing source.");
    return { ...mapped, env, warnings: [...warnings, "Kept mapped running Claude options (including settings/model); the startup prompt is not replayed.", ...mapped.warnings] };
  } catch { return { env, warnings: [...warnings, "The running Claude options could not be mapped from its help; using the seat's ordinary arguments."] }; }
}

export function resumedClaudeArguments(launch: ClaudeContinuationLaunch | undefined, fallback: string[], conversation: string, effort?: string | null): string[] {
  if (!launch?.args) return fallback;
  const args = [...launch.args];
  // Keep restore's existing explicit seat-effort precedence.
  if (effort) {
    const at = args.findIndex(a => a === "--effort" || a.startsWith("--effort="));
    if (at >= 0) args.splice(at, args[at]!.includes("=") ? 1 : 2, "--effort", effort);
    else args.push("--effort", effort);
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
