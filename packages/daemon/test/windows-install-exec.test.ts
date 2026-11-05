import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeWindowsInstall } from "../src/domain/windows-install-exec.js";

it.runIf(process.platform === "win32").each([0,7])("native installer exit %i retires its detached descendants before settling",async code=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"install-complete-job-")),receipt=path.join(root,"pids.json");
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")return false;throw error;}};
  let pids:number[]=[];
  try{
    const script="const fs=require('fs'),ready=process.argv[1]+'.ready';const c=require('child_process').spawn(process.execPath,['-e',\"require('fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)\",ready],{stdio:'ignore',detached:true});c.unref();fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));const until=Date.now()+3000;while(!fs.existsSync(ready)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(!fs.existsSync(ready))throw Error('owned descendant did not start');process.stdout.write('owned installer completed');process.stderr.write('owned installer diagnostic');process.exitCode=Number(process.argv[2]);";
    const result=executeWindowsInstall(process.execPath,["-e",script,receipt,String(code)],8000);
    if(code===0)expect(await result).toBe("owned installer completed");
    else await expect(result).rejects.toMatchObject({code:7,stderr:"owned installer diagnostic"});
    pids=JSON.parse(fs.readFileSync(receipt,"utf8"));expect(pids).toHaveLength(2);
    expect(fs.readFileSync(receipt+".ready","utf8")).toBe("ready");
    expect(pids.every(pid=>Number.isSafeInteger(pid)&&pid>1)).toBe(true);
    await expect.poll(()=>pids.some(alive),{timeout:3000}).toBe(false);
  }finally{
    // Retain evidence if an owned descendant unexpectedly survived the Job.
    if(!pids.some(alive))fs.rmSync(root,{recursive:true,force:true});
  }
},15000);

it.runIf(process.platform === "win32")("rejects excessive native installer output instead of recording success", async () => {
  await expect(executeWindowsInstall(process.execPath,
    ["-e", "process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)"], 8000))
    .rejects.toThrow("output exceeded its limit");
}, 15000);

it.runIf(process.platform === "win32")("installer timeout ends its owned tree and preserves an unrelated child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-job-"));
  const receipt = path.join(root, "pids.json");
  const unrelated = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const closed = once(unrelated, "close");
  let pids: number[] = [];
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});require('fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)";
    await expect(executeWindowsInstall(process.execPath, ["-e", script, receipt], 3000)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    pids = JSON.parse(fs.readFileSync(receipt, "utf8"));
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await expect.poll(() => pids.some(alive), { timeout: 3000 }).toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
  } finally {
    unrelated.stdin.end(); await closed;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
