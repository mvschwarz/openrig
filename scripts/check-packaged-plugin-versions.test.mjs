import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
