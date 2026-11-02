import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnRex } from "../src/domain/terminal/rex-transport.js";

it.skipIf(process.platform !== "win32")("native Rex forwards literal argv and stdin", async () => {
  const args = ["x y", "quote\"word", "中文", "", "end\\"];
  const code = "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>data+=s);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),data})));";
  expect(JSON.parse(await spawnRex([process.execPath, "-e", code, ...args], '{"literal":"$HOME"}', 5000)))
    .toEqual({ args, data: '{"literal":"$HOME"}' });
});

it.skipIf(process.platform !== "win32").each(["timeout", 0, 7] as const)("native Rex owns detached descendants through %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-rex-job-"));
  const pidFile = path.join(root, "child.pid");
  let pid = 0;
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const code = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,windowsHide:true,stdio:'ignore'}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);${mode === "timeout" ? "setInterval(()=>{},1000);" : `console.error('owned exit');process.exit(${mode});`}}},10);`;
  try {
    const run = spawnRex([process.execPath, "-e", code], "{}", mode === "timeout" ? 2500 : 5000);
    if (mode === 0) expect(await run).toBe("");
    else await expect(run).rejects.toMatchObject(mode === "timeout" ? { exitCode: null, message: "did not answer within 2500 ms" } : { exitCode: 7, stderr: expect.stringContaining("owned exit") });
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(1);
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 3000 }).toBe(false);
  } finally {
    if (!pid && fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (pid > 1) try { process.kill(pid); } catch { /* already ended */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);
