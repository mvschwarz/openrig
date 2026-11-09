import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const entrypoints = ["check-docs-guard.mjs", "check-internal-leak-guard.mjs", "mirror-skills.mjs"];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "openrig scripts # "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  for (const file of [...entrypoints, "internal-leak-scanner.mjs", "leak-guard-rules.mjs"]) {
    copyFileSync(new URL(file, import.meta.url), join(scripts, file));
  }
  const env = { ...process.env };
  delete env.OPENRIG_LEAK_GUARD_RULES;
  return {
    root,
    run: (file, ...args) => spawnSync(process.execPath, [join(scripts, file), ...args], {
      cwd: root, encoding: "utf8", env,
    }),
  };
}

test("docs guard rejects tracked plans from a checkout path containing spaces and #", (t) => {
  const { root, run } = fixture(t);
  mkdirSync(join(root, "docs/plans"), { recursive: true });
  writeFileSync(join(root, "docs/plans/example.md"), "local plan\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  const result = run("check-docs-guard.mjs");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /docs\/plans\/example\.md/);
});

test("leak guard reports a missing rules file instead of silently succeeding", (t) => {
  const { root, run } = fixture(t);
  const result = run("check-internal-leak-guard.mjs", "--repo", root, "--rules", join(root, "missing.json"), "--mode", "full");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Rules file not found/);
});

test("mirror check reports missing generated inputs instead of silently succeeding", (t) => {
  const { run } = fixture(t);
  const result = run("mirror-skills.mjs", "--check");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ENOENT.*skill-edge-layout\.generated\.json/);
});

for (const file of entrypoints) {
  for (const args of [[], ["missing-entrypoint.mjs"]]) {
    test(`${file} can be imported with ${args.length ? "a nonexistent" : "no"} entrypoint argument`, (t) => {
      const { root } = fixture(t);
      const url = pathToFileURL(join(root, "scripts", file)).href;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`, ...args], {
        cwd: root, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });
  }
}

for (const [file, args, error] of [
  ["check-docs-guard.mjs", [], /not a git repository/],
  ["check-internal-leak-guard.mjs", ["--repo", ".", "--rules", "missing.json", "--mode", "full"], /Rules file not found/],
  ["mirror-skills.mjs", ["--check"], /ENOENT.*skill-edge-layout\.generated\.json/],
]) {
  test(`${file} runs through a preserved symlink`, (t) => {
    const { root } = fixture(t);
    const link = join(root, "scripts", "linked.mjs");
    symlinkSync(file, link);
    const result = spawnSync(process.execPath, ["--preserve-symlinks-main", link, ...args], {
      cwd: root, encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, error);
  });
}
