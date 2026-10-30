import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { authStatus, resolveCodexHome } from "../src/domain/codex-auth.js";

it.runIf(process.platform === "win32").each(["timeout", "logged-in", "signed-out", "ambiguous-exit"])("bounds the owned native login-status probe on %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-login-bound-"));
  const pidFile = path.join(root, "owned-descendant.pid");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const pkg = path.join(root, "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(root, "node.exe"));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
    fs.writeFileSync(path.join(root, "codex.cmd"), '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const descendant = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>process.exit(0),9000);`;
    fs.writeFileSync(path.join(pkg, "bin", "codex.js"), mode === "timeout"
      ? `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore',windowsHide:true});child.unref();setTimeout(()=>process.exit(0),9000);`
      : `process.exit(${mode === "logged-in" ? 0 : mode === "ambiguous-exit" ? 125 : 1});`);
    vi.stubEnv("PATH", root); vi.stubEnv("PATHEXT", ".CMD;.EXE");
    vi.stubEnv("HOME", root); vi.stubEnv("USERPROFILE", root); vi.stubEnv("CODEX_HOME", path.join(root, "owned-home"));
    const started = Date.now();
    const result = authStatus(resolveCodexHome());
    expect(result.loginStatus).toBe(mode === "timeout" || mode === "ambiguous-exit" ? "unavailable" : mode === "logged-in" ? "logged_in" : "not_logged_in");
    expect(Date.now() - started).toBeLessThan(8000);
    if (mode === "timeout") {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      for (let attempt = 0; attempt < 20 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      expect(alive(pid)).toBe(false);
    }
  } finally {
    vi.unstubAllEnvs();
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8")), until = Date.now() + 11000;
      while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
      if (alive(pid)) throw new Error("owned login descendant has not self-exited; fixture retained");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 25000);
