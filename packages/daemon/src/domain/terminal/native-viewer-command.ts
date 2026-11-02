import path from "node:path";
import { powershellQuote } from "../../adapters/windows-launch.js";
import { shellQuote } from "../../adapters/shell-quote.js";

/** A newly attributed viewer may run only through an observed supported shell. */
export function nativeViewerCommand(argv: readonly string[], shell: string): string {
  if (!argv.length || argv.some(v => v.includes("\0"))) throw new Error("Invalid viewer argv");
  const kind = path.win32.basename(shell).toLowerCase().replace(/\.exe$/, "");
  if (["powershell", "pwsh"].includes(kind)) return "& " + argv.map(powershellQuote).join(" ");
  if (["bash", "sh", "dash", "zsh", "ksh"].includes(kind)) return [argv[0]!.replaceAll("\\", "/"), ...argv.slice(1)].map(shellQuote).join(" ");
  throw new Error("The new viewer's foreground shell is unqualified; no command was sent");
}

/** Never type an attach command into an editor, REPL, or a child foreground job. */
export function nativeViewerShellCommand(argv: readonly string[], info: unknown): string {
  if (!info || typeof info !== "object") throw new Error("Viewer shell identity is unavailable");
  const value = info as { shell_pid?: unknown; foreground_processes?: Array<{ pid?: unknown; argv?: unknown }> };
  const foreground = value.foreground_processes;
  if (!Number.isSafeInteger(value.shell_pid) || Number(value.shell_pid) <= 0 || !Array.isArray(foreground) || foreground.length !== 1)
    throw new Error("Viewer shell identity is unavailable");
  const current = foreground[0]!;
  if (current.pid !== value.shell_pid || !Array.isArray(current.argv) || typeof current.argv[0] !== "string")
    throw new Error("Viewer foreground is not its shell");
  return nativeViewerCommand(argv, current.argv[0]);
}
