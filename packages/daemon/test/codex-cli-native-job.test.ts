import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultCodexCli } from "../src/adapters/codex-runtime-adapter.js";

it.runIf(process.platform === "win32").each([0, 7])("contains the owned finite Codex CLI descendant and preserves exit %s", async status => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-job-"));
  const pidFile = path.join(root, "owned.pid");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const pkg = path.join(root, "node_modules/@openai/codex");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(root, "node.exe"));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
    fs.writeFileSync(path.join(root, "codex.cmd"), '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const descendant = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>process.exit(0),9000);`;
    fs.writeFileSync(path.join(pkg, "bin/codex.js"), `const fs=require('fs'); const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore',windowsHide:true});child.unref();
const until=Date.now()+3000; const ready=()=>{if(!fs.existsSync(${JSON.stringify(pidFile)})&&Date.now()<until)return setTimeout(ready,20);console.log(JSON.stringify(process.argv.slice(2)));console.error('owned stderr');process.exit(${status});};ready();`);
    const args = ["plugin", "marketplace", "add", "owned % ! & ' path"];
    const env = { ...process.env, PATH: root, PATHEXT: ".CMD;.EXE", HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, "home") };
    const result = await defaultCodexCli(args, env);
    expect(result.status).toBe(status);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.stderr.trim()).toBe("owned stderr");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    for (let attempt = 0; attempt < 20 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    expect(alive(pid)).toBe(false);
  } finally {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8")), until = Date.now() + 11000;
      while (alive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
      if (alive(pid)) throw new Error("owned finite CLI descendant has not self-exited; fixture retained");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 25000);
