import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAsyncSite } from "./sync-site-wrap.js";

const execFileAsync = promisify(execFile);

export interface NativeProcessRow {
  pid: number;
  ppid: number;
  command: string;
  pgid?: number;
  tpgid?: number;
  executableName?: string;
  startedAt?: string;
}

export type NativeRuntime = "claude-code" | "codex";

function tokens(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? [];
}

function executableName(token: string): string {
  return (token.split("/").pop() ?? token).toLowerCase().replace(/\.exe$/, "");
}

function commandUsesExpectedToken(command: string, runtime: NativeRuntime, expectedToken: string): boolean {
  const argv = tokens(command);
  const executable = runtime === "claude-code" ? "claude" : "codex";
  const executableIndex = argv.findIndex((token) => executableName(token) === executable);
  if (executableIndex < 0) return false;
  const args = argv.slice(executableIndex + 1);
  if (runtime === "claude-code") {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if ((arg === "--resume" || arg === "--session-id") && args[index + 1] === expectedToken) return true;
      if (arg === `--resume=${expectedToken}` || arg === `--session-id=${expectedToken}`) return true;
    }
    return false;
  }

  return codexResumeToken(args) === expectedToken;
}

// undefined is a fresh command; null is a resume command without an exact token.
function codexResumeToken(args: string[]): string | null | undefined {
  const topLevelOptionsWithValues = new Set([
    "-a", "--ask-for-approval", "-c", "--config", "-m", "--model",
    "-p", "--profile", "-s", "--sandbox",
  ]);
  let resumeIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (topLevelOptionsWithValues.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    if (arg === "resume") resumeIndex = index;
    break;
  }
  if (resumeIndex < 0) return undefined;
  const resumeArgs = args.slice(resumeIndex + 1);
  let index = 0;
  while (index < resumeArgs.length) {
    const arg = resumeArgs[index]!;
    if (arg === "--add-dir") { index += 2; continue; }
    if (arg.startsWith("-")) { index += 1; continue; }
    return arg;
  }
  return null;
}

// Managed fresh/resume launches name the current Claude identity explicitly.
// A fork's --resume names its parent, so it cannot prove the new occupant.
function claudeSessionToken(args: string[]): string | null {
  let token: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (index === 0 && /^\(\d+\.\d+\.\d+[^)]*\)$/.test(arg)) continue;
    if (["--permission-mode", "--model", "--name"].includes(arg)) { index += 1; continue; }
    if (/^--(?:permission-mode|model|name)=/.test(arg) || arg === "--dangerously-skip-permissions") continue;
    const identity = arg.match(/^--(?:session-id|resume)(?:=(.*))?$/);
    if (!identity) return null; // Unknown argv is not positive identity proof.
    const value = identity[1] ?? args[++index];
    if (token !== null || !value || value.startsWith("-")) return null;
    token = value;
  }
  return token;
}

/** Require a live process in the pane's own lineage whose argv names both the
 * declared runtime and the exact native resume identity. */
export function findExactNativeResumeProcess(
  processes: NativeProcessRow[],
  panePid: number,
  runtime: string | null,
  expectedToken: string,
): NativeProcessRow | null {
  if (runtime === "codex") return selectNativeProcess(processes, panePid, expectedToken, true)?.process ?? null;
  if (runtime !== "claude-code") return null;
  const byParent = new Map<number, NativeProcessRow[]>();
  for (const process of processes) {
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const queue = [panePid];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const process = byPid.get(pid);
    if (process && commandUsesExpectedToken(process.command, runtime, expectedToken)) return process;
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return null;
}

/** The same OS observation serves menu input, restore proof and periodic identity.
 * Older callers may carry only pid/ppid/command; that is insufficient positive Codex proof. */
export async function listNativeProcesses(): Promise<NativeProcessRow[]> {
  try {
    const output = await runAsyncSite("codex.runtime.list_processes", async () => {
      // lstart is locale-formatted; the child-only C locale keeps the English date the parser expects.
      const { stdout } = await execFileAsync("ps", ["-Ao", "pid,ppid,pgid,tpgid,ucomm,lstart,command"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
      return stdout;
    });
    return output.split("\n").slice(1).flatMap((line) => {
      // ucomm may contain spaces on every platform: macOS app helpers (`Slack Helper`), and on
      // Linux task names set by prctl(PR_SET_NAME) or process.title (`tmux: server`,
      // `node (vitest 1)`). lstart always begins with a weekday word and runs to the year, and
      // ucomm (16 bytes at most) is too short to contain such a date, so matching ucomm lazily
      // up to the first date is exact.
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), executableName: match[5]!, startedAt: match[6]!, command: match[7]! }] : [];
    });
  } catch { return []; }
}

