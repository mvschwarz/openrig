import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packEntry } from "./npm-pack-json.mjs";

const script = fs.readFileSync(new URL("./build-package.sh", import.meta.url), "utf8");
const assetsBranch = script.match(/^if \[ -d "\$DAEMON_DIR\/assets" \]; then\n[\s\S]*?^fi$/m)?.[0];
const inventory = script.match(/^node -e '\n[\s\S]*?^' "\$CLI_DIR\/daemon\/substance-surfaces.json" "\$\{SUBSTANCE_SURFACE_ROOTS\[@\]\}"$/m)?.[0];
assert.ok(assetsBranch, "actual daemon assets staging branch must exist");
assert.ok(inventory, "actual staged substance-root writer must exist");

const modes = { "": 0o755, "tool.sh": 0o755, "data.bin": 0o644, private: 0o700, "private/secret.txt": 0o400, shared: 0o750 };
const contents = { "tool.sh": Buffer.from("#!/bin/sh\necho fixture\n"), "data.bin": Buffer.from([0, 255, 13, 10, 128]), "private/secret.txt": Buffer.from("synthetic fixture\n") };
const links = { "local-link": "./data.bin", "outside-link": "../../../outside/sentinel.bin" };

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "package-assets-"));
  const daemon = join(root, "packages/daemon");
  const cli = join(root, "packages/cli");
  const assets = join(daemon, "assets");
  for (const dir of [assets, join(assets, "private"), join(assets, "shared"), join(cli, "daemon"), join(root, "outside")]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (const [name, bytes] of Object.entries(contents)) fs.writeFileSync(join(assets, name), bytes);
  for (const [name, mode] of Object.entries(modes)) fs.chmodSync(join(assets, name), mode);
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, join(assets, name));
  fs.writeFileSync(join(root, "outside/sentinel.bin"), "outside target, not asset content\n", { mode: 0o600 });
  return { root, daemon, cli, assets, staged: join(cli, "daemon/assets") };
}

function snapshot(root) {
  const entries = [];
  function walk(relative) {
    const file = join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) entries.push([relative, "link", fs.readlinkSync(file)]);
    else if (stat.isDirectory()) {
      entries.push([relative, "directory", stat.mode & 0o777]);
      for (const name of fs.readdirSync(file).sort()) walk(join(relative, name));
    } else entries.push([relative, "file", stat.mode & 0o777, fs.readFileSync(file).toString("hex")]);
  }
  walk("");
  return entries;
}

function stage(f, mask) {
  // Run only the real staging branch and its inventory writer, without builds or installs.
  return spawnSync("bash", ["-c", `set -euo pipefail
umask "$1"
DAEMON_DIR="$2"
CLI_DIR="$3"
SUBSTANCE_SURFACE_ROOTS=()
umask
${assetsBranch}
${inventory}
umask
`, "package-assets", mask, f.daemon, f.cli], { encoding: "utf8", timeout: 30_000 });
}

function assertStaged(f) {
  for (const [name, bytes] of Object.entries(contents)) {
    assert.ok(fs.lstatSync(join(f.staged, name)).isFile(), name);
    assert.deepEqual(fs.readFileSync(join(f.staged, name)), bytes, `${name} bytes`);
  }
  for (const [name, target] of Object.entries(links)) {
    assert.ok(fs.lstatSync(join(f.staged, name)).isSymbolicLink(), name);
    assert.equal(fs.readlinkSync(join(f.staged, name)), target, `${name} verbatim target`);
  }
  assert.deepEqual(fs.readdirSync(f.staged).sort(), ["data.bin", "local-link", "outside-link", "private", "shared", "tool.sh"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.cli, "daemon/substance-surfaces.json"), "utf8")), { schemaVersion: 1, roots: ["daemon/assets"] });
}

