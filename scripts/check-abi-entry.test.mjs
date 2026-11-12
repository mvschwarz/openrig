import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("native-cased ABI entry still executes its installed-addon check", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig ABI entry-"));
  try {
    const scripts = path.join(root, "scripts"), addon = path.join(root, "node_modules", "better-sqlite3");
    fs.mkdirSync(scripts); fs.mkdirSync(addon, { recursive: true });
    fs.copyFileSync(new URL("../packages/cli/scripts/check-abi.mjs", import.meta.url), path.join(scripts, "check-abi.mjs"));
    fs.writeFileSync(path.join(addon, "index.js"), 'throw new Error("owned ABI entry witness");');
    const result = spawnSync(process.execPath, [path.join(scripts, "CHECK-ABI.mjs")], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1, result.stderr || "ABI entry silently skipped");
    assert.match(result.stderr, /owned ABI entry witness/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a same-basename importer does not execute the ABI entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig ABI import-"));
  try {
    const scripts = path.join(root, "scripts"), runner = path.join(root, "runner"), addon = path.join(root, "node_modules", "better-sqlite3");
    fs.mkdirSync(scripts); fs.mkdirSync(runner); fs.mkdirSync(addon, { recursive: true });
    const entry = path.join(scripts, "check-abi.mjs");
    fs.copyFileSync(new URL("../packages/cli/scripts/check-abi.mjs", import.meta.url), entry);
    fs.writeFileSync(path.join(addon, "index.js"), 'throw new Error("must not load owned addon during import");');
    const importer = path.join(runner, "check-abi.mjs");
    fs.writeFileSync(importer, `const {checkAbi}=await import(${JSON.stringify(pathToFileURL(entry).href)}); console.log(typeof checkAbi);`);
    const result = spawnSync(process.execPath, [importer], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "function");
    assert.equal(result.stderr, "");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
