"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

function pairedPowerShell(candidate, text) {
  const bridge = '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0rig.ps1" %*\r\n';
  if (text !== bridge) return null;
  const source = fs.readFileSync(path.join(path.dirname(candidate), "rig.ps1"), "utf8");
  const failurePrefix = "$global:LASTEXITCODE = 1\n$ErrorActionPreference = 'Stop'\n";
  const safe = source.startsWith("\uFEFF" + failurePrefix);
  const body = source.slice(1 + (safe ? failurePrefix.length : 0));
  const entry = /^\$openrigQuoted = foreach \(\$openrigWord in \(@\(('(?:[^']|'')*')\) \+ @\(\$args\)\)\) \{$/.exec(body.split("\n")[0]);
  const executable = /^\$openrigStart\.FileName = ('(?:[^']|'')*')$/m.exec(body);
  if (!entry || !executable) throw Error("Unrecognized Windows paired PowerShell shim");
  const unquote = value => value.slice(1, -1).replaceAll("''", "'");
  const q = value => "'" + value.replaceAll("'", "''") + "'";
  const cli = unquote(entry[1]), interpreter = unquote(executable[1]);
  // Finite complete generated grammar, not execution or arbitrary script parsing.
  const expected = "\uFEFF" + (safe ? failurePrefix : "")
    + `$openrigQuoted = foreach ($openrigWord in (@(${q(cli)}) + @($args))) {\n`
    + String.raw`  '"' + [regex]::Replace([regex]::Replace([string]$openrigWord, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'` + "\n}\n"
    + "$openrigStart = New-Object System.Diagnostics.ProcessStartInfo\n$openrigStart.UseShellExecute = $false\n"
    + `$openrigStart.FileName = ${q(interpreter)}\n$openrigStart.Arguments = $openrigQuoted -join ' '\n`
    + "$openrigStart.WorkingDirectory = (Get-Location).ProviderPath\n"
    + "$openrigChild = [Diagnostics.Process]::Start($openrigStart)\ntry { $openrigChild.WaitForExit(); $global:LASTEXITCODE = $openrigChild.ExitCode } finally { $openrigChild.Dispose() }\nexit $LASTEXITCODE\n";
  if (source !== expected) throw Error("Unrecognized Windows paired PowerShell shim");
  return { interpreter, cli, versions: [safe ? "\0windows-seat-bin-v5" : "\0windows-seat-bin-v4"] };
}

// SeatLaunchEnvironment also supplies a rig-only bin for the CLI paired with
// the launching daemon. Recognize that exact generated form, never execute it.
function pairedSeatRig(candidate) {
  const text = fs.readFileSync(candidate, "utf8");
  const powershell = pairedPowerShell(candidate, text);
  const modern = /^@echo off\r?\nsetlocal DisableDelayedExpansion\r?\n"([^"\r\n]+)" "([^"\r\n]+)" %\*\r?\n$/.exec(text);
  const words = modern || /^@echo off\r?\n"([^"%\r\n]+)" "([^"%\r\n]+)" %\*\r?\n$/.exec(text);
  if (!words && !powershell) return null;
  const literalPath = value => {
    if (!modern) return value;
    if (value.replaceAll("%%", "").includes("%")) throw new Error("Unrecognized Windows seat rig path escape");
    return value.replaceAll("%%", "%");
  };
  const interpreter = fs.realpathSync(powershell ? powershell.interpreter : literalPath(words[1]));
  const cli = fs.realpathSync(powershell ? powershell.cli : literalPath(words[2]));
  const directory = path.dirname(candidate);
  const versions = powershell ? powershell.versions : modern ? ["\0windows-seat-bin-v2", "\0windows-seat-bin-v3"] : [""];
  const digests = versions.map(version => createHash("sha256").update(cli).update(version).digest("hex"));
  if (path.relative(interpreter, fs.realpathSync(process.execPath)) !== ""
    || !digests.includes(path.basename(directory))
    || path.basename(path.dirname(directory)) !== "seat-bin"
    || path.basename(path.dirname(path.dirname(directory))) !== "run") throw new Error("Unrecognized Windows seat rig shim");
  const root = path.resolve(path.dirname(cli), "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.rig;
  if (manifest.name !== "@openrig/cli" || typeof entry !== "string" || path.isAbsolute(entry)) throw new Error("Unrecognized paired rig package");
  const declared = path.resolve(root, entry), relative = path.relative(root, declared);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
    || path.relative(fs.realpathSync(declared), cli) !== "" || !fs.statSync(cli).isFile()) throw new Error("Unrecognized paired rig entry");
  return { command: process.execPath, prefix: [cli] };
}

// npm's Windows cmd shim is not directly spawnable. Keep PATH order and invoke
// only its recognized OpenRig package entry, through this hook's Node, without a shell.
function resolveRigCommand(env = process.env, cwd = process.cwd()) {
  if (process.platform !== "win32") return { command: "rig", prefix: [] };
  const pathKey = Object.keys(env).sort().find(key => key.toUpperCase() === "PATH");
  const extKey = Object.keys(env).sort().find(key => key.toUpperCase() === "PATHEXT");
  const extensions = (extKey === undefined ? ".COM;.EXE;.BAT;.CMD" : env[extKey] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";").filter(Boolean).map(value => value.toLowerCase());
  for (const value of (pathKey === undefined ? "" : env[pathKey] ?? "").split(path.delimiter)) {
    const dir = path.resolve(cwd, value.replace(/^"(.*)"$/, "$1"));
    for (const ext of extensions) {
      const candidate = path.join(dir, "rig" + ext);
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      if (ext === ".com" || ext === ".exe") return { command: fs.realpathSync(candidate), prefix: [] };
      if (ext !== ".cmd") throw new Error("Windows rig requires a native executable or recognized npm installation");
      const paired = pairedSeatRig(candidate);
      if (paired) return paired;
      const local = path.basename(dir).toLowerCase() === ".bin";
      const root = path.join(local ? path.dirname(dir) : path.join(dir, "node_modules"), "@openrig", "cli");
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.rig;
      if (manifest.name !== "@openrig/cli" || typeof entry !== "string" || path.isAbsolute(entry)) throw new Error("Unrecognized Windows rig npm entry");
      const file = path.resolve(root, entry), relative = path.relative(root, file);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("rig npm entry escapes its package");
      const needle = "%dp0%\\" + (local ? ".." : "node_modules") + "\\@openrig\\cli\\" + entry.replaceAll("/", "\\");
      if (!fs.readFileSync(candidate, "utf8").includes(needle)) throw new Error("Unrecognized Windows rig shim");
      return { command: process.execPath, prefix: [fs.realpathSync(file)] };
    }
  }
  const error = new Error("No rig executable on the Windows launch PATH");
  error.code = "ENOENT";
  throw error;
}

function spawnRig(args, options = {}) {
  try {
    const selected = resolveRigCommand(options.env, options.cwd);
    return spawnSync(selected.command, [...selected.prefix, ...args], { ...options, windowsHide: true });
  } catch (error) {
    return { error, status: null, signal: null, stdout: "", stderr: "" };
  }
}

module.exports = { resolveRigCommand, spawnRig };

if (require.main === module) {
  const result = spawnRig(process.argv.slice(2), { stdio: "inherit", env: process.env });
  if (result.error) process.stderr.write(result.error.message + "\n");
  process.exitCode = result.status ?? 1;
}
