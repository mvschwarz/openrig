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
