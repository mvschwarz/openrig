import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { npmCommand } from "./npm-command.mjs";

test("native prepublish lifecycle uses the paired build runner without bash on PATH", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepublish-native-"));
  try {
    const cli = path.join(root, "packages/cli"), scripts = path.join(root, "scripts");
    const bin = path.join(root, "node bin"), programs = path.join(root, "owned programs");
    const bash = path.join(programs, "Git/bin");
    for (const dir of [cli, scripts, bin, bash]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(bin, "node.exe"));
    fs.copyFileSync(process.execPath, path.join(bash, "bash.exe"));
    fs.copyFileSync(new URL("./run-package-build.mjs", import.meta.url), path.join(scripts, "run-package-build.mjs"));
    const witness = path.join(root, "witness.json");
    fs.writeFileSync(path.join(scripts, "build-package.sh"), "require('fs').writeFileSync(process.env.OPENRIG_TEST_BUILD_WITNESS,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));");
    const manifest = JSON.parse(fs.readFileSync(new URL("../packages/cli/package.json", import.meta.url), "utf8"));
    fs.writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "owned-fixture", version: "0.0.0", scripts: { prepublishOnly: manifest.scripts.prepublishOnly } }));
    execFileSync(...npmCommand(["run", "prepublishOnly"]), {
      cwd: cli, timeout: 15000, windowsHide: true, stdio: "pipe",
      env: { ...process.env, PATH: bin, ProgramFiles: programs, ProgramW6432: programs, OPENRIG_TEST_BUILD_WITNESS: witness },
    });
    const result = JSON.parse(fs.readFileSync(witness, "utf8"));
    assert.equal(fs.realpathSync.native(result.cwd), fs.realpathSync.native(root));
    assert.deepEqual(result.args, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
