import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { queueRecoveryCommand } from "../src/queue-recovery-command.js";

it("retains POSIX read-only endpoint selection", () => {
  expect(queueRecoveryCommand("qitem-test", "http://fixture.invalid", "linux"))
    .toBe("OPENRIG_URL='http://fixture.invalid' rig queue show 'qitem-test' --full --json");
});

it.runIf(process.platform === "win32").each([false, true])("executes literal native recovery and restores endpoint after failure=%s", fail => {
  const root = mkdtempSync(join(tmpdir(), "queue native recovery "));
  try {
    const output = join(root, "result.json");
    const id = "qitem ' literal; $env:OPENRIG_TEST_INJECTED='bad'";
    const url = "http://fixture.invalid/a'b;$env:OPENRIG_TEST_INJECTED='bad'";
    const q = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const script = `$ErrorActionPreference='Stop'; function rig { $script:observed=@{url=$env:OPENRIG_URL;args=@($args)}; ${fail ? "throw 'synthetic read failure'" : ""} }; try { ${queueRecoveryCommand(id, url)} } catch { $script:failed=$true }; [IO.File]::WriteAllText(${q(output)},(ConvertTo-Json -Depth 5 @{observed=$script:observed;restored=$env:OPENRIG_URL;injected=$env:OPENRIG_TEST_INJECTED;failed=[bool]$script:failed}))`;
    execFileSync(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd: root, windowsHide: true, timeout: 5000, stdio: "pipe", env: { SystemRoot: process.env.SystemRoot, OPENRIG_URL: "http://original.invalid" } });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
      observed: { url, args: ["queue", "show", id, "--full", "--json"] }, restored: "http://original.invalid", injected: null, failed: fail,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
