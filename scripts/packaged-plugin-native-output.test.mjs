import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

test('native plugin snapshot publication supports a long output basename and preserves it on failure', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-native-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'input'), pkg = join(input, 'package');
  const plugin = join(pkg, 'daemon/assets/plugins/owned/.claude-plugin');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'plugin.json'), '{"name":"owned","version":"0.1.0"}');
  writeFileSync(join(pkg, 'package.json'), '{"version":"0.1.0"}');
  const archive = join(root, 'owned.tgz');
  execFileSync('tar', ['-czf', archive, '-C', input, 'package'], { windowsHide: true });
  const output = join(root, 's'.repeat(245) + '.json');
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('./check-packaged-plugin-versions.mjs', import.meta.url)), archive,
    '--snapshot', '--out', output], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const bytes = readFileSync(output); assert.equal(JSON.parse(bytes).plugins.owned.version, '0.1.0');
  assert.equal(run().status, 0);
  rmSync(archive); assert.notEqual(run().status, 0);
  assert.deepEqual(readFileSync(output), bytes);
  assert.deepEqual(readdirSync(root).sort(), ['input', 's'.repeat(245) + '.json'].sort());
});
