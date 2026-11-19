import { windowsPowerShell } from "./windows-executables.js";
import path from "node:path";
import { parseWindowsCommandLine } from "../adapters/windows-argv.js";
import { powershellQuote } from "../adapters/windows-launch.js";
import { isStagedSendName } from "../adapters/staged-send-name.js";
import { readWindowsScopedLoader } from "../adapters/windows-scoped-launch.js";
import { shellQuote } from "../adapters/shell-quote.js";
import type { ProcessRow } from "./model-divergence/current-generation-record.js";

const samePath = (a: string, b: string) => a.replaceAll("/", "\\").toLowerCase() === b.replaceAll("/", "\\").toLowerCase();
function executable(row: ProcessRow, name: string): boolean {
  const first = parseWindowsCommandLine(row.command)[0];
  return row.platform === "win32" && !!first && !!row.executablePath && samePath(first, row.executablePath)
    && path.win32.basename(row.executablePath).toLowerCase() === `${name}.exe`;
}
const loader = (script: string) => `iex([IO.File]::ReadAllText(${powershellQuote(script)}))`;

/** Payload stays in the private file; only a fixed encoded loader crosses cmd. */
export function windowsCmdBridgeInvocation(script: string): string {
  if (!path.win32.isAbsolute(script) || !isStagedSendName(path.win32.basename(script))) throw new Error("Unrecognized native launch-script path");
  const shell = windowsPowerShell();
  if (/[\r\n"%!]/.test(shell)) throw new Error("Unsupported native PowerShell executable path");
  return `"${shell}" -NoProfile -EncodedCommand ${Buffer.from(loader(script), "utf16le").toString("base64")}`;
}

/** The same fixed loader through a POSIX shell on Windows; payload never enters argv. */
export function windowsPosixBridgeInvocation(script: string): string {
  const argv=parseWindowsCommandLine(windowsCmdBridgeInvocation(script));
  argv[0]=argv[0]!.replaceAll("\\","/");
  return argv.map(shellQuote).join(" ");
}

function isBridge(row: ProcessRow): boolean {
  if (!executable(row, "powershell")) return false;
  const words = parseWindowsCommandLine(row.command);
  if (words.length !== 4 || words[1] !== "-NoProfile" || words[2] !== "-EncodedCommand") return false;
  const encoded = words[3]!;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const source = Buffer.from(encoded, "base64").toString("utf16le");
  const match = /^iex\(\[IO\.File\]::ReadAllText\('((?:[^']|'')*)'\)\)$/.exec(source);
  if (!match) return false;
  const file = match[1]!.replaceAll("''", "'");
  return path.win32.isAbsolute(file) && isStagedSendName(path.win32.basename(file))
    && encoded === Buffer.from(loader(file), "utf16le").toString("base64");
}

function isScopedBootstrap(row: ProcessRow): boolean {
  if (!executable(row, "powershell")) return false;
  const words = parseWindowsCommandLine(row.command);
  if (words.length !== 5 || words[1] !== "-NoLogo" || words[2] !== "-NoProfile" || words[3] !== "-EncodedCommand") return false;
  const source = Buffer.from(words[4]!, "base64").toString("utf16le");
  const parsed = readWindowsScopedLoader(source);
  if (!parsed) return false;
  const file = parsed.file;
  return path.win32.isAbsolute(file) && isStagedSendName(path.win32.basename(file))
    && words[4] === Buffer.from(source, "utf16le").toString("base64");
}

function scopedShellChild(rows: ProcessRow[], pane: ProcessRow): ProcessRow | null {
  const children=rows.filter(row=>row.ppid===pane.pid),start=Date.parse(pane.startedAt??"");
  if (!Number.isFinite(start) || children.length!==1 || !Number.isFinite(Date.parse(children[0]!.startedAt??""))
    || Date.parse(children[0]!.startedAt!)<start) return null;
  const shell=children[0]!;
  return ["powershell","pwsh","cmd","bash","sh","dash","zsh","ksh"].some(name=>executable(shell,name)) ? shell : null;
}

/** Only the canonical bootstrap is transparent to idle-shell observation.
 * A running bridge/fork is not an idle-shell transition. */
export function windowsScopedShellPid(rows: ProcessRow[], panePid: number): number | null {
  if(new Set(rows.map(row=>row.pid)).size!==rows.length)return null;
  const pane=rows.find(row=>row.pid===panePid);
  if(!pane)return null;
  return isScopedBootstrap(pane) ? scopedShellChild(rows,pane)?.pid ?? null : panePid;
}

/** A direct PowerShell parent, or one managed loader under a supported shell. */
export function windowsManagedRunnerParent(rows: ProcessRow[], panePid: number): number | null {
  if (new Set(rows.map(row => row.pid)).size !== rows.length) return null;
  return managedRunnerParent(rows,panePid,1);
}

function managedRunnerParent(rows: ProcessRow[], panePid: number, posixForks: number): number | null {
  const pane = rows.find(row => row.pid === panePid);
  if (!pane) return null;
  if (isScopedBootstrap(pane)) {
    const shell = scopedShellChild(rows,pane);
    if(!shell)return null;
    if (executable(shell, "powershell") || executable(shell, "pwsh")) return shell.pid;
    if (["cmd","bash","sh","dash","zsh","ksh"].some(name=>executable(shell,name))) return managedRunnerParent(rows, shell.pid,posixForks);
    return null;
  }
  if (executable(pane, "powershell") || executable(pane, "pwsh")) return panePid;
  if (!["cmd","bash","sh","dash","zsh","ksh"].some(name=>executable(pane,name))) return null;
  const children = rows.filter(row => row.ppid === panePid);
  const start = Date.parse(pane.startedAt ?? "");
  if (!Number.isFinite(start) || children.some(row => !Number.isFinite(Date.parse(row.startedAt ?? "")) || Date.parse(row.startedAt!) < start)) return null;
  const consolePath = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");
  const consoles = children.filter(row => row.platform === "win32" && !!row.executablePath && samePath(row.executablePath, consolePath));
  if (consoles.length > 1) return null;
  const bridges = children.filter(row => !consoles.includes(row));
  if (bridges.length !== 1) return null;
  const bridge = bridges[0]!;
  if (isBridge(bridge)) return bridge.pid;
  // MSYS fork retains the shell's Windows executable and exact argv before
  // execing a native child. Admit one observed transition, never a general
  // descendant search or a second fork with ambiguous ancestry.
  if (posixForks > 0 && ["bash","sh","dash","zsh","ksh"].some(name=>executable(pane,name)&&executable(bridge,name))
    && samePath(pane.executablePath!,bridge.executablePath!) && pane.command === bridge.command)
    return managedRunnerParent(rows,bridge.pid,posixForks-1);
  return null;
}
