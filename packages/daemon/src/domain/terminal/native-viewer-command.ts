import path from "node:path";
import { powershellQuote, renderWindowsLaunchArgv } from "../../adapters/windows-launch.js";
import { windowsArguments } from "../../adapters/windows-argv.js";
import { isWindowsTileAttachArgv } from "./windows-tile-attach.js";
import { shellQuote } from "../../adapters/shell-quote.js";
import { randomUUID } from "node:crypto";
import { createPrivateTextFile } from "../private-text-file.js";
import { ensureWindowsPrivateDirectory } from "../windows-owned-text.js";

/** A newly attributed viewer may run only through an observed supported shell. */
export function nativeViewerCommand(argv: readonly string[], shell: string, stageDirectory?: string): string {
  if (!argv.length || argv.some(v => v.includes("\0"))) throw new Error("Invalid viewer argv");
  const kind = path.win32.basename(shell).toLowerCase().replace(/\.exe$/, "");
  if (["powershell", "pwsh", "cmd"].includes(kind)) {
    const canonical = isWindowsTileAttachArgv(argv);
    const script = renderWindowsLaunchArgv(argv, {}, { beforeStart: "$openrigStart.WorkingDirectory = (Get-Location).ProviderPath" });
    if (kind !== "cmd") {
      if (canonical) return "& " + argv.map(powershellQuote).join(" ");
      return "& ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"
        + Buffer.from(script, "utf16le").toString("base64") + "'))))";
    }
    // Keep data out of cmd's percent/delayed expansion and operator parser.
    const launch = canonical ? argv : [path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script + "\nexit $global:LASTEXITCODE", "utf16le").toString("base64")];
    if (/[\"%!\r\n]/.test(launch[0]!)) throw new Error("Viewer executable cannot be represented safely by cmd");
    const command = windowsArguments(launch);
    if (command.length > 8190) {
      if (!stageDirectory || process.platform !== "win32" || !path.win32.isAbsolute(stageDirectory)) throw new Error("Viewer command exceeds cmd's input limit without an owned staging directory");
      const file = path.join(stageDirectory, `openrig-viewer-command-${randomUUID()}.ps1`);
      // Load once, then remove before launching the foreground child. If dispatch
      // is uncertain the private file remains with the viewer's attribution;
      // callers must not repeat pane run merely because no readback arrived.
      const bootstrap = "$ErrorActionPreference = 'Stop'; $openrigViewerStagedScript = [IO.File]::ReadAllText(" + powershellQuote(file)
        + "); Remove-Item -LiteralPath " + powershellQuote(file)
        + " -ErrorAction Stop; & ([ScriptBlock]::Create($openrigViewerStagedScript)); exit $global:LASTEXITCODE";
      const staged = windowsArguments([path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")]);
      if (staged.length > 8190) throw new Error("Viewer staging path exceeds cmd's input limit");
      ensureWindowsPrivateDirectory(stageDirectory);
      createPrivateTextFile(file, script);
      return staged;
    }
    return command;
  }
  if (["bash", "sh", "dash", "zsh", "ksh"].includes(kind)) return [argv[0]!.replaceAll("\\", "/"), ...argv.slice(1)].map(shellQuote).join(" ");
  throw new Error("The new viewer's foreground shell is unqualified; no command was sent");
}

/** Never type an attach command into an editor, REPL, or a child foreground job. */
export function nativeViewerShellCommand(argv: readonly string[], info: unknown, stageDirectory?: string): string {
  if (!info || typeof info !== "object") throw new Error("Viewer shell identity is unavailable");
  const value = info as { shell_pid?: unknown; foreground_processes?: Array<{ pid?: unknown; argv?: unknown }> };
  const foreground = value.foreground_processes;
  if (!Number.isSafeInteger(value.shell_pid) || Number(value.shell_pid) <= 0 || !Array.isArray(foreground) || foreground.length !== 1)
    throw new Error("Viewer shell identity is unavailable");
  const current = foreground[0]!;
  if (current.pid !== value.shell_pid || !Array.isArray(current.argv) || typeof current.argv[0] !== "string")
    throw new Error("Viewer foreground is not its shell");
  return nativeViewerCommand(argv, current.argv[0], stageDirectory);
}
