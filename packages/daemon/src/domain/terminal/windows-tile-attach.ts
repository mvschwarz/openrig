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

export interface WindowsTileTarget { tmux: string; server: string[]; session: string; readOnly: boolean; retrySeconds: number }
/** Decode only this build's exact generated data wrapper, never arbitrary PowerShell. */
export function readWindowsTileAttachArgv(argv: readonly string[]): WindowsTileTarget | null {
  try {
    if (argv.length !== 6 || argv[4] !== '-EncodedCommand') return null;
    const script = Buffer.from(argv[5]!, 'base64').toString('utf16le');
    const match = script.match(/ '([A-Za-z0-9+/]+={0,2})'$/);
    if (!match) return null;
    const value = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8')) as WindowsTileTarget;
    if (!value || typeof value.tmux !== 'string' || !value.tmux || value.tmux.includes('\0')
      || !Array.isArray(value.server) || value.server.some(v => typeof v !== 'string' || v.includes('\0'))
      || typeof value.session !== 'string' || !value.session || /[\x00-\x1f]/.test(value.session)
      || typeof value.readOnly !== 'boolean' || !Number.isSafeInteger(value.retrySeconds) || value.retrySeconds < 0) return null;
    return JSON.stringify(windowsTileAttachArgv(value.tmux, value.server, value.session, value.readOnly, value.retrySeconds)) === JSON.stringify(argv) ? value : null;
  } catch { return null; }
}
