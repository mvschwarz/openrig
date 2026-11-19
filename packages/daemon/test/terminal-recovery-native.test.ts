import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

it.runIf(process.platform === "win32").each([false, true])("renders native SSH recovery argv with quoted session (readOnly=%s)", readOnly => {
  const session = "owned session 'quote' & % !";
  const view = composeView("owned", [{ seat: "owned@remote", label: "Owned", tmuxSession: session, host: "remote", readOnly, alive: true }],
    { localPlatform: "win32", resolveHost: () => ({ id: "remote", transport: "ssh", target: "host.example", user: "owned" }) });
  const pane = view.opened[0]!;
  expect(pane.recoveryShell).toBe("powershell");
  // Override only ssh inside this child: no real connection or terminal.
  const script = `$ProgressPreference='SilentlyContinue'; function ssh { [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @($args))) }; ${pane.recoveryCommand}`;
  const output = execFileSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  expect(JSON.parse(output)).toEqual(["-t", "owned@host.example", `tmux attach ${readOnly ? "-r " : "-f ignore-size "}-t ${shellQuote(session)}`]);
});
