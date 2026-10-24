import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPackagedPluginVersions, snapshotPlugins } from './check-packaged-plugin-versions.mjs';

test('changed packaged plugin content requires a strictly newer version', t => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-version-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = join(dir, 'daemon/assets/plugins/core');
  mkdirSync(join(plugin, 'skills'), { recursive: true });
  const version = (value, codex = value) => {
    for (const [harness, v] of [['.claude-plugin', value], ['.codex-plugin', codex]]) {
      mkdirSync(join(plugin, harness), { recursive: true });
      writeFileSync(join(plugin, harness, 'plugin.json'), JSON.stringify({ name: 'core', version: v }));
    }
  };
  version('0.1.9');
  writeFileSync(join(plugin, 'skills/SKILL.md'), 'released');
  const baseline = { release: 'previous', plugins: snapshotPlugins(dir) };
  assert.deepEqual(checkPackagedPluginVersions(dir, baseline), baseline.plugins);
  assert.throws(() => checkPackagedPluginVersions(dir, { plugins: {} }), /no packaged plugins/);

  writeFileSync(join(plugin, 'skills/SKILL.md'), 'changed');
  assert.throws(() => checkPackagedPluginVersions(dir, baseline), /not greater than 0\.1\.9/);
  version('0.1.8');
  assert.throws(() => checkPackagedPluginVersions(dir, baseline), /not greater/);
  version('0.1.10'); // Numeric ordering, not lexical ordering.
  assert.equal(checkPackagedPluginVersions(dir, baseline).core.version, '0.1.10');

  version('0.1.9');
  writeFileSync(join(plugin, 'skills/SKILL.md'), 'released');
  writeFileSync(join(plugin, 'new-hook.js'), 'new');
  assert.throws(() => checkPackagedPluginVersions(dir, baseline), /not greater/);
  rmSync(join(plugin, 'new-hook.js'));
  rmSync(join(plugin, 'skills/SKILL.md'));
  assert.throws(() => checkPackagedPluginVersions(dir, baseline), /not greater/);
  symlinkSync('first', join(plugin, 'skills/SKILL.md'));
  const linked = { release: 'previous', plugins: snapshotPlugins(dir) };
  rmSync(join(plugin, 'skills/SKILL.md'));
  symlinkSync('second', join(plugin, 'skills/SKILL.md'));
  assert.throws(() => checkPackagedPluginVersions(dir, linked), /not greater/);
  version('0.1.10', '0.1.9');
  assert.throws(() => checkPackagedPluginVersions(dir, baseline), /versions disagree/);
  version('0.1.10-preview');
  assert.throws(() => checkPackagedPluginVersions(dir, baseline), /invalid numeric/);
  rmSync(plugin, { recursive: true });
  assert.throws(() => checkPackagedPluginVersions(dir, baseline), /plugin missing/);
});

test('plugin roots and consumed manifests are not followed through links', t => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-link-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'package/daemon/assets/plugins');
  const plugin = join(root, 'core');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  const outside = join(dir, 'manifest.json');
  writeFileSync(outside, JSON.stringify({ version: '0.1.9' }));
  symlinkSync(outside, join(plugin, '.claude-plugin/plugin.json'));
  assert.throws(() => snapshotPlugins(join(dir, 'package')), /regular file/);
  rmSync(plugin, { recursive: true });
  symlinkSync(dir, plugin);
  assert.throws(() => snapshotPlugins(join(dir, 'package')), /directory/);
  rmSync(plugin);
  rmSync(join(dir, 'package/daemon/assets/plugins'), { recursive: true });
  symlinkSync(dir, root);
  assert.throws(() => snapshotPlugins(join(dir, 'package')), /directory/);
});

test('documented CLI snapshot refresh preserves the old fixture on failure', t => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-refresh-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = 'scripts/fixtures/packaged-plugins-last-release.json';
  mkdirSync(join(dir, 'scripts/fixtures'), { recursive: true });
  for (const rel of ['scripts/check-packaged-plugin-versions.mjs', fixture]) {
    copyFileSync(new URL('../' + rel, import.meta.url), join(dir, rel));
  }
  const pkg = join(dir, 'input/package');
  mkdirSync(join(pkg, 'daemon/assets/plugins/core/.claude-plugin'), { recursive: true });
  writeFileSync(join(pkg, 'daemon/assets/plugins/core/.claude-plugin/plugin.json'), '{"version":"0.1.18"}');
  writeFileSync(join(pkg, 'package.json'), '{"version":"0.7.1"}');
  execFileSync('tar', ['-czf', join(dir, 'release.tgz'), '-C', join(dir, 'input'), 'package']);
  const source = readFileSync(new URL('./check-packaged-plugin-versions.mjs', import.meta.url), 'utf8');
  const command = source.slice(source.indexOf('// node scripts/'), source.indexOf('// Check an exact candidate'))
    .trim().split('\n').map(line => line.replace(/^\/\/ ?/, '')).join('\n');
  const run = () => spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
  assert.equal(run().status, 0, 'documented refresh must generate a usable replacement');
  const refreshed = readFileSync(join(dir, fixture));
  assert.equal(JSON.parse(refreshed).plugins.core.version, '0.1.18');
  assert.equal(JSON.parse(refreshed).release, '0.7.1');
  rmSync(join(dir, 'release.tgz'));
  assert.notEqual(run().status, 0);
  assert.deepEqual(readFileSync(join(dir, fixture)), refreshed, 'failed generation must retain the previous baseline');
  rmSync(join(pkg, 'package.json'));
  writeFileSync(join(dir, 'metadata.json'), '{"version":"0.7.1"}');
  symlinkSync(join(dir, 'metadata.json'), join(pkg, 'package.json'));
  execFileSync('tar', ['-czf', join(dir, 'release.tgz'), '-C', join(dir, 'input'), 'package']);
  const linked = run();
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /package.json: expected a regular file/);
  assert.deepEqual(readFileSync(join(dir, fixture)), refreshed);
});
