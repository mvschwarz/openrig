import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";

const script = path.join(import.meta.dirname, "install.sh");
const source = fs.readFileSync(script, "utf8");

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "tools");
  const prefix = path.join(dir, "npm prefix with spaces");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  const write = (file, body) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write(path.join(bin, "node"), 'printf "node:%s\\n" "$*" >>"$TEST_LOG"; printf "v22.22.1\\n"');
  write(path.join(bin, "npm"), `
printf 'npm:%s\n' "$*" >>"$TEST_LOG"
case "$*" in
  --version) printf '10.9.4\n' ;;
  'install -g @openrig/cli') printf 'npm native output\n'; printf 'npm native error\n' >&2; exit "${INSTALL_EXIT:-0}" ;;
  'prefix -g') printf '%s\n' "$TEST_PREFIX"; exit "${PREFIX_EXIT:-0}" ;;
  *) exit 90 ;;
esac`);
  write(path.join(bin, "rig"), 'printf "STALE\\n" >>"$TEST_LOG"; exit 91');
  write(path.join(prefix, "bin", "rig"), `
printf 'installed:%s\n' "$*" >>"$TEST_LOG"
# Any available stdin would be an implicit answer or unconsumed script bytes.
if read -r answer; then printf 'unexpected stdin\n' >&2; exit 92; fi
case "$*" in
  'setup --dry-run') printf 'setup preview\n'; exit "${PREVIEW_EXIT:-0}" ;;
  setup) printf 'setup native output\n'; printf 'setup native error\n' >&2
    printf 'Next steps: choose providers, then rig up\n'; exit "${SETUP_EXIT:-0}" ;;
  *) exit 93 ;;
esac`);
  const env = { PATH: bin, HOME: dir, TEST_PREFIX: prefix, TEST_LOG: path.join(dir, "calls"), ...overrides };
  return { dir, bin, prefix, env,
    calls: () => fs.existsSync(env.TEST_LOG) ? fs.readFileSync(env.TEST_LOG, "utf8").trim().split("\n") : [],
    run: (...args) => spawnSync("/bin/sh", [script, ...args], { env, encoding: "utf8", timeout: 10000 }),
  };
}

test("dry run needs no tools and only prints the complete plan", t => {
  const f = fixture(t);
  f.env.PATH = path.join(f.dir, "absent");
  const r = f.run("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  for (const text of ["[1/4]", "npm install -g @openrig/cli", "rig setup --dry-run", "[4/4] rig setup", "both Claude Code and Codex", "cmux", "Dry run:"]) assert.ok(r.stdout.includes(text), text);
  assert.deepEqual(f.calls(), []);
});

for (const tool of ["node", "npm"]) test(`missing ${tool} reports the prerequisite step`, t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.bin, tool));
  const r = f.run();
  assert.equal(r.status, 127);
  assert.match(r.stderr, new RegExp(`Missing prerequisite: ${tool}`));
  assert.match(r.stderr, /FAILED \[1\/4\].*exit 127/);
  assert.deepEqual(f.calls(), []);
});

for (const [variable, code, step, command] of [
  ["INSTALL_EXIT", 37, 2, "npm install -g @openrig/cli"],
  ["PREFIX_EXIT", 38, 2, "npm prefix -g"],
  ["PREVIEW_EXIT", 39, 3, "setup --dry-run"],
  ["SETUP_EXIT", 40, 4, "setup"],
]) test(`${command} failure preserves status and native output`, t => {
  const f = fixture(t, { [variable]: String(code) });
  const r = f.run();
  assert.equal(r.status, code, r.stderr);
  assert.ok(r.stderr.includes(`FAILED [${step}/4]`), r.stderr);
  assert.ok(r.stderr.includes(command), r.stderr);
  assert.ok(r.stderr.includes(`exit ${code}`), r.stderr);
  assert.match(r.stdout, /npm native output/);
  assert.match(r.stderr, /npm native error/);
  assert.ok(!r.stdout.includes("Follow the next steps"));
  if (step < 4) assert.ok(!f.calls().includes("installed:setup"));
});

test("installed rig wins over stale PATH and a prefix containing spaces works", t => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), ["node:--version", "npm:--version", "npm:install -g @openrig/cli", "npm:prefix -g", "installed:setup --dry-run", "installed:setup"]);
  assert.match(r.stdout, /choose providers, then rig up/);
  assert.match(r.stderr, /setup native error/);
});

test("missing installed executable never falls back to a stale rig", t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.prefix, "bin", "rig"));
  const r = f.run();
  assert.equal(r.status, 127);
  assert.match(r.stderr, /FAILED \[2\/4\] locate installed rig/);
  assert.ok(!f.calls().includes("STALE"));
});

test("the actual HTTP download piped to sh preserves setup failure", async t => {
  const f = fixture(t, { SETUP_EXIT: "43" });
  const curl = spawnSync("/bin/sh", ["-c", "command -v curl"], { encoding: "utf8" });
  assert.equal(curl.status, 0, "curl is required for the pipe control");
  fs.symlinkSync(curl.stdout.trim(), path.join(f.bin, "curl"));
  const server = http.createServer((_req, res) => res.end(source));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/install.sh`;
  const child = spawn("/bin/sh", ["-c", 'curl -fsS --max-time 5 "$1" | /bin/sh', "pipe-test", url], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; });
  child.stderr.on("data", b => { stderr += b; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  t.after(() => clearTimeout(timer));
  const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(status, 43, stderr);
  assert.match(stdout, /setup native output/);
  assert.match(stderr, /setup native error/);
  assert.match(stderr, /FAILED \[4\/4\].*exit 43/);
  assert.ok(!f.calls().includes("STALE"));
});
