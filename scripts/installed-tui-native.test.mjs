import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npmCommand } from "./npm-command.mjs";

test("installed native npm TUI shim supports owned demo and connected reads", {
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
    const { spawnWindowsJobProcess } = await import(pathToFileURL(path.join(installed, "daemon/dist/domain/windows-job-process.js")).href);
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, path: request.url });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/api/rigs/summary") response.end("[]");
      else { response.statusCode = 404; response.end('{"error":"owned fixture has no data for this read"}'); }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    let child;
    try {
      child = spawnWindowsJobProcess(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "& $env:OPENRIG_TEST_TUI_COMMAND --url $env:OPENRIG_TEST_TUI_URL --socket $env:OPENRIG_TEST_TUI_SOCKET; exit $LASTEXITCODE"],
      { cwd: home, env: { ...env, OPENRIG_TEST_TUI_URL: url, OPENRIG_TEST_TUI_SOCKET: path.join(home, "connected.sock") }, stdio: ["pipe", "pipe", "pipe"] });
      const exited = once(child, "exit");
      let rendered = "", errors = "";
      child.stdout.on("data", bytes => { rendered = (rendered + bytes).slice(-2 * 1024 * 1024); });
      child.stderr.on("data", bytes => { errors = (errors + bytes).slice(-8192); });
      const deadline = Date.now() + 10000;
      // The first summary is startup; a second summary proves entry into the
      // connected work read lane. Other endpoints intentionally remain 404.
      while (requests.filter(request => request.path === "/api/rigs/summary").length < 2
        && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(requests.filter(request => request.path === "/api/rigs/summary").length >= 2, `connected reads unavailable: ${errors}`);
      assert.ok(requests.every(request => request.method === "GET"), "entering connected work must not send a mutation");
      child.stdin.end("q");
      let exitTimer;
      const code = await Promise.race([exited.then(([code]) => code), new Promise(resolve => { exitTimer = setTimeout(() => resolve("timeout"), 5000); })])
        .finally(() => clearTimeout(exitTimer));
      assert.equal(code, 0, errors);
      assert.ok(rendered.includes("\x1b[?1049h") && rendered.includes("\x1b[?1049l"));
      console.log(JSON.stringify({ installedBuild: BUILD_INFO, pairedCli: true, demoEnteredAndRestored: true, connectedSummaryReads: requests.filter(request => request.path === "/api/rigs/summary").length, onlyGetRequests: true }));
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "close"); }
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
