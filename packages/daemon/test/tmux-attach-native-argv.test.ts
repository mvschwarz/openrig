import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { setDaemonTmuxServer, tmuxAttachCommand } from "../src/adapters/tmux-server.js";

afterEach(() => setDaemonTmuxServer([]));

it.runIf(process.platform === "win32").each(["owned seat", "owned'quote", 'owned"quote'])("recovery guidance preserves actual native argv: %s", async session => {
  const { spawnWindowsJobProcess } = await import("../src/domain/windows-job-process.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attach argv # 中文-"));
  const receiver = path.join(root, "receiver.cjs"), output = path.join(root, "received.json");
  try {
    fs.writeFileSync(receiver, "require('fs').writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));process.exit(7);");
    setDaemonTmuxServer(["-S", "C:/owned server/socket"]);
    const command = tmuxAttachCommand(session, [process.execPath, receiver, output]);
    const script = command + "\nexit $global:LASTEXITCODE";
    const child = spawnWindowsJobProcess(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stdout!.resume(); child.stderr!.setEncoding("utf8"); child.stderr!.on("data", (value: string) => stderr += value);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
    expect(code, stderr).toBe(7);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual(["-S", "C:/owned server/socket", "attach", "-t", session]);
  } finally {
    for (const file of [receiver, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
}, 20000);
