import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnRex, createRexCliTransport, resolveRexBinary } from "../src/domain/terminal/rex-transport.js";

it.skipIf(process.platform !== 'win32')('Rex respects native case-insensitive environment keys for discovery and server selection', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'openrig-rex-env-'));
  try {
    const binary=path.join(root,'rex.exe');fs.writeFileSync(binary,'discovery fixture');
    expect(resolveRexBinary({Path:root})).toBe(binary);
    expect(resolveRexBinary({rex_bin_dir:root,Path:''})).toBe(binary);
    const calls:string[][]=[];
    const transport=createRexCliTransport({env:{rex_server:' selected server '},binary:()=>binary,run:async argv=>{calls.push(argv);return '{}';}});
    await transport.request('server.status',{});
    expect(calls[0]).toEqual([binary,'--autostart=false','-S','selected server','api','call','server.status','-']);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

it.skipIf(process.platform !== "win32")("native Rex reports a missing resolved executable as unavailable before launching", async () => {
  const missing=path.join(os.tmpdir(),'openrig-rex-missing-'+Date.now(),'rex.exe');
  await expect(spawnRex([missing],"{}",5000)).rejects.toMatchObject({errno:"ENOENT",exitCode:null});
  await expect(createRexCliTransport({binary:()=>missing}).request('server.status',{})).rejects.toMatchObject({kind:'unavailable'});
});

it.each(['stdout','stderr'] as const)("Rex rejects an overflowing %s as unknown instead of accepting truncated output", async stream => {
  const code=`process.${stream}.write(' '.repeat(4*1024*1024+1));setInterval(()=>{},1000);`;
  const run=(_argv:string[],input:string,timeout:number)=>spawnRex([process.execPath,'-e',code],input,timeout);
  await expect(createRexCliTransport({binary:()=>process.execPath,run,timeoutMs:5000}).request('layout.apply',{}))
    .rejects.toMatchObject({kind:'unknown',message:expect.stringContaining(stream+' exceeded the Rex reply limit')});
},10000);

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