export type NativeProcessLister = () => NativeProcessRow[] | Promise<NativeProcessRow[]>;
type NativeProcessObservation = { panePid: number; process: NativeProcessRow; fingerprint: string };
export type CodexProcessObservation = NativeProcessObservation;

function selectNativeProcess(rows: NativeProcessRow[], panePid: number, expectedToken?: string | null, requireResume = false, runtime: NativeRuntime = "codex"): NativeProcessObservation | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const root = byPid.get(panePid);
  if (byPid.size !== rows.length || !root?.startedAt || !root.tpgid || root.tpgid <= 0) return null;
  const matches: { process: NativeProcessRow; chain: NativeProcessRow[] }[] = [];
  const executable = runtime === "claude-code" ? "claude" : "codex";
  for (const row of rows) {
    const osExecutable = runtime === "claude-code" ? executableName(row.executableName ?? "") : row.executableName;
    if (osExecutable !== executable || executableName(tokens(row.command)[0] ?? "") !== executable
      || row.pgid !== root.tpgid || row.tpgid !== root.tpgid) continue;
    const chain: NativeProcessRow[] = [];
    const visited = new Set<number>();
    let current: NativeProcessRow | undefined = row;
    while (current && !visited.has(current.pid) && current.startedAt) {
      visited.add(current.pid);
      chain.push(current);
      if (current.pid === panePid) { matches.push({ process: row, chain }); break; }
      current = byPid.get(current.ppid);
    }
  }
  if (matches.length !== 1) return null;
  const { process, chain } = matches[0]!;
  if (runtime === "claude-code") {
    if (!expectedToken || claudeSessionToken(tokens(process.command).slice(1)) !== expectedToken) return null;
  } else {
    const resumeToken = codexResumeToken(tokens(process.command).slice(1));
    if (requireResume && !expectedToken) return null;
    if ((requireResume || (expectedToken !== undefined && resumeToken !== undefined))
      && (!expectedToken || resumeToken !== expectedToken)) return null;
  }
  return { panePid, process, fingerprint: JSON.stringify(chain.map((row) => [row.pid, row.ppid, row.startedAt, row.pgid, row.tpgid, row.executableName, row.command])) };
}

async function observeNativePaneProcess(input: {
  target: string;
  tmux: { getPanePid(target: string): Promise<number | null> };
  listProcesses?: NativeProcessLister;
  expectedToken?: string | null;
  requireResume?: boolean;
}, runtime: NativeRuntime): Promise<NativeProcessObservation | null> {
  try {
    const pid = await input.tmux.getPanePid(input.target);
    if (!pid) return null;
    const rows = await (input.listProcesses ?? listNativeProcesses)();
    return selectNativeProcess(rows, pid, input.expectedToken, input.requireResume, runtime);
  } catch { return null; }
}

export async function observeCodexPaneProcess(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<CodexProcessObservation | null> {
  return observeNativePaneProcess(input, "codex");
}

export async function verifyCodexPaneProcess(input: Parameters<typeof observeCodexPaneProcess>[0]): Promise<CodexProcessObservation | null> {
  const first = await observeCodexPaneProcess(input);
  if (!first) return null;
  const second = await observeCodexPaneProcess(input);
  return second?.fingerprint === first.fingerprint ? second : null;
}

/** Single observation for callers that pin identity across their own launch checks. */
export async function observeClaudePaneProcess(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<NativeProcessObservation | null> {
  return observeNativePaneProcess(input, "claude-code");
}

export async function verifyClaudePaneProcess(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<NativeProcessObservation | null> {
  const first = await observeNativePaneProcess(input, "claude-code");
  if (!first) return null;
  const second = await observeNativePaneProcess(input, "claude-code");
  return second?.fingerprint === first.fingerprint ? second : null;
}
