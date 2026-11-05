import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeViewerShellCommand } from "../src/domain/terminal/native-viewer-command.js";

it.runIf(process.platform === "win32").each([
  { shell: "powershell.exe", long: false }, { shell: "cmd.exe", long: false }, { shell: "cmd.exe", long: true },
])("viewer preserves native argv, cwd and exit through actual $shell (staged=$long)", async ({ shell, long }) => {
  const { spawnWindowsJobProcess } = await import("../src/domain/windows-job-process.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viewer argv # 测试-"));
  const receiver = path.join(root, "receiver # ü.cjs"), output = path.join(root, "received.json");
  const values = ["", "space 中文😀", "a'b", 'a"b', "trailing\\", "%PATH%", "!OPENRIG_VIEWER_CANARY!", "&|<>^();", "line\nnext"];
  try {
    if (long) values.push("long-data-" + "x".repeat(10000));
    fs.writeFileSync(receiver, "require('fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),cwd:process.cwd()}));process.exit(7);");
    const command = nativeViewerShellCommand([process.execPath, receiver, output, ...values],
      { shell_pid: 42, foreground_processes: [{ pid: 42, argv: [shell] }] }, long ? root : undefined);
    if (long) {
      expect(command.length).toBeLessThanOrEqual(8190);
      expect(fs.readdirSync(root).filter(file => file.startsWith("openrig-viewer-command-"))).toHaveLength(1);
    }
    const system = process.env.SystemRoot ?? "C:/Windows";
    const executable = path.join(system, shell === "cmd.exe" ? "System32/cmd.exe" : "System32/WindowsPowerShell/v1.0/powershell.exe");
    const args = shell === "cmd.exe" ? ["/d", "/q", "/v:on"]
      : ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command + "\nexit $global:LASTEXITCODE", "utf16le").toString("base64")];
    const child = spawnWindowsJobProcess(executable, args, { cwd: root, env: { ...process.env, OPENRIG_VIEWER_CANARY: "must-not-expand" },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stderr = ""; child.stdout!.resume(); child.stderr!.setEncoding("utf8"); child.stderr!.on("data", (value: string) => stderr += value);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdin!.end(shell === "cmd.exe" ? "@" + command + "\r\n@exit %ERRORLEVEL%\r\n" : "");
    const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
    expect(code, stderr).toBe(7);
    const observed = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(observed.args).toEqual(values);
    expect(fs.readdirSync(root).filter(file => file.startsWith("openrig-viewer-command-"))).toEqual([]);
    const cwd = fs.statSync(observed.cwd, { bigint: true }), owned = fs.statSync(root, { bigint: true });
    expect([cwd.dev, cwd.ino]).toEqual([owned.dev, owned.ino]);
  } finally {
    for (const file of [receiver, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
}, 20000);
