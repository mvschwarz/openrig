import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE_SCRIPT = fileURLToPath(new URL("./gate-lane.mjs", import.meta.url));

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "gate-candidate-"));
  write(join(root, ".gitignore"), "node_modules/\npackages/cli/daemon/\n");
  write(join(root, "tracked.txt"), "one\n");
  write(join(root, "packages/cli/index.js"), "export {};\n");
  const packages = {
    "": { workspaces: ["packages/cli"] },
    "node_modules/@openrig/cli": { resolved: "packages/cli", link: true },
    "packages/cli": { name: "@openrig/cli" },
  };
  write(join(root, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages }, null, 2)}\n`);
  mkdirSync(join(root, "node_modules/@openrig"), { recursive: true });
  symlinkSync("../../packages/cli", join(root, "node_modules/@openrig/cli"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "gate@example.invalid");
  git(root, "config", "user.name", "Gate Test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function runGate(root, extraEnv = {}) {
  const port = await freePort();
  return spawnSync(process.execPath, [GATE_SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENRIG_GATE_LANE_PORT: String(port),
      OPENRIG_GATE_LANE_SMOKE: "1",
      OPENRIG_GATE_VERDICT: join(root, "gate-lane-verdict.json"),
      ...extraEnv,
    },
  });
}

function assertCandidateRefusal(result, pattern) {
  assert.notEqual(result.status, 0, `gate must refuse\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

test("candidate binding: tracked dirt refuses before the first cleanup mutation", async () => {
  const root = makeRepo();
  const sentinel = join(root, "packages/cli/daemon/sentinel.txt");
  write(sentinel, "must survive refusal\n");
  write(join(root, "tracked.txt"), "dirty\n");
  const result = await runGate(root);
  assertCandidateRefusal(result, /candidate.*dirty|tracked.*change/i);
  assert.equal(existsSync(sentinel), true, "pre-mutation refusal preserves the stale-bundle sentinel");
});

test("candidate binding: a Git-visible untracked file refuses", async () => {
  const root = makeRepo();
  write(join(root, "untracked.test.mjs"), "// visible\n");
  assertCandidateRefusal(await runGate(root), /candidate.*dirty|untracked/i);
});

test("candidate binding: same verdict basename at a different path is not excluded", async () => {
  const root = makeRepo();
  write(join(root, "sub/dir/gate-lane-verdict.json"), "{}\n");
  assertCandidateRefusal(await runGate(root), /sub\/dir\/gate-lane-verdict\.json|candidate.*dirty/i);
});

test("candidate binding: only the canonical verdict path may be present and the verdict binds HEAD", async () => {
  const root = makeRepo();
  const verdictPath = join(root, "receipts/current-verdict.json");
  write(verdictPath, "{}\n");
  const head = git(root, "rev-parse", "HEAD");
  const result = await runGate(root, { OPENRIG_GATE_VERDICT: verdictPath });
  assert.equal(result.status, 0, result.stderr);
  const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
  assert.equal(verdict.candidateSha, head);
  assert.equal(verdict.gate, "pass");
});

test("candidate binding: HEAD drift during the gate refuses before writing a verdict", async () => {
  const root = makeRepo();
  const verdictPath = join(root, "gate-lane-verdict.json");
  const fakeBin = mkdtempSync(join(tmpdir(), "gate-fake-npm-"));
  const marker = join(tmpdir(), `gate-drift-marker-${process.pid}-${Date.now()}`);
  const fakeNpm = join(fakeBin, "npm");
  write(fakeNpm, `#!/bin/sh\n: > "$OPENRIG_TEST_MARKER"\nsleep 1\nexit 0\n`);
  chmodSync(fakeNpm, 0o755);
  const port = await freePort();

  const child = spawn(process.execPath, [GATE_SCRIPT], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      OPENRIG_TEST_MARKER: marker,
      OPENRIG_GATE_LANE_PORT: String(port),
      OPENRIG_GATE_VERDICT: verdictPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.on("close", resolve));

  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(marker), true, "the real gate reached its first injected leg");
  write(join(root, "tracked.txt"), "two\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "move head during gate");

  const status = await closed;
  assertCandidateRefusal({ status, stdout, stderr }, /HEAD.*(drift|changed)|candidateSha/i);
  assert.equal(existsSync(verdictPath), false, "a drifted run writes no verdict");
});

test("candidate binding: Git-visible input added during the gate refuses before writing a verdict", async () => {
  const root = makeRepo();
  const verdictPath = join(root, "gate-lane-verdict.json");
  const fakeBin = mkdtempSync(join(tmpdir(), "gate-fake-npm-"));
  const marker = join(tmpdir(), `gate-dirty-marker-${process.pid}-${Date.now()}`);
  const release = join(tmpdir(), `gate-dirty-release-${process.pid}-${Date.now()}`);
  const fakeNpm = join(fakeBin, "npm");
  write(fakeNpm, `#!/bin/sh\n: > "$OPENRIG_TEST_MARKER"\nwhile [ ! -e "$OPENRIG_TEST_RELEASE" ]; do sleep 0.02; done\nexit 0\n`);
  chmodSync(fakeNpm, 0o755);
  const port = await freePort();

  const child = spawn(process.execPath, [GATE_SCRIPT], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      OPENRIG_TEST_MARKER: marker,
      OPENRIG_TEST_RELEASE: release,
      OPENRIG_GATE_LANE_PORT: String(port),
      OPENRIG_GATE_VERDICT: verdictPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.on("close", resolve));

  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(marker)) write(release, "abort\n");
  assert.equal(existsSync(marker), true, "the real gate reached its first injected leg");
  write(join(root, "late-input.test.mjs"), "// introduced while the gate was running\n");
  write(release, "continue\n");

  const status = await closed;
  assertCandidateRefusal({ status, stdout, stderr }, /candidate.*dirty|late-input\.test\.mjs/i);
  assert.equal(existsSync(verdictPath), false, "a late-dirty run writes no verdict");
});
