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

/** Require a live process in the pane's own lineage whose argv names both the
 * declared runtime and the exact native resume identity. */
export function findExactNativeResumeProcess(
  processes: NativeProcessRow[],
  panePid: number,
  runtime: string | null,
  expectedToken: string,
): NativeProcessRow | null {
  if (runtime === "codex") return selectCodexProcess(processes, panePid, expectedToken, true)?.process ?? null;
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
      const { stdout } = await execFileAsync("ps", ["-Ao", "pid,ppid,pgid,tpgid,ucomm,lstart,command"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
      return stdout;
    });
    return output.split("\n").slice(1).flatMap((line) => {
      // ucomm may contain spaces (e.g. vitest retitles its worker "node (vitest 1)").
      // It is anchored on the fixed-format lstart date that always follows it.
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), executableName: match[5]!, startedAt: match[6]!, command: match[7]! }] : [];
    });
  } catch { return []; }
}

export type NativeProcessLister = () => NativeProcessRow[] | Promise<NativeProcessRow[]>;
export type CodexProcessObservation = { panePid: number; process: NativeProcessRow; fingerprint: string };

function selectCodexProcess(rows: NativeProcessRow[], panePid: number, expectedToken?: string | null, requireResume = false): CodexProcessObservation | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const root = byPid.get(panePid);
  if (byPid.size !== rows.length || !root?.startedAt || !root.tpgid || root.tpgid <= 0) return null;
  const matches: { process: NativeProcessRow; chain: NativeProcessRow[] }[] = [];
  for (const row of rows) {
    if (row.executableName !== "codex" || executableName(tokens(row.command)[0] ?? "") !== "codex"
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
  const resumeToken = codexResumeToken(tokens(process.command).slice(1));
  if (requireResume && !expectedToken) return null;
  if ((requireResume || (expectedToken !== undefined && resumeToken !== undefined))
    && (!expectedToken || resumeToken !== expectedToken)) return null;
  return { panePid, process, fingerprint: JSON.stringify(chain.map((row) => [row.pid, row.ppid, row.startedAt, row.pgid, row.tpgid, row.executableName, row.command])) };
}

export async function observeCodexPaneProcess(input: {
  target: string;
  tmux: { getPanePid(target: string): Promise<number | null> };
  listProcesses?: NativeProcessLister;
  expectedToken?: string | null;
  requireResume?: boolean;
}): Promise<CodexProcessObservation | null> {
  try {
    const pid = await input.tmux.getPanePid(input.target);
    if (!pid) return null;
    const rows = await (input.listProcesses ?? listNativeProcesses)();
    return selectCodexProcess(rows, pid, input.expectedToken, input.requireResume);
  } catch { return null; }
}

export async function verifyCodexPaneProcess(input: Parameters<typeof observeCodexPaneProcess>[0]): Promise<CodexProcessObservation | null> {
  const first = await observeCodexPaneProcess(input);
  if (!first) return null;
  const second = await observeCodexPaneProcess(input);
  return second?.fingerprint === first.fingerprint ? second : null;
}
