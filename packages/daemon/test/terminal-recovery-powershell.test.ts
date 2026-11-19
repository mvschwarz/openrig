import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";

it.runIf(process.platform === "win32").each([true, false])("executes a native local recovery command literally in PowerShell (readOnly=%s)", readOnly => {
  const session = "owned O'Brien $() & 中文", server = "owned server ' &";
  const view = composeView("owned", [{ seat: "owned", label: "owned", host: null, tmuxSession: session, readOnly, alive: true }],
    { resolveHost: () => null, localPlatform: "win32", localTmux: "ownedTmux", localTmuxServer: ["-L", server] });
  const script = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n"
    + "function ownedTmux { [Console]::Write((ConvertTo-Json -Compress -InputObject @($args))) }\n" + view.opened[0]!.recoveryCommand;
  const output = execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  expect(JSON.parse(output)).toEqual(["-L", server, "attach", ...(readOnly ? ["-r"] : ["-f", "ignore-size"]), "-t", session]);
});
