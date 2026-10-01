// Client-side helpers for the existing scenario scripts; never runs a daemon.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function dockerPlatform(server) {
  if (server?.Os !== 'linux' || !['amd64', 'arm64'].includes(server?.Arch)) {
    throw new Error(`Unsupported Docker server: ${server?.Os}/${server?.Arch}`);
  }
  return `linux/${server.Arch}`;
}

export async function runWithDeadline(argv, { timeoutMs, killAfterMs = 15000 }) {
  if (!argv.length || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || killAfterMs <= 0) {
    throw new Error('Command and positive finite deadline required');
  }
  return new Promise(resolveResult => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', detached: true });
    let forced, escalation, finished = false;
    const signalChild = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const terminate = code => {
      if (forced !== undefined) return;
      forced = code;
      signalChild('SIGTERM');
      escalation = setTimeout(() => signalChild('SIGKILL'), killAfterMs);
    };
    const timeout = setTimeout(() => terminate(124), timeoutMs);
    const interrupt = () => terminate(130);
    const shutdown = () => terminate(143);
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', shutdown);
    const finish = code => {
      if (finished) return;
      finished = true;
      if (forced !== undefined) signalChild('SIGKILL');
      clearTimeout(timeout); clearTimeout(escalation);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', shutdown);
      resolveResult(forced ?? code);
    };
    child.once('error', error => {
      console.error(`Cannot run ${argv[0]}: ${error.message}`);
      finish(127);
    });
    child.once('close', (code, signal) => finish(code ?? (128 + (constants.signals[signal] ?? 0))));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    if (operation === 'platform') {
      const version = spawnSync('docker', ['version', '--format', '{{json .Server}}'], { encoding: 'utf8', timeout: 30000 });
      if (version.error || version.status !== 0) throw new Error(version.error?.message ?? version.stderr);
      const server = JSON.parse(version.stdout);
      const platform = dockerPlatform(server);
      if (args[0]) writeFileSync(args[0], JSON.stringify({ platform, server }, null, 2) + '\n');
      console.log(platform);
    } else if (operation === 'timeout') {
      process.exitCode = await runWithDeadline(args.slice(1), { timeoutMs: Number(args[0]) * 1000 });
    } else {
      throw new Error('Expected platform [receipt-path] or timeout <seconds> <command> [args...]');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
