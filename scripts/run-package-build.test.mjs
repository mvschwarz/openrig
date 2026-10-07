import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageBuildShell } from './run-package-build.mjs';
test('native packaging chooses Git Bash without selecting the WSL system launcher', () => {
  assert.equal(packageBuildShell('win32', { ProgramFiles: 'C:\\Program Files' }, file => file === 'C:\\Program Files\\Git\\bin\\bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.throws(() => packageBuildShell('win32', {}, () => false), /requires Git for Windows/);
  assert.equal(packageBuildShell('linux', {}, () => false), 'bash');
});
