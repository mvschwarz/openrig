import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { setDaemonTmuxServer, tmuxAttachCommand } from "../src/adapters/tmux-server.js";

afterEach(() => setDaemonTmuxServer([]));

it.each(["owned-seat", "owned seat", "owned'quote", "owned;$literal"])("attach guidance preserves server and session words in the actual platform shell: %s", session => {
  const server = "/owned server/quo'te";
  setDaemonTmuxServer(["-S", server]);
  const command = tmuxAttachCommand(session);
  const expected = ["-S", server, "attach", "-t", "=" + session];
  if (process.platform === "win32") {
    const script = "function tmux { ConvertTo-Json -Compress -InputObject @($args) }\n" + command;
    const output = execFileSync(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: 15000, stdio: "pipe" });
    expect(JSON.parse(output.trim())).toEqual(expected);
  } else {
    const output = execFileSync("/bin/sh", ["-c", "tmux() { printf '<%s>' \"$@\"; }\n" + command], { encoding: "utf8", timeout: 15000 });
    expect(output).toBe(expected.map(value => "<" + value + ">").join(""));
  }
});
