// The two packages a release publishes, packed after a successful `npm run build:package`: @openrig/cli,
// and the @openrig/acp launcher the ACP registry starts, which carries the CLI's version and depends on
// exactly that CLI. Writes and prints each archive's path, version and hashes, and the registry listing's
// files. It never publishes: the release route publishes these archive files themselves, the CLI first,
// then the launcher, then submits the listing.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packEntry } from './npm-pack-json.mjs';
import { checkPackagedPluginVersions, snapshotPlugins } from './check-packaged-plugin-versions.mjs';

const LISTING = ['packages/acp/registry/agent.json', 'packages/acp/registry/icon.svg'];
const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Where the launcher or its listing doesn't match the CLI's version, each named by file and field. */
export function launcherMismatches(root) {
  const version = readJson(root, 'packages/cli/package.json').version;
  const launcher = readJson(root, 'packages/acp/package.json');
  const listing = readJson(root, LISTING[0]);
  return [
    ['packages/acp/package.json "version"', launcher.version, version],
    ['packages/acp/package.json dependencies["@openrig/cli"]', launcher.dependencies?.['@openrig/cli'], version],
    [`${LISTING[0]} "version"`, listing.version, version],
    [`${LISTING[0]} distribution.npx.package`, listing.distribution?.npx?.package, `@openrig/acp@${version}`],
  ].filter(([, actual, wanted]) => actual !== wanted).map(([where, actual, wanted]) => `${where} is ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`);
}

const BASELINE = 'scripts/fixtures/packaged-plugins-last-release.json';
const OPENRIG_PLUGIN = 'packages/daemon/assets/plugins/openrig';
const OPENRIG_MANIFESTS = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json'];
const parts = version => version.split('.').map(Number);
const earlier = (a, b) => { const [x, y] = [parts(a), parts(b)]; const i = x.findIndex((n, k) => n !== y[k]); return i >= 0 && x[i] < y[i]; };

/** The packaged plugins this release is checked against: the last published release's, refreshed from that published
 *  archive with `node scripts/check-packaged-plugin-versions.mjs <published.tgz> --snapshot`. An earlier release with
 *  its archive hash and plugins, never this candidate's own. */
export function releaseBaseline(root, version) {
  const baseline = readJson(root, BASELINE);
  const problems = [
    ...(typeof baseline.release === 'string' && /^\d+\.\d+\.\d+$/.test(baseline.release) && earlier(baseline.release, version) ? []
      : [`its release is ${JSON.stringify(baseline.release)}, not a release published before ${version}`]),
    ...(/^[0-9a-f]{64}$/.test(baseline.archiveSha256 ?? '') ? [] : ['it has no archive sha256']),
    ...(baseline.plugins && Object.keys(baseline.plugins).length > 0 ? [] : ['it lists no plugins']),
  ];
  if (problems.length > 0) throw new Error(`${BASELINE} must be the last published release's packaged plugins: ${problems.join('; ')}. Refresh it from that published archive (node scripts/check-packaged-plugin-versions.mjs <published.tgz> --snapshot).`);
  return baseline;
}

/** The openrig plugin ships inside the CLI, so its manifests carry the CLI's release version; openrig-core keeps its own. */
export function openrigPluginMismatches(root, version) {
  return OPENRIG_MANIFESTS.filter(rel => existsSync(join(root, OPENRIG_PLUGIN, rel)))
    .map(rel => [`${OPENRIG_PLUGIN}/${rel} "version"`, readJson(root, `${OPENRIG_PLUGIN}/${rel}`).version])
    .filter(([, actual]) => actual !== version).map(([where, actual]) => `${where} is ${JSON.stringify(actual)}, not ${JSON.stringify(version)}`);
}

export function packRelease(root, dest) {
  const version = readJson(root, 'packages/cli/package.json').version;
  const mismatches = launcherMismatches(root);
  if (mismatches.length > 0) throw new Error(`The launcher must match @openrig/cli ${version}:\n- ${mismatches.join('\n- ')}`);
  // This catches a build that never ran, not a partial one: a successful build:package is the precondition.
  if (!existsSync(join(root, 'packages/cli/daemon/dist'))) throw new Error('packages/cli has no daemon/dist, so build:package hasn\'t run: run npm run build:package first');
  const stamp = openrigPluginMismatches(root, version);
  if (stamp.length > 0) throw new Error(`The openrig plugin's manifests must carry @openrig/cli ${version}; set them in the release preparation, then run build:package again:\n- ${stamp.join('\n- ')}`);
  // The assembled CLI's plugins are what's packed: changed plugin bytes need a greater version than the last release's.
  const assembled = snapshotPlugins(join(root, 'packages/cli')).openrig;
  if (assembled && assembled.version !== version) throw new Error(`The assembled CLI's openrig plugin is ${assembled.version}, not ${version}: run npm run build:package again`);
  const baseline = releaseBaseline(root, version);
  const plugins = checkPackagedPluginVersions(join(root, 'packages/cli'), baseline);
  mkdirSync(dest, { recursive: true });
  // The CLI is packed as the release producer has packed it; the launcher isn't a workspace, so it's packed by path.
  // --ignore-scripts skips pack's prepack and postpack, but npm 10 still runs a `prepare`; neither package has one.
  const pack = target => packEntry(execFileSync('npm', ['pack', ...target, '--ignore-scripts', '--json', '--pack-destination', dest],
    { cwd: root, encoding: 'utf8' }));
  const artifacts = [pack(['--workspace', 'packages/cli']), pack(['./packages/acp'])].map(packed => {
    const path = join(dest, packed.filename);
    return { name: packed.name, version: packed.version, path, size: packed.size, sha256: sha256(path), integrity: packed.integrity };
  });
  const listing = LISTING.map(rel => ({ path: join(root, rel), sha256: sha256(join(root, rel)) }));
  const manifest = { version, artifacts, listing,
    plugins: { baseline: { release: baseline.release, archiveSha256: baseline.archiveSha256 }, packed: Object.fromEntries(Object.entries(plugins).map(([name, p]) => [name, p.version])) },
    publishOrder: ['@openrig/cli', '@openrig/acp', 'ACP registry listing'] };
  writeFileSync(join(dest, 'RELEASE-ARTIFACTS.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = process.argv[2];
  if (!dest) {
    console.error('Usage: npm run pack:release -- <destination directory>');
    process.exit(2);
  }
  try {
    const manifest = packRelease(resolve(fileURLToPath(import.meta.url), '../..'), resolve(dest));
    for (const a of manifest.artifacts) console.log(`${a.name}@${a.version}  ${a.path}  sha256 ${a.sha256}  ${a.size} B`);
    for (const l of manifest.listing) console.log(`listing  ${l.path}  sha256 ${l.sha256}`);
    console.log(`Wrote ${join(resolve(dest), 'RELEASE-ARTIFACTS.json')}. Publish these archive files themselves, by path, in this order: ${manifest.publishOrder.join(', then ')}.`);
    console.log('Publishing from the packages/cli folder instead runs its prepublishOnly, which rebuilds, so the bytes published could differ from these.');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
