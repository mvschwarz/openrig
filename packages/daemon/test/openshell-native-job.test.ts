import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenShellDriver, runOpenShellCommand } from "../src/adapters/openshell-driver.js";
import type { Placement } from "../src/domain/environment-platform.js";
import { writeWindowsNodeFixture } from "../../../scripts/windows-node-fixture.mjs";

it.skipIf(process.platform !== "win32").each([0, 7, "timeout", "overflow"] as const)("OpenShell finite native CLI owns descendants through %s", async mode => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'openrig-openshell-cli-job-'));
  const pidFile=path.join(root,'child.pid'),log=path.join(root,'argv.json');let pid=0;
  const child=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const source=`import fs from 'node:fs';import {spawn} from 'node:child_process';fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,windowsHide:true,stdio:'ignore'}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);const mode=${JSON.stringify(String(mode))};if(mode==='timeout')setInterval(()=>{},1000);else if(mode==='overflow'){process.stdout.write('x'.repeat(2*1024*1024+1));setInterval(()=>{},1000);}else{console.log(JSON.stringify({sandboxes:[],next_page_token:''}));process.exit(Number(mode));}}},10);`;
  try {
    writeWindowsNodeFixture(root,'openshell',source);vi.stubEnv('PATH',root);
    if(mode===0){
      expect(await new OpenShellDriver().list({gateway:'gateway space',workspace:'workspace "quoted"'} as Placement)).toEqual({complete:true,resources:[]});
      expect(JSON.parse(fs.readFileSync(log,'utf8'))).toEqual(['--gateway','gateway space','--workspace','workspace "quoted"','sandbox','list','--output','json','--page-size','100']);
    }else await expect(runOpenShellCommand(['owned fixture'],mode==='timeout'?2500:5000)).rejects.toMatchObject({code:'openshell_transport_unconfirmed',status:503});
    pid=Number(fs.readFileSync(pidFile,'utf8'));expect(pid).toBeGreaterThan(1);
    await expect.poll(()=>{try{process.kill(pid,0);return true;}catch{return false;}},{timeout:3000}).toBe(false);
  }finally{
    vi.unstubAllEnvs();
    if(!pid&&fs.existsSync(pidFile))pid=Number(fs.readFileSync(pidFile,'utf8'));
    if(pid>1)try{process.kill(pid);}catch{/* already ended */}
    fs.rmSync(root,{recursive:true,force:true});
  }
},10000);
