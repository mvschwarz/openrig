import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

test("guard CLIs execute from encoded and linked paths, while imports stay inert without argv", async () => {
  const root = await mkdtemp(join(tmpdir(), "openrig guard CLI-"));
  const scripts = join(root, "scripts space # 中文"), linked = join(root, "linked scripts");
  const call = (args) => spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true });
  try {
    await mkdir(scripts); await mkdir(join(root, "docs"));
    for (const name of ["check-docs-guard.mjs", "check-internal-leak-guard.mjs", "mirror-skills.mjs", "internal-leak-scanner.mjs", "leak-guard-rules.mjs"]) await copyFile(resolve("scripts", name), join(scripts, name));
    await symlink(scripts, linked, process.platform === "win32" ? "junction" : "dir");
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
    await writeFile(join(root, "docs/blocked.md"), "founder-only fixture\n");
    assert.equal(spawnSync("git", ["add", "docs/blocked.md"], { cwd: root }).status, 0);
    const rules = join(root, "rules.json");
    await writeFile(rules, JSON.stringify({ path_prefixes: ["private/"], seat_and_rig_patterns: ["operator-agent@"], host_patterns: ["mm2-"], charged_terms: ["founder"], internal_path_globs: ["*.internal.*"], allowed_context_substrings: ["do not ship"] }));
    for (const folder of [scripts, linked]) for (const flags of [[], ["--preserve-symlinks-main"]]) {
      for (const [name, args, pattern] of [
        ["check-docs-guard.mjs", [], /Blocked tracked docs paths/],
        ["check-internal-leak-guard.mjs", ["--repo", root, "--rules", rules, "--mode", "full"], /founder/],
        ["mirror-skills.mjs", ["--check"], /skill-edge-layout.generated.json/],
      ]) {
        const file = join(folder, name), result = call([...flags, file, ...args]);
        assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, pattern);
        const imported = call(["--input-type=module", "-e", `process.argv.length=1;await import(${JSON.stringify(pathToFileURL(file).href)});`]);
        assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout + imported.stderr, "");
      }
    }
  } finally { await rm(root, { recursive: true }); }
});

test("skill Git attributes preserve digest bytes with autocrlf and leave binary assets unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "openrig skill EOL-"));
  const git = (...args) => spawnSync("git", ["-c", "core.autocrlf=true", ...args], { cwd: root, encoding: "utf8" });
  try {
    assert.equal(git("init", "--quiet").status, 0);
    await copyFile(resolve(".gitattributes"), join(root, ".gitattributes"));
    const text = "first\nsecond\n", binary = Buffer.from([0, 13, 10, 255, 42]);
    const files = [];
    for (const folder of ["skills/_canonical/fixture", "packages/daemon/specs/agents/shared/skills/fixture", "packages/daemon/assets/plugins/openrig-core/skills/fixture"]) {
      await mkdir(join(root, folder), { recursive: true });
      await writeFile(join(root, folder, "SKILL.md"), text); await writeFile(join(root, folder, "asset.bin"), binary);
      files.push(folder + "/SKILL.md", folder + "/asset.bin");
    }
    assert.equal(git("add", ".").status, 0);
    for (const file of files) await rm(join(root, file));
    const checkout = git("checkout-index", "--all", "--force"); assert.equal(checkout.status, 0, checkout.stderr);
    for (const file of files) assert.deepEqual(await readFile(join(root, file)), file.endsWith(".md") ? Buffer.from(text) : binary);
  } finally { await rm(root, { recursive: true }); }
});
