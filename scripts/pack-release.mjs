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
import { checkPackagedPluginVersions } from './check-packaged-plugin-versions.mjs';

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

// The pages a newcomer copies install commands from. Each links the rigs skill, and the README and getting started
// also link the install script, at a release tag, so a copied command fetches that release's skill or install script
// (the script itself installs the latest published CLI): never a placeholder, a stale tag or main's unreleased skill.
// build:package copies docs/reference into the assembled CLI, and npm packs that copy, so both copies are checked.
const INSTALL_PAGES = ['README.md', 'docs/reference/getting-started.md', 'docs/reference/quickstart.md',
  'packages/cli/daemon/docs/reference/getting-started.md', 'packages/cli/daemon/docs/reference/quickstart.md'];
const INSTALL_LINK = /github(?:usercontent)?\.com\/mvschwarz\/openrig\/(?:tree\/)?([^/\s"'`]+)\/(skills\/rigs|scripts\/install\.sh)/g;

/** Where an install page links the rigs skill or the install script at anything but this release's tag, each named by
 *  file and line. A page with no rigs-skill link is named too, so a rewritten page can't pass by linking nothing. */
export function installTagMismatches(root, version) {
  const tag = `v${version}`;
  return INSTALL_PAGES.flatMap(rel => {
    if (!existsSync(join(root, rel))) return [`${rel} is missing`];
    const links = readFileSync(join(root, rel), 'utf8').split('\n')
      .flatMap((line, i) => [...line.matchAll(INSTALL_LINK)].map(([, ref, target]) => ({ line: i + 1, ref, target })));
    return [
      ...(links.some(link => link.target === 'skills/rigs') ? [] : [`${rel} has no rigs-skill install link`]),
      ...links.filter(link => link.ref !== tag).map(link => `${rel}:${link.line} links ${link.target} at ${JSON.stringify(link.ref)}, not ${JSON.stringify(tag)}`),
    ];
  });
}

const BASELINE = 'scripts/fixtures/packaged-plugins-last-release.json';
// The openrig plugin in source, and as the assembled CLI packs it.
const OPENRIG_PLUGIN_DIRS = ['packages/daemon/assets/plugins/openrig', 'packages/cli/daemon/assets/plugins/openrig'];
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

/** The openrig plugin ships inside the CLI, so all four of its manifests, in source and in the assembled CLI, carry the
 *  CLI's release version; openrig-core keeps its own, and other plugins' optional manifests stay optional. */
export function openrigPluginMismatches(root, version) {
  return OPENRIG_PLUGIN_DIRS.flatMap(dir => OPENRIG_MANIFESTS.map(rel => `${dir}/${rel}`)).flatMap(path => {
    if (!existsSync(join(root, path))) return [`${path} is missing`];
    const actual = readJson(root, path).version;
    return actual === version ? [] : [`${path} "version" is ${JSON.stringify(actual)}, not ${JSON.stringify(version)}`];
  });
}

/** What a successful pack says about its baseline: the checks read the baseline's own fields, so whether it's the
 *  registry's latest @openrig/cli is for the person releasing to confirm. */
export function baselineNotice(manifest) {
  const { release, archiveSha256 } = manifest.plugins.baseline;
  return `Plugins checked against ${release} (archive sha256 ${archiveSha256}); confirm that's the registry's latest @openrig/cli before publishing.`;
}

export function packRelease(root, dest) {
  const version = readJson(root, 'packages/cli/package.json').version;
  const mismatches = launcherMismatches(root);
  if (mismatches.length > 0) throw new Error(`The launcher must match @openrig/cli ${version}:\n- ${mismatches.join('\n- ')}`);
  // This catches a build that never ran, not a partial one: a successful build:package is the precondition.
  if (!existsSync(join(root, 'packages/cli/daemon/dist'))) throw new Error('packages/cli has no daemon/dist, so build:package hasn\'t run: run npm run build:package first');
  const links = installTagMismatches(root, version);
  if (links.length > 0) throw new Error(`The install pages must link this release's tag, v${version}, in source and in the assembled CLI; set them in the release preparation, then run npm run build:package again:\n- ${links.join('\n- ')}`);
  const stamp = openrigPluginMismatches(root, version);
  if (stamp.length > 0) throw new Error(`The openrig plugin's four manifests must carry @openrig/cli ${version}, in source and in the assembled CLI; set them in the release preparation, then run npm run build:package again:\n- ${stamp.join('\n- ')}`);
  // The assembled CLI's plugins are what's packed: changed plugin bytes need a greater version than the last release's.
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
    console.log(baselineNotice(manifest));
    console.log(`Wrote ${join(resolve(dest), 'RELEASE-ARTIFACTS.json')}. Publish these archive files themselves, by path, in this order: ${manifest.publishOrder.join(', then ')}.`);
    console.log('Publishing from the packages/cli folder instead runs its prepublishOnly, which rebuilds, so the bytes published could differ from these.');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
