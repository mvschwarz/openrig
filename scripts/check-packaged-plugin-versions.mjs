import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifests = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
export const lastRelease = JSON.parse(readFileSync(new URL('./fixtures/packaged-plugins-last-release.json', import.meta.url)));

export function snapshotPlugins(packageDir) {
  const root = join(packageDir, 'daemon/assets/plugins');
  return Object.fromEntries(readdirSync(root).sort().map(name => {
    const entries = [];
    const walk = (dir, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix + entry.name;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, rel + '/');
        else if (entry.isFile()) entries.push([rel, 'file', hash(readFileSync(path))]);
        else if (entry.isSymbolicLink()) entries.push([rel, 'link', readlinkSync(path)]);
        else throw new Error(`unsupported packaged plugin entry: ${name}/${rel}`);
      }
    };
    walk(join(root, name));
    const versions = manifests.filter(rel => entries.some(([path]) => path === rel))
      .map(rel => JSON.parse(readFileSync(join(root, name, rel), 'utf8')).version);
    assert.ok(versions.length > 0, `${name}: no packaged plugin manifest`);
    for (const version of versions) {
      assert.ok(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), `${name}: invalid numeric plugin version`);
      assert.equal(version, versions[0], `${name}: harness manifest versions disagree`);
    }
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return [name, { version: versions[0], sha256: hash(JSON.stringify(entries)) }];
  }));
}

export function checkPackagedPluginVersions(packageDir, baseline = lastRelease) {
  assert.ok(Object.keys(baseline.plugins).length > 0, 'last release has no packaged plugins');
  const current = snapshotPlugins(packageDir);
  for (const [name, previous] of Object.entries(baseline.plugins)) {
    const next = current[name];
    assert.ok(next, `released bundled plugin missing: ${name}`);
    if (next.sha256 === previous.sha256) continue;
    const oldParts = previous.version.split('.').map(BigInt);
    const newParts = next.version.split('.').map(BigInt);
    const difference = newParts.findIndex((part, i) => part !== oldParts[i]);
    assert.ok(difference >= 0 && newParts[difference] > oldParts[difference],
      `${name}: packaged files changed since ${baseline.release}, but version ${next.version} is not greater than ${previous.version}; existing installs would retain old content`);
  }
  return current;
}

// Refresh the fixture from the newly published archive after each release:
// node scripts/check-packaged-plugin-versions.mjs release.tgz --snapshot > scripts/fixtures/packaged-plugins-last-release.json
// Check an exact candidate archive without building or executing its contents:
// node scripts/check-packaged-plugin-versions.mjs candidate.tgz
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, option] = process.argv.slice(2);
  assert.ok(archive && (!option || option === '--snapshot'), 'usage: check-packaged-plugin-versions.mjs archive.tgz [--snapshot]');
  const dir = mkdtempSync(join(tmpdir(), 'packaged-plugin-versions-'));
  try {
    execFileSync('tar', ['-xzf', resolve(archive), '-C', dir, 'package/daemon/assets/plugins', 'package/package.json']);
    const pkg = join(dir, 'package');
    console.log(JSON.stringify(option === '--snapshot' ? {
      release: JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version,
      archiveSha256: hash(readFileSync(archive)), plugins: snapshotPlugins(pkg),
    } : checkPackagedPluginVersions(pkg), null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
