import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { launchArgs, launchCommand } from "../src/specs/launch.js";

it.runIf(process.platform === "win32")("executes the displayed spec launch literally in PowerShell", () => {
  const launch = { source: "owned O'Brien $() & ; %PATH% Ω", folder: "C:\\owned folder\\O'Brien", host: "local" };
  const script = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "function rig { [Console]::Write((@{arguments=@($args);host=$env:OPENRIG_HOST_SELECTED}|ConvertTo-Json -Compress)) }",
    launchCommand(launch),
  ].join("\n");
  const output = execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  // PowerShell functions consume the -- parser delimiter; native rig receives it.
  expect(launchCommand(launch)).toContain(" -- ");
  expect(JSON.parse(output)).toEqual({ arguments: launchArgs(launch).filter(arg => arg !== "--"), host: "local" });
});

it("retains POSIX command syntax for POSIX terminals", () => {
  expect(launchCommand({ source: "owned's", folder: "/owned folder", host: "local" }, "linux"))
    .toBe("OPENRIG_HOST_SELECTED=local rig up --cwd '/owned folder' -- 'owned'\\''s'");
});
