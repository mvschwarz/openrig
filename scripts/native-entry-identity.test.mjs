import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
for (const [file, diagnostic] of [
  ["check-docs-guard.mjs", /Blocked tracked docs paths/],
  ["check-packaged-plugin-versions.mjs", /usage: check-packaged-plugin-versions/],
  ["gate-lane-consume.mjs", /cannot derive current HEAD/],
]) test(`native direct entry through directory aliases still runs ${file}`, { skip: process.platform !== "win32" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-entry-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "scripts"); fs.mkdirSync(dir);
  const config = path.join(root, "empty.gitconfig"); fs.writeFileSync(config, "");
  const env = { ...process.env, HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: "0" };
  fs.copyFileSync(path.join(scripts, file), path.join(dir, file));
  if (file === "check-packaged-plugin-versions.mjs") {
    fs.mkdirSync(path.join(dir, "fixtures"));
    fs.copyFileSync(path.join(scripts, "fixtures/packaged-plugins-last-release.json"), path.join(dir, "fixtures/packaged-plugins-last-release.json"));
  }
  execFileSync("git", ["init", "--template=", root], { stdio: "pipe", env });
  fs.mkdirSync(path.join(root, "docs")); fs.writeFileSync(path.join(root, "docs/blocked.md"), "owned fixture");
  execFileSync("git", ["-C", root, "-c", "core.hooksPath=NUL", "add", "docs/blocked.md"], { stdio: "pipe", env });
  const alias = path.join(root, "directory alias"); fs.symlinkSync(dir, alias, "junction");
  for (const entry of [path.join(dir, file), path.join(alias, file)]) {
    const result = spawnSync(process.execPath, [entry], { cwd: root, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 1, `${entry}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, diagnostic);
  }
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.join(alias, file)).href)})`],
    { cwd: root, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, ""); assert.equal(imported.stderr, "");
});
