import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { powershellQuote, renderWindowsArgvForwarder, renderWindowsLaunch, renderWindowsManagedLaunch } from "../src/adapters/windows-launch.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { windowsArguments } from "../src/adapters/windows-argv.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32")("runs the paired CLI from a literal percent and bang path in cmd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-bin-path-"));
  try {
    const directory = path.join(root, "paired-中文-%OPENRIG_PATH_DECOY%-!OPENRIG_PATH_DECOY!");
    fs.mkdirSync(directory);
    const cli = path.join(directory, "rig.mjs");
    fs.writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)))");
    const previous = path.join(root, "run", "seat-bin", createHash("sha256").update(fs.realpathSync(cli)).digest("hex"));
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, "rig.cmd"), "older-shim-owned-by-running-daemon");
    const seat = new SeatLaunchEnvironment({} as TmuxAdapter, { OPENRIG_HOME: root }, root, cli, undefined, "win32");
    // Exercise shim construction only: no terminal, session or provider is created.
    const bin = (seat as unknown as { rigBin(): string }).rigBin();
    expect(bin).not.toBe(previous);
    expect(fs.readFileSync(path.join(previous, "rig.cmd"), "utf8")).toBe("older-shim-owned-by-running-daemon");
    const cmd = path.join(process.env.SystemRoot!, "System32", "cmd.exe");
    const result = spawnSync(cmd, ["/d", "/v:on", "/s", "/c", `""${path.join(bin, "rig.cmd")}" literal-argument"`], {
      cwd: root, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 10000,
      env: { ...process.env, OPENRIG_PATH_DECOY: "WRONG-DIRECTORY" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["literal-argument"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32").each(["forwarder", "classic", "managed"] as const)("a %s spawn failure cannot reuse a previous successful exit code", mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-bin-spawn-failure-"));
  try {
    const executable = path.join(root, "missing-node.exe"), args = ["owned-cli.mjs"];
    const command = mode === "forwarder" ? renderWindowsArgvForwarder(executable, args)
      : mode === "classic" ? renderWindowsLaunch([executable, ...args].map(shellQuote).join(" "))
      : renderWindowsManagedLaunch(executable, args, root, { SystemRoot: process.env.SystemRoot! }, []);
    const script = "$global:LASTEXITCODE=0; " + command + "\nexit $LASTEXITCODE";
    const result = spawnSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("preserves empty and quoted arguments through the paired PowerShell CLI shim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-bin-argv-"));
  try {
    const directory = path.join(root, "paired 中文 & %literal% !bang!"); fs.mkdirSync(directory);
    const cli = path.join(directory, "paired cli.mjs");
    fs.writeFileSync(cli, "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exitCode=7;");
    const previous = path.join(root, "run", "seat-bin", createHash("sha256").update(fs.realpathSync(cli)).update("\0windows-seat-bin-v4").digest("hex"));
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, "rig.ps1"), "older-running-daemon-shim");
    const seat = new SeatLaunchEnvironment({} as TmuxAdapter, { OPENRIG_HOME: root }, root, cli, undefined, "win32");
    const bin = (seat as unknown as { rigBin(): string }).rigBin();
    expect(bin).not.toBe(previous);
    expect(fs.readFileSync(path.join(previous, "rig.ps1"), "utf8")).toBe("older-running-daemon-shim");
    expect((seat as unknown as { rigBin(): string }).rigBin()).toBe(bin);
    const args = ["", "literal space", 'embedded"quote', "trailing\\", 'slash\\"quote', "中文 & %literal% !bang!", ""];
    const cwd = path.join(root, "selected directory"); fs.mkdirSync(cwd);
    const script = `Set-Location -LiteralPath ${powershellQuote(cwd)}; $words=ConvertFrom-Json $env:OWNED_SEAT_ARGS; & ${powershellQuote(path.join(bin, "rig.ps1"))} @words; exit $LASTEXITCODE`;
    const result = spawnSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000, env: { ...process.env, OWNED_SEAT_ARGS: JSON.stringify(args) } });
    expect(result.status, result.stderr).toBe(7);
    const actual = JSON.parse(result.stdout);
    expect(actual.args, result.stdout).toEqual(args);
    expect(fs.realpathSync.native(actual.cwd)).toBe(fs.realpathSync.native(cwd));
    const cmdArgs = ["", "literal space", 'embedded"quote', "trailing\\", 'slash\\"quote', "中文 & literal !bang!", ""];
    const throughCmd = spawnSync(path.join(process.env.SystemRoot!, "System32/cmd.exe"),
      ["/d", "/v:off", "/s", "/c", `""%OWNED_RIG_CMD%" ${windowsArguments(cmdArgs)}"`],
      { cwd, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000,
        env: { ...process.env, OWNED_RIG_CMD: path.join(bin, "rig.cmd") } });
    expect(throughCmd.status, throughCmd.stderr).toBe(7);
    const cmdActual = JSON.parse(throughCmd.stdout);
    expect(cmdActual.args, throughCmd.stdout).toEqual(cmdArgs);
    expect(fs.realpathSync.native(cmdActual.cwd)).toBe(fs.realpathSync.native(cwd));
    const before = fs.readFileSync(path.join(bin, "rig.ps1"));
    fs.writeFileSync(path.join(bin, "unexpected-tool.exe"), "owned unexpected file");
    expect(() => (seat as unknown as { rigBin(): string }).rigBin()).toThrow("Seat bin is not rig-only");
    expect(fs.readFileSync(path.join(bin, "unexpected-tool.exe"), "utf8")).toBe("owned unexpected file");
    expect(fs.readFileSync(path.join(bin, "rig.ps1"))).toEqual(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
