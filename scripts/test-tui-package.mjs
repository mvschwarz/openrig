import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-tui-pack-"));

try {
  execFileSync("npm", ["run", "build:package"], { cwd: root, stdio: "inherit" });
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: cli, encoding: "utf8" }));
  const tarball = path.join(temp, packed[0].filename);
  execFileSync("tar", ["-xzf", tarball, "-C", temp]);

  const pkgDir = path.join(temp, "package");
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(pkg.bin["openrig-tui"], "tui/dist/main.js");
  const entry = path.join(pkgDir, pkg.bin["openrig-tui"]);
  assert.ok(fs.existsSync(entry), "packed TUI entrypoint is missing");
  assert.notEqual(fs.statSync(entry).mode & 0o111, 0, "packed TUI entrypoint is not executable");

  fs.symlinkSync(path.join(root, "node_modules"), path.join(pkgDir, "node_modules"), "dir");
  const launched = spawnSync(process.execPath, [entry, "--demo", "--socket", path.join(temp, "tui.sock")], {
    cwd: pkgDir,
    input: "q",
    encoding: "utf8",
    timeout: 10_000,
    env: process.env,
  });
  assert.equal(launched.status, 0, launched.stderr || `packed TUI exited ${launched.status}`);
  console.log(`packed TUI launch PASS: ${packed[0].filename}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
