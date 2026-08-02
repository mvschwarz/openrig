import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "packages", "cli");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-tui-pack-"));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function assertDelayedSplits(entry, pkgDir) {
  const vectors = [
    ["up", "\x1b[A"], ["down", "\x1b[B"], ["right", "\x1b[C"], ["left", "\x1b[D"],
    ["pageup", "\x1b[5~"], ["pagedown", "\x1b[6~"],
    ["mouse", "\x1b[<0;47;12M\x1b[<0;47;12m"],
  ];
  let run = 0;
  for (const [label, sequence] of vectors) {
    const bytes = Buffer.from(sequence);
    for (let split = 1; split < bytes.length; split++) {
      const socket = path.join(temp, `split-${run++}.sock`);
      const child = spawn(process.execPath, [entry, "--demo", "--socket", socket], {
        cwd: pkgDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      await wait(40);
      child.stdin.write(bytes.subarray(0, split));
      await wait(80);
      child.stdin.write(bytes.subarray(split));
      await wait(20);
      child.stdin.write("q");
      const code = await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        wait(1_000).then(() => "timeout"),
      ]);
      if (code === "timeout") child.kill("SIGTERM");
      assert.equal(code, 0, `${label} split ${split}/${bytes.length} failed delayed packed-entry decoding: ${stderr}`);
    }
  }
}

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
  await assertDelayedSplits(entry, pkgDir);
  console.log(`packed TUI launch PASS: ${packed[0].filename}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
