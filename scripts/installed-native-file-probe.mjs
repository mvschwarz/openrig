import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The opt-in Gate supplies only its owned installed package and temporary home.
const [installed, home] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.ok(installed && home);
const helpers = await import(pathToFileURL(join(resolve(installed), "daemon/dist/windows-owned-files-surface.js")).href);
const { runNativeLocalCopy } = await import(pathToFileURL(join(resolve(installed), "dist/lib/native-local-copy.js")).href);
const root = join(resolve(home), "installed native files Ω"); mkdirSync(root);
assert.equal(typeof helpers.isWindowsDirectoryCaseSensitive(root), "boolean");
assert.equal(helpers.windowsNamesCollide(["Name.txt", "name.txt"]), true);
assert.equal(helpers.windowsNamesCollide(["K.txt", "K.txt"]), false);
const source = join(root, "source.txt"), destination = join(root, "destination.txt"), alias = join(root, "old-alias.txt");
writeFileSync(source, "owned installed replacement"); writeFileSync(destination, "retained installed original");
linkSync(destination, alias); chmodSync(destination, 0o444);
try {
  const plan = {src:{kind:"local",path:source},dst:{kind:"local",path:destination},dryRun:false};
  const copied = await runNativeLocalCopy(plan);
  assert.equal(copied.ok, true, copied.stderr);
  assert.equal(readFileSync(destination, "utf8"), "owned installed replacement");
  assert.equal(readFileSync(alias, "utf8"), "retained installed original");
  assert.equal(lstatSync(alias).mode & 0o200, 0);
  assert.notEqual(lstatSync(destination).mode & 0o200, 0);
  const inode = lstatSync(destination).ino;
  const repeated = await runNativeLocalCopy(plan);
  assert.equal(repeated.ok, true, repeated.stderr); assert.equal(repeated.filesTransferred, 0);
  assert.equal(lstatSync(destination).ino, inode);
  assert.equal(readdirSync(root).some(name=>name.startsWith(".openrig-copy-")), false);
} finally { chmodSync(alias, 0o666); chmodSync(destination, 0o666); }
console.log(JSON.stringify({nativeFileReplacement:true,retainedHardlink:true,nativeFilenameComparison:true}));
