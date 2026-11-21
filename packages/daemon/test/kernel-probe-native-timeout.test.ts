import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultProbeRuntimes } from "../src/domain/kernel-boot.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
it.runIf(process.platform === "win32")("ends the owned native auth probe at timeout without leaving its npm child alive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-native-probe-"));
  const receipt = path.join(root, "owned-pid.json");
  try {
    for (const name of ["claude", "codex"]) {
      const packageName = name === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
      const pkg = path.join(root, "node_modules", ...packageName.split("/")); fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: packageName, bin: { [name]: "cli.js" } }));
      fs.writeFileSync(path.join(pkg, "cli.js"), name === "claude"
        ? `require('fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify(process.pid));setTimeout(()=>process.exit(0),9000)`
        : "console.log('Logged in - owned fixture only')");
      fs.writeFileSync(path.join(root, `${name}.cmd`), `@echo off\r\nset "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%\\node_modules\\${packageName.replaceAll("/", "\\")}\\cli.js" %*\r\n`);
    }
    vi.stubEnv("PATH", [root, path.dirname(process.execPath), path.join(process.env.SystemRoot!, "System32")].join(path.delimiter));
    vi.stubEnv("PATHEXT", ".CMD;.EXE"); vi.stubEnv("CODEX_HOME", root);
    const result = await defaultProbeRuntimes();
    expect(result).toEqual({ claudeCode: "unavailable", codex: "ok" });
    const pid = JSON.parse(fs.readFileSync(receipt, "utf8"));
    expect(alive(pid)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    // The old implementation can leave this fixture alive. Its own timer ends
    // it; never send a signal to a numeric PID after an ownership boundary.
    if (fs.existsSync(receipt)) {
      const pid = JSON.parse(fs.readFileSync(receipt, "utf8"));
      await expect.poll(() => alive(pid), { timeout: 11000 }).toBe(false);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20000);
