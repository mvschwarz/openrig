import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { attachEnvironmentLines } from "../src/commands/attach.js";

it.runIf(process.platform === "win32")("applies native attach identity literally in an owned PowerShell process", () => {
  const node = "owned-node-Ω", session = "owned O'Brien $() & ; %PATH% Ω";
  const script = [
    "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    ...attachEnvironmentLines(node, session, "powershell"),
    "[Console]::Write((@{node=$env:OPENRIG_NODE_ID;session=$env:OPENRIG_SESSION_NAME}|ConvertTo-Json -Compress))",
  ].join("\n");
  const output = execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  expect(JSON.parse(output)).toEqual({ node, session });
});
