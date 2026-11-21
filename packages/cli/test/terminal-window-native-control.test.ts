import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultWindowDeps } from "../src/terminal-window.js";

it.runIf(process.platform === "win32").each([0, 7, "timeout"] as const)("native terminal control retains descendant custody through %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-terminal-control-"));
  const receipt = path.join(root, "child.json"), parent = path.join(root, "parent.cjs"), child = path.join(root, "child.cjs");
  const values = ["", 'quote"word', "line\nnext", "end\\", "literal%PATH%!&|", "中文"];
  fs.writeFileSync(child, "require('fs').writeFileSync(process.argv[2],JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);");
  fs.writeFileSync(parent, `const fs=require('fs');require('child_process').spawn(process.execPath,[${JSON.stringify(child)},${JSON.stringify(receipt)}],{detached:true,windowsHide:true,stdio:'ignore'}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(receipt)})){clearInterval(timer);console.log(JSON.stringify({args:process.argv.slice(2),canary:process.env.OPENRIG_CONTROL_CANARY}));${mode === "timeout" ? "setInterval(()=>{},1000);" : `console.error('owned exit');process.exit(${mode});`}}},10);`);
  let pid = 0;
  try {
    const deps = defaultWindowDeps({ ...process.env, OPENRIG_CONTROL_CANARY: "owned literal" });
    const result = deps.exec(process.execPath, [parent, ...values], mode === "timeout" ? 2500 : 5000);
    if (mode === 0) expect(JSON.parse(await result)).toEqual({ args: values, canary: "owned literal" });
    else await expect(result).rejects.toMatchObject(mode === "timeout" ? { code: "ETIMEDOUT" } : { code: 7, stderr: expect.stringContaining("owned exit") });
    pid = JSON.parse(fs.readFileSync(receipt, "utf8")).pid;
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 3000 }).toBe(false);
  } finally {
    if (!pid && fs.existsSync(receipt)) pid = JSON.parse(fs.readFileSync(receipt, "utf8")).pid;
    if (Number.isSafeInteger(pid) && pid > 1) try { process.kill(pid); } catch { /* already ended */ }
    for (const file of [receipt, parent, child]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
}, 10000);
