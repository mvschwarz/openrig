import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { composeDown } from "../packages/daemon/assets/plugins/openrig-core/skills/openrig-operating-model/scripts/compose-down.mjs";

const scripts = resolve("packages/daemon/assets/plugins/openrig-core/skills/openrig-operating-model/scripts");
const run = (args, env = process.env) => spawnSync(process.execPath, [join(scripts, "trunk-diff.mjs"), ...args], { encoding: "utf8", windowsHide: true, env });

test("native subtree diff updates its baseline after changes and protects it after failure", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "openrig trunk-")), root = join(fixture, "中文 source"), state = join(fixture, "last render.md");
  try {
    await mkdir(root); await writeFile(join(root, "SPEC.md"), "first authored version\n");
    const args = [root, state, "--name", "SPEC.md"];
    let result = run(args); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /first render/);
    result = run(args); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /no changes/);
    await writeFile(join(root, "SPEC.md"), "second authored version\n");
    result = run(args); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /-first authored version/); assert.match(result.stdout, /\+second authored version/);
    const previous = await readFile(state, "utf8");
    assert.match(previous, /second authored version/);
    assert.match(run(args).stdout, /no changes/);
    await writeFile(join(root, "SPEC.md"), "third authored version\n");
    const noGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")); noGit.PATH = "";
    result = run(args, noGit); assert.equal(result.status, 2); assert.match(result.stderr, /previous state retained/);
    assert.equal(await readFile(state, "utf8"), previous);
    await writeFile(state + ".lock", "other writer");
    assert.equal(run(args).status, 2); assert.equal(await readFile(state + ".lock", "utf8"), "other writer");
    assert.equal(await readFile(state, "utf8"), previous); await rm(state + ".lock");
    assert.deepEqual((await readdir(fixture)).sort(), ["last render.md", "中文 source"].sort());
    assert.equal(run([root, state, "--name", "../SPEC.md"]).status, 2);
    assert.equal(run([join(fixture, "absent"), state]).status, 2);
    assert.equal(await readFile(state, "utf8"), previous);
  } finally { assert.equal(fixture.startsWith(join(tmpdir(), "openrig trunk-")), true); await rm(fixture, { recursive: true }); }
});

test("native subtree render preserves audits and excludes hidden/dependency/linked trees", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "openrig subtree-")), root = join(fixture, "root"), outside = join(fixture, "outside");
  try {
    await mkdir(root); await mkdir(outside); await writeFile(join(outside, "SPEC.md"), "must stay outside");
    for (const name of [".hidden", "node_modules", "excluded", "authored", "template"]) await mkdir(join(root, name));
    for (const name of [".hidden", "node_modules", "excluded"]) await writeFile(join(root, name, "SPEC.md"), "excluded payload");
    const template = await readFile(join(scripts, "../templates/SPEC.md"));
    await writeFile(join(root, "template/SPEC.md"), template);
    await writeFile(join(root, "authored/SPEC.md"), "---\nstatus: UNSEEDED\n---\nreal content\n<!-- GENERATED discard me -->\n");
    await symlink(outside, join(root, "shortcut"), process.platform === "win32" ? "junction" : "dir");
    const text = await composeDown(root, ["SPEC.md"], [join(root, "exclude?")]);
    assert.match(text, /files: 2/); assert.match(text, /real content/); assert.match(text, /MARKER\/CONTENT DISAGREE/); assert.match(text, /scaffold only/);
    assert.doesNotMatch(text, /must stay outside|excluded payload|discard me/);
    assert.equal(await readFile(join(outside, "SPEC.md"), "utf8"), "must stay outside");
  } finally { await rm(fixture, { recursive: true }); }
});
