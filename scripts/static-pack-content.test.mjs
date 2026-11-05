import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createStaticContentResolver } from "./static-pack-content.mjs";

function fixture(run, format = "sha1") {
  const root = fs.mkdtempSync(path.join(tmpdir(), "openrig Git links 中文 "));
  const source = path.join(root, "packs"), reference = path.join(root, "docs/reference");
  const git = (args, input) => execFileSync("git", args, { cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try {
    fs.mkdirSync(source); fs.mkdirSync(reference, { recursive: true });
    git(["init", "--quiet", `--object-format=${format}`]); git(["config", "core.symlinks", "false"]);
    const placeholder = (name, target) => {
      const oid = git(["hash-object", "-w", "--stdin"], target).trim();
      git(["update-index", "--add", "--cacheinfo", `120000,${oid},packs/${name}`]);
      git(["checkout-index", "--force", "--", `packs/${name}`]);
      return path.join(source, name);
    };
    const resolver = () => createStaticContentResolver({ repoRoot: root, sourceRoot: source, referenceRoot: reference, platform: "win32" });
    run({ root, source, reference, git, placeholder, resolver });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const format of ["sha1", "sha256"]) test(`${format} Git placeholder resolves target bytes; ordinary path-looking text remains content`, () => fixture(({ source, reference, git, placeholder, resolver }) => {
  const target = path.join(reference, "guide space 中文.md"), body = Buffer.from("# Actual document\r\n中文\n");
  fs.writeFileSync(target, body);
  const file = placeholder("guide.md", "../docs/reference/guide space 中文.md");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  const ordinary = path.join(source, "ordinary.md"); fs.writeFileSync(ordinary, "../docs/reference/guide space 中文.md");
  git(["add", "packs/ordinary.md"]);
  const resolve = resolver();
  assert.deepEqual(fs.readFileSync(resolve(file)), body);
  assert.equal(resolve(ordinary), ordinary);
  fs.writeFileSync(file, "../docs/reference/edited.md");
  assert.throws(() => resolve(file), /differs from its index entry/);
}, format));

test("placeholder outside reference, through an escaping junction, to a directory or missing target refuses", () => fixture(({ root, reference, placeholder, resolver }) => {
  fs.writeFileSync(path.join(root, "outside.md"), "outside canary");
  const outsideDir = path.join(root, "outside"); fs.mkdirSync(outsideDir); fs.writeFileSync(path.join(outsideDir, "canary.md"), "outside");
  fs.symlinkSync(outsideDir, path.join(reference, "jump"), process.platform === "win32" ? "junction" : "dir");
  for (const [name, target] of [["outside.md", "../outside.md"], ["jump.md", "../docs/reference/jump/canary.md"], ["directory.md", "../docs/reference"], ["missing.md", "../docs/reference/missing.md"]]) {
    const file = placeholder(name, target);
    assert.throws(() => resolver()(file));
  }
  assert.equal(fs.readFileSync(path.join(root, "outside.md"), "utf8"), "outside canary");
}));

test("an unmerged index never becomes a cached plain-file fallback", () => fixture(({ reference, git, placeholder, resolver }) => {
  fs.writeFileSync(path.join(reference, "guide.md"), "actual body");
  const file = placeholder("guide.md", "../docs/reference/guide.md");
  const oid = git(["hash-object", "--stdin"], "../docs/reference/guide.md").trim();
  git(["update-index", "--force-remove", "--", "packs/guide.md"]);
  git(["update-index", "--index-info"], `120000 ${oid} 1\tpacks/guide.md\n`);
  const resolve = resolver();
  assert.throws(() => resolve(file), /Unmerged/);
  assert.throws(() => resolve(file), /Unmerged/);
}));

test("native mixed root spellings still resolve indexed placeholders to reference bytes", { skip: process.platform !== "win32" }, () => fixture(({ root, source, reference, placeholder }) => {
  const target = path.join(reference, "owned.md"); fs.writeFileSync(target, "owned reference content\n");
  const file = placeholder("owned.md", "../docs/reference/owned.md");
  const resolve = createStaticContentResolver({ repoRoot: root, sourceRoot: fs.realpathSync.native(source),
    referenceRoot: fs.realpathSync.native(reference), platform: "win32" });
  assert.equal(fs.readFileSync(resolve(fs.realpathSync.native(file)), "utf8"), "owned reference content\n");
}));
