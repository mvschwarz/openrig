import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const GUARD = resolve("scripts/check-internal-leak-guard.mjs");

test("full mode scans tracked files and fails loudly on a planted leak", () => {
  requireGuard();
  withRepo((repo, rules) => {
    write(join(repo, "README.md"), "founder-only detail\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "tracked leak");

    const result = runGuard(repo, rules, "--mode", "full");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /README\.md/);
    assert.match(result.stderr, /founder/);
    assert.match(result.stderr, /line 1/i);
    assert.match(result.stderr, /sidecar|fence|genericize|host-only/i);
  });
});

test("full mode passes a clean tracked tree and ignores untracked files", () => {
  requireGuard();
  withRepo((repo, rules) => {
    write(join(repo, "README.md"), "public detail\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "clean");
    write(join(repo, "untracked.md"), "founder\n");

    const result = runGuard(repo, rules, "--mode", "full");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("staged mode reads index bytes rather than the worktree", () => {
  requireGuard();
  withRepo((repo, rules) => {
    write(join(repo, "README.md"), "clean\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");

    write(join(repo, "README.md"), "operator-agent@kernel\n");
    git(repo, "add", "README.md");
    write(join(repo, "README.md"), "clean worktree replacement\n");

    const result = runGuard(repo, rules, "--mode", "staged");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /operator-agent@/);
    assert.doesNotMatch(result.stderr, /clean worktree replacement/);
  });
});

test("staged mode handles rename and deletion without reading missing worktree paths", () => {
  requireGuard();
  withRepo((repo, rules) => {
    write(join(repo, "old.md"), "clean\n");
    write(join(repo, "delete.md"), "clean\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    git(repo, "mv", "old.md", "renamed.md");
    git(repo, "rm", "delete.md");

    const result = runGuard(repo, rules, "--mode", "staged");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("range mode scans exact committed bytes between from and to", () => {
  requireGuard();
  withRepo((repo, rules) => {
    write(join(repo, "README.md"), "clean\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");
    const from = git(repo, "rev-parse", "HEAD").trim();

    write(join(repo, "skills", "public", "SKILL.md"), "mm2-secret\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "leak");
    const to = git(repo, "rev-parse", "HEAD").trim();
    write(join(repo, "README.md"), "clean uncommitted replacement\n");

    const result = runGuard(
      repo,
      rules,
      "--mode",
      "range",
      "--from",
      from,
      "--to",
      to,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /skills\/public\/SKILL\.md/);
    assert.match(result.stderr, /mm2-/);
  });
});

test("range mode rejects a leak from an intermediate pushed commit even when cleaned at to", () => {
  requireGuard();
  withRepo((repo, rules) => {
    write(join(repo, "README.md"), "clean\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");
    const from = git(repo, "rev-parse", "HEAD").trim();

    write(join(repo, "README.md"), "founder-only intermediate\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "intermediate leak");

    write(join(repo, "README.md"), "clean again\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "clean tip");
    const to = git(repo, "rev-parse", "HEAD").trim();

    const result = runGuard(
      repo,
      rules,
      "--mode",
      "range",
      "--from",
      from,
      "--to",
      to,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /README\.md/);
    assert.match(result.stderr, /founder/);
  });
});

test("each explicit mode refuses a missing generated rules file", () => {
  requireGuard();
  withRepo((repo) => {
    write(join(repo, "README.md"), "clean\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");
    const head = git(repo, "rev-parse", "HEAD").trim();
    const missing = join(repo, "missing-rules.json");

    for (const args of [
      ["--mode", "full"],
      ["--mode", "staged"],
      ["--mode", "range", "--from", head, "--to", head],
    ]) {
      const result = runGuard(repo, missing, ...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing-rules\.json|rules/i);
    }
  });
});

test("each explicit mode refuses an empty generated rules object", () => {
  requireGuard();
  withRepo((repo) => {
    write(join(repo, "README.md"), "clean\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");
    const head = git(repo, "rev-parse", "HEAD").trim();
    const empty = join(repo, "empty-rules.json");
    writeFileSync(empty, "{}");

    for (const args of [
      ["--mode", "full"],
      ["--mode", "staged"],
      ["--mode", "range", "--from", head, "--to", head],
    ]) {
      const result = runGuard(repo, empty, ...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /rules|path_prefixes|invalid/i);
    }
  });
});

test("Plain B keeps guard enforcement out of root test:repo while fixture tests remain discovered", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const command = pkg.scripts["test:repo"];

  assert.match(command, /node --test scripts\/\*\.test\.mjs/);
  assert.doesNotMatch(command, /node scripts\/check-internal-leak-guard\.mjs/);
});

function withRepo(run) {
  const root = mkdtempSync(join(tmpdir(), "openrig-guard-red-"));
  const repo = join(root, "repo");
  const rules = join(root, "rules.json");
  mkdirSync(repo, { recursive: true });
  writeFileSync(rules, JSON.stringify(fixtureRules()));
  git(repo, "init");
  git(repo, "config", "user.email", "qa@example.invalid");
  git(repo, "config", "user.name", "QA");
  try {
    run(repo, rules);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function requireGuard() {
  assert.equal(
    existsSync(GUARD),
    true,
    "scripts/check-internal-leak-guard.mjs must exist",
  );
}

function runGuard(repo, rules, ...args) {
  return spawnSync(
    process.execPath,
    [GUARD, "--repo", repo, "--rules", rules, ...args],
    { cwd: repo, encoding: "utf8" },
  );
}

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixtureRules() {
  return {
    path_prefixes: ["openrig-work/"],
    seat_and_rig_patterns: ["operator-agent@"],
    host_patterns: ["mm2-"],
    charged_terms: ["founder"],
    internal_path_globs: ["*.internal.*", "**/internal/**", "*-internal/**"],
    allowed_context_substrings: ["do not ship"],
  };
}
