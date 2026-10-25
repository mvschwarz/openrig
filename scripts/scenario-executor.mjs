// Client-side helpers for the existing scenario scripts; never runs a daemon.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function dockerPlatform(server) {
  if (server?.Os !== 'linux' || !['amd64', 'arm64'].includes(server?.Arch)) {
    throw new Error(`Unsupported Docker server: ${server?.Os}/${server?.Arch}`);
  }
  return `linux/${server.Arch}`;
}

// A client timeout does not establish that its engine-side container stopped.
// Unknown identity or settlement leaves the container for its owner to reconcile.
export function settleContainer({ id, name, image }, invoke = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
  return result.stdout;
}) {
  if (!/^[a-f0-9]{64}$/.test(id) || !/^sha256:[a-f0-9]{64}$/.test(image) || !name) {
    throw new Error('Exact created container ID, name and image ID required');
  }
  const inspect = () => {
    const objects = JSON.parse(invoke(['inspect', id]));
    const object = objects[0];
    if (objects.length !== 1 || object.Id !== id || object.Name !== '/' + name || object.Image !== image) {
      throw new Error('Container identity unknown; retained');
    }
    return object.State;
  };
  let state = inspect();
  if (state.Running === true) {
    // Explicit TERM has no automatic KILL escalation. A failed wait retains it.
    invoke(['kill', '--signal', 'TERM', id]);
    invoke(['wait', id]);
    state = inspect();
  }
  if (state.Running !== false || !['created', 'exited'].includes(state.Status)) {
    throw new Error('Container not confirmed stopped; retained');
  }
  invoke(['rm', id]);
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
    } else if (operation === 'settle') {
      const [cidFile, name, image] = args;
      settleContainer({ id: readFileSync(cidFile, 'utf8').trim(), name, image });
      unlinkSync(cidFile);
    } else if (operation === 'timeout') {
      process.exitCode = await runWithDeadline(args.slice(1), { timeoutMs: Number(args[0]) * 1000 });
    } else {
      throw new Error('Expected platform, settle <cid-file> <name> <image-id>, or timeout <seconds> <command> [args...]');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