for (const mask of ["0077", "0022"]) {
  test(`asset staging preserves source modes, bytes and relative links under umask ${mask}`, { skip: process.platform === "win32" }, () => {
    const f = fixture();
    const source = snapshot(f.assets);
    const outside = snapshot(join(f.root, "outside"));
    const callerMask = process.umask();
    try {
      const copied = stage(f, mask);
      assert.equal(copied.error, undefined, copied.stderr);
      assert.equal(copied.status, 0, copied.stderr);
      assert.deepEqual(copied.stdout.trim().split("\n"), [mask, mask], "copy must leave the caller's umask unchanged");
      assert.deepEqual(snapshot(f.assets), source, "source bytes, modes and links must remain unchanged");
      assert.deepEqual(snapshot(join(f.root, "outside")), outside, "outside target must remain untouched");
      for (const parent of [f.root, f.cli, join(f.cli, "daemon")]) assert.equal(fs.statSync(parent).mode & 0o777, 0o700, "private parent mode");
      assertStaged(f);
      const stagedModes = Object.fromEntries(Object.keys(modes).map(name => [name, fs.statSync(join(f.staged, name)).mode & 0o777]));
      assert.deepEqual(stagedModes, modes, `source modes under umask ${mask}`);
    } finally {
      assert.equal(process.umask(), callerMask, "test process umask must remain unchanged");
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("a real assets copy error stops before recording the substance root", { skip: process.platform === "win32" }, () => {
  assert.match(script, /^set -euo pipefail$/m, "the real build script must stop on an assets copy error");
  const f = fixture();
  const source = snapshot(f.assets);
  const outside = snapshot(join(f.root, "outside"));
  try {
    fs.writeFileSync(f.staged, "blocking regular file\n", { mode: 0o600 });
    const copied = stage(f, "0077");
    assert.equal(copied.error, undefined, copied.stderr);
    assert.equal(copied.signal, null);
    assert.notEqual(copied.status, 0, "copying a directory over a regular file must fail");
    assert.ok(copied.stderr.length > 0, "copy failure must be visible");
    assert.equal(fs.readFileSync(f.staged, "utf8"), "blocking regular file\n");
    assert.equal(fs.statSync(f.staged).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(join(f.cli, "daemon/substance-surfaces.json")), false);
    assert.deepEqual(snapshot(f.assets), source);
    assert.deepEqual(snapshot(join(f.root, "outside")), outside);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("offline npm pack carries staged asset bytes and executability, with npm's own link and mode policy", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const source = snapshot(f.assets);
  const outside = snapshot(join(f.root, "outside"));
  try {
    const copied = stage(f, "0022");
    assert.equal(copied.error, undefined, copied.stderr);
    assert.equal(copied.status, 0, copied.stderr);
    assertStaged(f);
    const staged = snapshot(f.staged);
    fs.writeFileSync(join(f.cli, "package.json"), JSON.stringify({ name: "openrig-assets-fixture", version: "1.0.0", private: true, files: ["daemon"] }));
    const packed = packEntry(execFileSync("bash", ["-c", 'umask 0022; exec npm pack --offline --ignore-scripts --json --pack-destination "$1"', "asset-pack", f.root], { cwd: f.cli, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }));
    const files = new Map(packed.files.map(file => [file.path, file]));
    for (const [name, bytes] of Object.entries(contents)) {
      const entry = `daemon/assets/${name}`;
      assert.ok(files.has(entry), `${entry} must be packed`);
      assert.deepEqual(execFileSync("tar", ["-xOf", join(f.root, packed.filename), `package/${entry}`]), bytes);
    }
    assert.equal(files.get("daemon/assets/tool.sh").mode, 0o755);
    assert.equal(files.get("daemon/assets/data.bin").mode, 0o644);
    assert.equal(files.get("daemon/assets/private/secret.txt").mode, 0o600, "npm adds owner write permission without adding group/other access");
    for (const name of Object.keys(links)) assert.equal(files.has(`daemon/assets/${name}`), false, "npm omits symlinks; staging retention is a separate contract");
    assert.deepEqual(snapshot(f.staged), staged, "packing must not mutate staged modes or links");
    assert.deepEqual(snapshot(f.assets), source);
    assert.deepEqual(snapshot(join(f.root, "outside")), outside);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
