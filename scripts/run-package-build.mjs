import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function packageBuildShell(platform, env, exists = existsSync) {
  if (platform !== 'win32') return 'bash';
  for (const root of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files'].filter(Boolean)) {
    const candidate = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (exists(candidate)) return candidate;
  }
  throw new Error('Native Windows packaging requires Git for Windows (Git Bash); WSL bash is not a native build shell.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync(packageBuildShell(process.platform, process.env), ['scripts/build-package.sh'],
    { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error('Package build shell could not be started.');
  process.exitCode = result.status ?? 1;
}
