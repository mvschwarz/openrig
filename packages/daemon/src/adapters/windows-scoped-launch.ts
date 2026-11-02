import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { parseWindowsCommandLine, windowsArguments } from "./windows-argv.js";
import { powershellQuote as q } from "./windows-launch.js";

/** A private bootstrap replaces the inherited server environment before starting the user's shell. */
export function windowsScopedLaunch(shell: string, command: string, selected: Readonly<Record<string, string | undefined>>, file: string, inheritEnvironment = false): { content: string; argv: string[] } {
  const words = existsSync(shell) ? [shell] : parseWindowsCommandLine(shell);
  const executable = words.shift();
  if (!executable) throw new Error("Default shell unavailable");
  const kind = win32.basename(executable).toLowerCase().replace(/\.exe$/, "");
  const powershell = ["powershell", "pwsh"].includes(kind);
  if (!["powershell", "pwsh", "cmd", "bash", "sh", "dash", "zsh", "ksh", "fish"].includes(kind)) throw new Error("Unsupported native scoped shell");
  // cmd parses its /c tail as shell syntax, not as a CRT argv word. /s
  // removes the enclosing pair while preserving the command's own quotes.
  const args = kind === "cmd" && command
    ? `${windowsArguments(words)} /s /c "${command}"`
    : windowsArguments(command ? [...words, powershell ? "-Command" : "-c", command] : words);
  const env = new Map<string, [string, string]>();
  for (const [key, value] of Object.entries(selected)) {
    if (!key || /[=\0]/.test(key) || value?.includes("\0")) throw new Error("Invalid environment entry");
    if (value !== undefined) env.set(key.toUpperCase(), [key, value]);
    else env.delete(key.toUpperCase());
  }
  const paneKeys = ["TMUX", "TMUX_PANE", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "SHELL", "PSMUX_SESSION", "PSMUX_SOCKET_NAME", "PSMUX_TARGET_SESSION", "PSMUX_SOCKET_PATH", "PSMUX_DATA_DIR"];
  for (const key of paneKeys) env.delete(key);
  const content = `$ErrorActionPreference='Stop'\n$p=New-Object Diagnostics.ProcessStartInfo\n$p.UseShellExecute=$false\n$p.FileName=${q(executable)}\n$p.Arguments=${q(args)}\n$p.WorkingDirectory=(Get-Location).ProviderPath\n${inheritEnvironment ? "" : "$p.EnvironmentVariables.Clear()\n"}`
    + [...env.values()].map(([key, value]) => `$p.EnvironmentVariables[${q(key)}]=${q(value)}\n`).join("")
    + paneKeys.map(key => `$v=[Environment]::GetEnvironmentVariable(${q(key)},'Process'); if ($null -ne $v) {$p.EnvironmentVariables[${q(key)}]=$v}\n`).join("")
    + `$child=[Diagnostics.Process]::Start($p)\ntry {$child.WaitForExit(); exit $child.ExitCode} finally {$child.Dispose()}\n`;
  const root = process.env.SystemRoot;
  if (!root) throw new Error("Windows system root unavailable");
  const loader = `$s=[IO.File]::ReadAllText(${q(file)}); Remove-Item -LiteralPath ${q(file)} -ErrorAction Stop; & ([ScriptBlock]::Create($s))`;
  return { content, argv: [win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(loader, "utf16le").toString("base64")] };
}
