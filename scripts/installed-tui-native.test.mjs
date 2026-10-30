import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npmCommand } from "./npm-command.mjs";

test("installed native npm TUI shim starts and exits an isolated demo", {
  skip: process.platform !== "win32" || process.env.RUN_NATIVE_INSTALLED_TUI !== "1"
    ? "opt-in RUN_NATIVE_INSTALLED_TUI=1; requires an assembled native CLI package" : false,
}, async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(repository, "packages", "cli");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed TUI owned-"));
  const prefix = path.join(root, "prefix"), home = path.join(root, "home");
  fs.mkdirSync(home);
  try {
    const packed = JSON.parse(execFileSync(...npmCommand(["pack", "--ignore-scripts", "--json", "--pack-destination", root]), { cwd: cli, encoding: "utf8" }));
    const tarball = path.join(root, packed[0].filename);
    execFileSync(...npmCommand(["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", tarball]), { cwd: root, stdio: "pipe", timeout: 120_000 });
    const modules = execFileSync(...npmCommand(["root", "-g", "--prefix", prefix]), { cwd: root, encoding: "utf8" }).trim();
    const relative = path.relative(prefix, modules);
    assert.ok(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
    const installed = path.join(modules, "@openrig", "cli");
    const shim = path.join(prefix, "openrig-tui.cmd");
    assert.ok(fs.statSync(shim).isFile());
    const env = {
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
      ComSpec: process.env.ComSpec, PATH: path.dirname(process.execPath), PATHEXT: ".EXE;.CMD",
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
      OPENRIG_HOME: home, OPENRIG_TEST_TUI_COMMAND: shim,
      OPENRIG_TEST_TUI_SOCKET: path.join(home, "owned-demo.sock"), NO_COLOR: "1",
    };
    const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const stdout = execFileSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "& $env:OPENRIG_TEST_TUI_COMMAND --demo --socket $env:OPENRIG_TEST_TUI_SOCKET; exit $LASTEXITCODE"],
    { cwd: home, env, input: "q", encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    assert.ok(stdout.includes("\x1b[?1049h"), "installed TUI must enter its terminal screen");
    assert.ok(stdout.includes("\x1b[?1049l"), "installed TUI must restore its terminal screen on quit");
    const { resolveTuiCliEntry } = await import(pathToFileURL(path.join(installed, "tui/dist/cli-command.js")).href);
    assert.equal(resolveTuiCliEntry({}), fs.realpathSync.native(path.join(installed, "dist/index.js")));
    const { BUILD_INFO } = await import(pathToFileURL(path.join(installed, "dist/build-info.js")).href);
    console.log(JSON.stringify({ installedBuild: BUILD_INFO, pairedCli: true, demoEnteredAndRestored: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
