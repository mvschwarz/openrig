import { windowsPowerShell } from "../windows-executables.js";
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { powershellQuote, renderWindowsLaunchArgv } from '../../adapters/windows-launch.js';
import { bindNativeSessionName, nativeSessionNameMayBeLegacy } from './native-session-name.js';

/** Execute the remote POSIX command as one SSH argument, without a local sh. */
export function windowsSshTileAttachArgv(destination: string, command: string, ssh = 'ssh'): string[] {
  if (!destination || destination.startsWith('-') || [destination, command, ssh].some(value => value.includes('\0'))) throw new Error('Invalid SSH tile target');
  const payload = Buffer.from(JSON.stringify({ destination, command, ssh }), 'utf8').toString('base64');
  const code = '# OpenRig SSH tile ' + payload + '\n' + renderWindowsLaunchArgv([ssh, '-t', destination, command]) + '\nexit $LASTEXITCODE';
  return [windowsPowerShell(),
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')];
}

/** Admit only exact generated native local or SSH wrappers to the Herdr argv path. */
export function isWindowsTileAttachArgv(argv: readonly string[]): boolean {
  if (readWindowsTileAttachArgv(argv)) return true;
  try {
    if (argv.length !== 6 || argv[4] !== '-EncodedCommand') return false;
    const match = Buffer.from(argv[5]!, 'base64').toString('utf16le').match(/^# OpenRig SSH tile ([A-Za-z0-9+/]+={0,2})\n/);
    if (!match) return false;
    const value = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8'));
    if (!value || ['destination', 'command', 'ssh'].some(key => typeof value[key] !== 'string')) return false;
    return JSON.stringify(windowsSshTileAttachArgv(value.destination, value.command, value.ssh)) === JSON.stringify(argv);
  } catch { return false; }
}

/** A short data-only tile command; the installed helper owns reattachment. */
export function windowsTileAttachArgv(tmux: string, server: readonly string[], session: string, readOnly: boolean, retrySeconds = 30, attachOnly = false, gate?: { path: string; until: number; expired: string }): string[] {
  const helper=fileURLToPath(new URL('../../../assets/terminal/windows-tile-attach.ps1',import.meta.url));
  const binding = bindNativeSessionName(session);
  const payload=Buffer.from(JSON.stringify({tmux,server,session,readOnly,retrySeconds,...(gate ? { gate } : {}),...(attachOnly ? { attachOnly: true } : {}),
    ...(binding.marker ? { nativeBinding: { physical: binding.physical, marker: binding.marker, legacy: nativeSessionNameMayBeLegacy(session) } } : {})}), 'utf8').toString('base64');
  const code="& ([ScriptBlock]::Create([IO.File]::ReadAllText("+powershellQuote(helper)+"))) "+powershellQuote(payload);
  return [windowsPowerShell(),
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')];
}

export interface WindowsTileTarget { tmux: string; server: string[]; session: string; readOnly: boolean; retrySeconds: number; attachOnly?: boolean; gate?: { path: string; until: number; expired: string } }
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
      || typeof value.readOnly !== 'boolean' || !Number.isSafeInteger(value.retrySeconds) || value.retrySeconds < 0
      || (value.attachOnly !== undefined && typeof value.attachOnly !== 'boolean')) return null;
    if (value.gate && (typeof value.gate.path !== "string" || !win32.isAbsolute(value.gate.path) || value.gate.path.includes("\0") || !Number.isFinite(value.gate.until) || typeof value.gate.expired !== "string")) return null;
    return JSON.stringify(windowsTileAttachArgv(value.tmux, value.server, value.session, value.readOnly, value.retrySeconds, value.attachOnly, value.gate)) === JSON.stringify(argv)
      ? { tmux: value.tmux, server: value.server, session: value.session, readOnly: value.readOnly, retrySeconds: value.retrySeconds, ...(value.attachOnly ? { attachOnly: true } : {}), ...(value.gate ? { gate: value.gate } : {}) } : null;
  } catch { return null; }
}
