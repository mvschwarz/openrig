import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONSUMER = fileURLToPath(new URL("./gate-lane-consume.mjs", import.meta.url));

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "gate-consume-"));
  write(join(root, "tracked.txt"), "one\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "gate@example.invalid");
  git(root, "config", "user.name", "Gate Test");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return { root, head: git(root, "rev-parse", "HEAD"), verdictPath: join(root, "gate-lane-verdict.json") };
}

function runConsumer(root, verdictPath) {
  return spawnSync(process.execPath, [CONSUMER, verdictPath], { cwd: root, encoding: "utf8" });
}

function assertRefused(result, verdictPath, pattern) {
  assert.notEqual(result.status, 0, `consumer must refuse\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
  if (verdictPath) assert.equal(existsSync(verdictPath), true, "a refused verdict is retained");
}

function put(path, value) {
  write(path, `${JSON.stringify(value)}\n`);
}

test("consumer refuses loudly when no verdict exists", () => {
  const { root, verdictPath } = makeRepo();
  const result = runConsumer(root, verdictPath);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /verdict.*(missing|does not exist)/i);
});

test("consumer refuses and retains a verdict with no candidateSha", () => {
  const { root, verdictPath } = makeRepo();
  put(verdictPath, { gate: "pass", smoke: false });
  assertRefused(runConsumer(root, verdictPath), verdictPath, /candidateSha.*required|missing.*candidateSha/i);
});

test("consumer derives current HEAD and refuses a stale candidateSha", () => {
  const { root, head, verdictPath } = makeRepo();
  put(verdictPath, { candidateSha: head, gate: "pass", smoke: false });
  write(join(root, "tracked.txt"), "two\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "move head");
  assertRefused(runConsumer(root, verdictPath), verdictPath, /candidateSha.*(mismatch|does not match)|current HEAD/i);
});

test("consumer refuses and retains a matching-SHA failed verdict", () => {
  const { root, head, verdictPath } = makeRepo();
  put(verdictPath, { candidateSha: head, gate: "fail", smoke: false });
  assertRefused(runConsumer(root, verdictPath), verdictPath, /gate.*pass/i);
});

test("consumer refuses and retains a smoke:true verdict", () => {
  const { root, head, verdictPath } = makeRepo();
  put(verdictPath, { candidateSha: head, gate: "pass", smoke: true });
  assertRefused(runConsumer(root, verdictPath), verdictPath, /smoke.*false|real gate/i);
});

test("consumer refuses and retains a verdict whose smoke field is absent", () => {
  const { root, head, verdictPath } = makeRepo();
  put(verdictPath, { candidateSha: head, gate: "pass" });
  assertRefused(runConsumer(root, verdictPath), verdictPath, /smoke.*false|missing.*smoke/i);
});

test("consumer honors only a matching real PASS and removes the consumed artifact", () => {
  const { root, head, verdictPath } = makeRepo();
  put(verdictPath, { candidateSha: head, gate: "pass", smoke: false });
  const result = runConsumer(root, verdictPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /consum|honor/i);
  assert.match(result.stdout, new RegExp(head));
  assert.equal(existsSync(verdictPath), false, "successful consume removes the verdict");
});
