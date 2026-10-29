import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { powershellQuote } from '../../adapters/windows-launch.js';

/** A short data-only tile command; the installed helper owns reattachment. */
export function windowsTileAttachArgv(tmux: string, server: readonly string[], session: string, readOnly: boolean, retrySeconds = 30): string[] {
  const helper=fileURLToPath(new URL('../../../assets/terminal/windows-tile-attach.ps1',import.meta.url));
  const payload=Buffer.from(JSON.stringify({tmux,server,session,readOnly,retrySeconds}), 'utf8').toString('base64');
  const code="& ([ScriptBlock]::Create([IO.File]::ReadAllText("+powershellQuote(helper)+"))) "+powershellQuote(payload);
  return [win32.join(process.env.SystemRoot ?? 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')];
}
