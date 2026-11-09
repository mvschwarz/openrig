import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launcherMismatches, packRelease } from './pack-release.mjs';

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** A repo with an assembled CLI at `version` and a launcher whose four pins are `pins`. */
function fixture(t, version, pins = {}, { assembled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pack-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
  const json = (rel, value) => write(rel, `${JSON.stringify(value, null, 2)}\n`);
  json('package.json', { name: 'fixture', private: true, workspaces: ['packages/cli'] });
  json('packages/cli/package.json', { name: '@openrig/cli', version, files: ['bin.js', 'daemon'] });
  write('packages/cli/bin.js', 'console.log("rig")\n');
  if (assembled) write('packages/cli/daemon/dist/index.js', 'export {}\n');
  json('packages/acp/package.json', { name: '@openrig/acp', version: pins.version ?? version, files: ['bin'],
    dependencies: { '@openrig/cli': pins.dependency ?? version } });
  write('packages/acp/bin/openrig-acp.js', 'console.log("acp")\n');
  json('packages/acp/registry/agent.json', { id: 'openrig', version: pins.listing ?? version,
    distribution: { npx: { package: pins.npx ?? `@openrig/acp@${version}` } } });
  write('packages/acp/registry/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>\n');
  return root;
}

test('the launcher and its listing must carry the CLI version, and a mismatch is named by file and field', t => {
  const root = fixture(t, '0.7.11', { version: '0.7.1', dependency: '0.7.1', listing: '0.7.1', npx: '@openrig/acp@0.7.1' });
  assert.deepEqual(launcherMismatches(root), [
    'packages/acp/package.json "version" is "0.7.1", not "0.7.11"',
    'packages/acp/package.json dependencies["@openrig/cli"] is "0.7.1", not "0.7.11"',
    'packages/acp/registry/agent.json "version" is "0.7.1", not "0.7.11"',
    'packages/acp/registry/agent.json distribution.npx.package is "@openrig/acp@0.7.1", not "@openrig/acp@0.7.11"',
  ]);
  const dest = join(root, 'out');
  assert.throws(() => packRelease(root, dest), /The launcher must match @openrig\/cli 0\.7\.11/);
  assert.equal(existsSync(dest), false);
  assert.deepEqual(launcherMismatches(fixture(t, '0.7.11')), []);
});

test('an unassembled CLI is not packed', t => {
  const root = fixture(t, '0.7.11', {}, { assembled: false });
  assert.throws(() => packRelease(root, join(root, 'out')), /run npm run build:package first/);
});

test('packs both packages at the one version, with exact paths and hashes, and the listing files', t => {
  const root = fixture(t, '0.7.11');
  const dest = join(root, 'out');
  const manifest = packRelease(root, dest);
  assert.deepEqual(manifest.artifacts.map(a => [a.name, a.version, a.path]), [
    ['@openrig/cli', '0.7.11', join(dest, 'openrig-cli-0.7.11.tgz')],
    ['@openrig/acp', '0.7.11', join(dest, 'openrig-acp-0.7.11.tgz')],
  ]);
  for (const a of manifest.artifacts) {
    assert.equal(a.sha256, sha256(a.path));
    assert.equal(a.size, readFileSync(a.path).length);
    assert.match(a.integrity, /^sha512-/);
  }
  assert.deepEqual(manifest.listing.map(l => [l.path, l.sha256]), ['agent.json', 'icon.svg']
    .map(f => join(root, 'packages/acp/registry', f)).map(p => [p, sha256(p)]));
  assert.deepEqual(manifest.publishOrder, ['@openrig/cli', '@openrig/acp', 'ACP registry listing']);
  assert.deepEqual(JSON.parse(readFileSync(join(dest, 'RELEASE-ARTIFACTS.json'), 'utf8')), manifest);
});

test('the pack step never publishes', () => {
  const source = readFileSync(new URL('./pack-release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\['publish'|"publish"|npm publish/);
});
