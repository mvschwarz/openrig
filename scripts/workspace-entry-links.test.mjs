import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'openrig workspace entry 用户-'));
  const source = join(root, 'package # source'), alias = join(root, 'linked package');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, source, alias };
}

test('workspace preparation executes through linked roots and derives its actual help artifact', async () => {
  const f = await fixture();
  try {
    await copyFile(resolve('scripts/prepare-workspace-build.mjs'), join(f.source, 'scripts/prepare-workspace-build.mjs'));
    for (const dir of ['packages/cli/dist', 'packages/cli/src/schemas', 'packages/cli/src/lib/scope-templates']) await mkdir(join(f.source, dir), { recursive: true });
    for (const [file, bytes] of Object.entries({
      LICENSE: 'owned license', 'README.md': 'owned readme', 'packages/cli/package.json': '{"type":"module"}',
      'packages/cli/dist/bin-wrapper.js': '// owned entry', 'packages/cli/src/schemas/owned.json': '{}',
      'packages/cli/src/lib/scope-templates/owned.md': '# Owned',
      'packages/cli/dist/index.js': "export function createProgram(){let output;return {configureHelp(){return this},configureOutput(value){output=value;return this},outputHelp(){output.writeOut('owned complete help\\n')}}}",
    })) await writeFile(join(f.source, file), bytes);
    const output = join(f.source, 'packages/cli/dist/root-help.txt');
    for (const flags of [[], ['--preserve-symlinks-main']]) {
      const entry = join(f.alias, 'scripts/prepare-workspace-build.mjs');
      const run = spawnSync(process.execPath, [...flags, entry, 'cli'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(output), true, 'entry returned without preparing its workspace');
      assert.equal(await readFile(output, 'utf8'), 'owned complete help\n');
      assert.equal(await readFile(join(f.source, 'packages/cli/LICENSE'), 'utf8'), 'owned license');
      await rm(output);
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv.length=1;await import(${JSON.stringify(pathToFileURL(entry).href)});`], { encoding: 'utf8', windowsHide: true });
      assert.equal(imported.status, 0, imported.stderr); assert.equal(existsSync(output), false);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('first-run reference guard actually reports missing fixture surfaces through linked roots', async () => {
  const f = await fixture();
  try {
    await copyFile(resolve('scripts/check-first-run-references.mjs'), join(f.source, 'scripts/check-first-run-references.mjs'));
    await symlink(resolve('node_modules'), join(f.source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const flags of [[], ['--preserve-symlinks-main']]) {
      const entry = join(f.alias, 'scripts/check-first-run-references.mjs');
      const run = spawnSync(process.execPath, [...flags, entry], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      assert.equal(run.status, 1, run.stderr); assert.match(run.stdout + run.stderr, /First-run references:/);
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv.length=1;await import(${JSON.stringify(pathToFileURL(entry).href)});`], { encoding: 'utf8', windowsHide: true });
      assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout + imported.stderr, '');
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const [script, args, status, diagnostic] of [
  ['check-packaged-plugin-versions.mjs', [], 1, /usage: check-packaged-plugin-versions/],
  ['scenario-executor.mjs', ['owned-invalid-operation'], 2, /Expected platform, settle/],
  ['gate-lane-consume.mjs', ['missing-owned-verdict.json'], 1, /verdict is missing/],
]) test(`${script} refuses invalid fixture input through linked roots instead of silently succeeding`, async () => {
  const f = await fixture();
  try {
    await copyFile(resolve('scripts', script), join(f.source, 'scripts', script));
    if (script === 'check-packaged-plugin-versions.mjs') {
      await mkdir(join(f.source, 'scripts/fixtures'));
      await copyFile(resolve('scripts/fixtures/packaged-plugins-last-release.json'), join(f.source, 'scripts/fixtures/packaged-plugins-last-release.json'));
    }
    if (script === 'gate-lane-consume.mjs') {
      for (const argv of [['init', '-q'], ['-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@openrig.invalid', 'commit', '--allow-empty', '-qm', 'owned fixture']]) {
        const git = spawnSync('git', argv, { cwd: f.source, encoding: 'utf8', windowsHide: true });
        assert.equal(git.status, 0, git.stderr);
      }
    }
    for (const flags of [[], ['--preserve-symlinks-main']]) {
      const entry = join(f.alias, 'scripts', script);
      const run = spawnSync(process.execPath, [...flags, entry, ...args], { cwd: f.source, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      assert.equal(run.status, status, run.stderr); assert.match(run.stderr, diagnostic);
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv.length=1;await import(${JSON.stringify(pathToFileURL(entry).href)});`], { encoding: 'utf8', windowsHide: true });
      assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout + imported.stderr, '');
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
