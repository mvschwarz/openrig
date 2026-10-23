import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';

// Exercise startup's real refresh in the existing restart case's disposable HOME.
export async function preserveRefresh(daemon, home, rigBin) {
  const plugin = join(home, 'plugins/openrig-core');
  const recovery = join(home, 'backups/managed-refresh');
  const shipped = join(dirname(rigBin), '../daemon/assets/plugins/openrig-core');
  const edited = Buffer.from([0xff, 0, ...Buffer.from('unique owner edit\r\n')]);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = dir => readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  const snapshot = () => Object.fromEntries(files(plugin).sort()
    .map(file => [relative(plugin, file), sha(readFileSync(file))]));

  await daemon.sigterm();
  writeFileSync(join(plugin, 'README.md'), edited);
  for (const harness of ['.claude-plugin', '.codex-plugin']) {
    const path = join(plugin, harness, 'plugin.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...manifest, version: '0.0.1' }));
  }
  const before = snapshot();
  mkdirSync(recovery, { recursive: true });
  chmodSync(recovery, 0o500); // Non-root fixture: fail backup before any target write.
  try {
    await daemon.restart();
    assert.deepEqual(snapshot(), before, 'failed backup changed plugin bytes/version');
    assert.ok(readFileSync(join(home, 'daemon.log'), 'utf8').split('\n').some(line =>
      line.includes(`preservation failed for ${plugin}:`) && line.includes('refresh skipped')),
    'missing skipped-refresh warning for this plugin');
  } finally {
    chmodSync(recovery, 0o700);
  }
  await daemon.restart();
  const backup = files(recovery).find(file => readFileSync(file).equals(edited));
  assert.ok(backup, 'refresh lost the exact binary edit');
  assert.deepEqual(readFileSync(join(plugin, 'README.md')), readFileSync(join(shipped, 'README.md')));
  const version = dir => JSON.parse(readFileSync(join(dir, '.claude-plugin/plugin.json'), 'utf8')).version;
  assert.equal(version(plugin), version(shipped), 'managed version did not advance');
  assert.notEqual(version(plugin), '0.0.1');
  return { failedBackupUnchanged: true, editedSha256: sha(edited), backedUpSha256: sha(readFileSync(backup)),
    targetFilesChecked: Object.keys(before).length, version: version(plugin), shippedVersion: version(shipped) };
}
