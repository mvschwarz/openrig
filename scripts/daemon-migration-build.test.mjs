import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const daemonPackage = JSON.parse(readFileSync(new URL("../packages/daemon/package.json", import.meta.url), "utf8"));

test("daemon build removes retired migration outputs before invoking the compiler", () => {
  const root = mkdtempSync(join(tmpdir(), "daemon-migration-build-"));
  try {
    const daemon = join(root, "packages", "daemon");
    const migrations = join(daemon, "dist", "db", "migrations");
    mkdirSync(migrations, { recursive: true });
    mkdirSync(join(daemon, "src", "db", "migrations"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(daemon, "scripts"), { recursive: true });
    writeFileSync(join(daemon, "scripts", "copy-workflow-specs.mjs"), "// Workflow asset copying is outside this compile-order fixture.");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(daemon, "package.json"), JSON.stringify({ name: "migration-build-fixture", version: "0.0.0", scripts: { ...daemonPackage.scripts } }));
    writeFileSync(join(migrations, "999_retired.js"), "compiled output with no source");
    writeFileSync(join(migrations, "999_retired.d.ts"), "retired declaration");
    writeFileSync(join(migrations, "999_retired.js.map"), "retired source map");
    writeFileSync(join(daemon, "src", "db", "migrations", "001_current.ts"), "current source");
    writeFileSync(join(daemon, "dist", "index.js"), "unrelated output");
    // Compilation is replaced at its process boundary; the build script and cleanup run unchanged.
    const compiler = join(root, "node_modules", ".bin", "tsc");
    writeFileSync(compiler, `#!/usr/bin/env node
const fs = require("node:fs");
const assert = require("node:assert/strict");
assert(!fs.existsSync("dist/db/migrations/999_retired.js"), "retired migration reached the compiler");
fs.mkdirSync("dist/db/migrations", { recursive: true });
fs.writeFileSync("dist/db/migrations/001_current.js", "current compiled output");
`);
    chmodSync(compiler, 0o755);
    writeFileSync(compiler + ".cmd", ["@echo off", `"${process.execPath}" "%~dp0tsc" %*`, ""].join(String.fromCharCode(13, 10)));
    writeFileSync(join(root, "scripts", "prepare-workspace-build.mjs"), "// Package preparation is outside this compile-order fixture.\n");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^npm_(?:config_(?:workspace|workspaces|prefix|local_prefix)|package_json)$/i.test(key)) delete env[key];
    execSync("npm --workspaces=false run build --silent", { cwd: daemon, env, stdio: "pipe" });
    assert(existsSync(join(migrations, "001_current.js")));
    for (const name of ["999_retired.js", "999_retired.d.ts", "999_retired.js.map"]) assert(!existsSync(join(migrations, name)), name);
    assert.equal(readFileSync(join(daemon, "src", "db", "migrations", "001_current.ts"), "utf8"), "current source");
    assert.equal(readFileSync(join(daemon, "dist", "index.js"), "utf8"), "unrelated output");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
