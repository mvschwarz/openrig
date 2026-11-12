import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { setDaemonTmuxAttachCommand, setDaemonTmuxServer, tmuxAttachCommand } from "../src/adapters/tmux-server.js";
import { bindNativeSessionName } from "../src/domain/terminal/native-session-name.js";
import { writeWindowsNodeFixture } from "../../../scripts/windows-node-fixture.mjs";

afterEach(() => setDaemonTmuxServer([]));

it.skipIf(process.platform !== "win32")("mapped general guidance preserves the pinned executable prefix and verifies binding before attach", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-attach-guidance-"));
  try {
    const log = path.join(root, "calls.jsonl"), logical = "owned|logical", binding = bindNativeSessionName(logical);
    const executable = writeWindowsNodeFixture(root, "tmux", "import fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(process.env.TEST_HINT_LOG,JSON.stringify(a)+'\\n');if(a[0]!=='literal-prefix'||a[1]!=='-L'||a[2]!=='owned-hint-home')process.exit(9);if(a.includes('has-session'))process.exit(0);if(a.includes('show-options'))console.log(process.env.TEST_HINT_MARKER);else if(a.includes('display-message'))console.log('500 $1:'+process.env.TEST_HINT_PHYSICAL);else if(a.includes('show-environment'))process.exit(1);else if(a.includes('attach'))process.exit(0);else process.exit(8);");
    setDaemonTmuxServer(["-L", "owned-hint-home"]);
    setDaemonTmuxAttachCommand([executable, "literal-prefix"]);
    for (const valid of [true, false]) {
      fs.writeFileSync(log, "");
      const hint = tmuxAttachCommand(logical);
      const run = spawnSync(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(hint, "utf16le").toString("base64")],
        { env: { ...process.env, TEST_HINT_LOG: log, TEST_HINT_MARKER: valid ? binding.marker : "wrong-marker", TEST_HINT_PHYSICAL: binding.physical }, encoding: "utf8", windowsHide: true, timeout: 15000 });
      expect(run.status, run.stderr).toBe(valid ? 0 : 1);
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
      expect(calls.every(argv => argv.slice(0, 3).join("|") === "literal-prefix|-L|owned-hint-home")).toBe(true);
      expect(calls.some(argv => argv.includes("attach"))).toBe(valid);
      expect(calls.flat()).not.toContain("=" + logical);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30000);

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
