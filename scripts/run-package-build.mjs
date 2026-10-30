import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function packageBuildShell(platform, env, exists = existsSync) {
  if (platform !== 'win32') return 'bash';
  for (const root of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files'].filter(Boolean)) {
    const candidate = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (exists(candidate)) return candidate;
  }
  throw new Error('Native Windows packaging requires Git for Windows (Git Bash); WSL bash is not a native build shell.');
}
let invokedDirectly = false;
try { invokedDirectly = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
catch { /* Imported without an existing entry file. */ }
if (invokedDirectly) {
  const result = spawnSync(packageBuildShell(process.platform, process.env), ['scripts/build-package.sh'],
    { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error('Package build shell could not be started.');
  process.exitCode = result.status ?? 1;
}
