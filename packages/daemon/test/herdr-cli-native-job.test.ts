import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHerdrViewerRun } from "../src/domain/terminal/herdr-viewer.js";
import { writeWindowsNodeFixture } from "../../../scripts/windows-node-fixture.mjs";

it.skipIf(process.platform !== "win32").each([0, 7, "timeout", "overflow"] as const)("Herdr native CLI keeps child custody through %s", async mode => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'openrig-herdr-cli-job-'));
  const pidFile=path.join(root,'child.pid');let pid=0;
  const child=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const source=`import fs from 'node:fs';import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,windowsHide:true,stdio:'ignore'}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);const mode=process.argv[2];if(mode==='timeout')setInterval(()=>{},1000);else if(mode==='overflow'){process.stdout.write('x'.repeat(2*1024*1024+1));setInterval(()=>{},1000);}else{console.log(JSON.stringify({args:process.argv.slice(3),socket:process.env.HERDR_SOCKET_PATH,session:process.env.HERDR_SESSION??null}));console.error('owned exit');process.exit(Number(mode));}}},10);`;
  try {
    writeWindowsNodeFixture(root,'herdr',source);
    const socket=path.join(root,'selected socket');
    const run=createHerdrViewerRun({socketPath:socket},{...process.env,PATH:root,HERDR_SESSION:'unrelated',herdr_session:'also unrelated'});
    const args=['x y','quote"word','中文','',"end\\"];
    const result=run([String(mode),...args]);
    if(mode===0)expect(JSON.parse(await result)).toEqual({args,socket,session:null});
    else await expect(result).rejects.toMatchObject(mode==='timeout'?{code:'ETIMEDOUT'}:mode==='overflow'?{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}:{code:7,stderr:expect.stringContaining('owned exit')});
    pid=Number(fs.readFileSync(pidFile,'utf8'));expect(pid).toBeGreaterThan(1);
    await expect.poll(()=>{try{process.kill(pid,0);return true;}catch{return false;}},{timeout:3000}).toBe(false);
  } finally {
    if(!pid&&fs.existsSync(pidFile))pid=Number(fs.readFileSync(pidFile,'utf8'));
    if(pid>1)try{process.kill(pid);}catch{/* already gone */}
    fs.rmSync(root,{recursive:true,force:true});
  }
},12000);
