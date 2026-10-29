import path from "node:path";
import { parseWindowsCommandLine } from "../adapters/windows-argv.js";
import { powershellQuote } from "../adapters/windows-launch.js";
import { isStagedSendName } from "../adapters/staged-send-name.js";
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
  const shell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (/[\r\n"%!]/.test(shell)) throw new Error("Unsupported native PowerShell executable path");
  return `"${shell}" -NoProfile -EncodedCommand ${Buffer.from(loader(script), "utf16le").toString("base64")}`;
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

/** A direct PowerShell parent, or exactly one managed PowerShell loader under cmd. */
export function windowsManagedRunnerParent(rows: ProcessRow[], panePid: number): number | null {
  if (new Set(rows.map(row => row.pid)).size !== rows.length) return null;
  const pane = rows.find(row => row.pid === panePid);
  if (!pane) return null;
  if (executable(pane, "powershell") || executable(pane, "pwsh")) return panePid;
  if (!executable(pane, "cmd")) return null;
  const children = rows.filter(row => row.ppid === panePid);
  const start = Date.parse(pane.startedAt ?? "");
  if (!Number.isFinite(start) || children.some(row => !Number.isFinite(Date.parse(row.startedAt ?? "")) || Date.parse(row.startedAt!) < start)) return null;
  const consolePath = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "conhost.exe");
  const consoles = children.filter(row => row.platform === "win32" && !!row.executablePath && samePath(row.executablePath, consolePath));
  if (consoles.length > 1) return null;
  const bridges = children.filter(row => !consoles.includes(row));
  return bridges.length === 1 && isBridge(bridges[0]!) ? bridges[0]!.pid : null;
}
