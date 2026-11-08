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

export function packRelease(root, dest) {
  const version = readJson(root, 'packages/cli/package.json').version;
  const mismatches = launcherMismatches(root);
  if (mismatches.length > 0) throw new Error(`The launcher must match @openrig/cli ${version}:\n- ${mismatches.join('\n- ')}`);
  // This catches a build that never ran, not a partial one: a successful build:package is the precondition.
  if (!existsSync(join(root, 'packages/cli/daemon/dist'))) throw new Error('packages/cli has no daemon/dist, so build:package hasn\'t run: run npm run build:package first');
  mkdirSync(dest, { recursive: true });
  // The CLI is packed as the release producer has packed it; the launcher isn't a workspace, so it's packed by path.
  // --ignore-scripts skips pack's prepack and postpack, but npm 10 still runs a `prepare`; neither package has one.
  const pack = target => JSON.parse(execFileSync('npm', ['pack', ...target, '--ignore-scripts', '--json', '--pack-destination', dest],
    { cwd: root, encoding: 'utf8' }))[0];
  const artifacts = [pack(['--workspace', 'packages/cli']), pack(['./packages/acp'])].map(packed => {
    const path = join(dest, packed.filename);
    return { name: packed.name, version: packed.version, path, size: packed.size, sha256: sha256(path), integrity: packed.integrity };
  });
  const listing = LISTING.map(rel => ({ path: join(root, rel), sha256: sha256(join(root, rel)) }));
  const manifest = { version, artifacts, listing, publishOrder: ['@openrig/cli', '@openrig/acp', 'ACP registry listing'] };
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
