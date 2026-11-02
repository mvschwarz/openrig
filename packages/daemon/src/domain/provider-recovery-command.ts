import { fileURLToPath } from "node:url";
import { parseLiteralLaunchWords, powershellQuote, renderWindowsLaunchArgv } from "../adapters/windows-launch.js";
import path from "node:path";

/** An in-place restart already observed the exact native executable and home.
 * Do not resolve a different provider from the operator's later PATH. */
export function pinnedWindowsRecoveryCommand(core: string, executable: string, cwd: string, home: string, observedHome?: string): string {
  if (![executable, cwd, home].every(value => path.win32.isAbsolute(value) && !value.includes("\0"))) throw new Error("Pinned recovery paths must be absolute");
  if (observedHome?.includes("\0")) throw new Error("Invalid observed HOME");
  const argv = parseLiteralLaunchWords(core);
  if (argv[0] !== "codex") throw new Error("Pinned recovery requires a literal Codex command");
  const script = renderWindowsLaunchArgv([executable, ...argv.slice(1)], { CODEX_HOME: home, ...(observedHome === undefined ? {} : { HOME: observedHome }) },
    { beforeStart: `$openrigStart.WorkingDirectory = ${powershellQuote(cwd)}` });
  return "& ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"
    + Buffer.from(script, "utf16le").toString("base64") + "'))))";
}

/** Presentation-only recovery commands: managed launch builders keep their
 * structured transport and must not reparse this PowerShell wrapper. */
export function providerRecoveryCommand(command: string | null): string | null {
  if (!command || process.platform !== "win32" || !/^(?:claude|codex) /.test(command)) return command;
  const argv = parseLiteralLaunchWords(command);
  if (!argv.some(word => word === "" || /['"\r\n]/.test(word))) return command;
  const helper = fileURLToPath(new URL("../../assets/windows-provider-recovery.mjs", import.meta.url));
  const payload = Buffer.from(JSON.stringify(argv), "utf8").toString("base64");
  // Node emits only a base64-encoded script, so PowerShell's native stdout
  // decoding cannot corrupt Unicode paths or provider arguments.
  return `& { $openrigRecovery = & ${powershellQuote(process.execPath)} ${powershellQuote(helper)} ${powershellQuote(payload)}; if ($LASTEXITCODE -ne 0) { throw 'Provider recovery command could not be resolved' }; & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(($openrigRecovery -join ''))))) }`;
}
