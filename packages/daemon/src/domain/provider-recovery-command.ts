import { fileURLToPath } from "node:url";
import { parseLiteralLaunchWords, powershellQuote } from "../adapters/windows-launch.js";

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
