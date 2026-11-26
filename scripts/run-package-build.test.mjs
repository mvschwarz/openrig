import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageBuildShell } from './run-package-build.mjs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
test('native packaging chooses Git Bash without selecting the WSL system launcher', () => {
  assert.equal(packageBuildShell('win32', { ProgramFiles: 'C:\\Program Files' }, file => file === 'C:\\Program Files\\Git\\bin\\bash.exe'), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.throws(() => packageBuildShell('win32', {}, () => false), /requires Git for Windows/);
  assert.equal(packageBuildShell('linux', {}, () => false), 'bash');
});

test('native package-build entry executes through a directory junction and imports stay inert', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'openrig build entry 用户-'));
  const source = join(root, 'package # source'), alias = join(root, 'linked package');
  const programs = join(root, 'owned-programs'), bin = join(programs, 'Git', 'bin');
  try {
    await mkdir(join(source, 'scripts'), { recursive: true }); await mkdir(bin, { recursive: true });
    await copyFile(resolve('scripts/run-package-build.mjs'), join(source, 'scripts', 'run-package-build.mjs'));
    // Stand in for Git Bash with an owned Node executable. The .sh file here
    // contains only a JS recorder, not package builds, npm calls or installs.
    await copyFile(process.execPath, join(bin, 'bash.exe'));
    await writeFile(join(source, 'scripts', 'build-package.sh'), "require('node:fs').writeFileSync(process.env.OPENRIG_TEST_BUILD_WITNESS,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));");
    await symlink(source, alias, 'junction');
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (['PROGRAMFILES', 'PROGRAMW6432'].includes(name.toUpperCase())) delete env[name];
    env.ProgramFiles = programs;
    let sequence = 0;
    for (const folder of [source, alias]) for (const flags of [[], ['--preserve-symlinks-main']]) {
      const marker = join(root, `called-${sequence++}.json`);
      const entry = join(folder, 'scripts', 'run-package-build.mjs');
      const result = spawnSync(process.execPath, [...flags, entry], { env: { ...env, OPENRIG_TEST_BUILD_WITNESS: marker }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(marker), true, `entry returned without running build: ${entry}; flags=${flags}`);
      const called = JSON.parse(await readFile(marker, 'utf8'));
      assert.equal(await realpath(called.cwd), await realpath(source));
      assert.deepEqual(called.args, []);
      const importedMarker = join(root, `imported-${sequence}.json`);
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv.length=1; await import(${JSON.stringify(pathToFileURL(entry).href)});`], {
        env: { ...env, OPENRIG_TEST_BUILD_WITNESS: importedMarker }, encoding: 'utf8', windowsHide: true, timeout: 10000,
      });
      assert.equal(imported.status, 0, imported.stderr); assert.equal(existsSync(importedMarker), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
