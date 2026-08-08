import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE_SCRIPT = fileURLToPath(new URL("./gate-lane.mjs", import.meta.url));
const CONSUMER_SCRIPT = fileURLToPath(new URL("./gate-lane-consume.mjs", import.meta.url));

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function makeRepo({ lockEntries = true, dependencyRoot = "exact" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gate-hermeticity-"));
  write(join(root, ".gitignore"), "node_modules/\npackages/cli/daemon/\n");
  write(join(root, "package.json"), '{"private":true}\n');
  write(join(root, "packages/cli/index.js"), "export {};\n");
  write(join(root, "packages/other/index.js"), "export {};\n");
  const packages = lockEntries
    ? {
        "": { workspaces: ["packages/cli"] },
        "node_modules/@openrig/cli": { resolved: "packages/cli", link: true },
        "packages/cli": { name: "@openrig/cli" },
      }
    : { "": { workspaces: [] } };
  write(join(root, "package-lock.json"), `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages }, null, 2)}\n`);

  if (dependencyRoot === "symlink") {
    const foreign = mkdtempSync(join(tmpdir(), "gate-hermeticity-root-"));
    mkdirSync(join(foreign, "node_modules"), { recursive: true });
    symlinkSync(join(foreign, "node_modules"), join(root, "node_modules"));
  } else if (dependencyRoot !== "absent") {
    mkdirSync(join(root, "node_modules/@openrig"), { recursive: true });
    const target = dependencyRoot === "swapped"
      ? "../../packages/other"
      : dependencyRoot === "cross-tree"
        ? join(mkdtempSync(join(tmpdir(), "gate-hermeticity-cross-")), "packages/cli")
        : "../../packages/cli";
    if (dependencyRoot === "cross-tree") mkdirSync(target, { recursive: true });
    symlinkSync(target, join(root, "node_modules/@openrig/cli"));
  }

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

async function runGate(root) {
  const port = await freePort();
  return spawnSync(process.execPath, [GATE_SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENRIG_GATE_LANE_PORT: String(port),
      OPENRIG_GATE_LANE_SMOKE: "1",
      OPENRIG_GATE_VERDICT: join(root, "gate-lane-verdict.json"),
    },
  });
}

function assertHermeticRefusal(result, pattern) {
  assert.notEqual(result.status, 0, `gate must refuse\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

test("dependency root: absent node_modules refuses before the gate mutates", async () => {
  const result = await runGate(makeRepo({ dependencyRoot: "absent" }));
  assertHermeticRefusal(result, /node_modules.*absent|missing dependency root/i);
});

test("dependency root: a symlinked node_modules root refuses", async () => {
  const root = makeRepo({ dependencyRoot: "symlink" });
  const sentinel = join(root, "packages/cli/daemon/sentinel.txt");
  write(sentinel, "must survive refusal\n");
  const result = await runGate(root);
  assertHermeticRefusal(result, /node_modules.*symlink/i);
  assert.equal(existsSync(sentinel), true, "the hermeticity refusal runs before cleanup mutation");
});

test("dependency root: a scoped link escaping to another tree refuses and prints both operands", async () => {
  const result = await runGate(makeRepo({ dependencyRoot: "cross-tree" }));
  assertHermeticRefusal(result, /@openrig\/cli[\s\S]*actual[\s\S]*expected/i);
});

test("dependency root: a scoped link swapped to another in-tree package refuses", async () => {
  const result = await runGate(makeRepo({ dependencyRoot: "swapped" }));
  assertHermeticRefusal(result, /@openrig\/cli[\s\S]*packages\/other[\s\S]*packages\/cli/i);
});

test("dependency root: a lock deriving zero scoped links refuses instead of vacuously passing", async () => {
  const result = await runGate(makeRepo({ lockEntries: false }));
  assertHermeticRefusal(result, /zero|no scoped @openrig/i);
});

test("dependency root: exact lock-derived target passes and prints the actual/expected pair", async () => {
  const result = await runGate(makeRepo());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /@openrig\/cli[\s\S]*actual[\s\S]*expected/i);
  assert.match(result.stdout, /packages\/cli/i);
});

test("dependency root: a later refusal invalidates a same-HEAD prior PASS", async () => {
  const root = makeRepo();
  const verdictPath = join(root, "gate-lane-verdict.json");
  const first = await runGate(root);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(verdictPath), true, "the first gate writes a PASS receipt");

  rmSync(join(root, "node_modules/@openrig/cli"), { force: true });
  symlinkSync("../../packages/other", join(root, "node_modules/@openrig/cli"));

  const second = await runGate(root);
  assertHermeticRefusal(second, /@openrig\/cli[\s\S]*packages\/other[\s\S]*packages\/cli/i);
  assert.equal(existsSync(verdictPath), false, "the refused retry invalidates the prior PASS");
  const consume = spawnSync(process.execPath, [CONSUMER_SCRIPT, verdictPath], { cwd: root, encoding: "utf8" });
  assert.notEqual(consume.status, 0, "the prior PASS is no longer consumable");
  assert.match(`${consume.stdout}\n${consume.stderr}`, /verdict.*missing/i);
});

test("dependency root: drift during the gate refuses before writing a verdict", async () => {
  const root = makeRepo();
  const verdictPath = join(root, "gate-lane-verdict.json");
  const fakeBin = mkdtempSync(join(tmpdir(), "gate-hermeticity-fake-npm-"));
  const marker = join(tmpdir(), `gate-root-marker-${process.pid}-${Date.now()}`);
  const release = join(tmpdir(), `gate-root-release-${process.pid}-${Date.now()}`);
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
  rmSync(join(root, "node_modules/@openrig/cli"), { force: true });
  symlinkSync("../../packages/other", join(root, "node_modules/@openrig/cli"));
  write(release, "continue\n");

  const status = await closed;
  assertHermeticRefusal({ status, stdout, stderr }, /@openrig\/cli[\s\S]*packages\/other[\s\S]*packages\/cli|gate-hermeticity/i);
  assert.equal(existsSync(verdictPath), false, "a late dependency-root drift writes no verdict");
});
