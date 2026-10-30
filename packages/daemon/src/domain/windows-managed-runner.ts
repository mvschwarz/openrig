import path from "node:path";
import { statSync } from "node:fs";
import { parseWindowsCommandLine } from "../adapters/windows-argv.js";
import { readProcessTable } from "./process-table.js";
import type { ProcessRow } from "./model-divergence/current-generation-record.js";
import { windowsManagedRunnerParent } from "./windows-cmd-bridge.js";

export interface WindowsRunnerEvidence {
  runtime: "pi" | "omp" | "stub";
  sessionName: string;
  entryPath: string | undefined;
  cwd: string;
  stateRoot?: string;
  launchId: string | undefined;
  getPanePid: () => Promise<number | null>;
  listProcesses?: () => Promise<ProcessRow[]>;
}

const samePath = (a: string, b: string) => a.replaceAll("/", "\\").toLowerCase() === b.replaceAll("/", "\\").toLowerCase();
function samePathOrObject(a: string, b: string, kind: "file" | "directory"): boolean {
  if (samePath(a, b)) return true;
  if (process.platform !== "win32") return false;
  try {
    const first = statSync(a, { bigint: true }), second = statSync(b, { bigint: true });
    const correctType = kind === "file" ? first.isFile() && second.isFile() : first.isDirectory() && second.isDirectory();
    return correctType && first.ino !== 0n && first.dev === second.dev && first.ino === second.ino;
  } catch { return false; }
}
function executable(row: ProcessRow, name: string): boolean {
  const first = parseWindowsCommandLine(row.command)[0];
  return row.platform === "win32" && !!first && !!row.executablePath && samePath(first, row.executablePath)
    && path.win32.basename(row.executablePath).toLowerCase() === `${name}.exe`;
}
function flag(words: string[], name: string): string | undefined {
  const at = words.indexOf(name);
  return at < 0 ? undefined : words[at + 1];
}

/** A pane can hold a live runner or remain after its death. Only the exact
 * managed child of PowerShell (directly, or the admitted cmd bridge) and matching sidecar launch prove readiness.
 * Unavailable/ambiguous observations stay unknown; a shell name is not proof. */
export async function verifyWindowsManagedRunner(input: WindowsRunnerEvidence): Promise<boolean> {
  if (!input.launchId || !input.entryPath) return false;
  try {
    const panePid = await input.getPanePid();
    if (!panePid) return false;
    const rows = await (input.listProcesses ?? readProcessTable)();
    const byPid = new Map(rows.map(row => [row.pid, row]));
    if (byPid.size !== rows.length) return false;
    const parent = byPid.get(panePid), parentStart = Date.parse(parent?.startedAt ?? "");
    const runnerParent = windowsManagedRunnerParent(rows, panePid);
    if (!parent || !Number.isFinite(parentStart) || runnerParent === null) return false;
    const descendants: ProcessRow[] = [], pending = [parent], visited = new Set<number>([panePid]);
    while (pending.length) {
      const current = pending.pop()!;
      for (const child of rows.filter(row => row.ppid === current.pid)) {
        if (visited.has(child.pid) || child.platform !== "win32" || !Number.isFinite(Date.parse(child.startedAt ?? ""))
          || Date.parse(child.startedAt!) < Date.parse(current.startedAt!)) return false;
        visited.add(child.pid); descendants.push(child); pending.push(child);
      }
    }
    const candidates = descendants.filter(row => flag(parseWindowsCommandLine(row.command), "--session-name") === input.sessionName);
    if (candidates.length !== 1) return false;
    const runner = candidates[0]!;
    if (runner.ppid !== runnerParent || !executable(runner, "node")) return false;
    const words = parseWindowsCommandLine(runner.command);
    const head = ["--session-name", input.sessionName, ...(input.runtime === "stub" ? [] : ["--state-root", input.stateRoot ?? ""]), "--cwd", input.cwd, "--launch-id", input.launchId];
    if (!samePathOrObject(words[1] ?? "", input.entryPath, "file")) return false;
    for (let i = 0; i < head.length; i++) {
      const actual = words[i + 2] ?? "", expected = head[i]!;
      if (i > 0 && ["--state-root", "--cwd"].includes(head[i - 1]!)) {
        if (!samePathOrObject(actual, expected, "directory")) return false;
      } else if (actual !== expected) return false;
    }
    const flags = ["--session-name", "--cwd", "--launch-id", ...(input.runtime === "stub" ? [] : ["--state-root"])];
    if (flags.some(name => words.filter(word => word === name).length !== 1) || flag(words, "--launch-id") !== input.launchId) return false;
    if (await input.getPanePid() !== panePid) return false;
    if (input.runtime === "omp") return words.filter(word => word === "--runtime").length === 1 && flag(words, "--runtime") === "omp";
    return !words.includes("--runtime") && (input.runtime !== "stub" || !words.includes("--state-root"));
  } catch { return false; }
}
