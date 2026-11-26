// The openrig plugin's Codex root (build-codex-plugin.mjs): made by the package build, with no Agent Plugins root manifest,
// so Codex 0.171 loads its Codex manifest and runs its hooks, and with files byte-equal to the shared folder's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const shared = join(repo, 'packages/daemon/assets/plugins/openrig');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const files = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]).sort();

/** Runs the package build's own line for the Codex root against this checkout, into a temporary CLI folder. */
function packagedCodexRoot(t) {
  const line = readFileSync(join(repo, 'scripts/build-package.sh'), 'utf8')
    .match(/^node "\$REPO_ROOT\/scripts\/build-codex-plugin\.mjs" .*$/m)?.[0];
  assert.ok(line, 'build-package.sh makes the Codex root');
  const cli = mkdtempSync(join(tmpdir(), 'codex-plugin-root-'));
  t.after(() => rmSync(cli, { recursive: true, force: true }));
  const run = spawnSync('bash', ['-c', `set -euo pipefail\nREPO_ROOT="$1"\nDAEMON_DIR="$1/packages/daemon"\nCLI_DIR="$2"\n${line}`, 'codex-root', repo, cli],
    { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  return join(cli, 'daemon/assets/plugins/openrig-codex');
}

test('the package build makes the Codex root with no root plugin.json, and nothing for other apps', t => {
  const codex = packagedCodexRoot(t);
  assert.equal(existsSync(join(codex, 'plugin.json')), false, 'an Agent Plugins plugin.json at the root is what Codex 0.171 would load instead');
  const skills = files(join(shared, 'skills')).map(rel => `skills/${rel}`);
  assert.deepEqual(files(codex), [
    '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', 'LICENSE', 'assets/logo.svg',
    'hooks/codex.json', 'hooks/scripts/claude-hook-bridge.cjs', ...skills,
  ].sort(), 'no mcp.json (the person adds their own server with their address), no Claude or Cursor manifest, no Claude hooks');
});

test("the Codex root's manifest names hooks/codex.json and keeps the interface block", t => {
  const manifest = json(join(packagedCodexRoot(t), '.codex-plugin/plugin.json'));
  assert.equal(manifest.name, 'openrig');
  assert.equal(manifest.hooks, './hooks/codex.json');
  assert.equal(manifest.skills, './skills');
  assert.equal(manifest.interface?.displayName, 'OpenRig');
  assert.equal(manifest.interface?.logo, './assets/logo.svg');
  assert.equal(manifest.mcpServers, undefined);
});

test("the Codex root's files are byte-equal to the shared folder's", t => {
  const codex = packagedCodexRoot(t);
  const source = rel => rel === '.agents/plugins/marketplace.json' ? '.claude-plugin/marketplace.json' : rel;
  for (const rel of files(codex)) {
    assert.ok(readFileSync(join(codex, rel)).equals(readFileSync(join(shared, source(rel)))), `${rel} differs from the shared ${source(rel)}`);
  }
  // Codex finds the listing at .agents/plugins/marketplace.json; it lists the root itself, as openrig@openrig-app.
  const listing = json(join(codex, '.agents/plugins/marketplace.json'));
  assert.equal(listing.name, 'openrig-app');
  assert.deepEqual(listing.plugins.map(({ name, source: from }) => ({ name, source: from })), [{ name: 'openrig', source: './' }]);
});

test('the shared root keeps its Agent Plugins plugin.json, with $schema, for VS Code, Copilot CLI and Cursor', () => {
  const manifest = json(join(shared, 'plugin.json'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'openrig');
});

test("the README's Codex commands install from the Codex root", () => {
  const readme = readFileSync(join(shared, 'README.md'), 'utf8');
  const adds = [...readme.matchAll(/^codex plugin marketplace add (.+)$/gm)].map(([, path]) => path);
  assert.deepEqual(adds, ['"$(npm root -g)/@openrig/cli/daemon/assets/plugins/openrig-codex"']);
  assert.match(readme, /^codex plugin add openrig@openrig-app$/m);
});
