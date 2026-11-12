import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { baselineNotice, installTagMismatches, launcherMismatches, openrigPluginMismatches, packRelease, releaseBaseline } from './pack-release.mjs';
import { snapshotPlugins } from './check-packaged-plugin-versions.mjs';

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

const MANIFESTS = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json'];

/** A repo with an assembled CLI at `version` and a launcher whose four pins are `pins`. Its openrig plugin carries
 *  `plugin.source` in source and `plugin.assembled` in the assembled CLI (both `version` by default), and its baseline is
 *  the published `baseline.release` (0.7.10 by default) with openrig-core's `baseline.core` bytes. Its install pages
 *  link the rigs skill and the install script at `pages.tag` in source and `pages.assembled` in the assembled CLI (both
 *  this release's tag by default). */
function fixture(t, version, pins = {}, { assembled = true, plugin = {}, baseline = {}, pages = {} } = {}) {
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
  const skill = tag => `npx skills add https://github.com/mvschwarz/openrig/tree/${tag}/skills/rigs --skill rigs --agent codex\n`;
  const script = tag => `curl -fsSL https://raw.githubusercontent.com/mvschwarz/openrig/${tag}/scripts/install.sh | sh\n`;
  const reference = (dir, tag) => {
    write(`${dir}/getting-started.md`, `# Getting started\n\n${skill(tag).replace(/(https:\S+)/, '"$1"')}${script(tag)}`);
    write(`${dir}/quickstart.md`, `# Quickstart\n\n${skill(tag)}`);
  };
  const tag = pages.tag ?? `v${version}`;
  write('README.md', `# OpenRig\n\n${skill(tag)}${script(tag)}`);
  reference('docs/reference', tag);
  if (assembled) reference('packages/cli/daemon/docs/reference', pages.assembled ?? tag);
  const plugins = (dir, openrig, core) => {
    for (const rel of MANIFESTS) json(`${dir}/openrig/${rel}`, { name: 'openrig', version: openrig });
    write(`${dir}/openrig/skills/team/SKILL.md`, '# team\n');
    for (const rel of MANIFESTS.slice(1, 3)) json(`${dir}/openrig-core/${rel}`, { name: 'openrig-core', version: '0.1.28' });
    write(`${dir}/openrig-core/skills/user/SKILL.md`, core);
  };
  plugins('packages/daemon/assets/plugins', plugin.source ?? version, '# user\n');
  if (assembled) plugins('packages/cli/daemon/assets/plugins', plugin.assembled ?? plugin.source ?? version, plugin.core ?? '# user\n');
  // The published baseline: openrig at its earlier 0.1.0, and openrig-core 0.1.28 with the bytes given.
  const published = mkdtempSync(join(tmpdir(), 'pack-release-published-'));
  t.after(() => rmSync(published, { recursive: true, force: true }));
  const pub = (rel, text) => { mkdirSync(join(published, rel, '..'), { recursive: true }); writeFileSync(join(published, rel), text); };
  for (const rel of MANIFESTS) pub(`daemon/assets/plugins/openrig/${rel}`, `${JSON.stringify({ name: 'openrig', version: '0.1.0' }, null, 2)}\n`);
  pub('daemon/assets/plugins/openrig/skills/team/SKILL.md', '# team, 0.1.0\n');
  for (const rel of MANIFESTS.slice(1, 3)) pub(`daemon/assets/plugins/openrig-core/${rel}`, `${JSON.stringify({ name: 'openrig-core', version: '0.1.28' }, null, 2)}\n`);
  pub('daemon/assets/plugins/openrig-core/skills/user/SKILL.md', baseline.core ?? '# user\n');
  json('scripts/fixtures/packaged-plugins-last-release.json', { release: baseline.release ?? '0.7.10',
    archiveSha256: baseline.archiveSha256 ?? 'a'.repeat(64), plugins: snapshotPlugins(published) });
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

test("the openrig plugin's four manifests must carry the CLI version, in source and in the assembled CLI", t => {
  const SOURCE = 'packages/daemon/assets/plugins/openrig', ASSEMBLED = 'packages/cli/daemon/assets/plugins/openrig';
  const root = fixture(t, '0.7.13', {}, { plugin: { source: '0.1.0' } });
  assert.deepEqual(openrigPluginMismatches(root, '0.7.13'), [SOURCE, ASSEMBLED].flatMap(dir => MANIFESTS.map(rel =>
    `${dir}/${rel} "version" is "0.1.0", not "0.7.13"`)));
  const dest = join(root, 'out');
  assert.throws(() => packRelease(root, dest), /The openrig plugin's four manifests must carry @openrig\/cli 0\.7\.13, in source and in the assembled CLI/);
  assert.equal(existsSync(dest), false);
  // A stale assembly is named file by file, with the rebuild step.
  const stale = fixture(t, '0.7.13', {}, { plugin: { source: '0.7.13', assembled: '0.1.0' } });
  assert.deepEqual(openrigPluginMismatches(stale, '0.7.13'), MANIFESTS.map(rel => `${ASSEMBLED}/${rel} "version" is "0.1.0", not "0.7.13"`));
  assert.throws(() => packRelease(stale, join(stale, 'out')), /run npm run build:package again/);
  // Each of the four is required in both places, even when the others carry the version.
  for (const dir of [SOURCE, ASSEMBLED]) {
    const missing = fixture(t, '0.7.13');
    rmSync(join(missing, dir, '.cursor-plugin/plugin.json'));
    assert.deepEqual(openrigPluginMismatches(missing, '0.7.13'), [`${dir}/.cursor-plugin/plugin.json is missing`]);
    assert.throws(() => packRelease(missing, join(missing, 'out')), /\.cursor-plugin\/plugin\.json is missing/);
    assert.equal(existsSync(join(missing, 'out')), false);
  }
  assert.deepEqual(openrigPluginMismatches(fixture(t, '0.7.13'), '0.7.13'), []);
});

test("the install pages must link this release's tag, and every other link is named by file and line", t => {
  const root = fixture(t, '0.7.13', {}, { pages: { tag: '<release-tag>', assembled: 'v0.7.13' } });
  assert.deepEqual(installTagMismatches(root, '0.7.13'), [
    'README.md:3 links skills/rigs at "<release-tag>", not "v0.7.13"',
    'README.md:4 links scripts/install.sh at "<release-tag>", not "v0.7.13"',
    'docs/reference/getting-started.md:3 links skills/rigs at "<release-tag>", not "v0.7.13"',
    'docs/reference/getting-started.md:4 links scripts/install.sh at "<release-tag>", not "v0.7.13"',
    'docs/reference/quickstart.md:3 links skills/rigs at "<release-tag>", not "v0.7.13"',
  ]);
  const dest = join(root, 'out');
  assert.throws(() => packRelease(root, dest), /The install pages must link this release's tag, v0\.7\.13, in source and in the assembled CLI; set them in the release preparation/);
  assert.equal(existsSync(dest), false);
  // The last release's tag and main's unreleased skill are refused the same way.
  for (const tag of ['v0.7.12', 'main']) assert.equal(installTagMismatches(fixture(t, '0.7.13', {}, { pages: { tag } }), '0.7.13').length, 8);
  // npm packs the assembled copies: current source over a stale assembly is refused, with the rebuild step.
  const stale = fixture(t, '0.7.13', {}, { pages: { assembled: 'v0.7.12' } });
  assert.deepEqual(installTagMismatches(stale, '0.7.13'), [
    'packages/cli/daemon/docs/reference/getting-started.md:3 links skills/rigs at "v0.7.12", not "v0.7.13"',
    'packages/cli/daemon/docs/reference/getting-started.md:4 links scripts/install.sh at "v0.7.12", not "v0.7.13"',
    'packages/cli/daemon/docs/reference/quickstart.md:3 links skills/rigs at "v0.7.12", not "v0.7.13"',
  ]);
  assert.throws(() => packRelease(stale, join(stale, 'out')), /then run npm run build:package again/);
  assert.equal(existsSync(join(stale, 'out')), false);
  // A page that links no rigs skill is named, rather than passing with nothing checked.
  const bare = fixture(t, '0.7.13');
  writeFileSync(join(bare, 'docs/reference/quickstart.md'), '# Quickstart\n');
  assert.deepEqual(installTagMismatches(bare, '0.7.13'), ['docs/reference/quickstart.md has no rigs-skill install link']);
  assert.deepEqual(installTagMismatches(fixture(t, '0.7.13'), '0.7.13'), []);
});

test('the baseline must be an earlier published release with its archive hash, never the candidate', t => {
  for (const [release, why] of [['0.7.13', /not a release published before 0\.7\.13/], ['0.7.14', /not a release published before/], ['candidate', /not a release published before/]]) {
    const root = fixture(t, '0.7.13', {}, { baseline: { release } });
    assert.throws(() => releaseBaseline(root, '0.7.13'), why);
    assert.throws(() => packRelease(root, join(root, 'out')), /must be the last published release's packaged plugins/);
  }
  assert.throws(() => releaseBaseline(fixture(t, '0.7.13', {}, { baseline: { archiveSha256: '' } }), '0.7.13'), /no archive sha256/);
  assert.equal(releaseBaseline(fixture(t, '0.7.13', {}, { baseline: { release: '0.7.9' } }), '0.7.13').release, '0.7.9');
});

test('changed plugin bytes need a greater version than the published release, and nothing is packed otherwise', t => {
  const root = fixture(t, '0.7.13', {}, { plugin: { core: '# user, changed\n' } });
  const dest = join(root, 'out');
  assert.throws(() => packRelease(root, dest), /openrig-core: packaged files changed since 0\.7\.10, but version 0\.1\.28 is not greater than 0\.1\.28/);
  assert.equal(existsSync(dest), false);
});

test('the release manifest records the baseline it was checked against and each packed plugin version', t => {
  const root = fixture(t, '0.7.13', {}, { baseline: { release: '0.7.12', archiveSha256: 'b'.repeat(64) } });
  const manifest = packRelease(root, join(root, 'out'));
  assert.deepEqual(manifest.plugins, { baseline: { release: '0.7.12', archiveSha256: 'b'.repeat(64) }, packed: { openrig: '0.7.13', 'openrig-core': '0.1.28' } });
  assert.equal(baselineNotice(manifest), `Plugins checked against 0.7.12 (archive sha256 ${'b'.repeat(64)}); confirm that's the registry's latest @openrig/cli before publishing.`);
});

test('the pack step never publishes', () => {
  const source = readFileSync(new URL('./pack-release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\['publish'|"publish"|npm publish/);
});
