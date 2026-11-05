import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { npmCommand } from "./npm-command.mjs";

test("the CLI build carries the unchanged repository LICENSE and README into npm pack", () => {
  const root = mkdtempSync(join(tmpdir(), "cli-license-"));
  try {
    const cli = join(root, "packages/cli");
    const bin = join(root, "bin");
    for (const dir of [cli, bin, join(cli, "src/schemas"), join(cli, "src/lib/scope-templates")]) mkdirSync(dir, { recursive: true });
    copyFileSync("LICENSE", join(root, "LICENSE"));
    copyFileSync("README.md", join(root, "README.md"));
    copyFileSync("packages/cli/package.json", join(cli, "package.json"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync("scripts/prepare-workspace-build.mjs", join(root, "scripts/prepare-workspace-build.mjs"));
    writeFileSync(join(cli, "src/schemas/fixture.json"), "{}\n");
    writeFileSync(join(cli, "src/lib/scope-templates/fixture.md"), "fixture\n");
    mkdirSync(join(cli, "dist"), { recursive: true });
    writeFileSync(join(cli, "dist/index.js"), 'export function createProgram(){let write;return {configureHelp(){return this},configureOutput(io){write=io.writeOut;return this},outputHelp(){write("Usage: rig\\n")}}}\n');
    // Compilation is outside this packaging regression. Run the actual build
    // script with its expected compiler output, then npm's real file selection.
    if (process.platform === "win32") {
      writeFileSync(join(bin, "compiler.cjs"), "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/bin-wrapper.js','// compiler fixture\\n');");
      writeFileSync(join(bin, "tsc.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0compiler.cjs"\r\n`);
    } else {
      writeFileSync(join(bin, "tsc"), "#!/bin/sh\nmkdir -p dist\nprintf '%s\\n' '// compiler fixture' > dist/bin-wrapper.js\n");
      chmodSync(join(bin, "tsc"), 0o755);
    }
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    execFileSync(...npmCommand(["run", "build"]), { cwd: cli, env, stdio: "pipe" });
    const source = readFileSync(join(root, "LICENSE"));
    assert.deepEqual(readFileSync(join(cli, "LICENSE")), source, "build must stage the repository license verbatim");
    const packed = JSON.parse(execFileSync(...npmCommand(["pack", "--ignore-scripts", "--json"]), { cwd: cli, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
    assert.ok(packed[0].files.some((file) => file.path === "LICENSE"), "npm archive must include LICENSE");
    assert.ok(packed[0].files.some((file) => file.path === "dist/root-help.txt"), "npm archive must include the generated complete root help");
    assert.equal(readFileSync(join(cli, "dist/root-help.txt"), "utf8"), "Usage: rig\n");
    const bytes = execFileSync("tar", ["-xOf", join(cli, packed[0].filename), "package/LICENSE"]);
    assert.deepEqual(bytes, source, "packed license must equal the existing root bytes");
    // npm shows the package-root README on the registry page; without it the page reads "No README data found".
    const readme = readFileSync(join(root, "README.md"));
    assert.ok(packed[0].files.some((file) => file.path === "README.md"), "npm archive must include README.md");
    const readmeBytes = execFileSync("tar", ["-xOf", join(cli, packed[0].filename), "package/README.md"]);
    assert.deepEqual(readmeBytes, readme, "packed README must equal the existing root bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
