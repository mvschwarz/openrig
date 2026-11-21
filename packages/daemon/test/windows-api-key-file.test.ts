import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeWindowsPrivateConfig } from "../src/adapters/windows-private-config.js";
import { claudeSeatTokenFileProblem, claudeSeatTokenStep } from "../src/domain/claude-seat-token.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { powershellQuote, renderWindowsLaunch, renderWindowsManagedLaunch } from "../src/adapters/windows-launch.js";
import { OPEN_WINDOWS_PRIVATE_API_KEY } from "../src/domain/windows-api-key-file.js";

const exec = promisify(execFile);
const execute = (script: string) => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
  encoding: "utf8", windowsHide: true, timeout: 10000,
  env: { ...process.env, ANTHROPIC_API_KEY: "synthetic-parent", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-parent", ANTHROPIC_BASE_URL: "synthetic-parent" },
});

describe.skipIf(process.platform !== "win32")("native private API-key file", () => {
  it("keeps credential values out of PowerShell variable tracing", async () => {
    const sentinel = "SYNTHETIC-TRACE-KEY";
    const config = await writeWindowsPrivateConfig(sentinel);
    try {
      const step = claudeSeatTokenStep({ label: "test", tokenFile: config.path, kind: "api-key" }, shellQuote, { platform: "win32" });
      const source = `console.log('receiver-ok:'+(process.env.ANTHROPIC_API_KEY.length===${sentinel.length}))`;
      const command = renderWindowsLaunch([process.execPath, "-e", source].map(shellQuote).join(" "), {}, { beforeStart: step });
      expect(command).not.toContain(sentinel);
      const { stdout, stderr } = await execute("Set-PSDebug -Trace 2; " + command);
      expect(stdout).toMatch(/^receiver-ok:true\r?$/m);
      expect(stdout + stderr).not.toContain(sentinel);
    } finally { await config.dispose(); }
  }, 15000);
  it("accepts exactly 8192 bytes and holds the verified file against writes until disposed", async () => {
    const config = await writeWindowsPrivateConfig("x".repeat(8192));
    try {
      const ref = { label: "test", tokenFile: config.path, kind: "api-key" as const };
      expect(claudeSeatTokenFileProblem(ref)).toBeNull();
      const locked = await execute(`$openrigKeyPath=${powershellQuote(config.path)}; ${OPEN_WINDOWS_PRIVATE_API_KEY}; try { try { $other=[IO.File]::Open($openrigKeyPath,'Open','Write','ReadWrite'); $other.Dispose(); throw 'unexpected write access' } catch [IO.IOException] { Write-Output 'locked' } } finally { $openrigKeyStream.Dispose() }`);
      expect(locked.stdout.trim()).toBe("locked");
      const command = renderWindowsLaunch([process.execPath, "-e", "console.log(process.env.ANTHROPIC_API_KEY.length)"].map(shellQuote).join(" "), {}, { beforeStart: claudeSeatTokenStep(ref, shellQuote, { platform: "win32" }) });
      expect((await execute(command)).stdout.trim()).toBe("8192");
    } finally { await config.dispose(); }
  }, 15000);
  it.each(["classic", "managed"])("reads a private file into only the %s child and scrubs routing/login overrides", async mode => {
    const config = await writeWindowsPrivateConfig("\ufeff  synthetic-private-api-key\r\n");
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-api-child-"));
    try {
      const ref = { label: "test", tokenFile: config.path, kind: "api-key" as const };
      expect(claudeSeatTokenFileProblem(ref)).toBeNull();
      const receiver = path.join(root, "receiver.cjs");
      await writeFile(receiver, "console.log(JSON.stringify({key:process.env.ANTHROPIC_API_KEY==='synthetic-private-api-key',login:process.env.CLAUDE_CODE_OAUTH_TOKEN===undefined,routing:process.env.ANTHROPIC_BASE_URL===undefined}));");
      const step = claudeSeatTokenStep(ref, shellQuote, { platform: "win32" });
      const command = mode === "classic" ? renderWindowsLaunch([process.execPath, receiver].map(shellQuote).join(" "), {}, { beforeStart: step })
        : renderWindowsManagedLaunch(process.execPath, [receiver], root, { SystemRoot: process.env.SystemRoot! }, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"], step);
      expect(command).not.toContain("synthetic-private-api-key");
      const { stdout, stderr } = await execute(command + "; Write-Output ($env:ANTHROPIC_API_KEY -eq 'synthetic-parent')");
      const lines = stdout.trim().split(/\r?\n/);
      expect(JSON.parse(lines[0]!)).toEqual({ key: true, login: true, routing: true });
      expect(lines[1]).toBe("True"); expect(stderr).not.toContain("synthetic-private-api-key");
    } finally { await config.dispose(); await rm(root, { recursive: true }); }
  }, 15000);

  it("rechecks the opened file ACL at launch after a successful preflight", async () => {
    const config = await writeWindowsPrivateConfig("synthetic-private-api-key");
    const marker = path.join(path.dirname(config.path), "never-started");
    try {
      const ref = { label: "test", tokenFile: config.path, kind: "api-key" as const };
      expect(claudeSeatTokenFileProblem(ref)).toBeNull();
      await execute(`$p=${powershellQuote(config.path)}; $acl=[IO.File]::GetAccessControl($p); $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl($p,$acl)`);
      expect(claudeSeatTokenFileProblem(ref)).toContain("private");
      const command = renderWindowsLaunch([process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`].map(shellQuote).join(" "), {}, { beforeStart: claudeSeatTokenStep(ref, shellQuote, { platform: "win32" }) });
      await expect(execute(command)).rejects.toThrow();
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await config.dispose(); }
  }, 15000);

  it.each(["", " \r\n", "two words", "nonascii-密", "x".repeat(8193)])("refuses invalid or oversized content without fallback: case %#", async content => {
    const config = await writeWindowsPrivateConfig(content);
    const marker = path.join(path.dirname(config.path), "never-started");
    try {
      const ref = { label: "test", tokenFile: config.path, kind: "api-key" as const };
      const command = renderWindowsLaunch([process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`].map(shellQuote).join(" "), {}, { beforeStart: claudeSeatTokenStep(ref, shellQuote, { platform: "win32", required: false }) });
      await expect(execute(command)).rejects.toThrow();
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await config.dispose(); }
  }, 15000);
});
