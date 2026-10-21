import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, symlinkSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareWorkspaceBuild } from "./prepare-workspace-build.mjs";

test("CLI build copies assets and root documents without shell utilities", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "openrig-build-assets-"));
  try {
    for (const dir of ["packages/cli/dist", "packages/cli/src/schemas", "packages/cli/src/lib/scope-templates"])
      mkdirSync(path.join(root, dir), { recursive: true });
    const files = {
      "LICENSE": "license", "README.md": "readme", "packages/cli/dist/bin-wrapper.js": "entry",
      "packages/cli/src/schemas/spec.json": "{}", "packages/cli/src/schemas/ignored.txt": "ignore",
      "packages/cli/src/lib/scope-templates/team.md": "team",
      "packages/cli/src/schemas/.hidden.json": "hidden schema",
      "packages/cli/src/lib/scope-templates/.hidden.md": "hidden template",
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
    prepareWorkspaceBuild(root, "cli", process.platform);
    for (const [name, content] of [["dist/schemas/spec.json", "{}"], ["dist/lib/scope-templates/team.md", "team"], ["LICENSE", "license"], ["README.md", "readme"]])
      assert.equal(readFileSync(path.join(root, "packages/cli", name), "utf8"), content);
    assert.throws(() => readFileSync(path.join(root, "packages/cli/dist/schemas/ignored.txt")));
    assert.equal(existsSync(path.join(root, "packages/cli/dist/schemas/.hidden.json")), false);
    assert.equal(existsSync(path.join(root, "packages/cli/dist/lib/scope-templates/.hidden.md")), false);
    if (process.platform !== "win32") assert.equal(statSync(path.join(root, "packages/cli/dist/bin-wrapper.js")).mode & 0o111, 0o111);
    writeFileSync(path.join(root, "packages/cli/src/schemas/spec.json"), "updated");
    prepareWorkspaceBuild(root, "cli", process.platform);
    assert.equal(readFileSync(path.join(root, "packages/cli/dist/schemas/spec.json"), "utf8"), "updated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function cliFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "openrig-build-selection-"));
  for (const dir of ["packages/cli/dist", "packages/cli/src/schemas", "packages/cli/src/lib/scope-templates"])
    mkdirSync(path.join(root, dir), { recursive: true });
  for (const name of ["LICENSE", "README.md", "packages/cli/dist/bin-wrapper.js"])
    writeFileSync(path.join(root, name), "fixture");
  return root;
}

test("CLI preparation follows file symlinks like the old cp glob", t => {
  const root = cliFixture();
  try {
    writeFileSync(path.join(root, "schema-source.txt"), "linked schema");
    writeFileSync(path.join(root, "template-source.txt"), "linked template");
    try {
      symlinkSync(path.join(root, "schema-source.txt"), path.join(root, "packages/cli/src/schemas/linked.json"), "file");
      symlinkSync(path.join(root, "template-source.txt"), path.join(root, "packages/cli/src/lib/scope-templates/linked.md"), "file");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
        t.skip("Windows file-symlink privilege unavailable; requires POSIX validation"); return;
      }
      throw error;
    }
    prepareWorkspaceBuild(root, "cli");
    assert.equal(readFileSync(path.join(root, "packages/cli/dist/schemas/linked.json"), "utf8"), "linked schema");
    assert.equal(readFileSync(path.join(root, "packages/cli/dist/lib/scope-templates/linked.md"), "utf8"), "linked template");
    assert.equal(statSync(path.join(root, "packages/cli/dist/schemas/linked.json")).isFile(), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI preparation fails when a source glob would have no matches", () => {
  for (const [source, other, extension] of [
    ["src/schemas", "src/lib/scope-templates/team.md", ".json"],
    ["src/lib/scope-templates", "src/schemas/spec.json", ".md"],
  ]) {
    const root = cliFixture();
    try {
      writeFileSync(path.join(root, "packages/cli", other), "fixture");
      writeFileSync(path.join(root, "packages/cli", source, `.hidden${extension}`), "not a glob match");
      assert.throws(() => prepareWorkspaceBuild(root, "cli"), /No .* files matched/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("TUI preparation requires the compiled entry and rejects unknown workspaces", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "openrig-build-tui-"));
  try {
    assert.throws(() => prepareWorkspaceBuild(root, "tui"), /ENOENT/);
    mkdirSync(path.join(root, "packages/tui/dist"), { recursive: true });
    writeFileSync(path.join(root, "packages/tui/dist/main.js"), "entry");
    prepareWorkspaceBuild(root, "tui", process.platform);
    if (process.platform !== "win32") assert.equal(statSync(path.join(root, "packages/tui/dist/main.js")).mode & 0o111, 0o111);
    assert.throws(() => prepareWorkspaceBuild(root, "other"), /Unknown workspace/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
