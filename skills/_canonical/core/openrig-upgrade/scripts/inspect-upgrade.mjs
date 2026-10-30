#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const rig = process.env.OPENRIG_RIG_BIN || "rig";

function probe(name, args, next) {
  // npm installs rig.cmd on Windows. execFile/spawn cannot launch that shim
  // directly; keep the command and arguments as data for PowerShell's call
  // operator instead of interpolating a shell command string.
  const result = process.platform === "win32"
    ? spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; $argv=@(ConvertFrom-Json $env:OPENRIG_UPGRADE_PROBE_ARGS); $bin=$env:OPENRIG_UPGRADE_PROBE_BIN; if(Test-Path -LiteralPath $bin -PathType Leaf){$command=(Get-Item -LiteralPath $bin).FullName}else{$command=(Get-Command -Name $bin -CommandType Application -ErrorAction Stop).Source}; & $command @argv; exit $LASTEXITCODE",
    ], { encoding: "utf8", windowsHide: true, env: { ...process.env, OPENRIG_UPGRADE_PROBE_BIN: rig, OPENRIG_UPGRADE_PROBE_ARGS: JSON.stringify(args) } })
    : spawnSync(rig, args, { encoding: "utf8" });
  const stdout = result.stdout?.trim() || "";
  const stderr = result.stderr?.trim() || "";
  if (result.status === 0) {
    let value = stdout;
    try {
      value = JSON.parse(stdout);
    } catch {
      // Versions and older surfaces may intentionally return plain text.
    }
    return { name, ok: true, command: [rig, ...args], value };
  }
  return {
    name,
    ok: false,
    command: [rig, ...args],
    exitCode: result.status,
    error: stderr || stdout || result.error?.message || "command produced no diagnostic",
    next,
  };
}

const report = {
  schema: "openrig-upgrade-inspection/v1",
  generatedAt: new Date().toISOString(),
  rigVersion: probe("rigVersion", ["--version"], `run ${rig} --version directly and verify the installed wrapper`),
  daemonStatus: probe("daemonStatus", ["daemon", "status"], `run ${rig} daemon status and inspect daemon state and logs`),
  nodes: probe("nodes", ["ps", "--nodes", "-A", "--json"], `run ${rig} ps --nodes -A --json and resolve control-plane reachability before mutation`),
  plugins: probe("plugins", ["plugin", "list", "--json"], `run ${rig} plugin list --json and derive the installed plugin roots before refresh`),
};

report.ready = [report.rigVersion, report.daemonStatus, report.nodes, report.plugins].every((item) => item.ok);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
