import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { pinnedWindowsRecoveryCommand } from "../src/domain/provider-recovery-command.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

it.runIf(process.platform === "win32")("pinned recovery preserves native argv, home, cwd and exit without PATH lookup", async () => {
  const { spawnWindowsJobProcess } = await import("../src/domain/windows-job-process.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinned recovery-"));
  const cwd = path.join(root, "work [1] ' 中文"), home = path.join(root, "home ' 中文");
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  const receiver = path.join(root, "receiver.cjs"), output = path.join(root, "received.json");
  try {
    fs.writeFileSync(receiver, "require('fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),home:process.env.CODEX_HOME,parentHome:process.env.HOME}));process.exit(7);");
    const values = ["-c", 'model_reasoning_effort="high"', "resume", "synthetic-conversation"];
    const core = ["codex", receiver, output, ...values].map(shellQuote).join(" ");
    const command = pinnedWindowsRecoveryCommand(core, process.execPath, cwd, home, root);
    const script = command + "\nexit $global:LASTEXITCODE";
    const child = spawnWindowsJobProcess(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd: root, env: { ...process.env, PATH: root, CODEX_HOME: "wrong-ambient-home", HOME: "wrong-parent-home" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = ""; child.stdout!.resume(); child.stderr!.setEncoding("utf8"); child.stderr!.on("data", (value: string) => stderr += value);
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
    expect(code, stderr).toBe(7);
    const received = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(received.args).toEqual(values); expect(received.home).toBe(home); expect(received.parentHome).toBe(root);
    const actual = fs.statSync(received.cwd, { bigint: true }), expected = fs.statSync(cwd, { bigint: true });
    expect([actual.dev, actual.ino]).toEqual([expected.dev, expected.ino]);
  } finally {
    for (const file of [receiver, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(cwd); fs.rmdirSync(home); fs.rmdirSync(root);
  }
}, 20000);

it("rejects unpinned paths and nonliteral recovery commands", () => {
  expect(() => pinnedWindowsRecoveryCommand("codex resume owned", "codex", "C:/work", "C:/home")).toThrow(/absolute/);
  expect(() => pinnedWindowsRecoveryCommand("codex resume owned; echo other", "C:/codex.exe", "C:/work", "C:/home")).toThrow();
  expect(() => pinnedWindowsRecoveryCommand("other resume owned", "C:/codex.exe", "C:/work", "C:/home")).toThrow(/Codex/);
});
