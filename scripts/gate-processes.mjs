import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';

export function snapshotGateProcesses({ platform = process.platform, env = process.env, execute = execFileSync } = {}) {
  try {
    let processes;
    const options = { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    if (platform === 'win32') {
      const shell = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);ConvertTo-Json -Compress -InputObject @(Get-Process | Select-Object @{n='pid';e={$_.Id}},@{n='command';e={$_.ProcessName}})";
      processes = JSON.parse(execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], options).replace(/^\uFEFF/, ''));
    } else {
      const text = execute('ps', ['-eo', 'pid=,comm='], options);
      processes = text.trim() ? text.trim().split(/\r?\n/).map(line => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) throw Error('Invalid process census');
        return { pid: Number(match[1]), command: match[2] };
      }) : [];
    }
    // Windows includes the System Idle Process with PID 0.
    if (!Array.isArray(processes) || processes.some(p => !Number.isSafeInteger(p?.pid) || p.pid < 0 || typeof p.command !== 'string' || !p.command)) throw Error('Invalid process census');
    return { status: 'available', processes };
  } catch {
    // Process arguments and platform errors can contain private data. Keep the
    // advisory factual without publishing their bodies into the gate receipt.
    return { status: 'unavailable', processes: null };
  }
}
