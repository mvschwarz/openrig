import { describe, expect, it } from "vitest";
import { browserLaunch } from "../src/browser-launch.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
describe("browser launch", () => {
  it.each([["darwin", "open"], ["linux", "xdg-open"]] as const)("opens URLs on %s", (platform, command) => {
    expect(browserLaunch("http://localhost:7433", platform)).toEqual({ command, args: ["http://localhost:7433"] });
  });
  it("passes Windows URLs literally without cmd expansion or PowerShell evaluation", () => {
    const url = "http://localhost:7433/?q=';%PATH%&$(throw 'bad')中文";
    const launch = browserLaunch(url, "win32", { systemroot: "D:\\Windows" });
    expect(launch.command).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(launch.args).toContain("-NoProfile");
    const script = Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le");
    expect(script).toBe("$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'http://localhost:7433/?q='';%PATH%&$(throw ''bad'')中文'");
  });
  it.runIf(process.platform === "win32")("starts its system PowerShell without it on PATH and delivers the URL literally", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openrig-browser-path-"));
    try {
      const env = { SystemRoot: process.env.SystemRoot, PATH: root, TEMP: tmpdir(), TMP: tmpdir() };
      expect(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { env, windowsHide: true }).error).toBeDefined();
      const url = "http://127.0.0.1:7433/?q=';%PATH%&$(throw 'bad')用户";
      const launch = browserLaunch(url, "win32", env);
      const script = Buffer.from(launch.args.at(-1)!, "base64").toString("utf16le");
      const witness = "function Start-Process { param([string]$FilePath) [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); [Console]::Write($FilePath) }; ";
      const result = spawnSync(launch.command, [...launch.args.slice(0, -1), Buffer.from(witness + script, "utf16le").toString("base64")], { env, encoding: "utf8", windowsHide: true, timeout: 10000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(url);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
