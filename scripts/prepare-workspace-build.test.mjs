import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
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
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
    prepareWorkspaceBuild(root, "cli", process.platform);
    for (const [name, content] of [["dist/schemas/spec.json", "{}"], ["dist/lib/scope-templates/team.md", "team"], ["LICENSE", "license"], ["README.md", "readme"]])
      assert.equal(readFileSync(path.join(root, "packages/cli", name), "utf8"), content);
    assert.throws(() => readFileSync(path.join(root, "packages/cli/dist/schemas/ignored.txt")));
    if (process.platform !== "win32") assert.equal(statSync(path.join(root, "packages/cli/dist/bin-wrapper.js")).mode & 0o111, 0o111);
    writeFileSync(path.join(root, "packages/cli/src/schemas/spec.json"), "updated");
    prepareWorkspaceBuild(root, "cli", process.platform);
    assert.equal(readFileSync(path.join(root, "packages/cli/dist/schemas/spec.json"), "utf8"), "updated");
  } finally { rmSync(root, { recursive: true, force: true }); }
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
