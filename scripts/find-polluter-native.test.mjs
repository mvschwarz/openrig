import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findPolluter } from '../packages/daemon/specs/agents/shared/skills/process/systematic-debugging/find-polluter.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'owned-polluter-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'src', 'nested'), { recursive: true });
  await writeFile(join(cwd, 'src', 'a.test.ts'), '');
  await writeFile(join(cwd, 'src', 'nested', '用户 & name.test.ts'), '');
  return cwd;
}
test('runs sorted literal file arguments without pollution', async t => {
  const cwd = await fixture(t), calls = [];
  assert.equal(await findPolluter(['pollution', 'src/*.test.ts'], { cwd, log() {}, run: async file => { calls.push(file); return true; } }), 0);
  assert.deepEqual(calls, ['./src/a.test.ts', './src/nested/用户 & name.test.ts']);
});
test('stops at pollution even when that test fails', async t => {
  const cwd = await fixture(t), calls = [];
  assert.equal(await findPolluter(['pollution', 'src/*.test.ts'], { cwd, log() {}, run: async file => {
    calls.push(file); await writeFile(join(cwd, 'pollution'), 'owned'); return false;
  } }), 1);
  assert.equal(calls.length, 1);
});
test('failed runs without pollution remain incomplete', async t => {
  const cwd = await fixture(t);
  assert.equal(await findPolluter(['pollution', 'src/*.test.ts'], { cwd, log() {}, run: async () => false }), 2);
});
test('preexisting pollution and empty selection run nothing', async t => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'pollution'), 'preserve');
  const run = () => { throw Error('Must not run'); };
  for (const pattern of ['src/*.test.ts', 'missing/*']) assert.equal(await findPolluter(['pollution', pattern], { cwd, log() {}, run }), 2);
});
test('invalid arguments and patterns return no result', async t => {
  const cwd = await fixture(t);
  for (const args of [[], ['only'], ['', '*'], ['pollution', '[']]) assert.equal(await findPolluter(args, { cwd, log() {} }), 2);
});
test('native npm CLI entry executes without cmd or shell parsing', { skip: process.platform !== 'win32' }, async t => {
  const cwd = await fixture(t), cli = join(cwd, 'npm fixture.cjs');
  await writeFile(cli, `const fs=require('fs');if(process.argv[2]!=='test'||!process.argv[3].startsWith('./src/'))process.exit(9);fs.writeFileSync('pollution',process.argv[3]);`);
  assert.equal(await findPolluter(['pollution', 'src/*.test.ts'], { cwd, log() {}, env: { ...process.env, npm_execpath: cli, PATH: '' } }), 1);
});
test('native selection accepts backslash paths and failed npm execution stays incomplete', { skip: process.platform !== 'win32' }, async t => {
  const cwd = await fixture(t), calls = [];
  assert.equal(await findPolluter(['pollution', '.\\src\\*.test.ts'], { cwd, log() {}, run: async file => { calls.push(file); return true; } }), 0);
  assert.equal(calls.length, 2);
  assert.equal(await findPolluter(['pollution', 'src/*.test.ts'], { cwd, log() {}, env: { ...process.env, npm_execpath: join(cwd, 'missing npm.cjs'), PATH: '' } }), 2);
});
test('native command-line entry returns the polluter exit code with literal arguments', { skip: process.platform !== 'win32' }, async t => {
  const cwd = await fixture(t), cli = join(cwd, 'npm entry 中文.cjs');
  await writeFile(cli, "require('fs').writeFileSync('owned pollution & file',process.argv[3]);");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../packages/daemon/specs/agents/shared/skills/process/systematic-debugging/find-polluter.mjs', import.meta.url)), 'owned pollution & file', 'src/*.test.ts'], {
    cwd, env: { ...process.env, npm_execpath: cli, PATH: '' }, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FOUND POLLUTER: \.\/src\/a\.test\.ts/);
  assert.match(result.stdout, /owned pollution & file/);
});
test('native directory alias executes the entry while importing stays inert', { skip: process.platform !== 'win32' }, async t => {
  const cwd = await fixture(t), home = join(cwd, 'helper home'), alias = join(cwd, 'helper alias');
  await mkdir(home);
  const source = new URL('../packages/daemon/specs/agents/shared/skills/process/systematic-debugging/find-polluter.mjs', import.meta.url);
  await copyFile(source, join(home, 'helper.mjs'));
  await copyFile(new URL('./npm-command.mjs', source), join(home, 'npm-command.mjs'));
  await symlink(home, alias, 'junction');
  const direct = spawnSync(process.execPath, [join(alias, 'helper.mjs')], { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(direct.status, 2, direct.stderr); assert.match(direct.stdout, /Usage:/);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(source.href)})`], { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
});
